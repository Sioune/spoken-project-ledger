import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import ts from 'typescript';
import {base,verifyLocalLedger} from './local-base.mjs';

// Real local writes only. Never initialize/restore a ledger or invoke a real provider.
assert.ok(process.env.LEDGER_QA_BASE,'Explicit LEDGER_QA_BASE is required');
assert.equal(base,'http://127.0.0.1:5194','This proof is locked to the isolated ledger on port 5194');
await verifyLocalLedger();
const out=path.resolve('.sites-runtime/image-intake-flow-proof');fs.mkdirSync(out,{recursive:true});
const imagePath=process.env.LEDGER_QA_IMAGE_PATH||'C:/Users/赵元章/AppData/Local/Temp/codex-clipboard-2b2e39ad-5eef-46f8-8471-080043e28329.png';
const original=fs.readFileSync(imagePath),sha=bytes=>createHash('sha256').update(bytes).digest('hex'),originalHash=sha(original);
assert.ok(original.length>0&&original.length<=1500000,'Original screenshot must fit the disclosed private image limit');
assert.deepEqual([...original.subarray(0,8)],[137,80,78,71,13,10,26,10],'This sample proof expects the original PNG screenshot');
const shared=ts.transpileModule(fs.readFileSync(new URL('../lib/intake-types.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {EMPTY_INTAKE_FIELDS}=await import('data:text/javascript;base64,'+Buffer.from(shared).toString('base64'));
const run=randomUUID(),date='2026-10-17',time='17:00',location='南里山房太阳宫山海',checks=[],http=[],writes=[],screenshots=[];
const report={production_write:false,provider_calls:0,actual_image_content_recognized:false,base,image:{sha256:originalHash,byte_size:original.length},checks,http,writes,screenshots};
let cookie='';
const stateHash=state=>sha(Buffer.from(JSON.stringify(state)));
const save=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\n','utf8');
const refs=state=>[...new Set(state.data.tasks.flatMap(task=>task.attachment_ids??[]))].sort();

async function call(route,{method='GET',body,anonymous=false,json=false}={}){
 const target=new URL(route,base);assert.equal(target.origin,base);assert.equal(target.hostname,'127.0.0.1');
 const response=await fetch(target,{method,body:json?JSON.stringify(body):body,redirect:'manual',headers:{...(!anonymous&&cookie?{Cookie:cookie}:{}),...(json?{'Content-Type':'application/json'}:{})},signal:AbortSignal.timeout(30000)});
 http.push({method,path:target.pathname,status:response.status});assert.ok(response.status<300||response.status>=400,'No redirects may be followed');
 let result=null;if(response.headers.get('content-type')?.includes('application/json'))result=await response.json();
 return {response,status:response.status,result};
}
async function getState(){const result=await call('/api/state');assert.equal(result.status,200);assert.equal(result.result.initialized,true,'Use an already initialized isolated local ledger');return result.result;}
function form(key,value,bytes=original,filename='original-banquet.png'){
 const data=new FormData();data.set(key,JSON.stringify(value));data.set('image',new Blob([bytes],{type:'image/png'}),filename);return data;
}
async function preview(fields,{note='本机隔离验收：仅核对已有预约并关联原图，不重复订位。',source=`qa-image-preview-${run}`,bytes=original,filename}={}){
 const result=await call('/api/intake/preview',{method:'POST',body:form('draft_json',{fields,note,questions:[],source_event_id:source},bytes,filename)});assert.equal(result.status,200,'Local manual preview must succeed without a provider');return result.result;
}
const operation=(state,changes,source)=>({operation_id:`qa-image-op-${randomUUID()}`,idempotency_key:`qa-image-key-${randomUUID()}`,source_event_id:source,base_version:state.revision,occurred_at:new Date().toISOString(),raw_text:'【本机隔离验收】截图对应已预约晚宴，仅验证原图关联与回执，不是生产业务更新。',changes,confirmed:true});
async function commit(payload,bytes=original,filename='original-banquet.png'){return call('/api/intake/commit',{method:'POST',body:form('payload_json',payload,bytes,filename)});}
async function image(id,anonymous=false){return call(`/api/images/${encodeURIComponent(id)}`,{anonymous});}
async function sameState(expected){const latest=await getState();assert.deepEqual(latest,expected,'Read-only/rejected flow must preserve the complete local state');return latest;}
function sameBusiness(before,after,targetId){
 assert.equal(after.data.tasks.length,before.data.tasks.length);assert.equal(after.data.projects.length,before.data.projects.length);
 for(const key of ['projects','documents','pending','settings','reminderLog'])assert.deepEqual(after.data[key],before.data[key]);
 for(const old of before.data.tasks){const current=after.data.tasks.find(task=>task.id===old.id);assert.ok(current);if(old.id!==targetId)assert.deepEqual(current,old);else{const strip=task=>Object.fromEntries(Object.entries(task).filter(([key])=>!['attachment_ids','version','updated_at'].includes(key)));assert.deepEqual(strip(current),strip(old));}}
}
function pngProbe(){
 const crc32=bytes=>{let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}return (crc^0xffffffff)>>>0;};
 const chunk=(name,data)=>{const kind=Buffer.from(name),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([kind,data])));return Buffer.concat([length,kind,data,crc]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('tEXt',Buffer.from(`qa\0${run}`)),chunk('IDAT',deflateSync(Buffer.from([0,0,0,0,255]))),chunk('IEND',Buffer.alloc(0))]);
}

async function browserProof(target,fields){
 if(process.env.LEDGER_QA_SKIP_BROWSER==='1'){report.browser={skipped:true,reason:'HTTP proof requested; fixture UI is covered separately'};return;}
 const {chromium}=await import('../.sites-runtime/browser-qa/node_modules/playwright-core/index.mjs');
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--disable-gpu']});
 const blocked=[],pageErrors=[];
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1100},locale:'zh-CN',serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',error=>pageErrors.push(error.message));
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==base){blocked.push({reason:'external',method:request.method(),path:url.pathname});return route.abort();}if(!['GET','HEAD'].includes(request.method())&&!(request.method()==='POST'&&url.pathname==='/api/intake/preview')){blocked.push({reason:'unexpected-write',method:request.method(),path:url.pathname});return route.abort();}return route.continue();});
  await page.goto(base+'/signin-with-chatgpt?return_to=/',{waitUntil:'networkidle'});
  const intake=page.getByRole('region',{name:'图片与事项'});await intake.getByLabel('选择事项图片').waitFor({state:'attached'});
  await intake.getByLabel('选择事项图片').setInputFiles(imagePath);await intake.getByRole('button',{name:'手动填写',exact:true}).click();
  await intake.getByLabel('图片补充说明').fill('本机验收：已有预约，仅核对并关联原图。');
  await intake.getByLabel('事项标题',{exact:true}).fill(fields.title);await intake.getByLabel('内容分类',{exact:true}).selectOption('reserved_event');await intake.getByLabel('记录类型',{exact:true}).selectOption('event');
  await intake.getByLabel('事项所属项目').selectOption(target.project_id);await intake.getByLabel('活动状态',{exact:true}).selectOption('reserved');
  await intake.getByLabel('活动日期（未知可留空）',{exact:true}).fill(date);await intake.getByLabel('开始时间（北京时间，可留空）',{exact:true}).fill(time);await intake.getByLabel('事项地点').fill(location);await intake.getByLabel('事项下一步').fill('按约参加晚宴，不重复订位');await intake.getByLabel('本次事项操作').selectOption('create');
  await intake.getByRole('checkbox').check();await intake.getByRole('button',{name:'生成核对预览',exact:true}).click();
  await intake.getByRole('region',{name:'图片事项核对预览'}).waitFor();assert.ok(await intake.getByText('发现已有事项，本次默认仅查看',{exact:true}).isVisible());assert.equal(await intake.getByRole('button',{name:'确认保存图片与事项',exact:true}).isDisabled(),true);assert.equal(await intake.getByRole('button',{name:'识别预览',exact:true}).isDisabled(),true);
  await page.screenshot({path:path.join(out,'real-image-manual-duplicate-desktop.png'),fullPage:true});screenshots.push('real-image-manual-duplicate-desktop.png');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  if(today==='2026-10-16'){
   assert.equal(await page.getByRole('region',{name:'今天的活动'}).getByRole('button',{name:`查看活动：${target.title}`,exact:true}).count(),0);
   assert.equal(await page.locator('.focus-panel').getByText(target.title,{exact:true}).count(),0);assert.equal(await page.locator('.task-list').getByText(target.title,{exact:true}).count(),0);
   await page.getByRole('group',{name:'按日期查看事项'}).getByRole('button',{name:'明天',exact:true}).click();await page.getByRole('region',{name:'明天的活动'}).getByRole('button',{name:`查看活动：${target.title}`,exact:true}).waitFor();
   await page.screenshot({path:path.join(out,'real-image-tomorrow-event.png'),fullPage:true});screenshots.push('real-image-tomorrow-event.png');checks.push('real-ui-tomorrow-event-outside-today-focus');
  }
  await page.setViewportSize({width:390,height:844});await intake.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'real-image-manual-mobile.png'),fullPage:true});screenshots.push('real-image-manual-mobile.png');
  assert.deepEqual(pageErrors,[]);assert.deepEqual(blocked,[]);report.browser={actual_file_selected:true,manual_duplicate_preview:true,formal_writes_sent:0,recognition_requests_sent:0,page_errors:pageErrors,blocked_requests:blocked};await context.close();
 }finally{await browser.close();}
}

try{
 for(const [route,options] of [['/api/intake/capabilities',{}],['/api/intake/preview',{method:'POST',body:form('draft_json',{fields:EMPTY_INTAKE_FIELDS,note:'匿名探针',source_event_id:`anon-${run}`})}],['/api/images/'+'img_'+'0'.repeat(64),{}]]){const denied=await call(route,{...options,anonymous:true});assert.equal(denied.status,401);}
 checks.push('anonymous-capabilities-preview-images-denied');
 const signed=await fetch(base+'/signin-with-chatgpt?return_to=/',{redirect:'manual',signal:AbortSignal.timeout(15000)});assert.equal(signed.status,302);cookie=signed.headers.get('set-cookie')?.split(';')[0]||'';assert.ok(cookie,'Local development sign-in must provide its own session cookie');
 const capabilities=await call('/api/intake/capabilities');assert.equal(capabilities.status,200);assert.equal(capabilities.result.vision.configured,false,'Stop before recognition if any real key is configured');assert.equal(capabilities.result.vision.enabled,false);assert.equal(capabilities.result.max_image_bytes,1500000);assert.ok(capabilities.result.draft_scope);checks.push('provider-disabled-owner-draft-scope');
 let state=await getState();save('initial-local-state.json',state);
 const fields={...EMPTY_INTAKE_FIELDS,title:'【本机验收】南里山房太阳宫山海晚宴',classification:'reserved_event',item_type:'event',status:'todo',event_status:'reserved',date,time,location,project_id:'',next_action:'按约参加晚宴，不重复订位',target_task_id:'',action:'inspect',uncertainties_confirmed:true};
 let initialPreview=await preview(fields,{source:`qa-find-dinner-${run}`});await sameState(state);
 const exact=initialPreview.candidates.filter(candidate=>candidate.exact);assert.ok(exact.length<=1,'Ambiguous existing local reservations must be resolved, never silently duplicated');
 let target=exact.length?state.data.tasks.find(task=>task.id===exact[0].id):null;
 if(!target){
  const id='qa-image-dinner-20261017-1700';assert.equal(state.data.tasks.some(task=>task.id===id),false,'Existing fixture ID changed semantics; stop rather than overwrite');
  const project=state.data.projects.find(project=>project.id==='p-inbox')||state.data.projects[0];assert.ok(project);
  const request=operation(state,[{type:'create',id,values:{title:'已预约活动｜【本机验收】南里山房太阳宫山海晚宴',project_id:project.id,item_type:'event',event_status:'reserved',event_date:date,start_at:`${date}T${time}:00+08:00`,location,status:'todo',next_action:'【本机验收】按约参加晚宴，不重复订位',source_ref:'仅本机隔离验收的样例记录，不代表生产新增预约'}}],`qa-fixture-dinner-${run}`);
  const saved=await call('/api/operations',{method:'POST',body:request,json:true});assert.equal(saved.status,200);assert.equal(saved.result.state,'verified');writes.push({kind:'local-fixture',operation_id:request.operation_id,result_version:saved.result.result_version});state=await getState();target=state.data.tasks.find(task=>task.id===id);assert.ok(target);
 }
 fields.project_id=target.project_id;fields.title=target.title;
 const before=await getState();save('before-local-state.json',before);
 const inspect=await preview(fields,{source:`qa-inspect-original-${run}`});assert.equal(inspect.image.sha256,originalHash);assert.equal(inspect.image.byte_size,original.length);assert.equal(inspect.duplicate,true);assert.equal(inspect.changes.length,0);assert.ok(inspect.candidates.some(candidate=>candidate.id===target.id&&candidate.exact));assert.equal(Object.hasOwn(inspect.image,'url'),false);await sameState(before);
 const originalWasLinked=refs(before).includes(inspect.image.id),uncommitted=await image(inspect.image.id);assert.equal(uncommitted.status,originalWasLinked?200:404);checks.push('original-image-inspect-matches-existing-without-write');
 const recognition=new FormData();recognition.set('image',new Blob([original],{type:'image/png'}),'original-banquet.png');recognition.set('note','本机验收，不授权服务商调用');recognition.set('request_id',`qa-recognition-off-${run}`);recognition.set('consent','false');
 const blockedRecognition=await call('/api/intake/recognize',{method:'POST',body:recognition});assert.equal(blockedRecognition.status,503);assert.ok(['VISION_NOT_CONFIGURED','VISION_NOT_AUTHORIZED'].includes(blockedRecognition.result.error));await sameState(before);assert.equal((await image(inspect.image.id)).status,originalWasLinked?200:404);checks.push('unconfigured-recognition-503-no-consent-no-ledger-image-write');
 const link=await preview({...fields,action:'link_existing',target_task_id:target.id},{source:`qa-link-original-${run}`});let payload;
 if(link.changes.length){assert.equal(link.changes.length,1);assert.equal(link.changes[0].type,'update');assert.equal(link.changes[0].id,target.id);assert.deepEqual(Object.keys(link.changes[0].values),['attachment_ids']);payload={...operation(before,link.changes,link.source_event_id),occurred_at:link.occurred_at};save('commit-request.json',payload);}else{const cached=path.join(out,'commit-request.json');assert.ok(fs.existsSync(cached),'Already linked original requires its prior local proof request for replay coverage');payload=JSON.parse(fs.readFileSync(cached,'utf8'));assert.ok(payload.changes.some(change=>change.id===target.id&&change.values.attachment_ids?.includes(inspect.image.id)));}
 const committed=await commit(payload);assert.equal(committed.status,200);assert.equal(committed.result.state,'verified');const independent=await getState();assert.equal(independent.revision,before.revision+(link.changes.length?1:0));sameBusiness(before,independent,target.id);assert.ok(independent.data.tasks.find(task=>task.id===target.id).attachment_ids.includes(inspect.image.id));
 const receipt=await call(`/api/operations/${encodeURIComponent(payload.operation_id)}`);assert.equal(receipt.status,200);assert.equal(receipt.result.state,'verified');assert.ok(receipt.result.result_version<=independent.revision);writes.push({kind:link.changes.length?'link-original':'replay-existing-link',operation_id:payload.operation_id,result_version:receipt.result.result_version});
 const stored=await image(inspect.image.id);assert.equal(stored.status,200);assert.equal(stored.response.headers.get('content-type'),'image/png');assert.ok(stored.response.headers.get('cache-control')?.includes('no-store'));assert.equal(stored.response.headers.get('x-content-type-options'),'nosniff');assert.equal(stored.response.headers.get('cross-origin-resource-policy'),'same-origin');assert.ok(stored.response.headers.get('content-security-policy')?.includes('sandbox'));assert.notEqual(stored.response.headers.get('access-control-allow-origin'),'*');assert.equal(sha(Buffer.from(await stored.response.arrayBuffer())),originalHash);assert.equal((await image(inspect.image.id,true)).status,401);assert.equal((await image('img_'+'0'.repeat(64))).status,404);checks.push('confirm-link-receipt-independent-read-original-sha-private-headers');
 const replay=await commit(payload,original,'renamed-identical.png');assert.equal(replay.status,200);assert.equal(replay.result.duplicate,true);assert.equal(replay.result.operation_id,payload.operation_id);await sameState(independent);assert.deepEqual(refs(await getState()),refs(independent));checks.push('identical-payload-replay-no-revision-item-image-reference-growth');
 const duplicate=await preview({...fields,title:`【本机验收】错误重复新建 ${run}`,action:'create',target_task_id:''},{filename:'renamed-identical.png',source:`qa-duplicate-photo-${run}`});assert.equal(duplicate.duplicate,true);assert.equal(duplicate.changes.length,0);assert.equal(duplicate.image.id,inspect.image.id);await sameState(independent);
 const rejectedPayload=operation(independent,[{type:'create',values:{title:`【本机拒绝探针】不同名字同张图 ${run}`,project_id:target.project_id,item_type:'reference',attachment_ids:[inspect.image.id]}}],`qa-rejected-duplicate-${run}`),rejected=await commit(rejectedPayload,original,'renamed-identical.png');assert.equal(rejected.status,409);assert.equal(rejected.result.error,'DUPLICATE_IMAGE');await sameState(independent);checks.push('renamed-same-photo-preview-and-backend-create-rejected');
 const probeBytes=pngProbe(),probe=await preview({...fields,action:'link_existing',target_task_id:target.id},{bytes:probeBytes,filename:'one-pixel-cas-probe.png',source:`qa-stale-image-${run}`});assert.notEqual(probe.image.sha256,originalHash);assert.equal((await image(probe.image.id)).status,404);assert.equal(probe.changes.length,1);const stalePayload={...operation(independent,probe.changes,probe.source_event_id),base_version:independent.revision-1,occurred_at:probe.occurred_at};const stale=await commit(stalePayload,probeBytes,'one-pixel-cas-probe.png');assert.equal(stale.status,409);assert.equal(stale.result.error,'REVISION_CONFLICT');assert.equal((await image(probe.image.id)).status,404);await sameState(independent);checks.push('stale-cas-distinct-valid-png-never-persists-orphan');
 await browserProof(target,fields);await sameState(independent);save('after-local-state.json',independent);
 report.ok=true;report.revision_before=before.revision;report.revision_after=independent.revision;report.state_hash_before=stateHash(before);report.state_hash_after=stateHash(independent);report.task_count_before=before.data.tasks.length;report.task_count_after=independent.data.tasks.length;report.referenced_image_count_before=refs(before).length;report.referenced_image_count_after=refs(independent).length;report.original_image_id=inspect.image.id;report.rejected_cas_image_id=probe.image.id;report.fixture_task_id=target.id;report.original_already_linked=originalWasLinked;report.image_count_basis='Unique owner-visible ledger image references plus private GET 404 for rejected CAS probe; no direct DB file read';save('result.json',report);console.log(JSON.stringify(report));
}catch(error){report.ok=false;report.failure=error instanceof Error?error.message:String(error);save('result.json',report);console.error(JSON.stringify({ok:false,out,failure:report.failure}));process.exitCode=1;}
