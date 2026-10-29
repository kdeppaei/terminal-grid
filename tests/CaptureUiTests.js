'use strict';

// Run with Node.js and an already installed Playwright package / Microsoft Edge.
// If Playwright is outside the project, set NODE_PATH to its node_modules folder.
// This test uses real browser / xterm rendering but mocked host and clipboard APIs.
// It does not start terminals, execute network commands, or validate native clipboard access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const uiRoot = path.join(root, 'ui');
const resultsRoot = path.join(root, '.test-work', 'capture-ui');
const sourceA = { workspaceId: 'capture-workspace', slot: 0, tabId: 'capture-tab-a', generation: 1 };
const sourceB = { workspaceId: 'capture-workspace', slot: 1, tabId: 'capture-tab-b', generation: 1 };
const firstAddress = 'fe80::1234:5678:abcd:1';
const secondAddress = 'fe80::1234:5678:abcd:2';

function serveUi() {
  const server = http.createServer((request, response) => {
    let requested;
    try { requested = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch (_) { response.writeHead(400); response.end(); return; }
    const file = path.resolve(uiRoot, '.' + (requested === '/' ? '/index.html' : requested));
    if (!file.startsWith(uiRoot + path.sep)) { response.writeHead(403); response.end(); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2' };
    fs.readFile(file, (error, bytes) => {
      if (error) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(bytes);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function ifconfig(address, iface = 'aware_data0') {
  return iface + ': flags=4163<UP,BROADCAST,RUNNING,MULTICAST> mtu 1500\r\n' +
    '    inet6 ' + address + '  prefixlen 64 scopeid 0x20<link>\r\n';
}

async function main() {
  const server = await serveUi();
  let browser, page;
  const assertions = [];
  const errors = [];
  function passed(label) { assertions.push(label); console.log('PASS: ' + label); }
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__captureHostMessages = [];
      window.__captureClipboardWrites = [];
      let listener = null;
      if (!window.chrome) window.chrome = {};
      window.chrome.webview = {
        postMessage(message) { window.__captureHostMessages.push(message); },
        addEventListener(type, callback) { if (type === 'message') listener = callback; }
      };
      window.__captureEmit = message => { if (!listener) throw new Error('Host listener unavailable'); listener({ data: message }); };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        async writeText(value) { window.__captureClipboardWrites.push(value); },
        async readText() { return window.__captureClipboardWrites.at(-1) || ''; }
      } });
    });
    await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__captureHostMessages.some(message => message.type === 'ready'));
    const emit = message => page.evaluate(value => window.__captureEmit(value), message);
    const output = (source, text) => emit(Object.assign({}, source, { type: 'output', data: Buffer.from(text, 'utf8').toString('base64') }));
    const outputBytes = (source, bytes) => emit(Object.assign({}, source, { type: 'output', data: bytes.toString('base64') }));
    const count = () => page.locator('#captureList .capture-item').count();
    const waitForCount = expected => page.waitForFunction(n => document.querySelectorAll('#captureList .capture-item').length === n, expected);
    await emit({ type: 'init', version: 'capture-ui-test', capabilities: {}, config: {
      activeWorkspaceId: sourceA.workspaceId,
      workspaces: [{ id: sourceA.workspaceId, name: 'WiFi Aware 測試', rows: 1, cols: 2, slots: [
        { activeTabId: sourceA.tabId, tabs: [{ id: sourceA.tabId, name: 'Android A', shell: 'CMD' }] },
        { activeTabId: sourceB.tabId, tabs: [{ id: sourceB.tabId, name: 'Android B', shell: 'CMD' }] }
      ] }]
    } });
    await emit(Object.assign({}, sourceA, { type: 'started', pid: 1001 }));
    await emit(Object.assign({}, sourceB, { type: 'started', pid: 1002 }));
    await page.locator('#captureButton').click();
    assert.equal(await page.locator('#capturePanel').isVisible(), true);
    assert.equal(await page.locator('#captureEnabled').isChecked(), true);
    assert.equal(await page.locator('dialog[open]').count(), 0);
    passed('capture shelf opens without a modal and collection starts enabled');

    const splitFixture = Buffer.from('查詢網路介面\r\n' + ifconfig(firstAddress), 'utf8');
    // Deliberately split a CJK code point and an IPv6 token across host messages.
    const addressOffset = splitFixture.indexOf(Buffer.from(firstAddress));
    await outputBytes(sourceA, splitFixture.subarray(0, 2));
    await outputBytes(sourceA, splitFixture.subarray(2, addressOffset + 12));
    await outputBytes(sourceA, splitFixture.subarray(addressOffset + 12));
    await waitForCount(1);
    assert.equal(await page.locator('.capture-item').first().getAttribute('data-address'), firstAddress);
    const firstText = await page.locator('.capture-item').first().innerText();
    assert.match(firstText, /Android A/);
    assert.match(firstText, /aware_data0/);
    assert.match(firstText, /WiFi Aware/);
    passed('split UTF-8/output captures a complete IPv6 address with terminal and interface source');

    await output(sourceA, ifconfig(firstAddress));
    await page.waitForTimeout(300);
    assert.equal(await count(), 1);
    await output(sourceB, ifconfig(firstAddress));
    await waitForCount(2);
    assert.match(await page.locator('.capture-item').first().innerText(), /Android B/);
    passed('exact repeats deduplicate within one source while another terminal keeps its own record');

    await output(sourceA, ifconfig(secondAddress));
    await waitForCount(3);
    assert.equal(await page.locator('.capture-item').first().getAttribute('data-address'), secondAddress);
    assert.equal(await page.locator('.capture-item[data-address="' + firstAddress + '"]').count(), 2);
    passed('new IPv6 records appear first while earlier observed addresses remain available');

    const newest = page.locator('.capture-item[data-address="' + secondAddress + '"]');
    await newest.locator('.capture-copy').click();
    assert.equal(await page.evaluate(() => window.__captureClipboardWrites.at(-1)), secondAddress);
    await newest.click({ button: 'right' });
    await page.locator('#terminalContextMenu').getByRole('button', { name: '複製暫存文字', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__captureClipboardWrites.at(-1)), secondAddress);
    assert.equal(await page.evaluate(() => window.__captureClipboardWrites.length), 2);
    passed('copy button and right click copy only the address through the clipboard adapter');

    await page.evaluate(address => {
      const item = document.querySelector('.capture-item[data-address="' + address + '"]');
      const transfer = new DataTransfer();
      item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      window.__captureDragValues = { value: transfer.getData('application/x-terminalgrid-value'), plain: transfer.getData('text/plain') };
      document.querySelector('[data-workspace-id="capture-workspace"] .pane[data-slot="1"] .terminal-layer')
        .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      item.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
    }, secondAddress);
    await page.waitForFunction(address => window.__captureHostMessages.some(message => message.type === 'input' && message.slot === 1 && message.data === address), secondAddress);
    assert.deepEqual(await page.evaluate(() => window.__captureDragValues), { value: secondAddress, plain: secondAddress });
    const inputMessages = await page.evaluate(() => window.__captureHostMessages.filter(message => message.type === 'input'));
    assert.equal(inputMessages.length, 1);
    assert.equal(inputMessages[0].data, secondAddress);
    assert.equal(inputMessages[0].tabId, sourceB.tabId);
    passed('drag inserts address into the chosen terminal without Enter or an automatic command');

    const restarted = Object.assign({}, sourceA, { generation: 2 });
    await emit(Object.assign({}, restarted, { type: 'started', pid: 1003 }));
    await output(sourceA, ifconfig('2001:db8::dead'));
    await output(restarted, ifconfig('2001:db8::beef'));
    await page.waitForFunction(() => !!document.querySelector('.capture-item[data-address="2001:db8::beef"]'));
    assert.equal(await page.locator('.capture-item[data-address="2001:db8::dead"]').count(), 0);
    passed('late output from a previous terminal generation cannot create a captured record');

    await page.locator('#captureEnabled').uncheck();
    const beforeDisabled = await count();
    await output(sourceB, ifconfig('2001:db8::d15a'));
    await page.waitForTimeout(300);
    assert.equal(await count(), beforeDisabled);
    assert.equal(await page.locator('.capture-item[data-address="2001:db8::d15a"]').count(), 0);
    await page.locator('#captureEnabled').check();
    await output(sourceB, ifconfig('2001:db8::eab1'));
    await page.waitForFunction(() => !!document.querySelector('.capture-item[data-address="2001:db8::eab1"]'));
    passed('collection can be disabled and resumed while terminals continue receiving output');

    await page.locator('#clearCapturesButton').click();
    await waitForCount(0);
    assert.equal((await page.locator('#captureCount').innerText()).trim(), '0');
    passed('clear removes observed addresses and updates the visible count');

    let bulk = '';
    for (let i = 1; i <= 85; i++) bulk += ifconfig('2001:db8:1::' + i.toString(16));
    await output(sourceB, bulk);
    await waitForCount(80);
    assert.equal(await page.locator('.capture-item').first().getAttribute('data-address'), '2001:db8:1::55');
    assert.equal(await page.locator('.capture-item[data-address="2001:db8:1::1"]').count(), 0);
    passed('capture history is bounded to 80 newest records');

    fs.mkdirSync(resultsRoot, { recursive: true });
    await page.screenshot({ path: path.join(resultsRoot, 'capture-shelf.png'), fullPage: true });
    await page.locator('#captureButton').click();
    assert.equal(await page.locator('#capturePanel').isVisible(), false);
    await output(sourceB, ifconfig('2001:db8::c105'));
    await page.locator('#captureButton').click();
    await page.waitForFunction(() => !!document.querySelector('.capture-item[data-address="2001:db8::c105"]'));
    passed('hiding the shelf preserves background collection');

    await page.locator('#clearCapturesButton').click();
    await waitForCount(0);
    const destination = page.locator('[data-workspace-id="capture-workspace"] .pane[data-slot="1"] .terminal-layer');
    await destination.click({ position: { x: 25, y: 50 } });
    await destination.click({ button: 'right' });
    assert.equal(await page.locator('#terminalContextMenu').getByRole('button', { name: '暫存選取文字', exact: true }).count(), 1);
    assert.equal(await page.locator('#terminalContextMenu').getByRole('button', { name: '編輯選取指令', exact: true }).count(), 1);
    await page.locator('#draftButton').click();
    assert.equal(await page.locator('#commandDraftText').isVisible(), true);
    assert.match(await page.locator('#commandDraftTarget').innerText(), /Android B/);
    assert.equal(await page.locator('dialog[open]').count(), 0);
    passed('terminal menu exposes saved text and editing, with a nonmodal draft bound to its terminal');

    const originalCommand = 'ping old-host.internal -n 2';
    const savedValue = 'new-host.internal';
    await page.locator('#commandDraftText').fill(originalCommand);
    await page.locator('#commandDraftText').evaluate(textarea => {
      textarea.focus();
      textarea.setSelectionRange(5, 22);
      textarea.dispatchEvent(new Event('select', { bubbles: true }));
    });
    await page.locator('#captureValueInput').fill(savedValue);
    await page.locator('#addCaptureValueButton').click();
    await waitForCount(1);
    const generic = page.locator('.capture-item[data-address="' + savedValue + '"]');
    assert.match(await generic.innerText(), /手動暫存/);
    await generic.click({ button: 'right' });
    await page.locator('#terminalContextMenu').getByRole('button', { name: '替換草稿中的選取文字', exact: true }).click();
    assert.equal(await page.locator('#commandDraftText').inputValue(), 'ping new-host.internal -n 2');
    passed('a manually saved generic value replaces only the draft selection after focus moves to the shelf');

    const draft = page.locator('#commandDraftText');
    async function selectDraftA() {
      await draft.fill('ping A -n 2');
      await draft.evaluate(textarea => {
        textarea.focus(); textarea.setSelectionRange(5, 6);
        textarea.dispatchEvent(new Event('select', { bubbles: true }));
      });
    }
    await selectDraftA();
    await draft.click({ button: 'right' });
    await page.locator('#commandDraftValues button').filter({ hasText: savedValue }).click();
    assert.equal(await draft.inputValue(), 'ping new-host.internal -n 2');
    passed('draft right click preserves the selected range and offers literal saved replacements');

    await selectDraftA();
    await generic.locator('.capture-address').dragTo(draft);
    assert.equal(await draft.inputValue(), 'ping new-host.internal -n 2');
    passed('real browser drag replaces the original selected range instead of inserting at drop coordinates');

    await draft.fill('ping A');
    await generic.locator('.capture-replace').click();
    assert.equal(await draft.inputValue(), 'ping A');
    assert.match(await page.locator('#toast').innerText(), /先.*選取/);
    await selectDraftA();
    await draft.evaluate(textarea => {
      const transfer = new DataTransfer(); transfer.setData('text/plain', 'B\r\necho BAD');
      textarea.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    assert.equal(await draft.inputValue(), 'ping A -n 2');
    await draft.fill('ping A\necho BAD');
    assert.equal(await page.locator('#sendDraftButton').isDisabled(), true);
    await draft.fill('ping new-host.internal -n 2');
    passed('missing selection and multiline replacement/send are rejected without changing the command');

    const beforeDraftSend = await page.evaluate(() => window.__captureHostMessages.filter(message => message.type === 'input').length);
    await page.locator('[data-workspace-id="capture-workspace"] .pane[data-slot="0"] .terminal-layer').click({ position: { x: 25, y: 50 } });
    await page.locator('#sendDraftButton').click();
    await page.waitForFunction(n => window.__captureHostMessages.filter(message => message.type === 'input').length === n + 1, beforeDraftSend);
    const sentDraft = await page.evaluate(() => window.__captureHostMessages.filter(message => message.type === 'input').at(-1));
    assert.equal(sentDraft.data, 'ping new-host.internal -n 2');
    assert.equal(sentDraft.tabId, sourceB.tabId);
    assert.equal(sentDraft.slot, sourceB.slot);
    assert.equal(sentDraft.generation, sourceB.generation);
    passed('sending a draft keeps its original terminal despite other pane focus, without appending Enter');

    await emit(Object.assign({}, sourceB, { generation: 2, type: 'started', pid: 1004 }));
    const afterDraftSend = await page.evaluate(() => window.__captureHostMessages.filter(message => message.type === 'input').length);
    await page.locator('#sendDraftButton').click();
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.__captureHostMessages.filter(message => message.type === 'input').length), afterDraftSend);
    assert.match(await page.locator('#toast').innerText(), /目標.*重新啟動/);
    passed('a terminal restart invalidates an existing draft target before further input can be sent');
    await page.screenshot({ path: path.join(resultsRoot, 'command-draft.png'), fullPage: true });

    await page.setViewportSize({ width: 900, height: 620 });
    await page.locator('#sendDraftButton').scrollIntoViewIfNeeded();
    const narrow = await page.evaluate(() => {
      const button = document.getElementById('sendDraftButton').getBoundingClientRect();
      const panel = document.getElementById('capturePanel').getBoundingClientRect();
      return { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
        width: innerWidth, height: innerHeight, button: { left: button.left, right: button.right, top: button.top, bottom: button.bottom },
        panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom } };
    });
    assert.ok(narrow.scrollWidth <= narrow.width, 'narrow window must not overflow horizontally');
    assert.ok(narrow.scrollHeight <= narrow.height, 'narrow window must not overflow vertically');
    assert.ok(narrow.button.left >= 0 && narrow.button.right <= narrow.width && narrow.button.top >= 0 && narrow.button.bottom <= narrow.height,
      'draft send control must remain reachable within the viewport');
    assert.ok(narrow.panel.left >= 0 && narrow.panel.right <= narrow.width && narrow.panel.bottom <= narrow.height,
      'capture shelf must stay inside the window');
    await page.screenshot({ path: path.join(resultsRoot, 'capture-narrow.png'), fullPage: true });
    passed('900×620 window retains a scrollable draft and shelf without page overflow');

    await page.locator('#saveButton').click();
    const saved = await page.evaluate(() => window.__captureHostMessages.filter(message => message.type === 'save').at(-1));
    assert.ok(saved);
    assert.equal(JSON.stringify(saved.config).includes('2001:db8::c105'), false);
    assert.equal(JSON.stringify(saved.config).includes(savedValue), false);
    assert.deepEqual(errors, []);
    passed('observed addresses stay outside saved configuration and UI emits no uncaught errors');
    console.log('Capture UI checks passed: ' + assertions.length + '. Host and clipboard APIs were mocked; no native terminal commands ran.');
  } catch (error) {
    if (page) {
      fs.mkdirSync(resultsRoot, { recursive: true });
      await page.screenshot({ path: path.join(resultsRoot, 'failure.png'), fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
