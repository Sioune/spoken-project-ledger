// Browser proof with isolated, entirely fictional API responses; no live DB writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const base=new URL(process.env.LEDGER_QA_BASE||'http://127.0.0.1:5193');
assert.equal(base.hostname,'127.0.0.1');assert.equal(base.protocol,'http:');
const runtime=process.env.LEDGER_QA_PLAYWRIGHT||`${process.env.HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs`;
const {chromium}=await import(pathToFileURL(runtime).href);
const fixture=JSON.parse(fs.readFileSync('tests/visual-fixture.json','utf8'));
fixture.identity={displayName:'虚构账号',draftScope:'a'.repeat(64)};
fixture.data.tasks.find(t=>t.id==='demo-t2').dependencies=['demo-t1'];
fixture.data.tasks.find(t=>t.id==='demo-t2').status='blocked';
let lastReceipt,submitted=[],backupRequested=false,backupMode='valid';
const browser=await chromium.launch({headless:true,executablePath:process.env.LEDGER_QA_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}});
const page=await context.newPage();page.setDefaultTimeout(10000);
await context.route('**/*',async route=>{
 const req=route.request(),url=new URL(req.url());if(url.origin!==base.origin)return route.abort('blockedbyclient');
 const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 if(url.pathname==='/api/state')return json(fixture);
 if(url.pathname==='/api/intake/capabilities')return json({draft_scope:'a'.repeat(64),vision:{configured:false,enabled:false}});
 if(url.pathname==='/api/operations'&&req.method()==='GET')return json({operations:[]});
 if(url.pathname==='/api/account-backup'){
  assert.equal(req.headers()['x-ledger-account-scope'],'a'.repeat(64));assert.equal(req.headers()['x-ledger-backup'],'download');backupRequested=true;
  if(backupMode==='html')return route.fulfill({status:200,contentType:'text/html',body:'<title>登录</title>'});
  const names=['accounts','ledgers','operations','images','image_recognitions'];
  return json({format:'d1-account-snapshot-v1',scope:'authenticated-account',complete:true,tables:Object.fromEntries(names.map(name=>[name,{columns:[],rows:name==='accounts'?[[]]:[]}])),row_counts:Object.fromEntries(names.map(name=>[name,name==='accounts'?1:0]))});
 }
 if(url.pathname==='/api/operations'&&req.method()==='POST'){
  const body=req.postDataJSON();assert.equal(req.headers()['x-ledger-account-scope'],'a'.repeat(64));
  const update=body.changes[0];assert.equal(update.type,'update');assert.equal(update.id,'demo-t1');
  submitted.push(update.values.dependencies);Object.assign(fixture.data.tasks.find(t=>t.id===update.id),update.values);fixture.revision++;
  lastReceipt={operation_id:body.operation_id,state:'verified',result_version:fixture.revision,changes:body.changes,before:{},after:{}};return json(lastReceipt);
 }
 if(url.pathname.startsWith('/api/operations/'))return json(lastReceipt);
 if(url.pathname.startsWith('/api/'))return json({error:'FIXTURE_ONLY'},404);
 if(!['GET','HEAD'].includes(req.method()))return route.abort('blockedbyclient');return route.continue();
});
try {
 await page.goto(base.origin+'/?view=today',{waitUntil:'domcontentloaded'});
 await page.getByRole('button',{name:'编辑完善演示版本的首页交互'}).click();
 await page.getByRole('heading',{name:'更新任务'}).waitFor();
 const cycle=page.getByRole('checkbox',{name:'前序任务：整理下一轮体验测试问题（产品体验升级）'});
 assert.equal(await cycle.isDisabled(),true);
 const incomplete=page.getByRole('checkbox',{name:'前序任务：校对项目方案与版本清单（资料与归档）'});
 await incomplete.check();assert.equal(await page.getByRole('button',{name:'确认保存'}).isDisabled(),true);
 await page.getByText('所选前序尚未完成，请先将任务状态改为待办或有前序依赖。').waitFor();await incomplete.uncheck();
 const done=page.getByRole('checkbox',{name:'前序任务：完成资料归档与版本说明（资料与归档）'});await done.check();
 await page.getByRole('button',{name:'确认保存'}).click();await page.getByText('已保存，并从正式记录读回').waitFor();
 assert.deepEqual(submitted[0],['demo-t6']);
 await page.getByRole('button',{name:'编辑完善演示版本的首页交互'}).click();
 assert.equal(await page.getByRole('checkbox',{name:'前序任务：完成资料归档与版本说明（资料与归档）'}).isChecked(),true);
 await page.getByRole('checkbox',{name:'前序任务：完成资料归档与版本说明（资料与归档）'}).uncheck();
 await page.getByRole('button',{name:'确认保存'}).click();await page.getByText('已保存，并从正式记录读回').waitFor();assert.deepEqual(submitted[1],[]);
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByText('含本人全部操作历史和图片原图',{exact:false}).waitFor();
 backupMode='html';await page.getByRole('button',{name:'下载本人备份'}).click();await page.getByText('未收到有效的本人备份，请重新登录后重试。').waitFor();
 backupMode='valid';await page.evaluate(()=>Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>false}));
 await page.getByRole('button',{name:'下载本人备份'}).click();await page.getByText('页面已切到后台或失去焦点，备份未下载；请返回并重新核验账号后重试。').waitFor();
 await page.evaluate(()=>delete document.hasFocus);
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'下载本人备份'}).click();const download=await downloadPromise;
 assert.match(download.suggestedFilename(),/^项目簿本人备份-.*\.json$/);assert.equal(backupRequested,true);
 await page.getByText('已下载本人数据备份').waitFor();
 console.log(JSON.stringify({verified:true,addAndRemove:true,cycleRejected:true,unfinishedBlocked:true,accountBackupDownload:true,loginPageRejected:true,backgroundDownloadRejected:true,onlyFictionalLocalData:true}));
} finally {await context.close();await browser.close();}
