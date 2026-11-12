'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), ui = path.join(root, 'ui');
async function main() {
  const server = http.createServer((req, res) => {
    const file = path.resolve(ui, '.' + new URL(req.url, 'http://localhost').pathname.replace(/^\/$/, '/index.html'));
    if (!file.startsWith(ui + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.setHeader('Content-Type', ({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css'})[path.extname(file)] || 'application/octet-stream'); res.end(b); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser; const errors = []; let count = 0;
  const pass = s => { count++; console.log('PASS ' + s); };
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(7000); page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      window.fixture = { messages: [], files: [] }; const f = window.fixture;
      window.chrome = window.chrome || {}; window.chrome.webview = {
        postMessage: m => f.messages.push(m),
        postMessageWithAdditionalObjects: (m, files) => { f.files.push(Array.from(files).map(x => x.name)); f.messages.push(m); },
        addEventListener: (_, fn) => { f.emit = data => fn({ data }); }
      };
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.fixture.emit);
    const config = { activeWorkspaceId: 'one', workspaces: [{ id:'one', name:'原工作區', rows:2, cols:2 }, {id:'two',name:'另一區',rows:2,cols:2}],
      commandPacks:[{id:'mine',name:'個人指令',commands:[{id:'c',name:'保留',command:'echo ORIGINAL'}]}] };
    const init = c => page.evaluate(c => { window.fixture.emit({type:'init',version:'3.10.0',config:c}); window.fixture.messages=[]; }, c);
    const messages = type => page.evaluate(type => window.fixture.messages.filter(m => m.type === type), type);
    const emit = m => page.evaluate(m => window.fixture.emit(m), m);
    async function drop(selector, names) { await page.locator(selector).first().evaluate((element, names) => { const data = new DataTransfer(); names.forEach(name => data.items.add(new File(['@echo fixture'], name))); element.dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:data})); }, names); }
    await init(config);
    assert.equal((await messages('start')).length, 0);
    await page.locator('#appOptions summary').click(); await page.locator('#helpButton').click();
    assert.ok((await page.locator('#helpDialog .eyebrow').innerText()).includes(require('../ui/help.js').version));
    await page.locator('#help-tab-1').click(); assert.match(await page.locator('#help-panel-1').innerText(), /JSON 流程資料/);
    await page.locator('#help-tab-2').click(); assert.match(await page.locator('#help-panel-2').innerText(), /有選取時複製/);
    fs.mkdirSync(path.join(root,'.test-work','batch-ui'), {recursive:true});
    await page.screenshot({path:path.join(root,'.test-work','batch-ui','help-shortcuts.png')});
    await page.setViewportSize({width:900,height:680});
    assert.equal(await page.locator('#helpDialog').evaluate(e => e.getBoundingClientRect().right <= innerWidth && e.getBoundingClientRect().bottom <= innerHeight), true);
    await page.screenshot({path:path.join(root,'.test-work','batch-ui','help-compact.png')});
    await page.locator('#helpDialog [data-close]').first().click(); await page.setViewportSize({width:1440,height:960});
    pass('versioned offline help, rules, shortcuts and compact viewport');
    const target = '[data-workspace-id="one"] .pane[data-slot="1"]';
    await drop(target + ' .pane-line-editor', ['a.bat','b.CMD']);
    let request = (await messages('batchDrop')).at(-1); assert.ok(request);
    assert.equal((await messages('batchDrop')).length, 1); assert.equal((await messages('input')).length, 0);
    await page.locator('.workspace-tab[data-workspace-id="two"]').click();
    const reply = {type:'batchFiles',requestId:request.requestId,files:[{name:'a.bat',path:'C:\\中文 & ! %VAR%\\a.bat',directory:'C:\\中文 & ! %VAR%'},{name:'b.CMD',path:'C:\\Tools\\b.CMD',directory:'C:\\Tools'}]};
    await emit(reply);
    let starts = await messages('start'); assert.equal(starts.length,2); assert.ok(starts.every(m => m.workspaceId === 'one' && m.slot === 1 && m.config.shell === 'CMD' && m.config.batchFile));
    assert.equal((await messages('stop')).length,0); assert.equal((await messages('input')).length,0);
    let saved = (await messages('save')).at(-1).config; assert.equal(saved.commandPacks[0].commands[0].command,'echo ORIGINAL');
    assert.equal(saved.workspaces[0].slots[1].tabs.length,3);
    assert.equal(await page.locator('.terminal-grid:visible').getAttribute('data-workspace-id'),'two');
    await emit(reply); assert.equal((await messages('start')).length,2);
    pass('two dropped files use captured target, create separate tabs once, preserve existing workspace and commands');
    await init(saved); assert.equal((await messages('start')).length,0);
    await page.locator('.workspace-tab[data-workspace-id="one"]').click();
    await page.locator(target + ' [data-action="configure"]').click();
    assert.equal(await page.locator('#settingBatchFile').inputValue(), reply.files[0].path);
    assert.equal(await page.locator('#settingCommand').isDisabled(),true);
    await page.locator('#settingsDialog [data-close]').first().click();
    pass('restored BAT reference is editable and never auto-runs');
    await page.locator('#appOptions summary').click(); await page.locator('#runBatchButton').click();
    request = (await messages('batchOpen')).at(-1); assert.ok(request);
    await emit({type:'batchFiles',requestId:request.requestId,cancelled:true}); assert.equal((await messages('start')).length,0);
    await page.locator('#appOptions summary').click(); await page.locator('#runBatchButton').click(); request = (await messages('batchOpen')).at(-1);
    await init(config); await emit({...reply,requestId:request.requestId}); assert.equal((await messages('start')).length,0);
    pass('picker cancellation and stale responses after config replacement do not execute');
    const full = structuredClone(config); full.workspaces[0].slots=[{tabs:Array.from({length:8},(_,i)=>({id:'t'+i,name:'tab'+i,shell:'CMD'}))}];
    await init(full); await drop('[data-workspace-id="one"] .pane[data-slot="0"]',['overflow.bat']); assert.equal((await messages('batchDrop')).length,0);
    assert.match(await page.locator('#toast').innerText(),/最多 8/);
    await init(config); await page.evaluate(() => delete window.chrome.webview.postMessageWithAdditionalObjects);
    await drop(target,['fallback.bat']); assert.equal((await messages('start')).length,0); assert.match(await page.locator('#toast').innerText(),/選檔執行/);
    pass('full cell rejects before execution; old runtime offers picker fallback');
    assert.deepEqual(errors,[]); console.log('Batch UI: '+count+' groups passed; host messages mocked, real Edge/xterm.');
  } finally { if (browser) await browser.close(); await new Promise(r => server.close(r)); }
}
main().catch(e => { console.error(e); process.exitCode=1; });
