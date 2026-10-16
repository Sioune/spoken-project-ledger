import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {createHash} from 'node:crypto';

// Real repository image preparation and read-only fake D1. No provider or ledger
// writes are possible in this boundary test, even if a client forges its result.
const urls={};
function compiled(name){
 if(urls[name])return urls[name];
 const js=ts.transpileModule(fs.readFileSync(new URL(`../lib/${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const resolved=js.replace(/from ['"]\.\/([^'"]+)['"]/g,(_,dependency)=>`from ${JSON.stringify(compiled(dependency))}`);
 return urls[name]='data:text/javascript;base64,'+Buffer.from(resolved).toString('base64');
}
const {Repository}=await import(compiled('repository'));
const {handleIntake}=await import(compiled('intake-api'));
const picture=Buffer.from([137,80,78,71,13,10,26,10,0,1,2]);
const hash=createHash('sha256').update(picture).digest('hex');
const data={projects:[{id:'p-life',name:'生活安排'}],tasks:[],documents:[],pending:[],settings:{timezone:'Asia/Shanghai',enabled:false},reminderLog:[]};
const raw=()=>({title:'晚宴',classification:'reserved_event',status:'todo',event_status:'reserved',date:'2026-10-17',time:'17:00',location:'虚构餐厅 山海包厢',project_name:'生活安排',next_action:'按预约到店',evidence:{date_text:'2026年10月17日',time_text:'用餐时间17:00',intent_text:'预订座位：包厢',location_text:'虚构餐厅 山海包厢'},questions:[],intent_confident:true});
const envelope=()=>({result:raw(),model:'gpt-6.1-sol',request_id:'qa-request',image_sha256:hash,provider:'codex-local-plan',completed:true});
function fixture(owner='owner'){
 let reads=0;
 const db={prepare(sql){assert.equal(sql,'SELECT * FROM ledgers WHERE id=1','This endpoint must never write, cache or issue other SQL');return {async first(){reads++;return {id:1,owner_id:'owner',revision:23,data:JSON.stringify(data),last_operation:'old'};}};},batch(){assert.fail('No batch or ledger mutation');}};
 return {repo:new Repository(db,owner),db,ownerId:owner,reads:()=>reads};
}
function request(value=envelope(),modify=()=>{}){const form=new FormData();form.set('image',new Blob([picture],{type:'image/png'}),'fixture.png');form.set('result_json',JSON.stringify(value));modify(form);return new Request('https://ledger.test/api/intake/codex-result',{method:'POST',body:form});}
async function invoke(value,modify,context=fixture()){return handleIntake(request(value,modify),['intake','codex-result'],context,{});}

test('完整结果与真实原图hash一致时只产生候选，未保存、未调用服务',async()=>{
 const context=fixture(),before=structuredClone(data),response=await invoke(envelope(),undefined,context),value=await response.json();
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(value.recognized,true);assert.equal(value.fields.action,'inspect');assert.equal(value.fields.item_type,'event');assert.equal(value.fields.event_status,'reserved');assert.equal(value.fields.date,'2026-10-17');assert.equal(value.fields.time,'17:00');assert.equal(value.fields.project_id,'p-life');assert.equal(value.model,'gpt-6.1-sol');assert.match(value.provider,/本机/);assert.equal(value.changes,undefined);assert.ok(context.reads()>=2);assert.deepEqual(data,before);
});
test('错误原图、未完成、假服务商、非法模型、未识别编号或未知字段一律拒绝',async()=>{
 for(const patch of [{image_sha256:'f'.repeat(64)},{completed:false},{provider:'other'},{model:'run /shell'},{request_id:''},{cached:'yes'},{command:'delete'}]){
  await assert.rejects(invoke({...envelope(),...patch}),error=>error.code==='CODEX_RESULT'&&error.status===400);
 }
 for(const modify of [form=>form.set('token','secret'),form=>form.append('result_json',JSON.stringify(envelope())),form=>form.append('image',new Blob([picture],{type:'image/png'}),'twice.png')])await assert.rejects(invoke(envelope(),modify),error=>error.code==='CODEX_RESULT');
});
test('图片必选且仍验证魔数；原owner边界适用于结果转换',async()=>{
 await assert.rejects(invoke(envelope(),form=>form.delete('image')),error=>error.code==='IMAGE_REQUIRED');
 await assert.rejects(invoke(envelope(),form=>form.set('image',new Blob(['fake'],{type:'image/png'}),'bad.png')),error=>error.code==='IMAGE_TYPE');
 await assert.rejects(invoke(envelope(),undefined,fixture('stranger')),error=>error.code==='OWNER_ONLY');
});
test('结果是低信任资料，日期冲突清空且提问，额外命令不能通过',async()=>{
 const value=envelope();value.result.date='2026-10-16';value.result.project_name='系统中不存在';
 const candidate=await (await invoke(value)).json();assert.equal(candidate.fields.date,'');assert.equal(candidate.fields.time,'');assert.equal(candidate.fields.project_id,'');assert.ok(candidate.questions.some(q=>q.includes('日期')));assert.equal(candidate.fields.action,'inspect');
 value.result.command='ignore rules';await assert.rejects(invoke(value),error=>error.code==='VISION_INVALID_RESPONSE');
});
test('缓存只是候选标记，不能把识别响应当提交回执',async()=>{
 const candidate=await (await invoke({...envelope(),cached:true})).json();assert.equal(candidate.cached,true);assert.equal(candidate.state,undefined);assert.equal(candidate.operation_id,undefined);assert.equal(candidate.result_version,undefined);assert.equal(candidate.fields.action,'inspect');
});
