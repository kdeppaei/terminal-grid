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
    assert.equal(await page.locator('#commandPackSelect option').count(), 11);
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
    assert.equal(await page.locator('#commandPackSelect option').count(), 12);
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
    await page.locator('select[data-target-key="LOCAL_IPV4"]').selectOption('10.0.0.5');
    await reset(); await page.locator('#pathCommandForm button[type="submit"]').click();
    assert.deepEqual((await inputs()).map(m => m.data), ['iperf3 -c "10.0.0.20" -B "10.0.0.5" -t 30']);
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
    await page.locator('#flowDialog [data-close]').first().click();
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
    assert.deepEqual(errors, []);
    console.log('Workbench UI: ' + count + ' groups passed; host and clipboard mocked.');
  } catch (error) { if (page) await page.screenshot({ path: path.join(results, 'failure.png') }).catch(() => {}); throw error; }
  finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
