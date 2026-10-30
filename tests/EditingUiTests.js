'use strict';

// Real Edge / xterm DOM integration with a mocked terminal host and clipboard API.
// No terminal commands run. The user's OS clipboard is never read or changed.
// Native editable-field paste is exercised with ClipboardEvents plus browser text
// insertion; OS-level Ctrl+X/V clipboard integration needs a separate manual check.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const uiRoot = path.join(root, 'ui');
const resultsRoot = path.join(root, '.test-work', 'editing-ui');
const sourceA = { workspaceId: 'edit-workspace', slot: 0, tabId: 'edit-a', generation: 1 };
const sourceAlt = { workspaceId: 'edit-workspace', slot: 0, tabId: 'edit-alt', generation: 1 };
const sourceB = { workspaceId: 'edit-workspace', slot: 1, tabId: 'edit-b', generation: 1 };

function serveUi() {
  const server = http.createServer((request, response) => {
    let requested;
    try { requested = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch (_) { response.writeHead(400); response.end(); return; }
    const file = path.resolve(uiRoot, '.' + (requested === '/' ? '/index.html' : requested));
    if (!file.startsWith(uiRoot + path.sep)) { response.writeHead(403); response.end(); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    fs.readFile(file, (error, bytes) => {
      if (error) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(bytes);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const server = await serveUi();
  let browser, page;
  const assertions = [], errors = [];
  const passed = label => { assertions.push(label); console.log('PASS: ' + label); };
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const state = window.__editing = { messages: [], reads: 0, writes: [], clipboard: 'PASTE_ONCE', deferred: false, pending: [], terminals: [], keys: [] };
      let listener = null;
      if (!window.chrome) window.chrome = {};
      window.chrome.webview = {
        postMessage(message) { state.messages.push(message); },
        addEventListener(type, callback) { if (type === 'message') listener = callback; }
      };
      state.emit = message => { if (!listener) throw new Error('Host listener unavailable'); listener({ data: message }); };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        async writeText(value) { state.writes.push(value); state.clipboard = value; },
        readText() { state.reads++; return state.deferred ? new Promise(resolve => state.pending.push(resolve)) : Promise.resolve(state.clipboard); }
      } });
      let TerminalClass;
      Object.defineProperty(window, 'Terminal', { configurable: true,
        get() { return TerminalClass; },
        set(Type) { TerminalClass = class extends Type { constructor(...args) { super(...args); state.terminals.push(this); } }; }
      });
      document.addEventListener('keydown', event => {
        const code = event.code, repeat = event.repeat;
        // Native event dispatch can drain microtasks between capture and target
        // listeners. Read the event's final cancellation state only when the
        // test inspects it after keyboard.press(), rather than in a microtask.
        state.keys.push({ code, repeat, get prevented() { return event.defaultPrevented; } });
      }, true);
      // Keep the platform clipboard untouched, including accidental native
      // fallthrough from a broken shortcut. defaultPrevented assertions below
      // still detect that bug, while browser key dispatch remains genuine.
      document.addEventListener('copy', event => event.preventDefault(), true);
      document.addEventListener('cut', event => event.preventDefault(), true);
    });
    await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__editing.messages.some(message => message.type === 'ready'));
    const emit = message => page.evaluate(value => window.__editing.emit(value), message);
    const output = (source, text) => emit(Object.assign({}, source, { type: 'output', data: Buffer.from(text, 'utf8').toString('base64') }));
    const inputs = () => page.evaluate(() => window.__editing.messages.filter(message => message.type === 'input'));
    const reset = value => page.evaluate(value => {
      const s = window.__editing; s.messages = []; s.reads = 0; s.writes = []; s.keys = [];
      if (value !== undefined) s.clipboard = value;
    }, value);
    async function expectInputs(expected) {
      await page.waitForTimeout(80);
      assert.deepEqual((await inputs()).map(message => message.data), expected);
    }
    // The UI creates a preview grid before the host handshake. init disposes
    // it; retain only the real fixture terminals created by that handshake.
    await page.evaluate(() => { window.__editing.terminals = []; });
    await emit({ type: 'init', version: 'editing-ui-test', capabilities: {}, config: {
      activeWorkspaceId: sourceA.workspaceId,
      workspaces: [{ id: sourceA.workspaceId, name: '編輯測試', rows: 1, cols: 2, slots: [
        { activeTabId: sourceA.tabId, tabs: [{ id: sourceA.tabId, name: 'CMD A', shell: 'CMD' }, { id: sourceAlt.tabId, name: 'CMD Alternate', shell: 'CMD' }] },
        { activeTabId: sourceB.tabId, tabs: [{ id: sourceB.tabId, name: 'CMD B', shell: 'CMD' }] }
      ] }]
    } });
    await emit(Object.assign({}, sourceA, { type: 'started', pid: 1101 }));
    await emit(Object.assign({}, sourceAlt, { type: 'started', pid: 1102 }));
    await emit(Object.assign({}, sourceB, { type: 'started', pid: 1103 }));
    const paneA = page.locator('[data-workspace-id="edit-workspace"] .pane[data-slot="0"]');
    const paneB = page.locator('[data-workspace-id="edit-workspace"] .pane[data-slot="1"]');
    const layerA = paneA.locator('.terminal-layer').nth(0);
    const layerAlt = paneA.locator('.terminal-layer').nth(1);
    const layerB = paneB.locator('.terminal-layer').nth(0);
    const rawA = layerA.locator('.xterm-helper-textarea');
    const focusRaw = async () => {
      await rawA.focus();
      await page.evaluate(() => window.__editing.terminals[0].clearSelection());
    };

    await focusRaw(); await reset('PASTE_ONCE');
    await page.keyboard.press('Control+v');
    await expectInputs(['PASTE_ONCE']);
    assert.equal(await page.evaluate(() => window.__editing.reads), 1);
    assert.ok(await page.evaluate(() => window.__editing.keys.some(key => key.code === 'KeyV' && key.prevented)));
    passed('Ctrl+V uses one clipboard read and sends exactly one paste payload');

    await focusRaw(); await reset('SHIFT_PASTE');
    await page.keyboard.press('Control+Shift+v');
    await expectInputs(['SHIFT_PASTE']);
    assert.equal(await page.evaluate(() => window.__editing.reads), 1);
    assert.ok(await page.evaluate(() => window.__editing.keys.some(key => key.code === 'KeyV' && key.prevented)));
    passed('Ctrl+Shift+V cancels the browser default and cannot take a second paste path');

    await focusRaw(); await reset('TWICE');
    await page.keyboard.press('Control+v'); await page.keyboard.press('Control+v');
    await expectInputs(['TWICE', 'TWICE']);
    passed('two independent identical paste gestures are both preserved');

    await focusRaw(); await reset('HELD_ONCE');
    await page.keyboard.down('Control'); await page.keyboard.down('v');
    await page.keyboard.down('v'); await page.keyboard.down('v');
    await page.keyboard.up('v'); await page.keyboard.up('Control');
    await expectInputs(['HELD_ONCE']);
    assert.equal(await page.evaluate(() => window.__editing.reads), 1);
    assert.ok(await page.evaluate(() => window.__editing.keys.some(key => key.repeat && key.code === 'KeyV')));
    passed('holding Ctrl+V ignores repeated keydown events');

    await focusRaw(); await reset('INSERT_ONCE');
    await page.keyboard.press('Shift+Insert');
    await expectInputs(['INSERT_ONCE']);
    passed('Shift+Insert pastes once');

    await output(sourceA, 'COPYTEXT');
    await page.waitForFunction(() => window.__editing.terminals[0].buffer.active.getLine(0).translateToString(true).includes('COPYTEXT'));
    await page.evaluate(() => { const terminal = window.__editing.terminals[0]; terminal.select(0, 0, 8); terminal.focus(); });
    await reset();
    await page.keyboard.press('Control+c');
    await expectInputs([]);
    assert.deepEqual(await page.evaluate(() => window.__editing.writes), ['COPYTEXT']);
    passed('Ctrl+C with a terminal selection copies once and sends no interrupt');

    await focusRaw(); await reset();
    await page.keyboard.press('Control+c');
    await expectInputs(['\u0003']);
    passed('Ctrl+C without a selection retains the terminal interrupt');

    await page.evaluate(() => { const terminal = window.__editing.terminals[0]; terminal.select(0, 0, 8); terminal.focus(); });
    await reset();
    await page.keyboard.press('Control+Shift+c');
    await expectInputs([]);
    assert.deepEqual(await page.evaluate(() => window.__editing.writes), ['COPYTEXT']);
    passed('Ctrl+Shift+C copies selected terminal text without sending input');

    await focusRaw(); await reset();
    await rawA.evaluate(textarea => {
      const data = new DataTransfer(); data.setData('text/plain', 'DOM_PASTE');
      textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expectInputs(['DOM_PASTE']);
    assert.equal(await page.evaluate(() => window.__editing.reads), 0);
    passed('one DOM paste event enters the app once and bypasses xterm duplicate listeners');

    await focusRaw(); await reset('OLD_SESSION');
    await page.evaluate(() => { window.__editing.deferred = true; });
    await page.keyboard.press('Control+v');
    await page.waitForFunction(() => window.__editing.pending.length === 1);
    sourceA.generation = 2;
    await emit(Object.assign({}, sourceA, { type: 'started', pid: 1104 }));
    await page.evaluate(() => { const s = window.__editing; s.deferred = false; s.pending.splice(0).forEach(resolve => resolve('OLD_SESSION')); });
    await expectInputs([]);
    passed('a delayed clipboard result cannot paste into a restarted terminal generation');

    await focusRaw(); await reset('echo A\necho B');
    await page.keyboard.press('Control+v');
    await page.locator('#confirmDialog').waitFor({ state: 'visible' });
    await page.locator('#confirmCancel').click();
    await expectInputs([]);
    passed('canceling a multiline clipboard prompt sends no terminal input');

    const editorA = layerA.locator('.pane-line-input');
    const editorAlt = layerAlt.locator('.pane-line-input');
    const editorB = layerB.locator('.pane-line-input');
    await editorA.waitFor({ state: 'visible' });
    await editorA.fill('KEEP_EXITED_EDITOR');
    await editorB.fill('KEEP_OTHER_EDITOR');
    await editorA.focus();
    await reset('STALE_EDITOR_PASTE');
    await page.evaluate(() => { window.__editing.deferred = true; });
    await page.keyboard.press('Control+Shift+v');
    await page.waitForFunction(() => window.__editing.pending.length === 1);
    await emit(Object.assign({}, sourceA, { type: 'exited', exitCode: 0 }));
    assert.equal(await editorA.isDisabled(), true);
    await editorB.focus();
    await page.evaluate(() => { const s = window.__editing; s.deferred = false; s.pending.splice(0).forEach(resolve => resolve('STALE_EDITOR_PASTE')); });
    await page.waitForTimeout(80);
    assert.equal(await editorA.inputValue(), 'KEEP_EXITED_EDITOR');
    assert.equal(await editorB.inputValue(), 'KEEP_OTHER_EDITOR');
    await expectInputs([]);
    passed('an editor clipboard result after exit changes neither the disabled editor nor another focused editor');
    sourceA.generation++;
    await emit(Object.assign({}, sourceA, { type: 'started', pid: 1105 }));
    await reset();
    await editorA.fill('ping middle-host -n 2');
    async function selectRange(editor, start, end) {
      await editor.evaluate((element, range) => {
        element.focus(); element.setSelectionRange(range.start, range.end);
        element.dispatchEvent(new Event('select', { bubbles: true }));
      }, { start, end });
    }
    async function mouseSelect(editor, start, end) {
      const points = await editor.evaluate((element, range) => {
        element.focus(); element.scrollLeft = 0;
        const box = element.getBoundingClientRect(), style = getComputedStyle(element);
        const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
        context.font = style.font;
        const left = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
        const y = box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop) + parseFloat(style.fontSize) * 0.65;
        return { x1: left + context.measureText(element.value.slice(0, range.start)).width,
          x2: left + context.measureText(element.value.slice(0, range.end)).width, y };
      }, { start, end });
      await page.mouse.move(points.x1, points.y); await page.mouse.down();
      await page.mouse.move(points.x2, points.y, { steps: 8 }); await page.mouse.up();
    }
    await mouseSelect(editorA, 5, 16);
    assert.equal(await editorA.evaluate(element => element.value.slice(element.selectionStart, element.selectionEnd)), 'middle-host');
    await page.keyboard.press('Backspace');
    assert.equal(await editorA.inputValue(), 'ping  -n 2');
    await expectInputs([]);
    passed('real mouse selection plus Backspace deletes the middle without touching the terminal');

    await editorA.fill('ping old-host -n 2');
    await selectRange(editorA, 5, 13); await page.keyboard.press('Delete');
    assert.equal(await editorA.inputValue(), 'ping  -n 2');
    await selectRange(editorA, 5, 5); await page.keyboard.insertText('new-host');
    assert.equal(await editorA.inputValue(), 'ping new-host -n 2');
    await expectInputs([]);
    passed('Delete and insertion at an arbitrary caret preserve the command suffix');

    await editorA.fill('ping A -n 2');
    await selectRange(editorA, 5, 6);
    await reset('clipboard-host');
    await page.keyboard.press('Control+Shift+v');
    assert.equal(await editorA.inputValue(), 'ping clipboard-host -n 2');
    assert.equal(await page.evaluate(() => window.__editing.reads), 1);
    await expectInputs([]);
    passed('editor Ctrl+Shift+V replaces its selection once without sending the command');
    await selectRange(editorA, 5, 5); await reset('prefix-');
    await page.keyboard.press('Shift+Insert');
    assert.equal(await editorA.inputValue(), 'ping prefix-clipboard-host -n 2');
    await expectInputs([]);
    passed('editor Shift+Insert inserts at the middle caret');

    await editorA.fill('ping A -n 2'); await selectRange(editorA, 5, 6);
    await reset('UNUSED_API_CLIPBOARD');
    const nativePaste = await editorA.evaluate(element => {
      const shortcut = new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true });
      element.dispatchEvent(shortcut);
      const data = new DataTransfer(); data.setData('text/plain', 'native-host');
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return { keyCanceled: shortcut.defaultPrevented, pasteCanceled: event.defaultPrevented, value: element.value };
    });
    assert.deepEqual(nativePaste, { keyCanceled: false, pasteCanceled: false, value: 'ping A -n 2' });
    // Synthetic paste events intentionally have no native insertion default.
    // Supply that browser edit separately without touching the OS clipboard.
    await page.keyboard.insertText('native-host');
    assert.equal(await editorA.inputValue(), 'ping native-host -n 2');
    assert.equal(await page.evaluate(() => window.__editing.reads), 0);
    await expectInputs([]);
    passed('editable Ctrl+V and valid native paste retain one browser insertion path without an API paste');
    const rejectedPaste = await editorA.evaluate(element => {
      const data = new DataTransfer(); data.setData('text/plain', 'first\r\nsecond');
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      element.dispatchEvent(event); return event.defaultPrevented;
    });
    assert.equal(rejectedPaste, true);
    assert.equal(await editorA.inputValue(), 'ping native-host -n 2');
    await expectInputs([]);
    passed('editable native paste rejects multiline input without changing the field or sending a command');

    await editorA.fill('ping A -n 2'); await selectRange(editorA, 5, 6);
    await editorA.click({ button: 'right' });
    const menu = page.locator('.text-edit-menu:visible');
    await menu.locator('.text-edit-replacement').fill('manual-B');
    await menu.locator('.text-edit-apply').click();
    assert.equal(await editorA.inputValue(), 'ping manual-B -n 2');
    await expectInputs([]);
    passed('generic right-click replacement preserves the range while the replacement field has focus');
    await page.keyboard.press('Control+z');
    assert.equal(await editorA.inputValue(), 'ping A -n 2');
    await page.keyboard.press('Control+y');
    assert.equal(await editorA.inputValue(), 'ping manual-B -n 2');
    await expectInputs([]);
    passed('manual replacement remains one native undo and redo operation');

    await page.locator('#captureButton').click();
    await page.locator('#captureValueInput').fill('saved-device-B');
    await page.locator('#addCaptureValueButton').click();
    const savedValue = page.locator('.capture-item[data-address="saved-device-B"]');
    await savedValue.waitFor();
    const ipv6Value = 'fe80::cafe:1234';
    await page.locator('#captureValueInput').fill(ipv6Value);
    await page.locator('#addCaptureValueButton').click();
    await editorA.fill('ping A -n 2'); await selectRange(editorA, 5, 6);
    await editorA.click({ button: 'right' });
    const suggested = page.locator('.text-edit-menu:visible .text-edit-suggestion');
    assert.match(await suggested.first().innerText(), /saved-device-B/);
    await page.locator('#toast').waitFor({ state: 'hidden', timeout: 8000 });
    fs.mkdirSync(resultsRoot, { recursive: true });
    await page.screenshot({ path: path.join(resultsRoot, 'editing-replace-menu.png'), fullPage: true });
    await suggested.filter({ hasText: ipv6Value }).click();
    assert.equal(await editorA.inputValue(), 'ping ' + ipv6Value + ' -n 2');
    await expectInputs([]);
    passed('suggestions rank matching text first but also allow replacing placeholder A with an IPv6 value');
    await editorA.fill('adb -s A shell'); await selectRange(editorA, 7, 8);
    await editorA.click({ button: 'right' });
    await page.locator('.text-edit-menu:visible .text-edit-suggestion').filter({ hasText: 'saved-device-B' }).click();
    assert.equal(await editorA.inputValue(), 'adb -s saved-device-B shell');
    passed('a saved device name replaces only the selected command argument');

    await editorA.fill('ping A -n 2'); await selectRange(editorA, 5, 6);
    await savedValue.locator('.capture-address').dragTo(editorA);
    assert.equal(await editorA.inputValue(), 'ping saved-device-B -n 2');
    await editorA.fill('ping  -n 2'); await selectRange(editorA, 5, 5);
    await savedValue.locator('.capture-address').dragTo(editorA);
    assert.equal(await editorA.inputValue(), 'ping saved-device-B -n 2');
    await expectInputs([]);
    passed('real browser drag supports both replacing a range and inserting at a saved caret');

    await editorA.fill('KEEP A');
    await paneA.locator('[data-tab-id="edit-alt"]').click();
    await editorAlt.fill('KEEP ALT');
    await editorB.fill('KEEP B');
    await paneA.locator('[data-tab-id="edit-a"]').click();
    assert.equal(await editorA.inputValue(), 'KEEP A');
    await paneA.locator('[data-tab-id="edit-alt"]').click();
    assert.equal(await editorAlt.inputValue(), 'KEEP ALT');
    assert.equal(await editorB.inputValue(), 'KEEP B');
    await expectInputs([]);
    passed('each terminal tab and pane owns an independent editable command');

    await editorAlt.fill('echo inspect-before-run'); await reset();
    await layerAlt.locator('.line-send').click();
    await expectInputs(['echo inspect-before-run']);
    assert.equal((await inputs())[0].tabId, sourceAlt.tabId);
    await editorB.fill('echo execute-B'); await reset();
    await editorB.press('Enter');
    const enterMessages = await inputs();
    assert.equal(enterMessages.map(message => message.data).join(''), 'echo execute-B\r');
    assert.ok(enterMessages.length > 0 && enterMessages.every(message => message.tabId === sourceB.tabId));
    passed('Send pastes without Enter; Enter executes only the selected editor terminal');
    await reset(); await layerB.locator('.line-interrupt').click();
    await expectInputs(['\u0003']);
    assert.equal((await inputs())[0].tabId, sourceB.tabId);
    passed('the editor interrupt button targets its own terminal');

    await page.locator('#closeCaptureButton').click();
    await page.setViewportSize({ width: 900, height: 620 });
    await editorB.scrollIntoViewIfNeeded();
    const geometry = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.terminal-layer:not([hidden]) .pane-line-editor')].filter(element => element.getClientRects().length)
        .flatMap(element => [element, ...element.querySelectorAll('input, textarea, button')])
        .map(element => { const b = element.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; });
      return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, boxes };
    });
    assert.ok(geometry.boxes.length >= 6);
    assert.ok(geometry.scrollWidth <= geometry.width && geometry.scrollHeight <= geometry.height, 'the 900×620 window must not overflow');
    for (const box of geometry.boxes) assert.ok(box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 && box.right <= geometry.width && box.bottom <= geometry.height, 'editor controls must remain inside the viewport: ' + JSON.stringify(box));
    fs.mkdirSync(resultsRoot, { recursive: true });
    await page.screenshot({ path: path.join(resultsRoot, 'editing-narrow.png'), fullPage: true });
    passed('900×620 window keeps both inline editors and their controls reachable');
    assert.deepEqual(errors, []);
    console.log('Editing UI checks passed: ' + assertions.length + '. Host and clipboard APIs mocked; no terminal commands or OS clipboard writes occurred.');
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
