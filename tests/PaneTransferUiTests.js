'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),ui=path.join(root,'ui');
async function main(){
 const server=http.createServer((req,res)=>{const file=path.resolve(ui,'.'+new URL(req.url,'http://localhost').pathname.replace(/^\/$/,'/index.html'));if(!file.startsWith(ui+path.sep)){res.writeHead(403);return res.end();}fs.readFile(file,(e,b)=>{if(e){res.writeHead(404);return res.end();}res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream');res.end(b);});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;let count=0;const errors=[];
 try{browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1380,height:900}});page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{const f=window.fixture={messages:[],terminals:[]};window.chrome=window.chrome||{};window.chrome.webview={postMessage:m=>{f.messages.push(m);if(m.type==='relocate')setTimeout(()=>f.emit({type:'relocated',requestId:m.requestId,error:f.reject?'test disk failure':undefined}),50);},addEventListener:(_,fn)=>f.emit=m=>fn({data:m})};let Type;Object.defineProperty(window,'Terminal',{get:()=>Type,set:Base=>Type=class extends Base{constructor(...a){super(...a);f.terminals.push(this);}}});});
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.evaluate(()=>{fixture.terminals=[];fixture.emit({type:'init',config:{workspaces:[{id:'one',name:'Network',rows:1,cols:2,slots:[{tabs:[{id:'t',name:'Server',shell:'CMD',cwd:'C:\\Tools'}]},{tabs:[{id:'t',name:'Client',shell:'CMD'}]}]},{id:'two',name:'Devices',rows:1,cols:2}]}});fixture.emit({type:'started',workspaceId:'one',slot:0,tabId:'t',generation:1,pid:1234});fixture.emit({type:'output',workspaceId:'one',slot:0,tabId:'t',generation:1,data:btoa('C:\\Tools>echo marker')});});
 const pane=(w,i)=>page.locator('[data-workspace-id="'+w+'"] .pane').nth(i),menu=page.locator('#terminalContextMenu');
 const title=(w,i)=>pane(w,i).locator('.pane-title-row');
 await title('one',0).dragTo(title('one',1));await page.waitForFunction(()=>!document.body.classList.contains('transfer-pending'));
 assert.equal(await pane('one',1).locator('.pane-name').innerText(),'Server');assert.equal(await pane('one',0).locator('.pane-name').innerText(),'Client');
 assert.ok(await pane('one',1).locator('.pane-state').innerText().then(s=>s.includes('1234')));count++;
 await pane('one',1).locator('.xterm-helper-textarea').first().focus();await page.keyboard.type('X');
 let inputs=await page.evaluate(()=>fixture.messages.filter(m=>m.type==='input'));assert.equal(inputs.at(-1).slot,1);assert.ok(inputs.at(-1).routeId);count++;
 await page.evaluate(()=>fixture.emit({type:'output',workspaceId:'one',slot:1,tabId:'t',generation:1,data:btoa('X')}));await page.waitForTimeout(80);
 assert.equal(await page.evaluate(()=>fixture.terminals[0].element.closest('.pane').dataset.slot),'1');assert.ok(await page.evaluate(()=>fixture.terminals[0].buffer.active.getLine(0).translateToString(true).includes('markerX')));count++;
 await title('one',1).click({button:'right'});await menu.getByRole('button',{name:'複製此分頁設定',exact:true}).click();
 await title('one',0).click({button:'right'});await menu.getByRole('button',{name:'在此格貼上分頁設定',exact:true}).click();
 assert.equal(await pane('one',0).locator('.terminal-tab').count(),2);assert.equal(await pane('one',0).locator('.pane-folder-path').innerText(),'C:\\Tools');assert.equal(await page.evaluate(()=>fixture.messages.filter(m=>m.type==='start').length),0);count++;
 // Drag a single live tab into another cell, preserving the target's existing tabs.
 await pane('one',1).locator('.terminal-tab').first().dragTo(title('one',0));await page.waitForFunction(()=>!document.body.classList.contains('transfer-pending'));
 assert.equal(await pane('one',0).locator('.terminal-tab').count(),3);assert.equal(await pane('one',1).locator('.terminal-tab').count(),1);assert.equal(await pane('one',1).locator('.pane-name').innerText(),'新終端');count++;
 // Cross-workspace move from the explicit picker.
 await title('one',0).click({button:'right'});await menu.getByRole('button',{name:'移動到工作區／格子…',exact:true}).click();
 await page.locator('.transfer-workspace').selectOption('two');await page.locator('.transfer-slot').selectOption('1');await page.locator('.transfer-dialog').getByRole('button',{name:'確定',exact:true}).click();
 await page.waitForFunction(()=>!document.body.classList.contains('transfer-pending'));assert.equal(await pane('two',1).locator('.pane-name').innerText(),'Server');assert.equal(await page.evaluate(()=>fixture.terminals[0].element.closest('[data-workspace-id]').dataset.workspaceId),'two');count++;
 await title('two',1).click({button:'right'});await menu.getByRole('button',{name:'剪下此分頁（貼上後移動）',exact:true}).click();
 await title('two',0).click({button:'right'});await menu.getByRole('button',{name:'將剪下的分頁移到此格',exact:true}).click();await page.waitForFunction(()=>!document.body.classList.contains('transfer-pending'));assert.equal(await pane('two',0).locator('.pane-name').innerText(),'Server');count++;
 await page.evaluate(()=>fixture.reject=true);await title('two',0).dragTo(title('two',1));await page.waitForFunction(()=>!document.body.classList.contains('transfer-pending'));assert.equal(await pane('two',0).locator('.pane-name').innerText(),'Server');assert.match(await page.locator('#toast').innerText(),/未移動/);count++;
 assert.equal(await page.evaluate(()=>fixture.messages.filter(m=>m.type==='stop').length),0);
 fs.mkdirSync(path.join(root,'.test-work','pane-transfer-ui'),{recursive:true});await title('two',0).click({button:'right'});await page.screenshot({path:path.join(root,'.test-work','pane-transfer-ui','menu.png')});assert.deepEqual(errors,[]);count++;
 await menu.getByRole('button',{name:'關閉並移除此分頁…',exact:true}).click();await page.locator('#confirmAccept').click();
 assert.equal(await pane('two',0).locator('.terminal-tab').count(),1);assert.equal(await page.evaluate(()=>fixture.messages.filter(m=>m.type==='stop').length),1);count++;
 await title('two',0).click({button:'right'});await menu.getByRole('button',{name:'關閉並移除此分頁…',exact:true}).click();await page.locator('#confirmAccept').click();
 assert.equal(await pane('two',0).locator('.terminal-tab').count(),1);assert.equal(await pane('two',0).locator('.pane-name').innerText(),'終端 1');assert.deepEqual(errors,[]);count++;
 console.log('Pane transfer UI: '+count+' mouse/menu, running state, stable routing, copy, cross-workspace, cut/paste and rejection checks passed.');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
}main().catch(e=>{console.error(e);process.exitCode=1;});
