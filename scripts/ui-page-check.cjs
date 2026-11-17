const assert = require('node:assert/strict');
const vm = require('node:vm');
const { page } = require('../dist/ui/page');

async function checkPage(html, history, files) {
    const nodes = new Map();
    const element = () => ({ innerHTML: '', dataset: {}, attributes: {}, value: '', setAttribute(k, v) { this.attributes[k] = v; } });
    for (const id of ['panel', 'history', 'comparison', 'artifacts', 'environment', 'notice', 'dialog', 'data-file', 'data-content', 'data-preview']) nodes.set('#' + id, element());
    const makeLog = (top = 0) => ({ scrollTop: top, scrollHeight: 1000, clientHeight: 200, listener: null, addEventListener(_name, listener) { this.listener = listener; } });
    const live = { log: makeLog(800), set innerHTML(_value) { this.log = makeLog(); }, querySelector(selector) { return selector === 'pre' ? this.log : null; } };
    nodes.set('#live', live);
    nodes.get('#environment').value = 'staging';
    const tabs = ['overview', 'modules', 'settings', 'requests', 'data', 'history'].map(name => {
        const el = element(); el.dataset.action = 'tab:' + name; el.selected = name === 'overview';
        el.classList = { toggle(_name, enabled) { el.selected = enabled; } }; return el;
    });
    const compare = element(); nodes.set('[data-action="compare"]', compare);
    const listeners = {};
    let allowDiscard = false;
    const context = vm.createContext({
        document: {
            querySelector: selector => nodes.get(selector) || null,
            querySelectorAll: () => tabs,
            addEventListener: (event, listener) => { listeners[event] = listener; },
        },
        window: { addEventListener() {} }, setInterval() {}, setTimeout() {},
        confirm: () => allowDiscard,
        fetch: async () => ({ ok: true, json: async () => files }),
    });
    const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
    // Prevent automatic Home navigation; exercise the production handlers below.
    vm.runInContext(script.replace('home().catch(e=>notify(e.message));', ''), context);
    context.fixture = { history, active: null, queued: [], settings: {
        name: 'Fixture', environments: { staging: 'https://example.test' }, headers: {}, timeout: '30s', thresholds: {},
        auth: { enabled: false, loginPath: '/login', identityField: 'email', tokenPath: 'data.token', poolSize: 1 }, requests: [],
        scenarios: { smoke: { enabled: true, vus: 5, duration: '1m', stages: [] } },
        modules: [{ id: 'main', name: 'Main', scenarios: { smoke: { vus: 10 } }, scripts: [{ id: 'test', name: 'Test', type: 'smoke', protocol: 'http', load: { vus: 20 } }] }],
    }, config: '', tests: [], files: [] };
    vm.runInContext("current='fixture';detail=fixture;", context);
    const clickTab = async name => listeners.click({ target: { closest: () => ({ dataset: { action: 'tab:' + name } }) } });
    for (const name of ['settings', 'modules', 'requests', 'data', 'history', 'overview']) {
        await clickTab(name);
        assert.deepEqual(tabs.filter(t => t.selected).map(t => t.dataset.action), ['tab:' + name]);
        assert.equal(tabs.find(t => t.selected).attributes['aria-current'], 'page');
        assert.equal(nodes.get('#environment').value, 'staging', 'Tab switch preserves environment');
        if (name === 'modules') assert.match(nodes.get('#panel').innerHTML, /Modules and tests/);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext("effectiveLoad(fixture.settings,fixture.settings.modules[0],fixture.settings.modules[0].scripts[0])", context))), { vus: 20, duration: '1m', stages: [], source: 'script' });
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext("effectiveLoad(fixture.settings,fixture.settings.modules[0],{type:'smoke',load:{}})", context))), { vus: 10, duration: '1m', stages: [], source: 'module' });
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext("effectiveLoad(fixture.settings,{scenarios:{},modules:[]},{type:'smoke',load:{}})", context))), { vus: 5, duration: '1m', stages: [], source: 'project' });
    vm.runInContext("detail.active={status:'running',environment:'staging',target:'smoke',log:'first'};updateLive()", context);
    assert.equal(live.log.scrollTop, live.log.scrollHeight, 'Run log follows the bottom initially');
    live.log.scrollTop = 300; live.log.listener();
    vm.runInContext("detail.active.log='second';updateLive()", context);
    assert.equal(live.log.scrollTop, 300, 'Run log stays at the user scroll position');
    live.log.scrollTop = live.log.scrollHeight - live.log.clientHeight; live.log.listener();
    vm.runInContext("detail.active.log='third';updateLive()", context);
    assert.equal(live.log.scrollTop, live.log.scrollHeight, 'Run log resumes following after returning to the bottom');
    vm.runInContext('dirty=true', context);
    await clickTab('settings');
    assert.equal(tabs.find(t => t.selected).dataset.action, 'tab:overview', 'Cancelled discard keeps selected tab');
    allowDiscard = true;
    await clickTab('history');
    await vm.runInContext('loadArtifacts()', context);
    const historyHTML = nodes.get('#history').innerHTML;
    assert.match(historyHTML, /View report/);
    assert.match(historyHTML, /href="\/report\/fixture\//);
    assert.doesNotMatch(historyHTML, /target="_blank"|<th>P95/);
    assert.match(historyHTML, /dashboard-report\.html/);
    // Dashboard preference and library summary fallback for short runs.
    context.run = history[0]; context.result = history[0].results[0];
    const preferred = vm.runInContext('resultReport(run,result)', context);
    assert.ok(preferred.endsWith('dashboard-report.html'));
    context.fallbackFiles = files.filter(f => !f.endsWith('dashboard-report.html'));
    vm.runInContext('reportFiles=fallbackFiles;updateLive()', context);
    assert.match(nodes.get('#history').innerHTML, /latest-k6-report\.html/);
    vm.runInContext('renderComparison()', context);
    assert.match(nodes.get('#comparison').innerHTML, /Previous.*Latest/s);
    assert.match(nodes.get('#comparison').innerHTML, /P95/);
    // Supports both k6 summary-export metrics and handleSummary metric.values.
    assert.match(nodes.get('#comparison').innerHTML, /\+50\.00 ms/);
    assert.match(nodes.get('#comparison').innerHTML, /\+1\.00 pp/);
    vm.runInContext("detail.history[1].results[0].file='load/other.test.ts';renderComparison()", context);
    assert.match(nodes.get('#comparison').innerHTML, /No matching test files/);
    vm.runInContext("detail.history[1].results[0].file='smoke/gui.test.ts';reportFiles=[];updateLive()", context);
    assert.match(nodes.get('#history').innerHTML, /HTML report unavailable/);
    assert.doesNotMatch(nodes.get('#history').innerHTML, /View report/);
    vm.runInContext("detail.history[1].environment='other';renderComparison()", context);
    assert.match(nodes.get('#comparison').innerHTML, /different environments/);
    vm.runInContext('detail.history=detail.history.slice(0,1);renderComparison();updateLive()', context);
    assert.equal(compare.disabled, true);
    console.log('PASS: tab selection, scope inheritance, preserved environment, library report links/fallback and latest-run comparison');
}

if (require.main === module) {
    const result = (p95, rate, nested) => ({ file: 'smoke/gui.test.ts', code: 0, summary: { metrics: {
        http_req_duration: nested ? { values: { 'p(95)': p95, avg: 10 } } : { 'p(95)': p95, avg: 10 },
        http_req_failed: nested ? { values: { rate } } : { rate },
    } } });
    const history = [
        { id: 'run-2', status: 'passed', environment: 'staging', startedAt: '2026-01-02', results: [result(150, 0.02, false)] },
        { id: 'run-1', status: 'passed', environment: 'staging', startedAt: '2026-01-01', results: [result(100, 0.01, true)] },
    ];
    const files = history.flatMap(r => ['latest-k6-report.html', 'dashboard-report.html'].map(f => r.id + '/smoke/gui/' + f));
    checkPage(page, history, files).catch(e => { console.error(e); process.exitCode = 1; });
}
module.exports = { checkPage };
