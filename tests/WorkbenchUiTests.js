'use strict';
// Real mouse/keyboard and xterm, isolated browser profile and mock clipboard/host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), ui = path.join(root, 'ui');
const results = path.join(root, '.test-work', 'workbench-ui');
async function main() {
  fs.mkdirSync(results, { recursive: true });
  const server = http.createServer((req, res) => {
    const file = path.resolve(ui, '.' + new URL(req.url, 'http://localhost').pathname.replace(/^\/$/, '/index.html'));
    if (!file.startsWith(ui + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (error, bytes) => { if (error) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' })[path.extname(file)] || 'application/octet-stream'); res.end(bytes); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page, count = 0; const errors = [];
  const pass = name => { count++; console.log('PASS ' + name); };
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(7000); page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      const f = window.fixture = { messages: [], terminals: [], clipboard: '222', reads: 0, writes: [], failWrite: false, deferRead: false };
      window.chrome = window.chrome || {};
      window.chrome.webview = { postMessage: m => f.messages.push(m), addEventListener: (type, fn) => { if (type === 'message') f.emit = data => fn({ data }); } };
      Object.defineProperty(navigator, 'clipboard', { value: {
        writeText: async value => { if (f.failWrite) throw Error('blocked'); f.writes.push(value); f.clipboard = value; },
        readText: () => { f.reads++; return f.deferRead ? new Promise(resolve => { f.resolveRead = resolve; }) : Promise.resolve(f.clipboard); }
      } });
      let Type; Object.defineProperty(window, 'Terminal', { get: () => Type, set: Base => { Type = class extends Base { constructor(...args) { super(...args); f.terminals.push(this); } }; } });
      document.addEventListener('copy', e => e.preventDefault(), true);
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.fixture.messages.some(m => m.type === 'ready'));
    await page.evaluate(() => { const f = window.fixture; f.terminals = []; f.emit({ type: 'init', version: '3.5.0-test', config: {
      activeWorkspaceId: 'network', workspaces: [{ id: 'network', name: '網路測試', rows: 2, cols: 2, slots: [
        { activeTabId: 'server', tabs: [{ id: 'server', name: 'iperf · Server', shell: 'CMD', cwd: 'C:\\NetworkTests' }, { id: 'server-log', name: '測試紀錄', shell: 'CMD' }] },
        { activeTabId: 'client', tabs: [{ id: 'client', name: 'iperf · Client', shell: 'CMD', cwd: 'C:\\NetworkTests' }] },
        { activeTabId: 'ping', tabs: [{ id: 'ping', name: 'IPv6 · Ping', shell: 'PowerShell' }] },
        { activeTabId: 'route', tabs: [{ id: 'route', name: '路由與介面', shell: 'CMD' }] }
      ] }, { id: 'devices', name: 'ADB / scrcpy', rows: 2, cols: 2 }] } }); });
    const source = { workspaceId: 'network', slot: 0, tabId: 'server', generation: 1 };
    const emit = message => page.evaluate(m => window.fixture.emit(m), { ...source, ...message });
    await emit({ type: 'started', pid: 1201 });
    assert.equal(await page.locator('.terminal-grid:visible').count(), 1);
    await page.locator('.workspace-tab[data-workspace-id="devices"]').click();
    assert.equal(await page.locator('.terminal-grid:visible').count(), 1);
    assert.equal(await page.locator('.terminal-grid:visible').getAttribute('data-workspace-id'), 'devices');
    await page.locator('.workspace-tab[data-workspace-id="network"]').click();
    assert.equal(await page.locator('.terminal-grid:visible .pane:visible').count(), 4);
    pass('loading and switching multiple workspaces shows only the selected workspace and its grid size');
    const pane = page.locator('[data-workspace-id="network"] .pane').first();
    const mount = pane.locator('.terminal-mount').first(), raw = pane.locator('.xterm-helper-textarea').first();
    const menu = page.locator('#terminalContextMenu');
    async function paint() {
      await emit({ type: 'output', data: Buffer.from('\x1b[2J\x1b[HC:\\NetworkTests>000111000').toString('base64') });
      await page.waitForTimeout(150);
    }
    async function reset(clipboard = 'PASTE') { await page.evaluate(v => { const f = window.fixture; f.messages = []; f.reads = 0; f.writes = []; f.clipboard = v; }, clipboard); }
    async function inputs() { await page.waitForTimeout(100); return page.evaluate(() => window.fixture.messages.filter(m => m.type === 'input')); }
    async function select() {
      const box = await page.evaluate(() => {
        const t = window.fixture.terminals[0], b = t.element.querySelector('.xterm-screen').getBoundingClientRect();
        const start = t.buffer.active.getLine(0).translateToString(true).indexOf('111');
        return { x: b.x + (start + .1) * b.width / t.cols, end: b.x + (start + 3.1) * b.width / t.cols, y: b.y + .5 * b.height / t.rows };
      });
      await page.mouse.move(box.x, box.y); await page.mouse.down(); await page.mouse.move(box.end, box.y, { steps: 6 }); await page.mouse.up();
      assert.equal(await page.evaluate(() => window.fixture.terminals[0].getSelection()), '111');
    }
    const right = () => mount.click({ button: 'right', position: { x: 80, y: 70 } });
    await raw.focus(); await page.locator('#commandButton').click();
    await reset(); await page.locator('#deviceFiles-commands').click();
    assert.deepEqual(await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'deviceFilesOpen')), [{ type: 'deviceFilesOpen' }]);
    assert.deepEqual(await inputs(), []);
    pass('device file editor opens through native host without injecting a terminal command');
    assert.equal(await page.locator('#commandPackSelect option').count(), await page.evaluate(() => window.TerminalGridDefaults.packs.length + 1));
    assert.equal(await page.locator('#renamePackButton').isDisabled(), true);
    await page.locator('#commandList .command-item').filter({ hasText: '安裝 APK（選檔）' }).getByRole('button', { name: '插入', exact: true }).click();
    await page.locator('#pathCommandDialog').waitFor({ state: 'visible' });
    await page.locator('[data-path-key="SERIAL"]').fill('TEST123');
    await page.locator('#pathCommandFields').getByRole('button', { name: '選檔案…' }).click();
    const request = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'pickCommandPath').at(-1));
    assert.equal(request.kind, 'apk');
    await emit({ type: 'commandPathPicked', requestId: request.requestId, path: 'C:\\測試 apps\\demo.apk' });
    await reset(); await page.locator('#pathCommandForm button[type="submit"]').click();
    assert.deepEqual((await inputs()).map(m => m.data), ['adb -s "TEST123" install "C:\\測試 apps\\demo.apk"']);
    pass('default categories load with existing user packs; APK picker inserts quoted path without Enter');
    await page.locator('#commandList .command-item').filter({ hasText: 'Push 檔案／資料夾' }).getByRole('button', { name: '插入', exact: true }).click();
    assert.equal(await page.locator('#pathCommandFields').getByRole('button', { name: '選資料夾…' }).count(), 1);
    await reset(); await page.locator('#pathCommandDialog [data-close]').first().click();
    assert.deepEqual(await inputs(), []);
    await page.locator('#duplicatePackButton').click();
    assert.equal(await page.locator('#renamePackButton').isEnabled(), true);
    assert.equal(await page.locator('#commandPackSelect option').count(), await page.evaluate(() => window.TerminalGridDefaults.packs.length + 2));
    await page.locator('#commandDialog [data-close]').first().click();
    pass('push supports file or folder selection; cancellation sends nothing; built-in copy remains editable');
    await page.locator('#commandButton').click();
    await page.locator('#commandPackSelect').selectOption('@default-adb-basic');
    await page.locator('#commandList .command-item').filter({ hasText: 'Pull 檔案／資料夾' }).getByRole('button', { name: '插入', exact: true }).click();
    await page.locator('#pathCommandFields').getByRole('button', { name: '選資料夾…' }).click();
    const folderRequest = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'pickCommandPath').at(-1));
    assert.equal(folderRequest.kind, 'folder');
    await emit({ type: 'commandPathPicked', requestId: folderRequest.requestId, path: 'C:\\SQA output' });
    await page.locator('[data-path-key="SERIAL"]').fill('TEST123');
    source.generation++; await emit({ type: 'started', pid: 1202 });
    await reset(); await page.locator('#pathCommandForm button[type="submit"]').click();
    assert.deepEqual(await inputs(), []);
    assert.match(await page.locator('#toast').innerText(), /目標終端已變更/);
    await page.locator('#pathCommandDialog [data-close]').first().click();
    await page.locator('#commandDialog [data-close]').first().click();
    pass('pull selects a destination folder; restart while editing prevents template insertion');
    await page.locator('#commandButton').click(); await page.locator('#commandPackSelect').selectOption('@default-scrcpy-basic');
    await page.locator('#commandList .command-item').filter({ hasText: '限制 FPS' }).getByRole('button', { name: '插入', exact: true }).click();
    const discovery = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'discoverCommandTargets').at(-1));
    await emit({ type: 'commandTargets', requestId: 'OLD', candidates: [{ kind: 'device', value: 'WRONG', label: 'OLD device' }] });
    assert.equal(await page.locator('select[data-target-key="SERIAL"] option').count(), 1);
    await emit({ type: 'commandTargets', requestId: discovery.requestId, candidates: [{ kind: 'device', value: 'USB123', label: 'USB123 · Phone A' }, { kind: 'local', value: '10.0.0.5', label: '本機 Wi-Fi' }] });
    await page.locator('select[data-target-key="SERIAL"]').selectOption('USB123');
    await reset(); await page.locator('#pathCommandForm button[type="submit"]').click();
    assert.deepEqual((await inputs()).map(m => m.data), ['scrcpy -s "USB123" --max-fps=30']);
    await page.locator('#commandPackSelect').selectOption('@default-iperf3-advanced');
    await page.locator('#commandList .command-item').filter({ hasText: '綁定本機 IP' }).getByRole('button', { name: '插入', exact: true }).click();
    const ipDiscovery = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'discoverCommandTargets').at(-1));
    await emit({ type: 'commandTargets', requestId: ipDiscovery.requestId, candidates: [{ kind: 'remote', value: '10.0.0.20', label: 'ADB 網路裝置' }, { kind: 'local', value: '10.0.0.5', label: '本機 Wi-Fi' }] });
    assert.equal(await page.locator('select[data-target-key="LOCAL_IPV4"] option').count(), 2);
    await page.locator('select[data-target-key="TARGET_IPV4"]').selectOption('10.0.0.20');
    await page.locator('[data-path-key="TARGET_IPV4"]').fill('192.0.2.10');
    await page.locator('select[data-target-key="LOCAL_IPV4"]').selectOption('10.0.0.5');
    await reset(); await page.locator('#pathCommandForm button[type="submit"]').click();
    assert.deepEqual((await inputs()).map(m => m.data), ['iperf3 -c "192.0.2.10" -B "10.0.0.5" -t 30']);
    await page.locator('#commandDialog [data-close]').first().click();
    pass('device and local/remote IP choices resolve once; stale detection replies cannot replace current options');
    await page.locator('#flowButton').click(); await page.locator('#newFlowButton').click();
    await page.locator('#addFlowStepButton').click();
    await page.locator('#flowSteps .flow-step-text').first().fill('scrcpy -s DEVICE_SERIAL --max-fps=30');
    await page.locator('#flowSteps .flow-step-text').first().dispatchEvent('change');
    await reset(); await page.locator('#runFlowButton').click();
    await page.locator('[data-path-key="SERIAL"]').fill('FLOW_DEVICE');
    await page.locator('#pathCommandForm button[type="submit"]').click();
    await page.locator('#confirmDialog').waitFor({ state: 'visible' });
    assert.match(await page.locator('#confirmMessage').innerText(), /scrcpy -s "FLOW_DEVICE" --max-fps=30/);
    assert.deepEqual(await inputs(), []);
    await page.locator('#confirmCancel').click();
    assert.match(await page.locator('#flowSteps .flow-step-text').first().inputValue(), /DEVICE_SERIAL/);
    await page.locator('#runFlowButton').click(); await page.locator('[data-path-key="SERIAL"]').fill('FLOW_DEVICE2');
    await page.locator('#pathCommandForm button[type="submit"]').click(); await reset(); await page.locator('#confirmAccept').click();
    await page.waitForFunction(() => window.fixture.messages.some(m => m.type === 'input'));
    assert.deepEqual((await inputs()).map(m => m.data), ['scrcpy -s "FLOW_DEVICE2" --max-fps=30\r']);
    await page.locator('#flowDialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.fixture.messages.some(m => m.type === 'runSave' && m.text.includes('結果 流程完成')));
    pass('automation resolves parameters before execution preview; cancel sends nothing and preserves saved template');
    await page.locator('#appOptions summary').click(); await page.locator('#showLineEditors').uncheck();
    assert.equal(await pane.locator('.pane-line-editor:visible').count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('terminalGrid.showLineEditors')), 'false');
    await page.locator('#showLineEditors').check(); await page.locator('#workspaceTabs').click();
    assert.equal(await pane.locator('.pane-line-editor:visible').count(), 1);
    pass('input row can be hidden and restored without removing its field or terminal');
    await paint(); await select(); await reset(); await right();
    assert.deepEqual(await page.evaluate(() => window.fixture.writes), ['111']);
    assert.equal(await page.evaluate(() => window.fixture.terminals[0].hasSelection()), false);
    assert.deepEqual(await inputs(), []); assert.equal(await menu.isVisible(), false);
    pass('right click copies selected terminal text exactly once and clears selection without executing');
    await reset('222'); await right();
    let sent = await inputs(); assert.deepEqual(sent.map(m => m.data), ['222']); assert.equal(sent[0].tabId, 'server');
    assert.equal(await page.evaluate(() => window.fixture.reads), 1);
    assert.equal(await menu.isVisible(), false);
    pass('right click without selection pastes once to the clicked terminal with no Enter');

    await paint(); await select(); await reset(); await raw.click({ button: 'right', modifiers: ['Shift'], force: true });
    assert.equal(await menu.isVisible(), true); assert.deepEqual(await inputs(), []);
    assert.equal(await page.evaluate(() => window.fixture.terminals[0].getSelection()), '111');
    assert.equal(await page.evaluate(() => window.fixture.reads), 0);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '原位替換選取文字…');
    await page.keyboard.press('Escape'); assert.equal(await menu.isVisible(), false);
    pass('Shift-right-click preserves selection and exposes keyboard-navigable replacement menu');

    await pane.locator('[data-action="menu"]').click();
    assert.equal(await menu.isVisible(), true); assert.equal(await menu.getByRole('button', { name: '終端設定…', exact: true }).isVisible(), true);
    await page.keyboard.press('Escape'); await raw.focus(); await page.keyboard.press('Shift+F10');
    assert.equal(await menu.isVisible(), true); assert.deepEqual(await inputs(), []);
    await page.keyboard.press('Escape');
    pass('per-pane ellipsis and Shift-F10 open full menu without clipboard side effects');

    await page.locator('#appOptions summary').click(); await page.locator('#rightClickMode').selectOption('menu');
    await page.locator('#workspaceTabs').click(); await reset(); await right();
    assert.equal(await menu.isVisible(), true); assert.deepEqual(await inputs(), []);
    assert.equal(await page.evaluate(() => localStorage.getItem('terminalGrid.rightClickMode')), 'menu');
    await page.keyboard.press('Escape');
    pass('menu mode restores original right-click behavior and saves the local preference');
    await page.locator('#appOptions summary').click(); await page.locator('#rightClickMode').selectOption('quick');
    await page.locator('#workspaceTabs').click();

    await paint(); await select(); await reset(); await page.evaluate(() => { window.fixture.deferRead = true; });
    await raw.focus(); await page.keyboard.press('Control+v');
    await page.waitForFunction(() => typeof window.fixture.resolveRead === 'function');
    await right(); // copy cancels the earlier selected replacement
    await page.evaluate(() => { window.fixture.deferRead = false; window.fixture.resolveRead('OLD'); });
    assert.deepEqual(await inputs(), []); assert.deepEqual(await page.evaluate(() => window.fixture.writes), ['111']);
    pass('quick copy cancels a previously pending selected clipboard replacement');

    await paint(); await select(); await reset(); await page.evaluate(() => { window.fixture.failWrite = true; }); await right();
    assert.deepEqual(await inputs(), []); assert.deepEqual(await page.evaluate(() => window.fixture.writes), []);
    assert.match(await page.locator('#toast').innerText(), /無法使用剪貼簿/);
    await page.evaluate(() => { window.fixture.failWrite = false; });
    pass('failed clipboard copy reports failure and never sends terminal input');

    await reset('echo one\necho two'); await right();
    await page.locator('#confirmDialog').waitFor({ state: 'visible' });
    assert.deepEqual(await inputs(), []); await page.locator('#confirmCancel').click(); assert.deepEqual(await inputs(), []);
    pass('right-click multiline paste keeps the existing preview and cancellation');

    await reset('LATE'); await page.evaluate(() => { window.fixture.deferRead = true; }); await right();
    source.generation++; await emit({ type: 'started', pid: 1202 });
    await page.evaluate(() => { window.fixture.deferRead = false; window.fixture.resolveRead('LATE'); });
    assert.deepEqual(await inputs(), []);
    pass('a delayed right-click paste cannot enter a restarted shell');

    await paint(); await reset();
    await page.locator('#toast').waitFor({ state: 'hidden' });
    // Representative demo output for visual QA; no external commands run.
    await emit({ type: 'output', data: Buffer.from('\x1b[2J\x1b[HC:\\NetworkTests>iperf3 -s\r\n\r\n-----------------------------------------------------------\r\nServer listening on 5201\r\n-----------------------------------------------------------\r\n\x1b[32mWaiting for a client connection...\x1b[0m').toString('base64') });
    await emit({ type: 'started', slot: 1, tabId: 'client', pid: 1203, generation: 1 });
    await emit({ type: 'output', slot: 1, tabId: 'client', generation: 1, data: Buffer.from('C:\\NetworkTests>iperf3 -c 192.0.2.10 -t 30\r\n\r\n[ ID] Interval       Transfer     Bitrate\r\n[  5]  0.00-1.00 s   112 MBytes   940 Mbits/sec\r\n[  5]  1.00-2.00 s   113 MBytes   948 Mbits/sec\r\n[  5]  2.00-3.00 s   112 MBytes   941 Mbits/sec').toString('base64') });
    await emit({ type: 'started', slot: 2, tabId: 'ping', pid: 1204, generation: 1 });
    await emit({ type: 'output', slot: 2, tabId: 'ping', generation: 1, data: Buffer.from('PS C:\\NetworkTests> ping 2001:db8::1\r\n\r\nReply from 2001:db8::1: time=2ms\r\nReply from 2001:db8::1: time=3ms\r\nReply from 2001:db8::1: time=2ms').toString('base64') });
    await page.waitForTimeout(150);
    await emit({ type: 'status', message: '介面示意 · 範例終端輸出' });
    await page.screenshot({ path: path.join(results, 'workbench-1440.png') });
    await page.locator('#captureButton').click();
    await page.locator('#captureValueInput').fill('fe80::1234:abcd%12'); await page.locator('#addCaptureValueButton').click();
    await page.setViewportSize({ width: 900, height: 680 }); await page.waitForTimeout(250);
    const visibleControls = ['#appOptions summary', '#saveButton', '#startAllButton', '#capturePanel', '#closeCaptureButton'];
    for (const selector of visibleControls) {
      const b = await page.locator(selector).boundingBox();
      assert.ok(b && b.x >= 0 && b.y >= 0 && b.x + b.width <= 901 && b.y + b.height <= 681, selector + ' remains inside viewport');
    }
    await page.locator('#appOptions summary').click();
    assert.equal(await page.locator('#importButton').isVisible(), true); assert.equal(await page.locator('#helpButton').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(results, 'workbench-900-shelf.png') });
    pass('900px layout keeps tools, shelf and configuration options accessible');
    await page.locator('#closeCaptureButton').click();
    await page.locator('#rowSelect').selectOption('4'); await page.locator('#colSelect').selectOption('4');
    await page.waitForTimeout(250);
    const dimensions = await page.locator('[data-workspace-id="network"] .pane .terminal-layer:not([hidden]) .terminal-mount').evaluateAll(elements => elements.filter(e => e.getBoundingClientRect().width > 0).map(e => ({ w: e.clientWidth, h: e.clientHeight })));
    assert.equal(dimensions.length, 16); assert.ok(dimensions.every(b => b.w > 100 && b.h >= 15), JSON.stringify(dimensions));
    const idlePane = page.locator('[data-workspace-id="network"] .pane').nth(3);
    const startBox = await idlePane.locator('.empty-start').boundingBox();
    const inputBox = await idlePane.locator('.pane-line-editor').boundingBox();
    assert.ok(startBox.y + startBox.height <= inputBox.y, 'compact start control does not overlap the input editor');
    await idlePane.locator('.empty-start').click();
    assert.ok(await page.evaluate(() => window.fixture.messages.some(m => m.type === 'start' && m.slot === 3 && m.tabId === 'route')));
    await pane.locator('[data-action="menu"]').click();
    assert.equal(await menu.getByRole('button', { name: '選擇啟動資料夾…', exact: true }).isVisible(), true);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(results, 'workbench-900-16panes.png') });
    pass('sixteen-pane compact layout retains terminal area and access to folder/settings actions');
    await page.locator('#appOptions summary').click(); await page.locator('#rightClickMode').selectOption('menu');
    await page.locator('#showLineEditors').uncheck();
    await page.reload(); await page.waitForFunction(() => window.fixture.messages.some(m => m.type === 'ready'));
    assert.equal(await page.locator('#rightClickMode').inputValue(), 'menu');
    assert.equal(await page.locator('#showLineEditors').isChecked(), false);
    pass('right-click preference survives app page reload');
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(() => window.fixture.emit({ type: 'init', config: null }));
    await page.locator('#flowButton').click(); await page.locator('#nanWorkflowButton').click();
    let nanRequest = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'discoverCommandTargets').pop());
    assert.ok(nanRequest, 'discovery works before focusing a terminal');
    assert.equal(nanRequest.android, undefined, 'discovery must not query interfaces before DUT selection');
    await emit({ type: 'commandTargets', requestId: nanRequest.requestId, candidates: [], message: '找不到 adb.exe' });
    assert.match(await page.locator('#nanStatus').textContent(), /選資料夾/);
    await page.locator('#nanDiscover').click();
    nanRequest = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'discoverCommandTargets').pop());
    await emit({ type: 'commandTargets', requestId: nanRequest.requestId, candidates: [{ kind: 'device', value: 'DUT_ONE', label: 'Samsung 1' }, { kind: 'device', value: 'DUT_TWO', label: 'Samsung 2' }] });
    assert.equal(await page.locator('#nanDevices option').count(), 2);
    await page.locator('#nanDut1').fill('DUT_ONE'); await page.locator('#nanDut2').fill('DUT_ONE');
    await page.locator('#nanForm button[type="submit"]').click();
    assert.equal(await page.locator('#nanDialog').isVisible(), true);
    await page.locator('#nanDut2').fill('DUT_TWO'); await page.locator('#nanIf1').fill('aware_data1');
    await page.locator('#nanTool').selectOption('iperf3');
    await page.screenshot({ path: path.join(results, 'nan-wizard.png') });
    await page.locator('#nanForm details summary').click();
    const evidenceChecklist = '核對接收紀錄\n記下吞吐量';
    await page.locator('#nanAfterTransfer').fill(evidenceChecklist);
    await page.locator('#nanDuringTransfer').fill('觸發測試操作');
    await reset(); await page.locator('#nanForm button[type="submit"]').click();
    assert.equal(await page.locator('.terminal-grid:visible .pane:visible').count(), 6);
    assert.equal(await page.evaluate(() => window.fixture.messages.filter(m => ['start', 'input'].includes(m.type)).length), 0);
    await page.locator('#saveFlowFileButton').click();
    const nanFile = await page.evaluate(() => JSON.parse(window.fixture.messages.filter(m => m.type === 'flowSave').pop().text));
    assert.equal(nanFile.workspace.slots[5].tabs.length, 2);
    assert.match(nanFile.workspace.slots[3].tabs[0].args, /--if1 "aware_data1" --if2 "auto"/);
    assert.equal(nanFile.steps.filter(s => s.action === 'pause').length, 3);
    assert.equal(nanFile.steps.find(s => s.action === 'trafficPause').tabId, 'nan-traffic');
    assert.equal(nanFile.steps.at(-1).text, '傳輸完成後\n' + evidenceChecklist);
    assert.equal(await page.locator('#flowSteps textarea.flow-step-text').last().inputValue(), nanFile.steps.at(-1).text);
    assert.deepEqual(nanFile.steps.slice(0, 3).map(s => s.action), ['stop', 'stop', 'stop']);
    await page.evaluate(() => {
      const f = window.fixture, original = window.chrome.webview.postMessage;
      window.chrome.webview.postMessage = m => { original(m); if (m.type === 'start') setTimeout(() => f.emit({ type: 'started', workspaceId: m.workspaceId, slot: m.slot, tabId: m.tabId, generation: 1, pid: 9000 + m.slot }), 10); };
    });
    await reset(); await page.locator('#runFlowButton').click();
    assert.equal(await page.evaluate(() => window.fixture.messages.some(m => m.type === 'start')), false);
    await page.locator('#confirmAccept').click(); await page.locator('#flowPauseDialog').waitFor({ state: 'visible' });
    assert.deepEqual(await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'start').map(m => m.slot)), [0, 1]);
    await page.locator('#continuePausedFlowButton').click();
    await page.locator('.terminal-grid:visible .pane[data-slot="3"][data-status="running"]').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.fixture.messages.some(m => m.type === 'start' && m.slot === 2)), false);
    const pingRoute = await page.evaluate(() => window.fixture.messages.find(m => m.type === 'start' && m.slot === 3));
    await emit({ type: 'output', workspaceId: pingRoute.workspaceId, slot: 3, tabId: pingRoute.tabId,
      generation: 1, data: Buffer.from('64 bytes from fe80::10: icmp_seq=1\r\n').toString('base64') });
    await page.waitForFunction(() => document.getElementById('flowPauseMessage').textContent.includes('server 正常監聽'));
    assert.deepEqual(await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'start').map(m => m.slot)), [0, 1, 3, 2]);
    await page.locator('#continuePausedFlowButton').click();
    await page.waitForFunction(() => window.fixture.messages.some(m => m.type === 'start' && m.slot === 4));
    pass('NAN wizard creates exportable six-cell workflow; manual NDP/server pauses gate ping and traffic with correct DUT mapping');
    const traffic = await page.evaluate(() => window.fixture.messages.find(m => m.type === 'start' && m.slot === 4));
    async function liveSample(line) {
      await emit({ type: 'output', workspaceId: traffic.workspaceId, slot: 4, tabId: traffic.tabId, generation: 1, data: Buffer.from(line + '\r\n').toString('base64') });
    }
    await liveSample('[  5] 0.00-1.00 sec  5 MBytes  40 Mbits/sec');
    await page.getByRole('button', { name: '開始操作', exact: true }).click();
    await liveSample('[  5] 1.00-2.00 sec  1 MBytes  8 Mbits/sec');
    await page.getByRole('button', { name: '完成操作', exact: true }).click();
    await liveSample('[  5] 2.00-3.00 sec  4 MBytes  32 Mbits/sec');
    await liveSample('[  5] 0.00-3.00 sec  10 MBytes  27 Mbits/sec  receiver');
    assert.equal(await page.evaluate(() => window.fixture.messages.some(m => m.type === 'stop' && m.slot === 4)), false);
    await emit({ type: 'exited', workspaceId: traffic.workspaceId, slot: 4, tabId: traffic.tabId, generation: 1, exitCode: 0 });
    await page.waitForFunction(() => document.getElementById('flowPauseMessage').textContent.includes('傳輸完成後'));
    assert.equal(await page.locator('#flowPauseMessage').textContent(), nanFile.steps.at(-1).text);
    await page.locator('#continuePausedFlowButton').click();
    await page.waitForFunction(() => window.fixture.messages.some(m => m.type === 'runSave' && m.text.includes('結果 流程完成')));
    const liveLog = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'runSave').at(-1).text);
    assert.match(liveLog, /操作前 .*40 Mbits\/sec/);
    assert.match(liveLog, /操作中 .*8 Mbits\/sec/);
    assert.match(liveLog, /操作後 .*32 Mbits\/sec/);
    pass('the traffic checkpoint keeps iperf running and saves before/during/after samples and receiver evidence');

    await page.evaluate(() => {
      const fixture = window.fixture, original = window.chrome.webview.postMessage;
      window.chrome.webview.postMessage = message => {
        original(message);
        if (message.type === 'stop') setTimeout(() => fixture.emit({
          type: 'exited', workspaceId: message.workspaceId, slot: message.slot, tabId: message.tabId,
          generation: 1, exitCode: 0
        }), 10);
      };
    });
    async function receivedStart(tabId) {
      await page.waitForFunction(id => window.fixture.messages.some(m => m.type === 'start' && m.tabId === id), tabId);
      return page.evaluate(id => window.fixture.messages.find(m => m.type === 'start' && m.tabId === id), tabId);
    }
    async function tabOutput(start, line) {
      await emit({ type: 'output', workspaceId: start.workspaceId, slot: start.slot, tabId: start.tabId, generation: 1, data: Buffer.from(line).toString('base64') });
    }
    async function prepareTransfer(python) {
      await page.locator('#flowButton').click();
      await page.locator('#nanWorkflowButton').click();
      await page.locator('#nanTool').selectOption('choose');
      await page.locator('#nanUsePython').setChecked(python);
      if (python) {
        await page.locator('#nanPythonPath').fill('C:\\Python Tools\\python.exe');
        if (!(await page.locator('#nanBeforeTransfer').isVisible())) await page.locator('#nanForm details summary').click();
        await page.locator('#nanBeforeTransfer').fill('開啟收證');
      }
      await page.locator('#nanForm button[type="submit"]').click();
      await reset(); await page.locator('#runFlowButton').click();
      assert.match(await page.locator('#confirmMessage').innerText(), /1300000000/);
      await page.locator('#confirmAccept').click();
      await page.waitForFunction(() => document.getElementById('flowPauseMessage').textContent.includes('啟動 Wi-Fi Aware') && document.getElementById('flowPauseDialog').open);
      await page.locator('#continuePausedFlowButton').click();
      await page.waitForFunction(() => document.getElementById('flowPauseMessage').textContent.includes('依測試工具的提示建立 NDP') && document.getElementById('flowPauseDialog').open);
      await page.locator('#continuePausedFlowButton').click();
      if (python) {
        const probe = await receivedStart('nan-python-probe');
        assert.match(probe.config.args, /--python "C:\\Python Tools\\python\.exe"$/);
        await page.waitForFunction(() => document.querySelector('.terminal-grid:not([hidden]) .pane[data-slot="3"]').dataset.status === 'running');
        await tabOutput(probe, 'NAN_PING_OK\r\n');
        await emit({ type: 'exited', workspaceId: probe.workspaceId, slot: probe.slot, tabId: probe.tabId, generation: 1, exitCode: 0 });
      }
      const ping = await receivedStart('nan-ping');
      await page.waitForFunction(() => document.querySelector('.terminal-grid:not([hidden]) .pane[data-slot="3"]').dataset.status === 'running');
      await tabOutput(ping, 'PING fe80::1 \r\nwarning: no bytes from this destination\r\n');
      await page.waitForTimeout(250);
      assert.equal(await page.locator('#nanTransferDialog').isVisible(), false);
      await tabOutput(ping, '64 bytes from fe80::1: icmp_seq=1 ttl=64 time=1.3 ms\r\n');
      if (python) {
        await page.waitForFunction(() => document.getElementById('flowPauseMessage').textContent.includes('開啟收證') && document.getElementById('flowPauseDialog').open);
        assert.equal(await page.locator('#nanTransferDialog').isVisible(), false);
        await page.locator('#continuePausedFlowButton').click();
      }
      await page.locator('#nanTransferDialog').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#nanTransferAmount').innerText(), '1.3 GB（1,300,000,000 bytes）');
      assert.equal(await page.evaluate(() => window.fixture.messages.some(m => m.type === 'start' && /nan-(server|traffic)/.test(m.tabId))), false);
    }
    await prepareTransfer(true);
    await page.screenshot({ path: path.join(results, 'nan-transfer.png') });
    await page.locator('[data-nan-transfer="share"]').click();
    await page.waitForFunction(() => document.getElementById('flowPauseMessage').textContent.includes('Quick Share') && document.getElementById('flowPauseDialog').open);
    await page.locator('#continuePausedFlowButton').click();
    await page.waitForFunction(() => window.fixture.messages.some(m => m.type === 'runSave' && m.text.includes('使用者確認 Quick Share 完成') && m.text.includes('結果 流程完成')));
    assert.equal(await page.evaluate(() => window.fixture.messages.some(m => m.type === 'start' && /nan-(server|traffic)/.test(m.tabId))), false);
    pass('Python marker and real-shaped fresh Ping reply gate Quick Share, with user-confirmed completion and no iperf process');

    for (const [choice, suffix] of [['iperf', '-iperf2'], ['iperf3', '']]) {
      await prepareTransfer(false);
      await page.locator('[data-nan-transfer="' + choice + '"]').click();
      const selectedServer = await receivedStart('nan-server' + suffix);
      assert.equal(await page.evaluate(() => window.fixture.messages.some(m => m.type === 'start' && m.tabId.startsWith('nan-traffic'))), false);
      await page.waitForFunction(() => document.querySelector('.terminal-grid:not([hidden]) .pane[data-slot="2"]').dataset.status === 'running');
      await tabOutput(selectedServer, 'Server listening on port 5001\r\n');
      const selectedClient = await receivedStart('nan-traffic' + suffix);
      assert.match(selectedClient.config.args, /--amount "1300000000"/);
      assert.equal(selectedClient.slot, 4);
      await page.waitForFunction(() => document.querySelector('.terminal-grid:not([hidden]) .pane[data-slot="4"]').dataset.status === 'running');
      await emit({ type: 'exited', workspaceId: selectedClient.workspaceId, slot: selectedClient.slot, tabId: selectedClient.tabId, generation: 1, exitCode: 0 });
      await page.waitForFunction(id => window.fixture.messages.some(m => m.type === 'stop' && m.tabId === id), selectedServer.tabId);
      await page.waitForFunction(() => window.fixture.messages.some(m => m.type === 'runSave' && m.text.includes('結果 流程完成')));
    }
    pass('both iperf selections wait for the matching receiver and send exactly 1300000000 as the byte target');

    const config = { workspaces: [{ id: 'conditions', name: 'Conditions', rows: 1, cols: 1,
      slots: [{ tabs: [{ id: 'check', name: 'Check', shell: 'CMD' }] }] }],
      automations: [{ id: 'condition', workspaceId: 'conditions', name: 'Output check', steps: [
        { action: 'start', slot: 0, tabId: 'check', delayMs: 100 },
        { action: 'send', slot: 0, tabId: 'check', text: 'echo probe', delayMs: 100 },
        { action: 'output', slot: 0, tabId: 'check', text: 'NAN started', failureText: 'NDP lost', timeoutMs: 300, retries: 1 },
        { action: 'send', slot: 0, tabId: 'check', text: 'echo reached' }
      ] }] };
    await emit({ type: 'init', config });
    await reset(); await page.locator('#flowButton').click();
    await page.locator('#runFlowButton').click(); await page.locator('#confirmAccept').click();
    await page.waitForFunction(() => window.fixture.messages.some(m => m.type === 'input' && m.data === 'echo probe\r'));
    await emit({ type: 'output', workspaceId: 'conditions', slot: 0, tabId: 'check', generation: 1, data: Buffer.from('NDP lost\r\n').toString('base64') });
    await page.waitForFunction(() => window.fixture.messages.some(m => m.type === 'runSave' && m.text.includes('結果 第 3 步') && m.text.includes('NDP lost')));
    assert.deepEqual((await inputs()).map(m => m.data), ['echo probe\r']);
    await page.locator('#flowButton').click();
    assert.equal(await page.locator('.flow-failed').getAttribute('data-step'), '3');
    pass('failure condition persists a run log, identifies step three and prevents later input');
    await page.locator('#flowDialog [data-close]').first().click();
    await page.locator('#appOptions summary').click(); await page.locator('#adbLogsButton').click();
    await reset();
    await page.locator('#commandList .command-item').filter({ hasText: 'Pull /data/debuglogger/' }).getByRole('button', { name: '插入', exact: true }).click();
    const logDiscovery = await page.evaluate(() => window.fixture.messages.find(m => m.type === 'discoverCommandTargets'));
    const devices = [{ kind: 'device', value: 'USB1', label: 'USB1 · DUT1' }, { kind: 'device', value: 'USB2', label: 'USB2 · DUT2' }];
    await emit({ type: 'commandTargets', requestId: logDiscovery.requestId, candidates: devices, adbPath: 'C:\\Tools Folder\\adb.exe' });
    await page.locator('select[data-target-key="SERIAL"]').selectOption('USB2');
    assert.equal(await page.locator('select[data-target-key="SERIAL"]').inputValue(), 'USB2');
    const phonePath = page.getByRole('textbox', { name: '手機來源路徑' });
    assert.equal(await phonePath.inputValue(), '/data/debuglogger/');
    await page.getByRole('button', { name: '瀏覽手機…', exact: true }).click();
    const browseRequest = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'browseAndroidPath').at(-1));
    assert.equal(browseRequest.serial, 'USB2');
    assert.equal(browseRequest.path, '/data/debuglogger');
    await emit({ type: 'androidPathResult', requestId: browseRequest.requestId, entries: [{ name: 'Run 3', directory: true }] });
    await page.locator('#androidBrowseEntries').selectOption('0');
    await page.locator('#androidBrowseEnter').click();
    const childBrowse = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'browseAndroidPath').at(-1));
    assert.equal(childBrowse.path, '/data/debuglogger/Run 3');
    await emit({ type: 'androidPathResult', requestId: browseRequest.requestId, entries: [{ name: 'Stale.log', directory: false }] });
    await emit({ type: 'androidPathResult', requestId: childBrowse.requestId, entries: [{ name: '測試 1.log', directory: false }] });
    assert.equal(await page.locator('#androidBrowseEntries option').count(), 1);
    await page.locator('#androidBrowseEntries').selectOption('0');
    await page.locator('#androidBrowseUse').click();
    assert.equal(await phonePath.inputValue(), '/data/debuglogger/Run 3/測試 1.log');
    await page.getByRole('textbox', { name: '本機目的路徑' }).fill('C:\\My Logs');
    assert.match(await page.locator('#pullCommandPreview').innerText(), /USB2[\s\S]*\/data\/debuglogger\/Run 3\/測試 1.log[\s\S]*C:\\My Logs/);
    await page.locator('#pathCommandForm button[type="submit"]').click();
    assert.deepEqual((await inputs()).map(m => m.data), ['"C:\\Tools Folder\\adb.exe" -s "USB2" pull "/data/debuglogger/Run 3/測試 1.log" "C:\\My Logs"']);
    assert.equal(await page.locator('#commandDialog').isVisible(), false);
    pass('ADB Pull browses DUT2, ignores stale directory replies, and pastes the selected remote and local paths without Enter');

    await emit({ type: 'output', workspaceId: 'conditions', slot: 0, tabId: 'check', generation: 1, data: Buffer.from('KEEP THIS LOG\r\n').toString('base64') });
    await page.locator('#captureButton').click();
    await page.locator('#captureEnabled').uncheck();
    await page.locator('#captureEnabled').check();
    await page.locator('#closeCaptureButton').click();
    await page.locator('.terminal-grid:visible .pane-menu:visible').first().click();
    await page.getByRole('button', { name: '檢視／匯出終端 Log…', exact: true }).click();
    assert.match(await page.locator('#terminalLogText').inputValue(), /KEEP THIS LOG/);
    await page.locator('#terminalLogDialog [data-close]').first().click();
    pass('changing IPv6 capture leaves the terminal transcript available');

    await reset(); await page.locator('#appOptions summary').click(); await page.locator('#androidAppsButton').click();
    const appDiscovery = await page.evaluate(() => window.fixture.messages.find(m => m.type === 'discoverCommandTargets'));
    await emit({ type: 'commandTargets', requestId: appDiscovery.requestId, candidates: devices, adbPath: 'C:\\Tools Folder\\adb.exe' });
    await page.locator('#androidDevice').selectOption('USB2');
    const appRequest = await page.evaluate(() => window.fixture.messages.find(m => m.type === 'androidApps'));
    assert.equal(appRequest.serial, 'USB2');
    await emit({ type: 'androidActionResult', requestId: appRequest.requestId, components: ['com.android.settings/.Settings', 'com.android.chrome/.Main'] });
    await page.locator('#openAndroidMirror').click();
    const mirrorRequest = await page.evaluate(() => window.fixture.messages.find(m => m.type === 'androidMirror'));
    assert.equal(mirrorRequest.serial, 'USB2');
    await emit({ type: 'androidActionResult', requestId: mirrorRequest.requestId });
    assert.match(await page.locator('#androidAppsStatus').innerText(), /已啟動 scrcpy/);
    await page.locator('#wakeAndroidScreen').click();
    const wakeRequest = await page.evaluate(() => window.fixture.messages.find(m => m.type === 'androidWake'));
    assert.equal(wakeRequest.serial, 'USB2');
    await emit({ type: 'androidActionResult', requestId: wakeRequest.requestId });
    assert.match(await page.locator('#androidAppsStatus').innerText(), /已送出喚醒指令/);
    await page.locator('#androidAppSearch').fill('settings');
    assert.equal(await page.locator('#androidApp option').count(), 1);
    await page.locator('#androidApp').selectOption('com.android.settings/.Settings');
    await page.locator('#launchAndroidApp').click();
    const launch = await page.evaluate(() => window.fixture.messages.find(m => m.type === 'androidLaunch'));
    assert.equal(launch.serial, 'USB2'); assert.equal(launch.component, 'com.android.settings/.Settings');
    await emit({ type: 'androidActionResult', requestId: launch.requestId });
    await page.locator('#androidSysdump').click();
    const sysdump = await page.evaluate(() => window.fixture.messages.find(m => m.type === 'androidLaunch' && m.sysdump));
    assert.equal(sysdump.serial, 'USB2');
    await emit({ type: 'androidActionResult', requestId: sysdump.requestId });
    assert.match(await page.locator('#androidAppsStatus').innerText(), /手動鍵入 \*#9900#/);
    pass('App filtering, component launch and SysDump dialer action stay on the selected device');
    await page.locator('#androidBatchPanel summary').click();
    await page.locator('#androidBatchDevices input[value=USB1]').check();
    await page.locator('#androidBatchDevices input[value=USB2]').check();
    await reset();
    await page.locator('#openAndroidBatch').click();
    const firstBatch = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'androidMirror'));
    assert.deepEqual(firstBatch.map(m => m.serial), ['USB1']);
    await emit({ type: 'androidActionResult', requestId: firstBatch[0].requestId, error: 'Fixture unavailable' });
    const secondBatch = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'androidMirror').at(-1));
    assert.equal(secondBatch.serial, 'USB2');
    await emit({ type: 'androidActionResult', requestId: secondBatch.requestId, alreadyOpen: true });
    assert.match(await page.locator('#androidBatchStatus').innerText(), /1 台已有鏡像視窗.*USB1/);
    await page.locator('#androidBatchDevices input[value=USB1]').uncheck();
    await page.locator('#wakeAndroidBatch').click();
    const batchWake = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'androidWake').at(-1));
    assert.equal(batchWake.serial, 'USB2');
    await emit({ type: 'androidActionResult', requestId: batchWake.requestId });
    assert.match(await page.locator('#androidBatchStatus').innerText(), /1 台完成/);
    pass('batch device controls target checked phones, continue after per-device failure and report existing mirrors');
    await page.locator('#androidAppsDialog [data-close]').first().click();
    async function openLogPull(name) {
      await page.locator('#appOptions summary').click();
      await page.locator('#adbLogsButton').click();
      await page.locator('#commandList .command-item').filter({ hasText: name }).getByRole('button', { name: '插入', exact: true }).click();
    }
    async function cancelLogPull() {
      await page.locator('#pathCommandDialog [data-close]').first().click();
      await page.locator('#commandDialog [data-close]').first().click();
    }
    const localPath = page.getByRole('textbox', { name: '本機目的路徑' });
    await openLogPull('Pull /data/debuglogger/');
    assert.equal(await localPath.inputValue(), 'C:\\My Logs');
    await localPath.fill('C:\\Cancelled');
    await cancelLogPull();
    await openLogPull('Pull /sdcard/log');
    assert.equal(await localPath.inputValue(), '');
    await page.locator('[data-path-key="SERIAL"]').fill('USB1');
    await localPath.fill('D:\\Samsung Logs');
    await page.locator('#pathCommandForm button[type="submit"]').click();
    await openLogPull('Pull /data/debuglogger/');
    assert.equal(await localPath.inputValue(), 'C:\\My Logs');
    await phonePath.fill('/sdcard/log/session');
    assert.equal(await localPath.inputValue(), 'D:\\Samsung Logs');
    await localPath.fill('E:\\Manual');
    await phonePath.fill('/data/debuglogger');
    assert.equal(await localPath.inputValue(), 'E:\\Manual');
    await phonePath.fill('/sdcard/another');
    await page.locator('[data-path-key="SERIAL"]').fill('USB1');
    await page.locator('#pathCommandForm button[type="submit"]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('terminalGrid.pullDestination.data/debuglogger')), 'C:\\My Logs');
    assert.equal(await page.evaluate(() => localStorage.getItem('terminalGrid.pullDestination.sdcard/log')), 'D:\\Samsung Logs');
    await page.reload();
    await page.waitForFunction(() => window.fixture.messages.some(m => m.type === 'ready'));
    await emit({ type: 'init', config });
    await emit({ type: 'started', workspaceId: 'conditions', slot: 0, tabId: 'check', generation: 1, pid: 1400 });
    await page.locator('.terminal-grid:visible .terminal-mount:visible').first().click();
    await openLogPull('Pull /data/debuglogger/');
    assert.equal(await localPath.inputValue(), 'C:\\My Logs');
    await cancelLogPull();
    await openLogPull('Pull /sdcard/log');
    assert.equal(await localPath.inputValue(), 'D:\\Samsung Logs');
    await page.locator('[data-path-key="SERIAL"]').fill('USB2');
    await localPath.fill('C:\\Restarted');
    await emit({ type: 'started', workspaceId: 'conditions', slot: 0, tabId: 'check', generation: 2, pid: 1401 });
    await reset(); await page.locator('#pathCommandForm button[type="submit"]').click();
    assert.deepEqual(await inputs(), []);
    assert.equal(await page.evaluate(() => localStorage.getItem('terminalGrid.pullDestination.sdcard/log')), 'D:\\Samsung Logs');
    await cancelLogPull();
    pass('Pull destinations persist separately across reload, respect source changes, and reject cancelled or stale updates');
    await reset();
    await page.locator('#flowButton').click();
    await page.locator('#testCaseButton').click();
    await page.locator('#newTestCase').click();
    await page.locator('#testCaseCode').fill('DEMO-01');
    await page.locator('#testCaseName').fill('雙機檢查');
    await page.locator('#testCaseNotes').fill('步驟一\n核對接收紀錄');
    await page.locator('#testCaseFeasibility').selectOption('assisted');
    await page.locator('#testCaseFlow').selectOption({ index: 1 });
    await page.locator('#testCaseUsb').fill('2');
    await page.locator('#testCaseSerials').fill('USB1, USB2');
    await page.locator('#testCaseForm button[type="submit"]').click();
    await page.waitForFunction(() => window.fixture.messages.some(m => m.type === 'save' && m.config.testCases[0]?.code === 'DEMO-01'));
    await page.locator('#testCaseFilter').fill('demo-01');
    assert.equal(await page.locator('#testCaseSelect option').count(), 2);
    const checkedUsb = value => ({ kind: 'device', value, usb: true });
    async function checkUsb(candidates) {
      await reset();
      await page.locator('#runTestCase').click();
      const request = await page.evaluate(() => window.fixture.messages.find(m => m.type === 'discoverCommandTargets'));
      await emit({ type: 'commandTargets', requestId: request.requestId, candidates, adbPath: 'adb.exe' });
    }
    await checkUsb([checkedUsb('USB1'), { kind: 'device', value: 'USB2', usb: false }]);
    assert.match(await page.locator('#testCaseStatus').innerText(), /已確認 1 台.*USB2/);
    assert.equal(await page.locator('#confirmDialog').isVisible(), false);
    await checkUsb([checkedUsb('USB1'), checkedUsb('USB3')]);
    assert.match(await page.locator('#testCaseStatus').innerText(), /已確認 2 台.*USB2/);
    await checkUsb([checkedUsb('USB1'), checkedUsb('USB2')]);
    await page.locator('#confirmAccept').waitFor({ state: 'visible' });
    assert.match(await page.locator('#confirmMessage').innerText(), /步驟一\s+核對接收紀錄/);
    assert.equal(await page.evaluate(() => window.fixture.messages.some(m => m.type === 'start' || m.type === 'input')), false);
    await page.locator('#confirmAccept').click();
    await page.waitForFunction(() => window.fixture.messages.filter(m => m.type === 'discoverCommandTargets').length === 2);
    const recheck = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'discoverCommandTargets').at(-1));
    await emit({ type: 'commandTargets', requestId: recheck.requestId, candidates: [checkedUsb('USB1')], adbPath: 'adb.exe' });
    await page.locator('#testCaseDialog').waitFor({ state: 'visible' });
    assert.match(await page.locator('#testCaseStatus').innerText(), /執行前重新檢查.*USB2/);
    assert.equal(await page.evaluate(() => window.fixture.messages.some(m => m.type === 'start' || m.type === 'input')), false);
    pass('TC checks exact USB devices before preview and stops when a required DUT is removed before execution');
    await page.locator('#testCaseForm details summary').click();
    const linkedFlow = await page.locator('#testCaseFlow option').nth(1).innerText();
    await page.locator('#testCaseImportText').fill('code,title,flow,usbCount\nDEMO-02,兩機測試,' + linkedFlow + ',2');
    await page.locator('#importTestCases').click();
    await page.locator('#confirmAccept').click();
    await page.locator('#testCaseQueue label').filter({ hasText: 'DEMO-02' }).locator('input').check();
    await page.locator('#testCaseQueue label').filter({ hasText: 'DEMO-01' }).locator('input').check();
    await reset();
    await page.locator('#runTestCaseQueue').click();
    const queueCheck = await page.evaluate(() => window.fixture.messages.find(m => m.type === 'discoverCommandTargets'));
    await emit({ type: 'commandTargets', requestId: queueCheck.requestId, candidates: [checkedUsb('USB1')], adbPath: 'adb.exe' });
    await page.waitForFunction(() => document.getElementById('testCaseStatus').textContent.startsWith('DEMO-02'));
    assert.equal(await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'discoverCommandTargets').length), 1);
    assert.equal(await page.locator('#confirmDialog').isVisible(), false);
    pass('batch TC import arrives inert and the queue stops at the first selected case on preflight failure');
    await page.locator('#testCaseDialog [data-close]').click();
    await page.locator('#flowDialog [data-close]').first().click();
    await emit({ type: 'init', config: {
      activeWorkspaceId: 'queue', workspaces: [{ id: 'queue', name: 'Local fixture', slots: [
        { activeTabId: 'script', tabs: [{ id: 'script', name: 'Script fixture', shell: 'CMD' }] }
      ] }],
      automations: [{ id: 'script-flow', name: 'Script fixture', workspaceId: 'queue',
        steps: [{ action: 'start', slot: 0, tabId: 'script' }, { action: 'exit', slot: 0, tabId: 'script' }] }],
      testCases: [{ id: 'first', code: 'DEMO-A', title: 'First', flowId: 'script-flow' },
        { id: 'second', code: 'DEMO-B', title: 'Second', flowId: 'script-flow' }]
    } });
    await page.evaluate(() => {
      const fixture = window.fixture, original = window.chrome.webview.postMessage;
      let generation = 0;
      window.chrome.webview.postMessage = message => {
        original(message);
        if (message.type !== 'start') return;
        setTimeout(() => {
          const route = { workspaceId: message.workspaceId, slot: message.slot, tabId: message.tabId, generation: ++generation };
          fixture.emit({ ...route, type: 'started', pid: 1600 + generation });
          const path = 'C:\\Evidence\\' + message.recordRun + '.log';
          fixture.emit({ ...route, type: 'recording', recording: true, path });
          fixture.emit({ ...route, type: 'recording', recording: false, path });
          fixture.emit({ ...route, type: 'exited', exitCode: 0 });
        }, 20);
      };
    });
    await page.locator('#flowButton').click();
    await page.locator('#testCaseButton').click();
    if (!(await page.locator('#testCaseQueue').isVisible())) await page.locator('#testCaseForm details summary').click();
    await page.locator('#testCaseLogChecks').check();
    await page.locator('#pickCaseRecordingFolder').click();
    const evidenceFolderRequest = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'pickCommandPath').at(-1));
    await emit({ type: 'commandPathPicked', requestId: evidenceFolderRequest.requestId, path: 'C:\\Evidence' });
    await page.locator('#testCaseQueue label').filter({ hasText: 'DEMO-B' }).locator('input').check();
    await page.locator('#testCaseQueue label').filter({ hasText: 'DEMO-A' }).locator('input').check();
    await reset();
    await page.locator('#runTestCaseQueue').click();
    for (const code of ['DEMO-B', 'DEMO-A']) {
      await page.locator('#confirmAccept').waitFor({ state: 'visible' });
      assert.ok((await page.locator('#confirmTitle').innerText()).includes(code));
      await page.locator('#confirmAccept').click();
      await page.waitForFunction(() => document.getElementById('flowPauseMessage').textContent.includes('保留仍需要的舊 Log'));
      await page.locator('#continuePausedFlowButton').click();
      await page.waitForFunction(() => document.getElementById('flowPauseMessage').textContent.includes('停止本輪手機錄製'));
      await page.locator('#continuePausedFlowButton').click();
      await page.waitForFunction(id => window.fixture.messages.some(m => m.type === 'runSave' && m.text.includes('測項 ' + id) && m.text.includes('結果 流程完成')), code);
    }
    const recordings = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'start'));
    assert.equal(recordings.length, 2);
    assert.notEqual(recordings[0].recordRun, recordings[1].recordRun);
    assert.ok(recordings.every(m => m.recordFolder === 'C:\\Evidence'));
    pass('the TC queue advances in selection order with separately identified output recordings and manual log checkpoints');
    if (await page.locator('#testCaseDialog').isVisible()) await page.locator('#testCaseDialog [data-close]').click();
    if (await page.locator('#flowDialog').isVisible()) await page.locator('#flowDialog [data-close]').first().click();
    await emit({ type: 'init', config: {}, capabilities: { appDirectory: 'C:\\Terminal Grid\\' } });
    await page.locator('#flowButton').click();
    await page.locator('#testCaseButton').click();
    assert.equal(await page.locator('#defaultTestCase option').count(), 9);
    await reset();
    for (const code of ['NAN-PING', 'NAN-PING-2']) {
      await page.locator('#defaultTestCase').selectOption('NAN-PING');
      await page.locator('#addDefaultTestCase').click();
      assert.equal(await page.locator('#nanTool').inputValue(), 'ping');
      const request = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'discoverCommandTargets').at(-1));
      await emit({ type: 'commandTargets', requestId: request.requestId, candidates: [
        checkedUsb('USB3'), checkedUsb('USB2'), checkedUsb('USB1'), { kind: 'device', value: 'LAN1', usb: false }
      ], adbPath: 'C:\\Tools\\adb.exe' });
      assert.equal(await page.locator('#nanDut1Choices option[value=LAN1]').count(), 0);
      if (code === 'NAN-PING') {
        assert.equal(await page.locator('#nanDut1').inputValue(), '');
        await page.locator('#nanDut1Choices').selectOption('USB1');
        await page.locator('#nanDut2Choices').selectOption('USB2');
      } else {
        assert.equal(await page.locator('#nanDut1').inputValue(), 'USB1');
        assert.equal(await page.locator('#nanDut2').inputValue(), 'USB2');
        assert.equal(request.toolsFolder, 'C:\\Tools\\');
      }
      await page.locator('#nanForm button[type="submit"]').click();
      assert.equal(await page.locator('#testCaseCode').inputValue(), code);
      assert.equal(await page.locator('#testCaseUsb').inputValue(), '2');
      assert.ok(await page.locator('#testCaseFlow').inputValue());
    }
    await page.locator('#defaultTestCase').selectOption('AP-CONNECTED');
    await page.locator('#addDefaultTestCase').click();
    const apRequest = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'discoverCommandTargets').at(-1));
    await emit({ type: 'commandTargets', requestId: apRequest.requestId, candidates: [checkedUsb('USB1')], adbPath: 'C:\\Tools\\adb.exe' });
    assert.equal(await page.locator('#apTestSerial').inputValue(), 'USB1');
    await page.locator('#apTestSsid').fill('Lab Test AP');
    await page.locator('#apTestForm button[type="submit"]').click();
    assert.equal(await page.locator('#testCaseCode').inputValue(), 'AP-CONNECTED');
    assert.equal(await page.locator('#testCaseUsb').inputValue(), '1');
    assert.ok(await page.locator('#testCaseFlow').inputValue());
    assert.equal(await page.evaluate(() => window.fixture.messages.filter(m => ['start', 'input'].includes(m.type)).length), 0);
    pass('Default TC reuses confirmed USB roles with a third phone present and carries the ADB folder into the next setup without executing commands');
    await page.locator('#defaultTestCase').selectOption('NAN-PING');
    await page.locator('#addDefaultTestCase').click();
    const uiDevices = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'discoverCommandTargets').at(-1));
    await emit({ type: 'commandTargets', requestId: uiDevices.requestId, candidates: [checkedUsb('USB1'), checkedUsb('USB2')], adbPath: 'C:\\Tools\\adb.exe' });
    await page.locator('#nanProfileBrowse').click();
    const uiProfilePick = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'pickCommandPath').at(-1));
    assert.equal(uiProfilePick.kind, 'json');
    await emit({ type: 'commandPathPicked', requestId: uiProfilePick.requestId, path: 'C:\\Lab\\test-ui.json' });
    assert.equal(await page.locator('#nanPythonField').isVisible(), true);
    await page.locator('#nanForm button[type="submit"]').click();
    const uiSetup = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'save').at(-1).config.automations.at(-1).steps);
    assert.deepEqual(uiSetup.filter(s => s.action === 'start').map(s => s.tabId), ['nan-ui-nan', 'nan-ui-ndp', 'nan-ping']);
    assert.equal(await page.evaluate(() => window.fixture.messages.filter(m => ['start', 'input'].includes(m.type)).length), 0);
    pass('NAN setup JSON picker produces two automatic phone stages and a Ping stage without running them on save');
    await page.locator('#testCaseDialog [data-close]').click();
    await page.locator('#flowDialog [data-close]').first().click();
    await reset();
    await page.locator('#quickNanButton').click();
    assert.equal(await page.locator('#nanTool').inputValue(), 'ping');
    assert.equal(await page.locator('#nanCheckpoints').isVisible(), false);
    assert.equal(await page.locator('#nanUiProfile').evaluate(input => input.required), true);
    const quickDevices = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'discoverCommandTargets').at(-1));
    await emit({ type: 'commandTargets', requestId: quickDevices.requestId, candidates: [checkedUsb('USB2')],
      adbPath: 'C:\\Tools\\adb.exe' });
    assert.match(await page.locator('#nanStatus').innerText(), /目前只有 1 台/);
    assert.equal(await page.locator('#saveNanFlow').isDisabled(), true);
    assert.equal(await page.locator('#nanCheckDevice').inputValue(), 'USB2');
    await page.locator('#nanCheckButton').click();
    const check = await page.evaluate(() => window.fixture.messages.find(m => m.type === 'nanCheck'));
    assert.equal(check.serial, 'USB2');
    assert.equal(check.profile, 'C:\\Lab\\test-ui.json');
    assert.equal(check.toolsFolder, 'C:\\Tools\\');
    await emit({ type: 'nanCheckResult', requestId: check.requestId, report: 'App and screen available.' });
    assert.match(await page.locator('#nanCheckStatus').innerText(), /預檢完成/);
    assert.equal(await page.evaluate(() => window.fixture.messages.some(m => m.type === 'start')), false);
    await page.locator('#nanDiscover').click();
    const discoveredPair = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'discoverCommandTargets').at(-1));
    await emit({ type: 'commandTargets', requestId: discoveredPair.requestId, candidates: [
      checkedUsb('USB3'), checkedUsb('USB2'), checkedUsb('USB1')
    ], adbPath: 'C:\\Tools\\adb.exe' });
    assert.equal(await page.locator('#nanDut1').inputValue(), 'USB1');
    assert.equal(await page.locator('#nanDut2').inputValue(), 'USB2');
    await page.locator('#saveNanFlow').click();
    const quickConfig = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'save').at(-1).config);
    assert.equal(quickConfig.testCases.at(-1).feasibility, 'auto');
    assert.equal(quickConfig.automations.at(-1).steps.some(s => s.action === 'pause'), false);
    assert.equal(await page.evaluate(() => window.fixture.messages.some(m => m.type === 'start')), false);
    await emit({ type: 'init', config: quickConfig, capabilities: { appDirectory: 'C:\\Terminal Grid\\' } });
    await reset();
    await page.locator('#quickNanButton').click();
    const missingPair = await page.evaluate(() => window.fixture.messages.find(m => m.type === 'discoverCommandTargets'));
    await emit({ type: 'commandTargets', requestId: missingPair.requestId, candidates: [checkedUsb('USB1'), checkedUsb('USB3')] });
    await page.waitForFunction(() => document.getElementById('testCaseStatus').textContent.includes('USB2'));
    assert.equal(await page.evaluate(() => window.fixture.messages.some(m => m.type === 'start')), false);
    await page.locator('#testCaseDialog [data-close]').click();
    await page.evaluate(data => {
      const f = window.fixture;
      document.getElementById('testCaseRecordOutput').checked = false;
      window.chrome.webview.postMessage = m => {
        f.messages.push(m);
        if (m.type !== 'start') return;
        setTimeout(() => {
          f.emit({ ...m, type: 'started', pid: 1204 });
          if (m.tabId === 'nan-ping') f.emit({ ...m, type: 'output', data });
          else f.emit({ ...m, type: 'exited', exitCode: 0 });
        }, 20);
      };
    }, Buffer.from('64 bytes from fe80::10: icmp_seq=1\r\n').toString('base64'));
    await reset();
    await page.locator('#quickNanButton').click();
    const readyPair = await page.evaluate(() => window.fixture.messages.find(m => m.type === 'discoverCommandTargets'));
    await emit({ type: 'commandTargets', requestId: readyPair.requestId, candidates: [checkedUsb('USB1'), checkedUsb('USB2')] });
    await page.waitForFunction(() => window.fixture.messages.some(m => m.type === 'runSave' && m.text.includes('結果 流程完成')));
    assert.deepEqual(await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'start').map(m => m.tabId)),
      ['nan-ui-nan', 'nan-ui-ndp', 'nan-ping']);
    assert.equal(await page.locator('#confirmDialog').isVisible(), false);
    assert.equal(await page.locator('#flowPauseDialog').isVisible(), false);
    await page.locator('#quickNanButton').click();
    assert.equal(await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'start').length), 3);
    assert.equal(await page.locator('.pane[data-status="running"] .pane-name').innerText(), 'DUT2 · Ping 保活');
    pass('NAN＋Ping supports a single-device check, blocks an incomplete or substituted pair, and leaves one persistent Ping');
    assert.deepEqual(errors, []);
    console.log('Workbench UI: ' + count + ' groups passed; host and clipboard mocked.');
  } catch (error) { if (errors.length) console.error('Page errors:', errors); if (page) await page.screenshot({ path: path.join(results, 'failure.png') }).catch(() => {}); throw error; }
  finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
