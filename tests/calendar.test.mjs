import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import ts from 'typescript';

// Isolated memory-only runtime; no shared testbuild, server, production call or DB file.
const compile=name=>ts.transpileModule(fs.readFileSync(new URL(`../lib/${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const url=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const modelUrl=url(compile('model'));
const {applyChanges,seed}=await import(modelUrl);
const {isCalendarDate,toShanghaiDate}=await import(url(compile('calendar')));
const {Repository}=await import(url(compile('repository').replace("from './model'",`from ${JSON.stringify(modelUrl)}`)));
const {mcpCommitPayload,changeValuesSchema}=await import(url(compile('mcp-contract').replace("from './model'",`from ${JSON.stringify(modelUrl)}`)));
const now='2026-10-16T08:00:00.000Z',later='2026-10-16T09:00:00.000Z';
const project=(id='p-calendar',extra={})=>({id,name:'虚构项目',goal:'日历验收',status:'active',completion_rule:'本人核实',external_links:[],version:1,...extra});
const task=(id='t-calendar',extra={})=>({id,project_id:'p-calendar',title:'虚构任务',status:'todo',next_action:'下一步',dependencies:[],version:1,updated_at:'2026-10-15T01:00:00.000Z',completed_at:null,verification_state:'user_reported',source_ref:'虚构测试',...extra});
const legacy=()=>({projects:[project()],tasks:[task()],documents:[],pending:[],settings:{timezone:'Asia/Shanghai',intervalHours:2,workStart:'09:00',workEnd:'19:00',enabled:false},reminderLog:[]});
const apply=(data,changes,time=now,occurred=time)=>applyChanges(data,changes,time,occurred).data;
const update=(id,values)=>({type:'update',id,values});
const submit=(revision,changes,extra={})=>{const id=crypto.randomUUID();return {operation_id:id,idempotency_key:id,source_event_id:id,base_version:revision,occurred_at:new Date().toISOString(),raw_text:'虚构日历元数据测试',changes,...extra};};

class Adapter{
 constructor(){this.sql=new DatabaseSync(':memory:');this.calendarQueries=0;this.calendarRows=[];this.failHistory=false;for(const file of fs.readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())for(const statement of fs.readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))this.sql.exec(statement);}
 prepare(sql){const db=this;let values=[];const statement={sql,values:()=>values,bind(...args){values=args;return statement;},async first(){return db.sql.prepare(sql).get(...values)??null;},async all(){if(sql.includes('AS before_tasks')){db.calendarQueries++;if(db.failHistory)throw Error('Injected history read failure');}const results=db.sql.prepare(sql).all(...values);if(sql.includes('AS before_tasks'))db.calendarRows.push(...results);return {results};},async run(){return db.sql.prepare(sql).run(...values);}};return statement;}
 async batch(statements){this.sql.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>this.sql.prepare(s.sql).run(...s.values()));this.sql.exec('COMMIT');return results;}catch(error){this.sql.exec('ROLLBACK');throw error;}}
 state(data,revision=1,last='fixture'){this.sql.prepare('INSERT INTO ledgers(id,owner_id,revision,data,last_operation) VALUES (1,?,?,?,?)').run('owner-test',revision,JSON.stringify(data),last);}
 operation(receipt,owner='owner-test'){const id=receipt.operation_id;this.sql.prepare('INSERT INTO operations(id,owner_id,idempotency_key,source_event_id,payload_hash,receipt,created_at) VALUES (?,?,?,?,?,?,?)').run(id,owner,id,id,'fixture',JSON.stringify(receipt),receipt.created_at);}
 close(){this.sql.close();}
}
const fixture=(data=legacy(),revision=1)=>{const db=new Adapter();db.state(data,revision);return {db,repo:new Repository(db,'owner-test')};};
const history=(revision,before,after,changes,extra={})=>({state:'saved',operation_id:`history-${revision}`,result_version:revision,created_at:new Date(Date.parse('2026-10-10T00:00:00Z')+revision*1000).toISOString(),occurred_at:'2000-01-01T00:00:00Z',timezone:'Asia/Shanghai',changes,before,after,source_event_id:`history-${revision}`,raw_text:'虚构历史',...extra});
const empty=data=>({...data,projects:[],tasks:[],documents:[],pending:[]});

test('真实日期和UTC到上海跨日，date-only不被时区漂移',()=>{
 assert.equal(toShanghaiDate('2026-10-15T16:00:00.000Z'),'2026-10-16');
 assert.equal(toShanghaiDate('2026-10-15T15:59:59.999Z'),'2026-10-15');
 assert.equal(toShanghaiDate('2026-10-16'),'2026-10-16');
 assert.equal(toShanghaiDate('2026-10-16T00:00:00+08:00'),'2026-10-16');
 for(const value of ['2026-02-31','2026-02-29','2026-13-01','2026-00-01','2026-10-00','0000-01-01','2026-2-01'])assert.equal(isCalendarDate(value),false,value);
 assert.equal(isCalendarDate('2024-02-29'),true);assert.equal(toShanghaiDate('2026-02-31'),null);assert.equal(toShanghaiDate(null),null);
});

test('新建任务和项目只用服务端now登记，不用口述、完成或编辑时刻',()=>{
 const data=legacy();
 const created=apply(data,[{type:'project',id:'p-new',values:{name:'新项目'}},{type:'create',id:'t-new',values:{title:'新建登记',project_id:'p-new',status:'done'}}],now,'2000-01-01T00:00:00Z');
 assert.equal(created.projects.find(p=>p.id==='p-new').created_at,now);
 assert.equal(created.tasks.find(t=>t.id==='t-new').created_at,now);assert.equal(created.tasks.find(t=>t.id==='t-new').completed_at,'2000-01-01T00:00:00Z');
 const edited=apply(created,[update('t-new',{next_action:'编辑后的下一步'}),{type:'project',id:'p-new',values:{goal:'编辑目标'}}],later);
 assert.equal(edited.tasks.find(t=>t.id==='t-new').created_at,now);assert.equal(edited.projects.find(p=>p.id==='p-new').created_at,now);
 assert.equal(edited.tasks[0].created_at,undefined);assert.equal(edited.projects[0].created_at,undefined);
});

test('客户端创建/编辑均不可伪造created_at，MCP保留旧字段并公开项目日期',()=>{
 const data=legacy();
 for(const change of [{type:'create',values:{title:'伪造登记',created_at:now}},{type:'update',id:'t-calendar',values:{created_at:now}},{type:'project',id:'p-calendar',values:{created_at:now}},{type:'project',id:'new',values:{name:'伪造项目',created_at:now}}])assert.throws(()=>apply(data,[change]),error=>error.code==='FIELD');
 assert.equal(changeValuesSchema.properties.created_at,undefined);
 const valid=submit(1,[{type:'project',id:'p-calendar',values:{start_date:'2026-10-01',target_end_date:'2026-10-20',completed_date:null}}]);
 assert.deepEqual(mcpCommitPayload(valid),valid);assert.deepEqual(mcpCommitPayload({payload_json:JSON.stringify(valid)},true),valid);
 assert.throws(()=>mcpCommitPayload({...valid,changes:[update('t-calendar',{created_at:now})]}),error=>error.code==='FIELD');
});

test('项目进场、计划和实际日期可明确维护/清空，不自动归档或完成任务',()=>{
 const data=legacy(),created=apply(data,[{type:'project',id:'p-calendar',values:{start_date:'2026-10-01',target_end_date:'2026-10-20',completed_date:'2026-10-18'}},update('t-calendar',{planned_date:'2026-10-16'})]);
 assert.equal(created.projects[0].status,'active');assert.equal(created.tasks[0].status,'todo');assert.equal(created.projects[0].completed_date,'2026-10-18');
 const cleared=apply(created,[{type:'project',id:'p-calendar',values:{start_date:null,target_end_date:'',completed_date:null}},update('t-calendar',{planned_date:null})],later);
 assert.equal(cleared.projects[0].start_date,null);assert.equal(cleared.projects[0].target_end_date,null);assert.equal(cleared.projects[0].completed_date,null);assert.equal(cleared.tasks[0].planned_date,null);
 for(const date of ['2026-02-31','2026-02-29','2026-13-01'])for(const field of ['start_date','target_end_date','completed_date'])assert.throws(()=>apply(data,[{type:'project',id:'p-calendar',values:{[field]:date}}]),error=>error.code==='DATE');
 assert.throws(()=>apply(data,[update('t-calendar',{planned_date:'2026-02-31'})]),error=>error.code==='DATE');
 assert.throws(()=>apply(data,[{type:'project',id:'p-calendar',values:{start_date:'2026-10-20',target_end_date:'2026-10-01'}}]),error=>error.code==='DATE_ORDER');
 assert.throws(()=>apply(data,[{type:'project',id:'p-calendar',values:{start_date:'2026-10-20',completed_date:'2026-10-19'}}]),error=>error.code==='DATE_ORDER');
 assert.equal(apply(data,[{type:'project',id:'p-calendar',values:{start_date:'2024-02-29'}}]).projects[0].start_date,'2024-02-29');
});

test('初始化只在全新库写服务端登记，现有旧库读取不回填',async()=>{
 const db=new Adapter(),repo=new Repository(db,'owner-test');
 try{const initialized=await repo.initialize();const calendar=await repo.calendar();assert.ok(initialized.data.tasks.every(t=>t.created_at));assert.ok(calendar.tasks.every(t=>t.registration_source==='recorded'));assert.ok(calendar.projects.every(p=>p.registration_source==='recorded'));assert.equal(db.calendarQueries,0);}finally{db.close();}
 const old=fixture();try{const before=await old.repo.read();await old.repo.initialize();await old.repo.calendar();assert.deepEqual(await old.repo.read(),before);}finally{old.db.close();}
});

test('旧初始化回执同时还原项目与任务首次登记，不取occurred_at且GET不改原库',async()=>{
 const data=legacy(),{db,repo}=fixture(data);db.operation(history(1,empty(data),data,[{type:'initialize'}]));
 try{const before=await repo.read(),calendar=await repo.calendar();assert.equal(calendar.tasks[0].registration_source,'history');assert.equal(calendar.projects[0].registration_source,'history');assert.equal(calendar.tasks[0].registered_at,'2026-10-10T00:00:01.000Z');assert.equal(calendar.tasks[0].completed_at,null);assert.deepEqual(await repo.read(),before);assert.equal(calendar.history_complete,true);assert.deepEqual(calendar.warnings,[]);assert.equal(db.calendarQueries,1);}finally{db.close();}
});

test('超过100历史的晚期旧任务仍被分页找到，按revision而非时间/ID判首次',async()=>{
 const original=legacy(),current=structuredClone(original);current.tasks.push(task('t-late',{title:'后来新增的旧任务'}));const {db,repo}=fixture(current,126);
 db.operation(history(1,empty(original),original,[{type:'initialize'}],{operation_id:'z-initialize',created_at:'2026-10-15T01:00:00.000Z'}));
 for(let revision=2;revision<=125;revision++)db.operation(history(revision,original,original,[],{operation_id:`a-edit-${revision}`,created_at:'2026-10-15T01:00:00.000Z'}));
 db.operation(history(126,original,current,[{type:'create',id:'t-late'}],{created_at:'2026-10-14T01:00:00.000Z'}));
 try{assert.equal((await repo.history()).operations.length,100);const calendar=await repo.calendar();assert.equal(calendar.tasks.find(t=>t.id==='t-late').registered_at,'2026-10-14T01:00:00.000Z');assert.equal(calendar.tasks[0].registered_at,'2026-10-15T01:00:00.000Z');assert.ok(db.calendarQueries>=7);assert.ok(db.calendarRows.every(row=>!('receipt'in row)&&!row.before_tasks.includes('next_action')));assert.equal(calendar.history_complete,true);}finally{db.close();}
});

test('已知服务端created_at优先且无需历史，不随更新、重试或回执漂移',async()=>{
 const db=new Adapter(),repo=new Repository(db,'owner-test');
 try{await repo.initialize();const state=await repo.read();const request=submit(state.revision,[{type:'create',id:'t-recorded',values:{title:'服务端登记测试',project_id:'p-inbox'}}]);const receipt=await repo.commit(request);assert.equal(receipt.after.tasks.find(t=>t.id==='t-recorded').created_at,receipt.created_at);const before=await repo.calendar();await repo.commit(submit(receipt.result_version,[update('t-recorded',{next_action:'编辑不会移动登记日'})]));const replay=await repo.commit(request);assert.equal(replay.duplicate,true);const after=await repo.calendar();assert.equal(after.tasks.find(t=>t.id==='t-recorded').registered_at,before.tasks.find(t=>t.id==='t-recorded').registered_at);assert.equal(after.tasks.find(t=>t.id==='t-recorded').registration_source,'recorded');assert.equal(db.calendarQueries,0);}finally{db.close();}
});

test('首次只在before出现或来自restore/undo时保持未知，不把恢复当登记',async()=>{
 for(const mode of ['before','restore','undo']){
  const data=legacy(),{db,repo}=fixture(data,2);
  const receipt=mode==='before'?history(2,data,data,[update('t-calendar',{title:'编辑'})]):history(2,empty(data),data,[{type:mode==='restore'?'restore':'create',id:'t-calendar'}],mode==='undo'?{undo_of:'missing-original'}:{});
  db.operation(receipt);
  try{const calendar=await repo.calendar();assert.equal(calendar.tasks[0].registered_at,null,mode);assert.equal(calendar.tasks[0].registration_source,'unknown',mode);assert.ok(calendar.warnings.some(w=>w.includes('未知')));assert.equal(calendar.history_complete,true);}finally{db.close();}
 }
});

test('恢复/撤销重新引入的旧对象可找到更早真实birth，缺失birth则未知',async()=>{
 for(const keepBirth of [true,false]){
  const data=legacy(),removed={...data,tasks:[]},{db,repo}=fixture(data,3);
  if(keepBirth)db.operation(history(1,empty(data),data,[{type:'initialize'}]));
  db.operation(history(2,data,removed,[{type:'restore'}]));db.operation(history(3,removed,data,[{type:'restore'}],{undo_of:'history-2'}));
  try{const calendar=await repo.calendar();assert.equal(calendar.tasks[0].registration_source,keepBirth?'history':'unknown');assert.equal(calendar.tasks[0].registered_at,keepBirth?'2026-10-10T00:00:01.000Z':null);}finally{db.close();}
 }
});

test('restore保留当前已知created_at；旧对象和重新引入对象不信备份自报时间',()=>{
 const data=legacy();data.tasks[0].created_at=now;data.projects[0].created_at=now;const snapshot=structuredClone(data);snapshot.tasks[0].created_at='1999-01-01T00:00:00Z';snapshot.projects[0].created_at='1999-01-01T00:00:00Z';snapshot.tasks.push(task('t-imported',{title:'备份重新引入',created_at:'1999-01-01T00:00:00Z'}));snapshot.projects.push(project('p-imported',{created_at:'1999-01-01T00:00:00Z'}));
 const result=apply(data,[{type:'restore',values:{data:snapshot}}]);assert.equal(result.tasks[0].created_at,now);assert.equal(result.projects[0].created_at,now);assert.equal(result.tasks[1].created_at,undefined);assert.equal(result.projects[1].created_at,undefined);
 const old=legacy(),injected=structuredClone(old);injected.tasks[0].created_at=now;injected.projects[0].created_at=now;const restored=apply(old,[{type:'restore',values:{data:injected}}]);assert.equal(restored.tasks[0].created_at,undefined);assert.equal(restored.projects[0].created_at,undefined);
});

test('真实repo.undo恢复缺created_at的旧快照仍保留当前服务端登记',async()=>{
 const db=new Adapter(),repo=new Repository(db,'owner-test');
 try{await repo.initialize();const original=await repo.read();const receipt=await repo.commit(submit(original.revision,[update('t-ui',{next_action:'可撤销编辑'})]));const legacyReceipt=structuredClone(receipt);for(const item of [...legacyReceipt.before.tasks,...legacyReceipt.before.projects])delete item.created_at;db.sql.prepare('UPDATE operations SET receipt=? WHERE id=?').run(JSON.stringify(legacyReceipt),receipt.operation_id);const undone=await repo.undo(receipt.operation_id,receipt.result_version,'calendar-undo');assert.equal(undone.state,'verified');assert.equal(undone.after.tasks.find(t=>t.id==='t-ui').created_at,original.data.tasks.find(t=>t.id==='t-ui').created_at);assert.equal(undone.after.projects[0].created_at,original.data.projects[0].created_at);}finally{db.close();}
});

test('无历史正常穷尽为未知；历史故障明确partial且不改原数据',async()=>{
 for(const fail of [false,true]){const {db,repo}=fixture();db.failHistory=fail;try{const before=await repo.read(),calendar=await repo.calendar();assert.equal(calendar.history_complete,!fail);assert.equal(calendar.tasks[0].registered_at,null);assert.equal(calendar.projects[0].registered_at,null);assert.ok(calendar.warnings.length);assert.deepEqual(await repo.read(),before);}finally{db.close();}}
});

test('calendar使用同一owner隔离；其他owner历史不能提供登记证明',async()=>{
 const data=legacy(),{db,repo}=fixture(data);db.operation(history(1,empty(data),data,[{type:'initialize'}]),'other-owner');
 try{assert.throws(()=>new Repository(db,''),error=>error.status===401);await assert.rejects(new Repository(db,'other-owner').calendar(),error=>error.status===403);const calendar=await repo.calendar();assert.equal(calendar.tasks[0].registration_source,'unknown');}finally{db.close();}
});

test('并发后续操作不越过本次state revision；未初始化日历为空且不初始化',async()=>{
 const data=legacy(),{db,repo}=fixture(data,1);db.operation(history(2,empty(data),data,[{type:'initialize'}]));
 try{assert.equal((await repo.calendar()).tasks[0].registration_source,'unknown');}finally{db.close();}
 const emptyDb=new Adapter(),emptyRepo=new Repository(emptyDb,'owner-test');try{const calendar=await emptyRepo.calendar();assert.equal(calendar.revision,0);assert.deepEqual(calendar.tasks,[]);assert.deepEqual(calendar.projects,[]);assert.equal((await emptyRepo.read()).initialized,false);assert.equal(emptyDb.calendarQueries,0);}finally{emptyDb.close();}
});
