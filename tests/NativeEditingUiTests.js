'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),readline=require('node:readline'),{spawn}=require('node:child_process');
const {chromium}=require('playwright'); const root=path.resolve(__dirname,'..'),ui=path.join(root,'ui');
async function main(){
 const server=http.createServer((req,res)=>{const file=path.resolve(ui,'.'+new URL(req.url,'http://localhost').pathname.replace(/^\/$/,'/index.html')); if(!file.startsWith(ui+path.sep)){res.writeHead(403);return res.end();} fs.readFile(file,(e,b)=>{if(e){res.writeHead(404);return res.end();} res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream');res.end(b);});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); let browser,child; let count=0;
 try{browser=await chromium.launch({channel:'msedge',headless:true});
 for(const shell of ['CMD','PowerShell']){
  const cwd=path.join(root,'.test-work','native-edit-'+shell);fs.mkdirSync(cwd,{recursive:true});
  const page=await browser.newPage({viewport:{width:1300,height:850}});page.setDefaultTimeout(10000);
  child=spawn(path.join(root,'.test-work','NativeEditingHarness.exe'),[cwd,shell],{windowsHide:true,stdio:['pipe','pipe','pipe']}); let chain=Promise.resolve();
  child.stderr.on('data',d=>process.stderr.write(d));
  await page.exposeFunction('nativeSend',m=>{if(['start','input','resize','stop'].includes(m.type))child.stdin.write(JSON.stringify(m)+'\n');});
  await page.addInitScript(()=>{const f=window.fixture={messages:[],terminals:[]};window.chrome=window.chrome||{};window.chrome.webview={postMessage:m=>{f.messages.push(m);window.nativeSend(m);},addEventListener:(_,fn)=>{f.emit=m=>fn({data:m});}};let Type;Object.defineProperty(window,'Terminal',{get:()=>Type,set:Base=>{Type=class extends Base{constructor(...a){super(...a);f.terminals.push(this);}};}});});
  fs.writeFileSync(path.join(cwd,'native-output.jsonl'),'');
  const lines=readline.createInterface({input:child.stdout});lines.on('line',line=>{const m={...JSON.parse(line),workspaceId:'real',slot:0,tabId:'test',generation:1};fs.appendFileSync(path.join(cwd,'native-output.jsonl'),JSON.stringify(m.type==='output'?{text:Buffer.from(m.data,'base64').toString('utf8')}:m)+'\n');chain=chain.then(()=>page.evaluate(m=>window.fixture.emit(m),m));});
  await page.goto('http://127.0.0.1:'+server.address().port); await page.evaluate(shell=>{window.fixture.terminals=[];window.fixture.emit({type:'init',config:{workspaces:[{id:'real',rows:1,cols:1,slots:[{tabs:[{id:'test',shell,name:'Native'}]}]}]}});},shell);
  await page.locator('.pane').first().locator('.pane-start').click();
  const text=()=>page.evaluate(()=>{const t=window.fixture.terminals[0],b=t.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString(true)).join('\n');});
  await page.waitForFunction(()=>{const t=window.fixture.terminals[0],b=t.buffer.active;return b.getLine(b.baseY+b.cursorY).translateToString(true).includes('>');});
  await page.keyboard.type('echo 000111000',{delay:35});
  await page.waitForFunction(()=>window.fixture.terminals[0].buffer.active.getLine(window.fixture.terminals[0].buffer.active.baseY+window.fixture.terminals[0].buffer.active.cursorY).translateToString(true).includes('000111000'));
  async function select(value){const box=await page.evaluate(value=>{const t=window.fixture.terminals[0],b=t.buffer.active,y=b.baseY+b.cursorY,line=b.getLine(y),rect=t.element.querySelector('.xterm-screen').getBoundingClientRect();let x=-1;for(let i=0;i<t.cols-value.length;i++)if(Array.from({length:value.length},(_,n)=>line.getCell(i+n).getChars()).join('')===value){x=i;break;} if(x<0)throw Error('missing selection '+value);return{x:rect.x+(x+.1)*rect.width/t.cols,end:rect.x+(x+value.length+.1)*rect.width/t.cols,y:rect.y+(y-b.viewportY+.5)*rect.height/t.rows};},value);await page.mouse.move(box.x,box.y);await page.mouse.down();await page.mouse.move(box.end,box.y,{steps:8});await page.mouse.up();}
  await select('111');await page.keyboard.press('Backspace');await page.waitForTimeout(350);
  fs.writeFileSync(path.join(cwd,'delete-diagnostic.json'),JSON.stringify(await page.evaluate(()=>({toast:document.getElementById('toast').textContent,selection:window.fixture.terminals[0].getSelection(),active:document.activeElement.className,inputs:window.fixture.messages.filter(m=>m.type==='input').map(m=>m.data)})),null,2));
  assert.ok((await text()).includes('echo 000000'),shell+' mouse-selected Backspace should delete middle argument'); count++;
  await select('000000');await page.keyboard.type('222',{delay:60});await page.waitForTimeout(350);
  fs.writeFileSync(path.join(cwd,'replace-diagnostic.json'),JSON.stringify(await page.evaluate(()=>{const t=window.fixture.terminals[0],b=t.buffer.active,l=b.getLine(b.baseY+b.cursorY);return {toast:document.getElementById('toast').textContent,selection:t.getSelection(),cursor:b.cursorX,screen:l.translateToString(false),cells:Array.from({length:t.cols},(_,i)=>l.getCell(i).getChars()).join('|'),inputs:window.fixture.messages.filter(m=>m.type==='input').map(m=>m.data)};}),null,2));
  assert.ok((await text()).includes('echo 222'),shell+' typing should replace selection');count++;
  const beforeDelete=await page.evaluate(()=>fixture.terminals[0].buffer.active.cursorX);
  await select('222');await page.keyboard.press('Delete');
  await page.waitForFunction(x=>fixture.terminals[0].buffer.active.cursorX===x-3,beforeDelete);
  fs.writeFileSync(path.join(cwd,'second-delete-diagnostic.json'),JSON.stringify({screen:await text(),...await page.evaluate(()=>({toast:document.getElementById('toast').textContent,selection:fixture.terminals[0].getSelection(),inputs:fixture.messages.filter(m=>m.type==='input').map(m=>m.data)}))},null,2));
  count++; // PSReadLine may display a dim/italic suggestion after the cleared caret.
  await page.keyboard.type('000111000',{delay:35});await page.waitForTimeout(150);await select('111');await page.keyboard.type('222',{delay:60});await page.waitForTimeout(350);
  assert.ok((await text()).includes('echo 000222000'),shell+' typed replacement must preserve the suffix');count++;
  await page.keyboard.press('Enter');await page.waitForTimeout(350);assert.match(await text(),/222/);
  child.stdin.end();await chain;await page.close();lines.close();child=null;
 }
 console.log('Native editing UI: '+count+' actual CMD/PowerShell and mouse/keyboard checks passed.');
 }finally{if(child)child.stdin.end();if(browser)await browser.close();await new Promise(r=>server.close(r));}
}main().catch(e=>{console.error(e);process.exitCode=1;});
