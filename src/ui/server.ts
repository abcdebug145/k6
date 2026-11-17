import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { assert, defaults, generate, safePath, Settings, walk, writeJSON } from './workspace';
import { page } from './page';

interface Run {
    id: string; project: string; target: string; environment: string;
    status: string; startedAt: string; endedAt?: string; log: string;
    results: Array<{ file: string; code: number; summary?: unknown }>;
}
export function startUI(args: string[] = []): http.Server {
    const portIndex = args.indexOf('--port');
    const port = portIndex < 0 ? 5666 : Number(args[portIndex + 1]);
    assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid port');
    const root = path.resolve(process.cwd(), 'workspaces');
    fs.mkdirSync(root, { recursive: true });
    assert(!fs.lstatSync(root).isSymbolicLink(), 'Workspace root cannot be a symbolic link');
    const token = randomBytes(24).toString('hex');
    let active: Run | undefined;
    let child: ChildProcess | undefined;
    const queue: Run[] = [];
    const projectPath = (id: string) => {
        assert(/^[\w-]+$/.test(id), 'Invalid project ID');
        return safePath(root, id);
    };
    const busy = (id: string) => active?.project === id || queue.some(r => r.project === id);
    const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
    const managed = (dir: string): Settings | null => {
        if (!fs.existsSync(safePath(dir, 'k6-lib.project.json'))) return null;
        const settings = read(path.join(dir, 'k6-lib.project.json')) as Settings;
        settings.modules ||= [];
        settings.scenarios.socket ||= { enabled: false, vus: 5, duration: '1m', stages: [] };
        settings.requests ||= [];
        return settings;
    };
    const tests = (dir: string) => walk(dir, '.test.ts').map(f => path.relative(dir, f).replace(/\\/g, '/'));
    const history = (dir: string): Run[] => {
        const reports = safePath(dir, 'reports');
        if (!fs.existsSync(reports)) return [];
        return fs.readdirSync(reports).filter(n => /^run-[\w-]+$/.test(n)).flatMap(n => {
            const file = safePath(dir, `reports/${n}/run.json`);
            if (!fs.existsSync(file)) return [];
            const r = read(file) as Run;
            if (['running', 'building', 'queued', 'stopping'].includes(r.status) && active?.id !== r.id && !queue.some(q => q.id === r.id)) r.status = 'interrupted';
            return [r];
        }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    };
    const persist = (run: Run) => {
        const dir = safePath(projectPath(run.project), `reports/${run.id}`);
        fs.mkdirSync(dir, { recursive: true });
        writeJSON(path.join(dir, 'run.json'), run);
    };
    const log = (run: Run, value: string) => { run.log = (run.log + value).slice(-100000); };
    const execute = (run: Run, command: string, argv: string[], env: NodeJS.ProcessEnv): Promise<number> => new Promise(resolve => {
        log(run, '\n> ' + [command, ...argv].join(' ') + '\n');
        child = spawn(command, argv, { cwd: process.cwd(), env, windowsHide: true, detached: process.platform !== 'win32' });
        child.stdout?.on('data', data => log(run, String(data)));
        child.stderr?.on('data', data => log(run, String(data)));
        child.once('error', err => log(run, err.message + '\n'));
        child.once('close', code => { child = undefined; resolve(code ?? 1); });
    });
    async function pump(): Promise<void> {
        if (active || !queue.length) return;
        const run = queue.shift()!;
        active = run;
        try {
            const dir = projectPath(run.project);
            const env = { ...process.env, ENV: run.environment };
            const envFile = safePath(dir, '.env');
            if (fs.existsSync(envFile)) Object.assign(env, require('dotenv').parse(fs.readFileSync(envFile)));
            env.ENV = run.environment;
            run.status = 'building'; persist(run);
            const spec = ['openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.yaml', 'swagger.json'].some(n => fs.existsSync(safePath(dir, n)));
            if (spec) assert(await execute(run, process.execPath, [path.join(__dirname, '../cli/gen.js'), dir], env) === 0, 'Codegen failed');
            if (run.status === 'stopping') return;
            assert(await execute(run, process.execPath, [path.join(__dirname, '../cli/build.js'), dir], env) === 0, 'Build failed');
            if (run.status === 'stopping') return;
            const selected = tests(dir).filter(f => {
                if (!run.target) return true;
                if (run.target.startsWith('type:')) return f.split('/')[2] === run.target.slice(5);
                if (run.target.startsWith('module:')) return f.startsWith(`modules/${run.target.slice(7)}/`);
                if (run.target.startsWith('script:')) return f === run.target.slice(7);
                return f === run.target || f.startsWith(run.target + '/');
            });
            assert(selected.length, 'No matching tests');
            run.status = 'running'; persist(run);
            for (const file of selected) {
                if (run.status === 'stopping') break;
                const out = safePath(dir, `reports/${run.id}/${file.replace(/\.test\.ts$/, '')}`);
                fs.mkdirSync(out, { recursive: true });
                const bundled = safePath(dir, 'dist/' + file.replace(/\.ts$/, '.js'));
                const code = await execute(run, 'k6', ['run', bundled, '--summary-export', path.join(out, 'summary.json')], {
                    ...env, K6_SUMMARY_DIR: out, K6_TEST_NAME: file,
                    K6_WEB_DASHBOARD: 'true', K6_WEB_DASHBOARD_PORT: '-1',
                    K6_WEB_DASHBOARD_PERIOD: '1s',
                    K6_WEB_DASHBOARD_EXPORT: path.join(out, 'dashboard-report.html'),
                });
                const summary = path.join(out, 'summary.json');
                run.results.push({ file, code, ...(fs.existsSync(summary) ? { summary: read(summary) } : {}) });
                persist(run);
            }
            if (run.status !== 'stopping') run.status = run.results.every(r => r.code === 0) ? 'passed' : 'failed';
        } catch (e) { log(run, '\n' + (e as Error).message); if (run.status !== 'stopping') run.status = 'failed'; }
        finally {
            if (run.status === 'stopping') run.status = 'cancelled';
            run.endedAt = new Date().toISOString(); persist(run); active = undefined; void pump();
        }
    }
    function stop(): void {
        if (!active) return;
        active.status = 'stopping';
        if (child?.pid) {
            if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
        }
    }
    const send = (res: http.ServerResponse, value: unknown, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value));
    };
    const server = http.createServer(async (req, res) => {
        try {
            const host = req.headers.host || '';
            assert(host === `127.0.0.1:${port}` || host === `localhost:${port}`, 'Invalid host');
            const url = new URL(req.url || '/', `http://${host}`);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Referrer-Policy', 'no-referrer');
            if (req.method === 'GET' && url.pathname === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
                res.end(page.replace('__TOKEN__', token)); return;
            }
            const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
            if (parts[0] === 'report' && req.method === 'GET') {
                const dir = projectPath(parts[1]);
                const file = safePath(dir, 'reports/' + parts.slice(2).join('/'));
                assert(fs.existsSync(file) && fs.statSync(file).isFile(), 'Report not found');
                res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:");
                res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.json') ? 'application/json' : 'text/plain');
                fs.createReadStream(file).pipe(res); return;
            }
            assert(parts[0] === 'api' && req.headers['x-k6-ui-token'] === token, 'Unauthorized request');
            let body: any = {};
            if (req.method !== 'GET') {
                let content = ''; for await (const chunk of req) { content += chunk; assert(Buffer.byteLength(content) <= 2e6, 'Request exceeds 2 MB'); }
                body = content ? JSON.parse(content) : {};
            }
            if (parts.length === 2 && parts[1] === 'projects') {
                if (req.method === 'GET') {
                    send(res, fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && /^[\w-]+$/.test(d.name)).map(d => {
                        const dir = projectPath(d.name); const s = managed(dir); const latest = history(dir)[0];
                        return { id: d.name, name: s?.name || d.name, environments: s?.environments, tests: tests(dir), status: busy(d.name) ? active?.project === d.name ? active.status : 'queued' : latest?.status || 'ready', latest };
                    })); return;
                }
                if (req.method === 'POST') {
                    const dir = projectPath(body.id); assert(!fs.existsSync(dir), 'Project already exists');
                    const settings = defaults(body.name || body.id, body.baseURL);
                    // Validate before creating the directory.
                    require('./workspace').validateSettings(settings);
                    fs.mkdirSync(dir); generate(dir, settings);
                    fs.writeFileSync(path.join(dir, 'test-users.local.csv'), 'email,password,username,role\n');
                    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n*.local.csv\nreports/\ndist/\n');
                    send(res, { id: body.id }, 201); return;
                }
            }
            assert(parts[1] === 'projects' && parts[2], 'Unknown endpoint');
            const id = parts[2]; const dir = projectPath(id); assert(fs.existsSync(dir), 'Project not found');
            const action = parts[3];
            if (!action && req.method === 'GET') {
                const s = managed(dir);
                send(res, { id, settings: s, tests: tests(dir), history: history(dir), active: active?.project === id ? active : null, queued: queue.filter(r => r.project === id), files: dataFiles(dir), config: !s ? ['config.ts', 'project.config.ts'].filter(n => fs.existsSync(safePath(dir, n))).map(n => fs.readFileSync(safePath(dir, n), 'utf8')).join('\n') : '' }); return;
            }
            if (action === 'run' && req.method === 'POST') {
                assert(!busy(id), 'Project already has a pending run');
                const s = managed(dir); assert(typeof body.environment === 'string' && /^[\w-]+$/.test(body.environment), 'Invalid environment');
                if (s) assert(Object.hasOwnProperty.call(s.environments, body.environment), 'Unknown environment');
                const target = body.target || '';
                const available = tests(dir);
                const expected = target.startsWith('type:') ? available.some(f => f.split('/')[2] === target.slice(5))
                    : target.startsWith('module:') ? available.some(f => f.startsWith(`modules/${target.slice(7)}/`))
                    : target.startsWith('script:') ? available.includes(target.slice(7))
                    : available.some(f => !target || f === target || f.startsWith(target + '/'));
                assert(typeof target === 'string' && expected, 'No matching tests');
                const run: Run = { id: 'run-' + Date.now() + '-' + randomBytes(3).toString('hex'), project: id, target, environment: body.environment, status: 'queued', startedAt: new Date().toISOString(), log: '', results: [] };
                // Snapshot configuration without credentials for later review.
                persist(run); if (s) writeJSON(safePath(dir, `reports/${run.id}/settings.json`), s);
                queue.push(run); void pump(); send(res, run, 202); return;
            }
            if (action === 'stop' && req.method === 'POST') {
                for (let i = queue.length - 1; i >= 0; i--) if (queue[i].project === id) { const r = queue.splice(i, 1)[0]; r.status = 'cancelled'; r.endedAt = new Date().toISOString(); persist(r); }
                if (active?.project === id) stop(); send(res, { ok: true }); return;
            }
            if (req.method !== 'GET') assert(!busy(id), 'Stop the project run before changing files or deleting history');
            if (action === 'adopt' && req.method === 'POST') {
                assert(!managed(dir), 'Project already has GUI settings');
                assert(!fs.existsSync(safePath(dir, 'gui.config.ts')) && !tests(dir).some(f => f.endsWith('/gui.test.ts')), 'GUI file names are already in use');
                const settings = defaults(id, body.baseURL);
                settings.configFile = 'gui.config.ts';
                generate(dir, settings);
                const users = safePath(dir, 'test-users.local.csv');
                if (!fs.existsSync(users)) fs.writeFileSync(users, 'email,password,username,role\n');
                const ignore = safePath(dir, '.gitignore');
                fs.appendFileSync(ignore, '\n*.local.csv\nreports/\ndist/\n');
                send(res, { ok: true }); return;
            }
            if (!action && req.method === 'DELETE') {
                assert(body.confirm === id, 'Type the project ID to confirm deletion'); fs.rmSync(projectPath(id), { recursive: true }); send(res, { ok: true }); return;
            }
            if (action === 'history' && req.method === 'DELETE') {
                assert(body.confirm === id, 'Type the project ID to confirm clearing history');
                fs.rmSync(safePath(dir, 'reports'), { recursive: true, force: true }); send(res, { ok: true }); return;
            }
            if (action === 'settings' && req.method === 'PUT') {
                const previous = managed(dir);
                assert(previous, 'Add GUI settings before editing');
                body.configFile = previous.configFile;
                generate(dir, body); send(res, { ok: true }); return;
            }
            if (action === 'data') {
                const name = url.searchParams.get('file') || body.file;
                assert(typeof name === 'string' && /^(?:test-users(?:\.local)?\.csv|data\/[\w.-]+\.(?:csv|json|jsonl))$/.test(name), 'Invalid data file path');
                const file = safePath(dir, name);
                if (req.method === 'GET') { send(res, { content: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' }); return; }
                if (req.method === 'PUT') {
                    assert(typeof body.content === 'string', 'Content must be text');
                    if (name.endsWith('.json')) JSON.parse(body.content);
                    if (name.endsWith('.jsonl')) body.content.split(/\r?\n/).filter((s: string) => s.trim()).forEach((s: string) => JSON.parse(s));
                    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body.content); send(res, { ok: true }); return;
                }
                if (req.method === 'DELETE') { fs.unlinkSync(file); send(res, { ok: true }); return; }
            }
            if (action === 'artifacts' && req.method === 'GET') {
                const list = (base: string): string[] => !fs.existsSync(base) ? [] : fs.readdirSync(base, { withFileTypes: true }).flatMap(e => e.isSymbolicLink() ? [] : e.isDirectory() ? list(path.join(base, e.name)) : [path.relative(path.join(dir, 'reports'), path.join(base, e.name)).replace(/\\/g, '/')]);
                send(res, list(safePath(dir, 'reports'))); return;
            }
            send(res, { error: 'Unknown endpoint' }, 404);
        } catch (e) { send(res, { error: (e as Error).message }, 400); }
    });
    function dataFiles(dir: string): string[] {
        const data = safePath(dir, 'data');
        return ['test-users.csv', 'test-users.local.csv'].filter(f => fs.existsSync(safePath(dir, f))).concat(fs.existsSync(data) ? fs.readdirSync(data).filter(f => /^[\w.-]+\.(csv|json|jsonl)$/.test(f)).map(f => 'data/' + f) : []);
    }
    server.listen(port, '127.0.0.1', () => console.log(`k6-lib UI: http://127.0.0.1:${port}\nWorkspace: ${root}\nPress Ctrl+C to stop.`));
    server.on('error', err => console.error('UI server:', err.message));
    process.once('SIGINT', () => { queue.length = 0; stop(); server.close(); });
    return server;
}
