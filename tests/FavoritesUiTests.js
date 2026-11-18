'use strict';
// Real xterm and application UI, with an isolated browser and mocked native host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const ui = path.resolve(__dirname, '../ui');

async function main() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(ui, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(ui + path.sep)) { response.writeHead(403); response.end(); return; }
    fs.readFile(file, (error, content) => {
      if (error) { response.writeHead(404); response.end(); return; }
      response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
      response.end(content);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const errors = [];
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const fixture = window.favoritesFixture = { messages: [], terminals: [] };
      window.chrome = window.chrome || {};
      window.chrome.webview = {
        postMessage: message => fixture.messages.push(message),
        addEventListener: (type, callback) => { if (type === 'message') fixture.emit = data => callback({ data }); }
      };
      let Type;
      Object.defineProperty(window, 'Terminal', {
        get: () => Type,
        set: Base => { Type = class extends Base { constructor(...args) { super(...args); fixture.terminals.push(this); } }; }
      });
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.favoritesFixture.messages.some(message => message.type === 'ready'));
    const emit = message => page.evaluate(data => window.favoritesFixture.emit(data), message);
    await page.evaluate(() => { window.favoritesFixture.terminals = []; });
    const config = {
      activeWorkspaceId: 'favorites',
      workspaces: [{ id: 'favorites', rows: 1, cols: 1, slots: [
        { activeTabId: 'cmd', tabs: [{ id: 'cmd', shell: 'CMD' }] }
      ] }]
    };
    await emit({ type: 'init', config });
    const source = { workspaceId: 'favorites', slot: 0, tabId: 'cmd', generation: 1 };
    await emit({ ...source, type: 'started', pid: 1234 });
    await emit({ ...source, type: 'output', data: Buffer.from('C:\\>%aware_data0').toString('base64') });
    await page.waitForFunction(() => window.favoritesFixture.terminals[0].buffer.active.getLine(0).translateToString(true).includes('%aware_data0'));
    const menu = page.locator('#terminalContextMenu');
    const menuButton = page.locator('.pane[data-slot="0"] [data-action="menu"]');
    await menuButton.click();
    assert.equal(await menu.getByRole('button', { name: '存到我的常用…', exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.favoritesFixture.terminals[0].select(4, 0, 12));
    await menuButton.click();
    await menu.getByRole('button', { name: '存到我的常用…', exact: true }).click();
    assert.equal(await page.locator('#commandTextInput').inputValue(), '%aware_data0');
    assert.equal(await page.locator('#commandItemType').inputValue(), 'literal');
    await page.locator('#commandEditDialog').getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.locator('#commandPackSelect option[value="personal-favorites"]').count(), 0);
    await menuButton.click();
    await menu.getByRole('button', { name: '存到我的常用…', exact: true }).click();
    await page.locator('#commandNameInput').fill('My scope');
    await page.locator('#commandEditForm button[type="submit"]').click();
    await page.locator('#commandButton').click();
    const item = page.locator('#commandList .command-item').filter({ hasText: 'My scope' });
    await item.locator('.command-pin').click();
    assert.equal(await item.locator('.command-pin').getAttribute('aria-pressed'), 'true');
    await page.locator('#exportPackButton').click();
    const exported = await page.evaluate(() => window.favoritesFixture.messages.filter(message => message.type === 'commandPackSave').at(-1).text);
    assert.equal(JSON.parse(exported).commands[0].pinned, true);
    await item.getByRole('button', { name: '⋯', exact: true }).click();
    await page.locator('#commandDescriptionInput').fill('Scope retained while editing');
    await page.locator('#commandEditForm button[type="submit"]').click();
    assert.equal(await item.locator('.command-pin').getAttribute('aria-pressed'), 'true');
    await page.locator('#commandDialog .modal-actions [data-close]').click();
    await page.locator('.pane[data-slot="0"] .terminal-mount').click({ position: { x: 90, y: 90 } });
    await menuButton.click();
    assert.equal(await menu.locator('button').first().innerText(), '★ 插入：My scope');
    await menu.locator('button').first().click();
    await page.waitForFunction(() => window.favoritesFixture.messages.some(message => message.type === 'input' && message.data === '%aware_data0'));
    assert.equal(await page.locator('#pathCommandDialog').isVisible(), false);
    await page.locator('#saveButton').click();
    const saved = await page.evaluate(() => window.favoritesFixture.messages.filter(message => message.type === 'save').at(-1).config);
    await emit({ type: 'init', config: saved });
    await menuButton.click();
    assert.equal(await menu.locator('button').first().innerText(), '★ 插入：My scope');
    await page.keyboard.press('Escape');
    await page.locator('#commandButton').click();
    await page.locator('#commandPackSelect').selectOption('personal-favorites');
    await item.locator('.command-pin').click();
    assert.equal(await item.locator('.command-pin').getAttribute('aria-pressed'), 'false');
    await page.locator('#commandDialog .modal-actions [data-close]').click();
    await menuButton.click();
    assert.equal(await menu.locator('button').first().innerText(), '複製選取文字');
    assert.equal(await menu.getByRole('button', { name: '插入：My scope', exact: true }).count(), 1);
    assert.deepEqual(errors, []);
    console.log('Favorites UI passed: selection save/cancel, pin/unpin, exact literal insertion, export and configuration reload.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
