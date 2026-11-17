// End-to-end checks against the real server, webpack and installed k6 binary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const id = 'ui-check-' + Date.now();
const workspace = path.join(root, 'workspaces', id);
const adoptedID = id + '-custom';
const adoptedWorkspace = path.join(root, 'workspaces', adoptedID);
const base = 'http://127.0.0.1:5975';
const server = spawn(process.execPath, ['dist/cli/index.js', 'ui', '--port', '5975'], { cwd: root, stdio: 'pipe' });
let output = '';
server.stdout.on('data', x => output += x);
server.stderr.on('data', x => output += x);
let token, hits = 0, logins = 0;
const fixture = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/auth/login') {
        assert.deepEqual(JSON.parse(body), { email: 'test@example.com', password: 'test-only' });
        logins++; res.end(JSON.stringify({ data: { token: 'fixture-token' } }));
    } else if (req.url === '/posts?limit=1') {
        assert.equal(req.headers.authorization, 'Bearer fixture-token');
        assert.equal(req.headers['x-test'], 'yes');
        assert.deepEqual(JSON.parse(body), { title: 'test' });
        hits++; res.statusCode = 201; res.end('{"ok":true}');
    } else { res.statusCode = 404; res.end('{}'); }
});
const wait = ms => new Promise(r => setTimeout(r, ms));
async function api(route, method = 'GET', body, expected = 200) {
    const response = await fetch(base + '/api/' + route, { method, headers: { 'x-k6-ui-token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data)); return data;
}
async function done() {
    for (let i = 0; i < 150; i++) {
        const d = await api('projects/' + id);
        if (!d.active && !d.queued.length) return d;
        await wait(300);
    }
    throw Error('Run timed out');
}
(async () => {
    await new Promise(r => fixture.listen(5976, '127.0.0.1', r));
    let html;
    for (let i = 0; i < 50; i++) { try { html = await (await fetch(base)).text(); break; } catch { await wait(100); } }
    assert.ok(html, output);
    token = html.match(/const token='([^']+)'/)[1];
    new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
    await api('projects', 'POST', { id, name: 'Integration check', baseURL: 'http://127.0.0.1:5976' }, 201);
    let d = await api('projects/' + id);
    const s = d.settings;
    s.auth.enabled = true;
    for (const t of Object.keys(s.scenarios)) { s.scenarios[t].enabled = false; s.scenarios[t].vus = 1; s.scenarios[t].duration = '4s'; s.scenarios[t].stages = []; }
    s.scenarios.smoke.enabled = true;
    s.scenarios.load.enabled = true;
    s.scenarios.load.stages = [];
    s.requests = [{ name: 'Create', method: 'POST', path: '/posts?limit=1', body: { title: 'test' }, headers: { 'X-Test': 'yes' }, status: 201, auth: true }];
    s.modules = [{ id: 'orders', name: 'Orders', scenarios: { smoke: { vus: 1 }, load: { vus: 1 } }, scripts: [
        { id: 'smoke-api', name: 'Smoke API', type: 'smoke', protocol: 'http', load: { vus: 1 }, method: 'POST', path: '/posts?limit=1', body: { title: 'test' }, headers: { 'X-Test': 'yes' }, status: 201, auth: true },
        { id: 'load-api', name: 'Load API', type: 'load', protocol: 'http', method: 'POST', path: '/posts?limit=1', body: { title: 'test' }, headers: { 'X-Test': 'yes' }, status: 201, auth: true },
    ] }];
    await api('projects/' + id + '/settings', 'PUT', s);
    await api('projects/' + id + '/data', 'PUT', { file: 'test-users.local.csv', content: 'email,password\ntest@example.com,test-only\n' });
    await api('projects/' + id + '/data', 'PUT', { file: 'data/posts.json', content: '[{"title":"test"}]' });
    await api('projects/' + id + '/data', 'PUT', { file: 'data/bad.json', content: '{' }, 400);
    await api('projects/' + id + '/data?file=../config.ts', 'GET', undefined, 400);
    const smokeScript = fs.readFileSync(path.join(workspace, 'modules/orders/smoke/smoke-api.test.ts'), 'utf8');
    assert.match(smokeScript, /"vus":1/); // script override wins over module/project
    const loadScript = fs.readFileSync(path.join(workspace, 'modules/orders/load/load-api.test.ts'), 'utf8');
    assert.match(loadScript, /"vus":1/); // module override wins over project
    await api('projects/' + id + '/run', 'POST', { environment: 'default', target: '' }, 202);
    await api('projects/' + id + '/history', 'DELETE', { confirm: id }, 400);
    await api('projects/' + id + '/settings', 'PUT', s, 400);
    d = await done();
    assert.equal(d.history[0].status, 'passed', d.history[0].log);
    assert.equal(d.history[0].results.length, 2);
    assert.ok(hits >= 2 && logins >= 2);
    const files = await api('projects/' + id + '/artifacts');
    assert.ok(files.some(f => f.endsWith('summary.json')));
    assert.ok(files.some(f => f.endsWith('dashboard-report.html')));
    assert.ok(d.history[0].results.every(r => r.summary.metrics.http_reqs));
    const report = await fetch(base + '/report/' + id + '/' + files.find(f => f.endsWith('dashboard-report.html')));
    assert.equal(report.status, 200); assert.match(report.headers.get('content-security-policy'), /sandbox/);
    await api('projects/' + id + '/run', 'POST', { environment: 'default', target: 'type:smoke' }, 202);
    d = await done(); assert.equal(d.history[0].results.length, 1);
    await api('projects/' + id + '/run', 'POST', { environment: 'default', target: 'module:orders' }, 202);
    d = await done(); assert.equal(d.history[0].results.length, 2);
    await api('projects/' + id + '/run', 'POST', { environment: 'default', target: 'script:modules/orders/smoke/smoke-api.test.ts' }, 202);
    d = await done(); assert.equal(d.history[0].results.length, 1);
    s.modules[0].scripts.push({ id: 'events', name: 'Socket events', type: 'socket', protocol: 'socket', path: '/events', messages: [{ action: 'sendJSON', data: '{"type":"ping"}' }], socketDuration: '1s', load: { vus: 1, duration: '2s' } });
    s.scenarios.socket ||= { enabled: false, vus: 5, duration: '1m', stages: [] };
    await api('projects/' + id + '/settings', 'PUT', s);
    assert.ok(fs.readFileSync(path.join(workspace, 'modules/orders/socket/events.test.ts'), 'utf8').includes('project.ws.connect'));
    const build = spawn(process.execPath, ['dist/cli/index.js', 'build', workspace], { cwd: root, stdio: 'pipe' });
    const buildCode = await new Promise(resolve => build.once('close', resolve));
    assert.equal(buildCode, 0, 'Generated HTTP/WebSocket module scripts build');
    s.modules[0].scripts.pop();
    s.thresholds = { http_req_duration: ['p(95)<0'] };
    await api('projects/' + id + '/settings', 'PUT', s);
    await api('projects/' + id + '/run', 'POST', { environment: 'default', target: 'type:smoke' }, 202);
    d = await done(); assert.equal(d.history[0].status, 'failed');
    await api('projects/' + id + '/run', 'POST', { environment: 'default', target: 'type:load' }, 202);
    fs.mkdirSync(adoptedWorkspace);
    fs.writeFileSync(path.join(adoptedWorkspace, 'config.ts'), '// Existing custom configuration\n');
    await api('projects/' + adoptedID + '/adopt', 'POST', { baseURL: 'http://127.0.0.1:5976' });
    assert.equal(fs.readFileSync(path.join(adoptedWorkspace, 'config.ts'), 'utf8'), '// Existing custom configuration\n');
    assert.ok(fs.readFileSync(path.join(adoptedWorkspace, 'modules/main/smoke/health.test.ts'), 'utf8').includes("from '../../../gui.config'"));
    await api('projects/' + adoptedID + '/run', 'POST', { environment: 'default', target: 'type:smoke' }, 202);
    const queued = await api('projects/' + adoptedID);
    assert.equal(queued.queued.length, 1);
    await api('projects/' + adoptedID + '/stop', 'POST', {});
    assert.equal((await api('projects/' + adoptedID)).history[0].status, 'cancelled');
    await api('projects/' + adoptedID, 'DELETE', { confirm: adoptedID });
    await api('projects/' + id + '/stop', 'POST', {});
    d = await done(); assert.equal(d.history[0].status, 'cancelled');
    await api('projects/' + id + '/history', 'DELETE', { confirm: 'wrong' }, 400);
    await api('projects/' + id + '/history', 'DELETE', { confirm: id });
    d = await api('projects/' + id); assert.equal(d.history.length, 0); assert.ok(d.tests.length);
    assert.equal(fs.existsSync(path.join(workspace, 'reports')), false);
    await api('projects/' + id, 'DELETE', { confirm: 'wrong' }, 400);
    await api('projects/' + id, 'DELETE', { confirm: id });
    assert.equal(fs.existsSync(workspace), false);
    console.log('PASS: real k6 auth/request flow, run all/type/module/script, socket build and reports, thresholds, stop, data validation, protected deletion and browser script syntax');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
    server.kill(); fixture.close();
    // Only this uniquely named integration workspace can be removed here.
    if (path.dirname(workspace) === path.join(root, 'workspaces') && path.basename(workspace) === id) fs.rmSync(workspace, { recursive: true, force: true });
    if (path.dirname(adoptedWorkspace) === path.join(root, 'workspaces') && path.basename(adoptedWorkspace) === adoptedID) fs.rmSync(adoptedWorkspace, { recursive: true, force: true });
});
