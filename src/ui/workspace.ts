import * as fs from 'fs';
import * as path from 'path';
import { ScenarioPresets } from '../scenarios/presets';

export const types = ['smoke', 'load', 'stress', 'spike', 'soak', 'performance', 'socket'];
export interface LoadProfile { vus?: number; duration?: string; stages?: Array<{ duration: string; target: number }> }
export interface TestScript {
    id: string; name: string; type: string; protocol: 'http' | 'socket'; load?: LoadProfile;
    method?: string; path?: string; body?: unknown; headers?: Record<string,string>; status?: number; auth?: boolean;
    messages?: Array<{ action: 'send' | 'sendJSON'; data: string }>; socketDuration?: string;
}
export interface TestModule { id: string; name: string; scenarios: Record<string, LoadProfile>; scripts: TestScript[] }
export interface Settings {
    configFile?: 'config.ts' | 'gui.config.ts';
    name: string;
    environments: Record<string, string>;
    headers: Record<string, string>;
    timeout: string;
    thresholds: Record<string, string[]>;
    auth: { enabled: boolean; loginPath: string; identityField: string; tokenPath: string; poolSize: number };
    scenarios: Record<string, { enabled: boolean; vus: number; duration: string; stages: Array<{ duration: string; target: number }> }>;
    requests: Array<{ name: string; method: string; path: string; body: unknown; headers: Record<string, string>; status: number; auth: boolean }>;
    modules: TestModule[];
}
export function defaults(name: string, baseURL = 'http://localhost:3000'): Settings {
    return {
        name, environments: { default: baseURL }, headers: {}, timeout: '30s',
        thresholds: { http_req_duration: ['p(95)<1000'], http_req_failed: ['rate<0.01'] },
        auth: { enabled: false, loginPath: '/auth/login', identityField: 'email', tokenPath: 'data.token', poolSize: 1 },
        scenarios: Object.fromEntries(types.map(type => {
            const p = type === 'socket' ? { vus: 5, duration: '1m', stages: [] } : ScenarioPresets[type as keyof typeof ScenarioPresets];
            return [type, { enabled: type === 'smoke', vus: 'vus' in p ? p.vus : 50, duration: 'duration' in p ? p.duration : '5m', stages: 'stages' in p ? p.stages : [] }];
        })),
        requests: [{ name: 'Health', method: 'GET', path: '/health', body: null, headers: {}, status: 200, auth: false }],
        modules: [{ id: 'main', name: 'Main', scenarios: {}, scripts: [{ id: 'health', name: 'Health check', type: 'smoke', protocol: 'http', method: 'GET', path: '/health', body: null, headers: {}, status: 200, auth: false }] }],
    };
}
export function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}
export function safePath(root: string, relative: string): string {
    const target = path.resolve(root, relative);
    assert(target.startsWith(path.resolve(root) + path.sep), 'Path must stay inside the workspace');
    let current = path.resolve(root);
    for (const segment of path.relative(root, target).split(path.sep)) {
        current = path.join(current, segment);
        if (fs.existsSync(current)) assert(!fs.lstatSync(current).isSymbolicLink(), 'Symbolic links are not supported');
    }
    return target;
}
export function validateSettings(s: Settings): void {
    assert(!s.configFile || ['config.ts', 'gui.config.ts'].includes(s.configFile), 'Invalid config file');
    assert(s && typeof s.name === 'string' && s.name.trim(), 'Project name is required');
    assert(s.environments && Object.keys(s.environments).length, 'At least one environment is required');
    for (const [name, url] of Object.entries(s.environments)) {
        assert(/^[\w-]+$/.test(name), 'Invalid environment name');
        assert(/^https?:$/.test(new URL(url).protocol), 'Base URL must use HTTP or HTTPS');
    }
    const duration = (v: string) => typeof v === 'string' && /^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(v) && /[1-9]/.test(v);
    assert(duration(s.timeout), 'Invalid timeout');
    assert(s.headers && typeof s.headers === 'object' && !Array.isArray(s.headers) && Object.values(s.headers).every(v => typeof v === 'string'), 'Headers must be a string map');
    assert(s.thresholds && Object.entries(s.thresholds).every(([k, v]) => k && Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim())), 'Invalid thresholds');
    assert(s.auth && typeof s.auth.enabled === 'boolean' && typeof s.auth.loginPath === 'string' && typeof s.auth.tokenPath === 'string' && /^[\w-]+$/.test(s.auth.identityField), 'Invalid auth configuration');
    assert(Number.isInteger(s.auth.poolSize) && s.auth.poolSize > 0, 'Pool size must be positive');
    assert(s.scenarios && types.every(t => s.scenarios[t]), 'All scenario settings are required');
    for (const v of Object.values(s.scenarios)) {
        assert(typeof v.enabled === 'boolean' && Number.isInteger(v.vus) && v.vus > 0 && duration(v.duration), 'Invalid VUs or duration');
        assert(Array.isArray(v.stages) && v.stages.every(x => duration(x.duration) && Number.isInteger(x.target) && x.target >= 0), 'Invalid stages');
    }
    assert(Array.isArray(s.modules), 'Modules must be an array');
    const ids = new Set<string>();
    for (const module of s.modules) {
        assert(/^[\w-]+$/.test(module.id) && !ids.has(module.id) && !!module.name.trim(), 'Module IDs must be unique and valid');
        ids.add(module.id);
        assert(module.scenarios && Array.isArray(module.scripts), 'Invalid module configuration');
        for (const profile of Object.values(module.scenarios)) validateProfile(profile, duration);
        const scriptIds = new Set<string>();
        for (const script of module.scripts) {
            assert(/^[\w-]+$/.test(script.id) && !scriptIds.has(script.id) && !!script.name.trim(), 'Script IDs must be unique and valid per module');
            scriptIds.add(script.id);
            assert(types.includes(script.type) && ['http', 'socket'].includes(script.protocol), 'Unknown test type or protocol');
            if (script.protocol === 'http') {
                assert(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(script.method || ''), 'Invalid HTTP method');
                assert(typeof script.path === 'string' && script.path.startsWith('/'), 'Request path must start with /');
                assert(Number.isInteger(script.status) && script.status! >= 100 && script.status! <= 599, 'Invalid expected status');
                assert(script.headers && Object.values(script.headers).every(v => typeof v === 'string'), 'Invalid request headers');
            } else {
                assert(typeof script.path === 'string' && script.path.startsWith('/'), 'Socket path must start with /');
                assert(typeof script.socketDuration === 'string' && duration(script.socketDuration), 'Invalid socket duration');
                assert(Array.isArray(script.messages) && script.messages.every(m => ['send', 'sendJSON'].includes(m.action)), 'Invalid socket messages');
            }
            if (script.load) validateProfile(script.load, duration);
        }
    }
    assert(Array.isArray(s.requests), 'Requests must be an array');
    for (const r of s.requests) {
        assert(r.name && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(r.method), 'Invalid request name or method');
        assert(typeof r.path === 'string' && r.path.startsWith('/'), 'Request path must start with /');
        assert(Number.isInteger(r.status) && r.status >= 100 && r.status <= 599, 'Invalid expected status');
        assert(r.headers && Object.values(r.headers).every(v => typeof v === 'string'), 'Invalid request headers');
    }
}
function validateProfile(profile: LoadProfile, isDuration: (value: string) => boolean): void {
    assert(profile && Object.keys(profile).every(k => ['vus', 'duration', 'stages'].includes(k)), 'Invalid load override');
    assert(profile.vus === undefined || Number.isInteger(profile.vus) && profile.vus > 0, 'VU override must be positive');
    assert(profile.duration === undefined || isDuration(profile.duration), 'Invalid duration override');
    assert(profile.stages === undefined || Array.isArray(profile.stages) && profile.stages.every(x => isDuration(x.duration) && Number.isInteger(x.target) && x.target >= 0), 'Invalid stages override');
}
export function writeJSON(file: string, value: unknown): void {
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temporary, file);
}
export function walk(root: string, extension?: string): string[] {
    if (!fs.existsSync(root)) return [];
    const result: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.') || ['node_modules', 'dist', 'reports', 'generated', 'data'].includes(entry.name)) continue;
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) result.push(...walk(full, extension));
        else if (!extension || entry.name.endsWith(extension)) result.push(full);
    }
    return result.sort();
}
// Managed files are generated from the JSON settings. Existing custom scripts remain untouched.
export function generate(root: string, s: Settings): void {
    validateSettings(s);
    const configFile = s.configFile || 'config.ts';
    // Resolve every generated path before the first mutation, including existing symlinks.
    const scriptFiles = s.modules.flatMap(m => m.scripts.map(t => `modules/${m.id}/${t.type}/${t.id}.test.ts`));
    for (const relative of ['data', configFile, 'k6-lib.project.json', ...types.map(t => t + '/gui.test.ts'), ...scriptFiles]) safePath(root, relative);
    for (const relative of scriptFiles) {
        const file = safePath(root, relative);
        if (fs.existsSync(file)) assert(fs.readFileSync(file, 'utf8').startsWith('// Generated by k6-lib UI.'), `Refusing to overwrite custom script: ${relative}`);
    }
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const j = JSON.stringify;
    fs.writeFileSync(path.join(root, configFile), `// Generated by k6-lib UI. Edit k6-lib.project.json through the UI.\nimport { defineProject, passwordAuth, csvUsers } from '@htplus/k6-lib';\nexport default defineProject({\n name: ${j(s.name)}, baseURL: ${j(s.environments)}, defaultHeaders: ${j(s.headers)}, defaultTimeout: ${j(s.timeout)}, thresholds: ${j(s.thresholds)},\n ${s.auth.enabled ? `auth: { user: passwordAuth({ loginPath: ${j(s.auth.loginPath)}, body: u => ({ [${j(s.auth.identityField)}]: u[${j(s.auth.identityField)}], password: u.password }), extractToken: ${j(s.auth.tokenPath)}, pool: { size: ${s.auth.poolSize}, rotation: 'round-robin' } }) }, testUsers: csvUsers('./test-users.local.csv'),` : ''}\n});\n`);
    for (const type of (s.modules.length ? [] : types)) {
        const v = s.scenarios[type];
        const dir = safePath(root, type);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'gui.test.ts');
        if (!v.enabled) { if (fs.existsSync(file)) fs.unlinkSync(file); continue; }
        const scenario = v.stages.length ? { executor: 'ramping-vus', stages: v.stages, gracefulStop: '10s' } : { executor: 'constant-vus', vus: v.vus, duration: v.duration, gracefulStop: '10s' };
        fs.writeFileSync(file, `// Generated by k6-lib UI.\nimport { group, sleep } from 'k6';\nimport project from '../${configFile.slice(0, -3)}';\nexport { handleSummary } from '@htplus/k6-lib/reporter';\nexport const options = ${j({ scenarios: { [type]: scenario }, thresholds: s.thresholds })};\nexport function setup() { return project.setup(); }\nconst requests = ${j(s.requests)};\nexport default function(data: any) {\n project.applySetupData(data);\n for (const r of requests) group(r.name, () => {\n const response = project.http.batch([{ method: r.method as any, path: r.path, body: r.body, options: { headers: r.headers, auth: r.auth ? 'user' : false } }])[0];\n project.check(response, r.status);\n });\n sleep(1);\n}\n`);
    }
    const activeScripts = new Set(scriptFiles);
    for (const relative of walk(path.join(root, 'modules'), '.test.ts').map(file => path.relative(root, file).replace(/\\/g, '/'))) {
        if (!relative.startsWith('modules/')) continue;
        if (!activeScripts.has(relative)) {
            const file = safePath(root, relative);
            if (fs.readFileSync(file, 'utf8').startsWith('// Generated by k6-lib UI.')) fs.unlinkSync(file);
        }
    }
    for (const module of s.modules) for (const script of module.scripts) {
        const relative = `modules/${module.id}/${script.type}/${script.id}.test.ts`;
        const file = safePath(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const projectProfile = s.scenarios[script.type];
        const moduleProfile = module.scenarios[script.type] || {};
        const profile = {
            vus: script.load?.vus ?? moduleProfile.vus ?? projectProfile.vus,
            duration: script.load?.duration ?? moduleProfile.duration ?? projectProfile.duration,
            stages: script.load?.stages ?? moduleProfile.stages ?? projectProfile.stages,
        };
        const scenario = profile.stages?.length
            ? { executor: 'ramping-vus', stages: profile.stages, gracefulStop: '10s' }
            : { executor: 'constant-vus', vus: profile.vus, duration: profile.duration, gracefulStop: '10s' };
        const common = `// Generated by k6-lib UI. Edit the script in the Modules tab.\nimport project from '../../../${configFile.slice(0, -3)}';\nexport { handleSummary } from '@htplus/k6-lib/reporter';\nexport const options = ${j({ scenarios: { [script.id]: scenario }, thresholds: s.thresholds })};\nexport function setup() { return project.setup(); }\n`;
        const code = script.protocol === 'socket'
            ? `${common}export default function(data: any) {\n project.applySetupData(data);\n project.ws.connect(${j(script.path)}, { auth: false }, socket => {\n${(script.messages || []).map(m => `  socket.${m.action}(${m.action === 'sendJSON' ? m.data : j(m.data)});\n`).join('')}  socket.waitFor(${j(script.socketDuration)});\n });\n}\n`
            : `${common}import { group } from 'k6';\nexport default function(data: any) {\n project.applySetupData(data);\n group(${j(script.name)}, () => {\n const response = project.http.batch([{ method: ${j(script.method)} as any, path: ${j(script.path)}, body: ${j(script.body)}, options: { headers: ${j(script.headers || {})}, auth: ${script.auth ? "'user'" : 'false'} } }])[0];\n project.check(response, ${script.status});\n });\n}\n`;
        fs.writeFileSync(file, code);
    }
    writeJSON(path.join(root, 'k6-lib.project.json'), s);
}
