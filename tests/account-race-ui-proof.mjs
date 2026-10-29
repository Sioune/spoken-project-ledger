// Local-only browser proof with completely fictional API responses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const base=new URL(process.env.LEDGER_QA_BASE||'http://127.0.0.1:5191');
assert.equal(base.hostname,'127.0.0.1');assert.equal(base.protocol,'http:');
const runtime=process.env.LEDGER_QA_PLAYWRIGHT||`${process.env.HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs`;
const {chromium}=await import(pathToFileURL(runtime).href);
const browser=await chromium.launch({headless:true,executablePath:process.env.LEDGER_QA_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const fixture=JSON.parse(fs.readFileSync('tests/visual-fixture.json','utf8'));
const a='a'.repeat(64),b='b'.repeat(64), controls={account:'A',holdPreview:false,failState:false,holdNextState:false,stateRelease:null,holdHistory:false,historyRelease:null,historyScope:null,holdImage:false,imageRelease:null,imageOperation:null,imageReceiptScopes:[],writes:[],blocked:[],previewRelease:null};
function appState(name){const r=structuredClone(fixture);r.revision=41;r.identity={displayName:name,draftScope:name==='A'?a:b};r.data.projects[0].name=`项目 ${name}`;return r;}
const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1200}});const page=await context.newPage();page.setDefaultTimeout(10000);
await context.route('**/*',async route=>{
 const req=route.request(),url=new URL(req.url());if(url.origin!==base.origin)return route.abort('blockedbyclient');
 const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 if(url.pathname==='/api/state'){if(controls.failState)return json({error:'TEST_OFFLINE'},503);const snapshot=appState(controls.account);if(controls.holdNextState){controls.holdNextState=false;await new Promise(resolve=>{controls.stateRelease=resolve})}return json(snapshot);}
 if(url.pathname.startsWith('/api/')){
  const expected=controls.account==='A'?a:b;if(req.headers()['x-ledger-account-scope']!==expected){controls.blocked.push(url.pathname);return json({error:'ACCOUNT_CHANGED',message:'登录账号已变化'},409);}
  if(url.pathname==='/api/intake/capabilities')return json({draft_scope:expected,vision:{configured:false,enabled:false}});
  if(url.pathname==='/api/operations'&&req.method()==='GET')return json({operations:controls.account==='A'?[{operation_id:'history-op',raw_text:'A 的历史回执',state:'saved',result_version:5,changes:[],before:{},after:{}}]:[]});
  if(url.pathname.startsWith('/api/operations/image-op-')){controls.imageReceiptScopes.push(req.headers()['x-ledger-account-scope']);return json({operation_id:decodeURIComponent(url.pathname.split('/').at(-1)),state:'verified',result_version:41,changes:[],before:{},after:{}});}
  if(url.pathname==='/api/operations/history-op'){controls.historyScope=req.headers()['x-ledger-account-scope'];if(controls.holdHistory)await new Promise(resolve=>{controls.historyRelease=resolve});return json({operation_id:'history-op',raw_text:'A 的延迟历史',state:'verified',result_version:5,changes:[],before:{},after:{}});}
  if(url.pathname==='/api/intake/preview'){const form=await new Response(req.postDataBuffer(),{headers:{'Content-Type':req.headers()['content-type']}}).formData();const d=JSON.parse(form.get('draft_json'));return json({fields:d.fields,changes:[{type:'create',values:{title:d.fields.title,project_id:'demo-product'}}],questions:[],candidates:[],duplicate:false,summary:'虚构图片预览',base_version:41,source_event_id:d.source_event_id,occurred_at:'2026-10-29T00:00:00Z'});}
  if(url.pathname==='/api/intake/commit'){const form=await new Response(req.postDataBuffer(),{headers:{'Content-Type':req.headers()['content-type']}}).formData();controls.imageOperation=JSON.parse(form.get('payload_json')).operation_id;if(controls.holdImage)await new Promise(resolve=>{controls.imageRelease=resolve});return json({operation_id:controls.imageOperation});}
  if(url.pathname==='/api/preview'){
   if(controls.holdPreview) await new Promise(resolve=>{controls.previewRelease=resolve});
   return json({summary:'账号 A 的旧预览',changes:[{type:'create',values:{title:'A 私有任务'}}],questions:[],base_version:41,source_event_id:'fixture-source',occurred_at:'2026-10-29T00:00:00Z'});
  }
  if(url.pathname==='/api/operations'&&req.method()==='POST'){controls.writes.push({account:controls.account,body:req.postData()});return json({error:'FIXTURE_BLOCKED'},500)}
  return json({error:'FIXTURE_ONLY'},404);
 }
 if(!['GET','HEAD'].includes(req.method()))return route.abort('blockedbyclient');return route.continue();
});
try{
 await page.goto(base.origin+'/?view=today',{waitUntil:'networkidle'});
 const input=page.getByLabel('粘贴口述转写或输入任务更新');await input.waitFor();
 await input.fill('账号 A 的私有草稿'); controls.holdPreview=true;
 await page.getByRole('button',{name:'预览变更'}).click();
 await page.waitForFunction(()=>document.body.textContent.includes('预览'));
 while(!controls.previewRelease)await new Promise(resolve=>setTimeout(resolve,10));
 controls.account='B';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await page.getByText('项目 B',{exact:true}).first().waitFor();controls.previewRelease();
 await page.waitForTimeout(200);assert.equal(await input.inputValue(),'');assert.equal(await page.getByText('账号 A 的旧预览',{exact:true}).count(),0);assert.equal(await page.getByText('A 私有任务',{exact:true}).count(),0);
 // Revisit A, create an A preview, then switch credentials without firing focus.
 controls.account='A';controls.holdPreview=false;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByText('项目 A',{exact:true}).first().waitFor();
 await input.fill('只属于 A 的待提交内容');await page.getByRole('button',{name:'预览变更'}).click();await page.getByText('账号 A 的旧预览',{exact:true}).waitFor();
 controls.account='B';await page.getByRole('button',{name:'确认并保存',exact:true}).click();await page.getByText('项目 B',{exact:true}).first().waitFor();
 assert.deepEqual(controls.writes,[]);assert.ok(controls.blocked.includes('/api/operations'));assert.equal(await input.inputValue(),'');assert.equal(await page.getByText('账号 A 的旧预览',{exact:true}).count(),0);
 controls.account='A';controls.holdNextState=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));while(!controls.stateRelease)await new Promise(resolve=>setTimeout(resolve,10));controls.account='B';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByText('项目 B',{exact:true}).first().waitFor();controls.stateRelease();await page.waitForTimeout(200);assert.equal(await page.getByText('项目 A',{exact:true}).count(),0);
 controls.failState=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByText('暂时无法核验当前账号，原有内容已暂时隐藏。').waitFor();assert.equal(await page.getByText('项目 B',{exact:true}).first().isVisible(),false);controls.failState=false;await page.getByRole('button',{name:'重新核验',exact:true}).click();await page.getByText('项目 B',{exact:true}).first().waitFor();
 controls.account='A';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByText('项目 A',{exact:true}).first().waitFor();await page.getByRole('button',{name:'操作历史',exact:true}).click();await page.getByText('A 的历史回执',{exact:true}).waitFor();controls.holdHistory=true;await page.getByText('A 的历史回执',{exact:true}).click();while(!controls.historyRelease)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(controls.historyScope,a);controls.account='B';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByText('项目 B',{exact:true}).first().waitFor();controls.historyRelease();await page.waitForTimeout(200);assert.equal(await page.getByText('A 的延迟历史',{exact:true}).count(),0);
 // Preserve a second user's image draft while the first user's old save is in flight.
 await page.getByRole('button',{name:'今天',exact:true}).click();await page.getByRole('button',{name:'选择事项图片',exact:true}).waitFor();await page.getByLabel('图片补充说明').fill('B 的独立图片草稿');
 await page.getByText('本人本机草稿已保存',{exact:true}).waitFor();await page.evaluate(scope=>localStorage.removeItem('spoken-projects:temporary-draft:v2:'+scope),a);controls.account='A';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByText('项目 A',{exact:true}).first().waitFor();
 await input.fill('A 的独立文字草稿');await page.getByRole('button',{name:'手动填写',exact:true}).click();await page.getByLabel('事项标题',{exact:true}).fill('A 的图片事项');await page.getByRole('button',{name:'生成核对预览',exact:true}).click();await page.getByText('虚构图片预览',{exact:true}).waitFor();
 await page.getByRole('button',{name:'确认保存图片与事项',exact:true}).click();await page.getByText('图片与事项已保存，并已独立读回验证。',{exact:true}).waitFor();assert.equal(await input.inputValue(),'A 的独立文字草稿');assert.deepEqual(controls.imageReceiptScopes,[a]);
 await page.getByRole('button',{name:'手动填写',exact:true}).click();await page.getByLabel('事项标题',{exact:true}).fill('A 的延迟图片事项');await page.getByRole('button',{name:'生成核对预览',exact:true}).click();await page.getByText('虚构图片预览',{exact:true}).waitFor();controls.holdImage=true;await page.getByRole('button',{name:'确认保存图片与事项',exact:true}).click();while(!controls.imageRelease)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(await page.getByRole('button',{name:'预览变更'}).isDisabled(),true);
 controls.account='B';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByText('项目 B',{exact:true}).first().waitFor();await page.getByLabel('图片补充说明').waitFor();assert.equal(await page.getByLabel('图片补充说明').inputValue(),'B 的独立图片草稿');controls.imageRelease();await page.waitForTimeout(200);assert.equal(await page.getByLabel('图片补充说明').inputValue(),'B 的独立图片草稿');assert.deepEqual(controls.imageReceiptScopes,[a]);
 // An unverified text save prevents image submission and preserves its operation ID.
 await input.fill('B 的待核验文字');await page.getByRole('button',{name:'预览变更'}).click();await page.getByText('账号 A 的旧预览',{exact:true}).waitFor();await page.getByRole('button',{name:'确认并保存',exact:true}).click();await page.getByText('上一次提交尚待核对',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'手动填写',exact:true}).isDisabled(),true);assert.equal(await input.inputValue(),'B 的待核验文字');
 console.log(JSON.stringify({status:'verified',scopeRace:true,stalePreviewDiscarded:true,crossAccountWriteBlocked:true,failedRevalidationHidesData:true,outOfOrderStateIgnored:true,historyScopeAndRace:true,imageReceiptPreservesText:true,imageRacePreservesOtherDraft:true,pendingTextBlocksImage:true,pendingImageBlocksText:true,onlyFictionalLocalData:true}));
}finally{await context.close();await browser.close()}
