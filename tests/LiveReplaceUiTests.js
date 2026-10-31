'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), ui = path.join(root, 'ui');
async function main() {
  const server = http.createServer((req, res) => {
    const file = path.resolve(ui, '.' + new URL(req.url, 'http://localhost').pathname.replace(/^\/$/, '/index.html'));
    if (!file.startsWith(ui + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, bytes) => { if (err) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream'); res.end(bytes); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page; let groups = 0; const errors = [];
  const pass = message => { groups++; console.log('PASS ' + message); };
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const s = window.fixture = { messages: [], terminals: [], clipboard: '222', deferred: false };
      if (!window.chrome) window.chrome = {};
      window.chrome.webview = { postMessage: message => s.messages.push(message), addEventListener: (name, fn) => { if (name === 'message') s.emit = data => fn({ data }); } };
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { s.clipboard = value; }, readText: () => s.deferred ? new Promise(resolve => { s.resolve = resolve; }) : Promise.resolve(s.clipboard) } });
      let Type;
      Object.defineProperty(window, 'Terminal', { get: () => Type, set: Base => { Type = class extends Base { constructor(...args) { super(...args); s.terminals.push(this); } }; } });
      document.addEventListener('copy', event => event.preventDefault(), true);
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.fixture.emit && window.fixture.messages.some(m => m.type === 'ready'));
    await page.evaluate(() => { window.fixture.terminals = []; window.fixture.emit({ type: 'init', config: {
      activeWorkspaceId: 'live', workspaces: [{ id: 'live', name: '原位替換', rows: 1, cols: 1,
        slots: [{ activeTabId: 'cmd', tabs: [{ id: 'cmd', name: 'CMD', shell: 'CMD' }] }] }]
    } }); });
    const source = { workspaceId: 'live', slot: 0, tabId: 'cmd', generation: 1 };
    const emit = message => page.evaluate(m => window.fixture.emit(m), Object.assign({}, source, message));
    await emit({ type: 'started', pid: 1234 });
    const pane = page.locator('[data-workspace-id="live"] .pane').first();
    const editor = pane.locator('.pane-line-input').first(), raw = pane.locator('.xterm-helper-textarea').first();
    async function paint(command = '000111000', prefix = 'C:\\test>', cursor = command.length) {
      await page.evaluate(() => { window.fixture.messages = []; window.fixture.terminals[0].clearSelection(); });
      await emit({ type: 'output', data: Buffer.from('\x1b[2J\x1b[H' + prefix + command + '\x1b[D'.repeat(command.length - cursor)).toString('base64') });
      await page.waitForFunction(() => window.fixture.messages.some(m => m.type === 'ack'));
      await page.waitForTimeout(60);
      await page.evaluate(() => { window.fixture.messages = []; });
    }
    async function select(text = '111', mouse = true) {
      const position = await page.evaluate(text => {
        const t = window.fixture.terminals[0], b = t.buffer.active;
        for (let y = 0; y < b.length; y++) {
          const line = b.getLine(y);
          for (let x = 0; x <= t.cols - text.length; x++) {
            if (Array.from({ length: text.length }, (_, n) => line.getCell(x + n).getChars()).join('') === text) {
              const box = t.element.querySelector('.xterm-screen').getBoundingClientRect();
              return { x, y, px: box.x + (x + 0.1) * box.width / t.cols, end: box.x + (x + text.length + 0.1) * box.width / t.cols,
                py: box.y + (y - b.viewportY + 0.5) * box.height / t.rows };
            }
          }
        }
        throw new Error('Could not locate selection ' + text);
      }, text);
      if (mouse) { await page.mouse.move(position.px, position.py); await page.mouse.down(); await page.mouse.move(position.end, position.py, { steps: 8 }); await page.mouse.up(); }
      else await page.evaluate(({ position, text }) => window.fixture.terminals[0].select(position.x, position.y, text.length), { position, text });
      assert.equal(await page.evaluate(() => window.fixture.terminals[0].getSelection()), text);
    }
    async function expectInput(expected) {
      await page.waitForTimeout(60);
      const messages = await page.evaluate(() => window.fixture.messages.filter(m => m.type === 'input'));
      assert.deepEqual(messages.map(m => m.data), expected);
      assert.ok(messages.every(m => m.workspaceId === source.workspaceId && m.tabId === source.tabId && m.generation === source.generation));
    }
    const keys = '\x1b[D'.repeat(3) + '\x7f'.repeat(3);
    await paint(); await select('111', true); await editor.fill('222');
    assert.equal(await pane.locator('.line-send').first().innerText(), '替換');
    await pane.locator('.line-send').first().click(); await expectInput([keys + '222']);
    await emit({ type: 'output', data: Buffer.from('\rC:\\test>000222000\x1b[K').toString('base64') });
    pass('real mouse selection 111 plus bottom 222 sends one in-place edit without Enter or appending');
    fs.mkdirSync(path.join(root, '.test-work', 'live-replace-ui'), { recursive: true });
    await page.screenshot({ path: path.join(root, '.test-work', 'live-replace-ui', 'replaced.png') });

    await paint(); await select(); await raw.click({ button: 'right', force: true });
    await page.locator('#terminalContextMenu').getByRole('button', { name: '原位替換選取文字…', exact: true }).click();
    await page.locator('.live-replace-text').fill('44444');
    await page.locator('.live-replace-apply').click(); await expectInput([keys + '44444']);
    pass('right-click replace changes length while preserving suffix');

    await paint(); await select(); await raw.focus(); await page.keyboard.press('Control+v'); await expectInput([keys + '222']);
    pass('Ctrl+V replaces the live selection once');
    await paint(); await select(); await raw.focus(); await page.keyboard.press('Backspace'); await expectInput([keys]);
    pass('Backspace deletes only the selected live argument');
    await paint('000111000', 'C:\\test>', 1); await select(); await editor.fill('22'); await editor.press('Enter');
    await expectInput(['\x1b[C'.repeat(5) + '\x7f'.repeat(3) + '22']);
    pass('cursor before selection moves right correctly; editor Enter replaces without executing');

    await paint('000111000', 'C:\\使用者\\測試>'); await select(); await editor.fill('222'); await pane.locator('.line-send').first().click(); await expectInput([keys + '222']);
    pass('wide Chinese characters in CMD path do not shift replacement coordinates');
    await paint('000111000', 'PS C:\\test> '); await select(); await editor.fill('222'); await pane.locator('.line-send').first().click(); await expectInput([keys + '222']);
    pass('PowerShell standard prompt supports the same edit');
    await paint('000111000', 'C:\\' + 'folder'.repeat(25) + '>'); await select(); await editor.fill('222'); await pane.locator('.line-send').first().click(); await expectInput([keys + '222']);
    pass('wrapped prompt keeps input coordinates within the current logical line');

    await page.locator('#captureButton').click();
    await page.locator('#captureValueInput').fill('222'); await page.locator('#addCaptureValueButton').click();
    const saved = page.locator('.capture-item[data-address="222"]');
    await editor.fill('old input'); await editor.selectText();
    await paint(); await select(); await saved.locator('.capture-replace').click(); await expectInput([keys + '222']);
    pass('shelf Replace targets the new terminal selection instead of an older input-field selection');
    await paint(); await select();
    await saved.locator('.capture-address').dragTo(pane.locator('.terminal-mount').first()); await expectInput([keys + '222']);
    pass('real shelf drag replaces selected terminal characters instead of appending');
    await page.locator('#closeCaptureButton').click();

    await paint(); await select(); await editor.fill('A\u001b'); await pane.locator('.line-send').first().click(); await expectInput([]);
    pass('replacement control characters cannot become terminal input');

    await paint(); await select(); await emit({ type: 'output', data: Buffer.from('\x1b[0m').toString('base64') });
    await page.waitForTimeout(60); await editor.fill('222'); await pane.locator('.line-send').first().click(); await expectInput([]);
    pass('output after selection invalidates the edit even when the visible text is unchanged');
    await paint('000111000\r\nC:\\test>'); await select(); await editor.fill('222'); await pane.locator('.line-send').first().click(); await expectInput([]);
    pass('historical output cannot be changed through terminal editing keys');
    await paint(); await select('test'); await editor.fill('222'); await pane.locator('.line-send').first().click(); await expectInput([]);
    pass('shell prompt selection is excluded');
    await paint('000111000', 'progress: '); await select(); await editor.fill('222'); await pane.locator('.line-send').first().click(); await expectInput([]);
    pass('arbitrary program output cannot be mistaken for a standard shell prompt');
    await paint(); await select(); await page.evaluate(() => window.fixture.terminals[0].resize(60, 15));
    await editor.fill('222'); await pane.locator('.line-send').first().click(); await expectInput([]);
    pass('resize invalidates the selected screen coordinates');

    await paint(); await select(); await page.evaluate(() => { window.fixture.deferred = true; });
    await raw.focus(); await page.keyboard.press('Control+v');
    source.generation = 2; await emit({ type: 'started', pid: 5678 });
    await page.evaluate(() => { window.fixture.deferred = false; window.fixture.resolve('222'); }); await expectInput([]);
    pass('delayed clipboard cannot replace a restarted session');
    assert.deepEqual(errors, []);
    console.log('Live replacement UI: ' + groups + ' groups passed; mocked host/clipboard, real xterm and mouse.');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(root, '.test-work', 'live-replace-failure.png') }).catch(() => {});
    throw error;
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
