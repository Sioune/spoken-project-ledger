import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// In-memory model tests: no database, server, production call or shared testbuild.
const source=fs.readFileSync(new URL('../lib/model.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {applyChanges}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const now='2026-10-16T08:00:00.000Z';
const task=(id,title,status='todo',dependencies=[],extra={})=>({id,project_id:'project',title,status,next_action:title,dependencies,version:1,updated_at:'2026-10-15T01:00:00.000Z',completed_at:null,verification_state:'user_reported',source_ref:'虚构依赖回归',...extra});
function fixture(){return {projects:[{id:'project',name:'虚构项目',goal:'依赖锁验收',status:'active',completion_rule:'本人确认',external_links:[],version:1}],tasks:[task('prerequisite','完成前序审核'),task('follow-up','执行后续发送','blocked',['prerequisite']),task('already-done','另一已完成前序','done')],documents:[],pending:[],settings:{timezone:'Asia/Shanghai',intervalHours:2,workStart:'09:00',workEnd:'19:00',enabled:false},reminderLog:[]};}
const update=(id,values)=>({type:'update',id,values});
const apply=(data,changes,time=now)=>applyChanges(data,changes,time,time).data;
const find=(data,id)=>data.tasks.find(t=>t.id===id);
const blocked=fn=>assert.throws(fn,error=>error.code==='BLOCKED'&&error.details.task_id==='follow-up'&&error.details.blocking_dependency_ids.includes('prerequisite'));

test('同一变更清空依赖不能把受阻后续晋级doing/waiting/done，原快照保持不变',()=>{
 for(const status of ['doing','waiting','done']){
  const data=fixture(),before=structuredClone(data);
  blocked(()=>apply(data,[update('follow-up',{dependencies:[],status,...(status==='waiting'?{waiting_for:'审核人'}:{})})]));
  assert.deepEqual(data,before);
 }
});

test('同组分两次修改或替换为已完成前序也不能绕过原前序',()=>{
 for(const dependencies of [[],['already-done']])blocked(()=>apply(fixture(),[update('follow-up',{dependencies}),update('follow-up',{status:'done'})]));
});

test('前序与后续在同一原子组真实完成允许两种顺序和原样/修订依赖数组',()=>{
 for(const dependencies of [['prerequisite'],[]])for(const reverse of [false,true]){
  const changes=[update('prerequisite',{status:'done'}),update('follow-up',{dependencies,status:'done'})];
  const result=apply(fixture(),reverse?changes.toReversed():changes);
  assert.equal(find(result,'prerequisite').status,'done');assert.equal(find(result,'follow-up').status,'done');
 }
});

test('本组前序曾经done但最终又doing/cancelled时仍阻止绕过',()=>{
 for(const status of ['doing','cancelled'])blocked(()=>apply(fixture(),[update('prerequisite',{status:'done'}),update('follow-up',{dependencies:[],status:'done'}),update('prerequisite',{status})]));
});

test('单独明确修订依赖仍保留，后一个独立组可依据修订后的关系推进',()=>{
 const edited=apply(fixture(),[update('follow-up',{dependencies:[]})]);
 assert.deepEqual(find(edited,'follow-up').dependencies,[]);assert.equal(find(edited,'follow-up').status,'blocked');
 const advanced=apply(edited,[update('follow-up',{status:'done'})],'2026-10-16T08:01:00.000Z');
 assert.equal(find(advanced,'follow-up').status,'done');assert.equal(find(advanced,'prerequisite').status,'todo');
});

test('完成前序仅解锁为todo或已有等待对象的waiting，跨组再完成后续',()=>{
 for(const waitingFor of [null,'审核人']){
  const data=fixture();find(data,'follow-up').waiting_for=waitingFor;
  const unlocked=apply(data,[update('prerequisite',{status:'done'})]);
  assert.equal(find(unlocked,'follow-up').status,waitingFor?'waiting':'todo');
  assert.equal(find(unlocked,'follow-up').completed_at,null);
  const advanced=apply(unlocked,[update('follow-up',{status:'done'})],'2026-10-16T08:01:00.000Z');
  assert.equal(find(advanced,'follow-up').status,'done');
 }
});

test('已经完成原前序的结构化原样数组与合法关系维护保持兼容',()=>{
 const data=fixture();find(data,'prerequisite').status='done';find(data,'follow-up').status='todo';
 const result=apply(data,[update('follow-up',{dependencies:['prerequisite'],status:'doing'})]);
 assert.equal(find(result,'follow-up').status,'doing');
 const related=apply(data,[update('follow-up',{dependencies:['already-done']})]);
 assert.deepEqual(find(related,'follow-up').dependencies,['already-done']);
});

test('仍校验新依赖和循环，不能借关系修订引入环',()=>{
 assert.throws(()=>apply(fixture(),[update('prerequisite',{dependencies:['follow-up']})]),error=>error.code==='CYCLE');
 const data=fixture();find(data,'prerequisite').status='done';
 data.tasks.push(task('new-prerequisite','新增尚未完成前序'));
 assert.throws(()=>apply(data,[update('follow-up',{dependencies:['new-prerequisite'],status:'done'})]),error=>error.code==='BLOCKED');
});

test('纯快照恢复保留原语义，提醒历史清空而非被依赖guard阻断',()=>{
 const data=fixture(),snapshot=structuredClone(data);
 find(snapshot,'follow-up').dependencies=[];find(snapshot,'follow-up').status='done';snapshot.reminderLog=[{state:'sent'}];
 const result=apply(data,[{type:'restore',values:{data:snapshot}}]);
 assert.equal(find(result,'follow-up').status,'done');assert.deepEqual(result.reminderLog,[]);
});

test('新任务仍按最终依赖校验，同组完成前序后新建done允许逆序',()=>{
 const create={type:'create',id:'new-follow-up',values:{title:'全新完成交付',project_id:'project',status:'done',dependencies:['prerequisite']}};
 assert.throws(()=>apply(fixture(),[create]),error=>error.code==='BLOCKED');
 const result=apply(fixture(),[create,update('prerequisite',{status:'done'})]);
 assert.equal(find(result,'new-follow-up').status,'done');
});
