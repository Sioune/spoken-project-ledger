import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from '../.sites-runtime/browser-qa/node_modules/playwright-core/index.mjs';
const base='http://127.0.0.1:5186',output='.sites-runtime/browser-proof';fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--disable-gpu']});
const errors=[];const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(base);await page.getByRole('heading',{name:'请从本人工作空间打开'}).waitFor();
 await page.goto(base+'/signin-with-chatgpt?return_to=/');await page.getByRole('heading',{name:'今天，推进一件件。'}).waitFor();
 const text='新增任务：虚构浏览器验收 '+crypto.randomUUID();await page.locator('#spoken-input').fill(text);await page.getByRole('button',{name:'预览变更',exact:true}).click();await page.getByText('核对本次变更',{exact:true}).waitFor();
 const post=page.waitForResponse(r=>r.url().endsWith('/api/operations')&&r.request().method()==='POST');await page.getByRole('button',{name:'确认并保存',exact:true}).click();const saved=await(await post).json();assert.equal(saved.state,'verified');await page.getByText('本次更新已读回验证',{exact:true}).waitFor();
 await page.reload();await page.getByRole('heading',{name:'今天，推进一件件。'}).waitFor();await page.getByRole('button',{name:text.replace('新增任务：',''),exact:true}).waitFor();
 await page.locator('#spoken-input').fill(text);await page.getByRole('button',{name:'预览变更',exact:true}).click();await page.getByText('已有相同任务，无需重复新增。',{exact:true}).waitFor();
 const s=await(await context.request.get(base+'/api/state')).json();assert.equal(s.data.tasks.filter(t=>t.title===text.replace('新增任务：','')).length,1);
 await page.screenshot({path:output+'/desktop.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 // A real concurrent write after preview must produce a visible conflict.
 await page.locator('#spoken-input').fill('新增任务：虚构冲突草稿 '+crypto.randomUUID());await page.getByRole('button',{name:'预览变更',exact:true}).click();await page.getByText('核对本次变更',{exact:true}).waitFor();
 const op=crypto.randomUUID();await context.request.post(base+'/api/operations',{data:{operation_id:op,idempotency_key:op,source_event_id:op,base_version:s.revision,occurred_at:new Date().toISOString(),raw_text:'虚构并发测试',changes:[]}});
 await page.getByRole('button',{name:'确认并保存',exact:true}).click();await page.locator('.conflict-panel').waitFor();assert.equal(await page.locator('.notice-success').count(),0);await page.getByRole('button',{name:'读取最新版本，再预览'}).click();
 // Controlled transport failure must leave input and the original operation ID.
 await page.route('**/api/operations',route=>route.request().method()==='POST'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'QA_FAILURE',message:'虚构保存失败'})}):route.continue());
 await page.locator('#spoken-input').fill('新增任务：虚构保存失败 '+crypto.randomUUID());await page.getByRole('button',{name:'预览变更',exact:true}).click();await page.getByText('核对本次变更',{exact:true}).waitFor();await page.getByRole('button',{name:'确认并保存',exact:true}).click();await page.locator('.pending-submission').waitFor();await page.getByText('未找到已提交记录，保存未确认成功',{exact:true}).waitFor();assert.ok((await page.locator('#spoken-input').inputValue()).includes('虚构保存失败'));await page.unroute('**/api/operations');await page.getByRole('button',{name:'读取最新并重新编辑',exact:true}).click();
 await page.setViewportSize({width:390,height:844});await page.reload();await page.getByRole('heading',{name:'今天，推进一件件。'}).waitFor();assert.equal(await page.locator('.mobile-nav').isVisible(),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:output+'/mobile.png',fullPage:true});
 await page.getByRole('navigation',{name:'手机导航'}).getByRole('button',{name:'设置',exact:true}).click();await page.getByText('Asia/Shanghai',{exact:true}).first().waitFor();await page.screenshot({path:output+'/mobile-settings.png',fullPage:true});
 assert.deepEqual(errors,[]);const report={checks:{unauthenticatedUI:true,createSaveReadback:true,reloadPersistence:true,duplicateNoInsert:true,conflictVisible:true,saveFailureNotSuccess:true,draftRetained:true,mobile390NoOverflow:true,desktop1440NoOverflow:true,mobileNavigation:true,noPageErrors:true},operation_id:saved.operation_id,result_version:saved.result_version,screenshots:['desktop.png','mobile.png','mobile-settings.png']};fs.writeFileSync(output+'/result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await context.close();await browser.close()}
