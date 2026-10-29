import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import ts from 'typescript';

// Isolated in-memory model/SQLite. No shared testbuild, provider, server or production request.
const compile=name=>ts.transpileModule(fs.readFileSync(new URL(`../lib/${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const url=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const modelUrl=url(compile('model')),calendarUrl=url(compile('calendar'));
const {applyChanges}=await import(modelUrl);
const {Repository}=await import(url(compile('repository').replace("from './model'",`from ${JSON.stringify(modelUrl)}`)));
const schedule=await import(url(compile('schedule').replace("from './calendar'",`from ${JSON.stringify(calendarUrl)}`)));
const {mcpCommitPayload,changeValuesSchema}=await import(url(compile('mcp-contract').replace("from './model'",`from ${JSON.stringify(modelUrl)}`)));
const now='2026-10-16T08:00:00.000Z',later='2026-10-16T09:00:00.000Z';
const task=(id='existing',extra={})=>({id,project_id:'project',title:'原有事项',status:'todo',next_action:'原下一步',dependencies:[],version:1,updated_at:'2026-10-15T01:00:00Z',completed_at:null,verification_state:'user_reported',source_ref:'原来源',...extra});
const legacy=()=>({projects:[{id:'project',name:'原项目',goal:'保留原数据',status:'active',completion_rule:'本人确认',external_links:[],version:1}],tasks:[task()],documents:[],pending:[],settings:{timezone:'Asia/Shanghai',intervalHours:2,workStart:'09:00',workEnd:'19:00',enabled:false},reminderLog:[]});
const update=(id,values)=>({type:'update',id,values});
const create=(id,title,values={})=>({type:'create',id,values:{project_id:'project',title,...values}});
const apply=(data,changes,time=now)=>applyChanges(data,changes,time,time).data;
const submit=(revision,changes,extra={})=>{const id=crypto.randomUUID();return {operation_id:id,idempotency_key:id,source_event_id:id,base_version:revision,occurred_at:new Date().toISOString(),raw_text:'虚构图片录入测试',changes,...extra};};
const png=()=>Uint8Array.from([137,80,78,71,13,10,26,10,0,1,2,3]).buffer;

class Adapter{
 constructor(){this.sql=new DatabaseSync(':memory:');this.failOperationInsert=false;this.beforeBatch=null;for(const file of fs.readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())for(const statement of fs.readFileSync(new URL(`../drizzle/${file}`,import.meta.url),'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))this.sql.exec(statement);this.sql.prepare('INSERT INTO ledgers(id,owner_id,revision,data,last_operation) VALUES (1,?,1,?,?)').run('owner-test',JSON.stringify(legacy()),'fixture');}
 prepare(sql){const db=this;let values=[];const statement={sql,values:()=>values,bind(...args){values=args.map(value=>value instanceof ArrayBuffer?new Uint8Array(value):value);return statement;},async first(){return db.sql.prepare(sql).get(...values)??null;},async all(){return {results:db.sql.prepare(sql).all(...values)};},async run(){return db.sql.prepare(sql).run(...values);}};return statement;}
 async batch(statements){if(this.beforeBatch){const run=this.beforeBatch;this.beforeBatch=null;run();}this.sql.exec('BEGIN IMMEDIATE');try{const results=[];for(const statement of statements){if(this.failOperationInsert&&statement.sql.startsWith('INSERT INTO operations'))throw Error('Injected operation insert failure');results.push(this.sql.prepare(statement.sql).run(...statement.values()));}this.sql.exec('COMMIT');return results;}catch(error){this.sql.exec('ROLLBACK');throw error;}}
 countImages(){return this.sql.prepare('SELECT COUNT(*) AS n FROM images').get().n;}
 close(){this.sql.close();}
}
const fixture=()=>{const db=new Adapter();return {db,repo:new Repository(db,'owner-test')};};

test('旧对象不回填；预约仅由明确旧前缀与已有日期只读推导，未来不归今天',()=>{
 const today=schedule.shanghaiDay(),tomorrow=schedule.shiftDay(today,1),data=legacy(),before=structuredClone(data);
 const event=task('old-reservation',{title:'已预约活动｜原晚宴',planned_date:tomorrow,due_at:`${tomorrow}T18:00:00+08:00`});
 assert.equal(schedule.getItemType(event),'event');assert.equal(schedule.getEventStatus(event),'reserved');assert.equal(schedule.getEventDate(event),tomorrow);assert.equal(schedule.getEventStart(event),`${tomorrow}T18:00:00+08:00`);assert.equal(schedule.isVisibleOnDay(event,today),false);assert.equal(schedule.isVisibleOnDay(event,tomorrow),true);assert.equal(event.item_type,undefined);
 assert.equal(schedule.getEventStatus({...event,status:'done'}),'completed');assert.equal(schedule.getEventStatus({...event,status:'cancelled'}),'cancelled');assert.equal(schedule.getEventStatus({...event,status:'done',event_status:'reserved'}),'reserved');
 assert.equal(schedule.getItemType(task('ordinary',{title:'计划晚宴',planned_date:tomorrow})),'task');assert.equal(schedule.getItemType(task('undated',{title:'已预约活动｜原晚宴'})),'task');
 assert.equal(schedule.isVisibleOnDay(data.tasks[0],today),true);assert.equal(schedule.isVisibleOnDay(task('future',{planned_date:tomorrow}),today),false);assert.equal(schedule.isVisibleOnDay(task('reference',{item_type:'reference',planned_date:today}),today),false);
 assert.equal(schedule.getTaskDay(task('none',{updated_at:now,created_at:now})),null);assert.equal(schedule.getEventDate(task('unknown-event',{item_type:'event',created_at:now})),null);assert.deepEqual(data,before);
});

test('上海归日和日期移动不猜未知日期，event字段与task计划字段独立',()=>{
 assert.equal(schedule.shanghaiDay('2026-10-16T16:00:00Z'),'2026-10-17');assert.equal(schedule.shiftDay('2024-02-28',1),'2024-02-29');assert.equal(schedule.shiftDay('2026-02-31',1),null);
 const event=task('e',{item_type:'event',event_date:'2026-10-17',start_at:'2026-10-16T16:30:00Z',planned_date:'2026-10-20',due_at:'2026-10-21T00:00:00Z'});
 assert.equal(schedule.getEventDate(event),'2026-10-17');assert.equal(schedule.getEventStart(event),'2026-10-16T16:30:00Z');assert.equal(schedule.getTaskDay(event),'2026-10-20');
 assert.equal(schedule.getEventStart(task('not-legacy',{item_type:'event',due_at:now})),null);assert.equal(schedule.isVisibleOnDay(task('e',{item_type:'event'}),schedule.shanghaiDay()),false);
});

test('新事件、参考、事实字段CRUD不完成普通任务，保留登记与口述完成时间语义',()=>{
 const data=legacy(),result=apply(data,[create('reservation','未来晚宴',{item_type:'event',event_status:'reserved',event_date:'2026-10-17',start_at:'2026-10-17T18:00:00+08:00',location:'私人宴会厅'}),create('reference','参考说明',{item_type:'reference',fact_date:'2026-10-16',fact_at:'2026-10-15T16:30:00Z'})]);
 const event=result.tasks.find(t=>t.id==='reservation');assert.equal(event.status,'todo');assert.equal(event.event_status,'reserved');assert.equal(event.completed_at,null);assert.equal(event.created_at,now);assert.deepEqual(result.tasks[0],data.tasks[0]);
 const edited=apply(result,[update('reservation',{event_status:'completed',event_date:null,start_at:null,location:null,fact_date:'2026-10-16',fact_at:now})],later).tasks.find(t=>t.id==='reservation');assert.equal(edited.status,'done');assert.equal(edited.completed_at,later);assert.equal(edited.created_at,now);assert.equal(edited.event_date,null);
 assert.throws(()=>apply(data,[update('existing',{created_at:now})]),error=>error.code==='FIELD');
});

test('旧dot仅改显式活动status时同步活动状态；相同状态或说明编辑保留已预约',()=>{
 const data=legacy();data.tasks[0]={...data.tasks[0],item_type:'event',event_status:'reserved'};
 const before=structuredClone(data);
 const unchanged=applyChanges(data,[update('existing',{status:'todo',next_action:'只改出席说明'})],now,now);assert.equal(unchanged.data.tasks[0].event_status,'reserved');assert.equal(unchanged.effective[0].values.event_status,undefined);
 const done=applyChanges(data,[update('existing',{status:'done'})],now,now);assert.equal(done.data.tasks[0].event_status,'completed');assert.equal(done.data.tasks[0].completed_at,now);assert.deepEqual(done.effective[0].values,{status:'done',event_status:'completed'});
 const reopened=applyChanges(done.data,[update('existing',{status:'todo'})],later,later);assert.equal(reopened.data.tasks[0].event_status,'planned');assert.equal(reopened.data.tasks[0].completed_at,null);assert.equal(reopened.effective[0].values.event_status,'planned');
 const cancelled=apply(data,[update('existing',{status:'cancelled'})]);assert.equal(cancelled.tasks[0].event_status,'cancelled');
 const doing=apply(data,[update('existing',{status:'doing'})]);assert.equal(doing.tasks[0].event_status,'planned');assert.deepEqual(data,before);
});

test('单独活动状态同步业务状态，生成字段记录于有效变更并继续受原依赖锁保护',()=>{
 const data=legacy();data.tasks[0]={...data.tasks[0],item_type:'event',event_status:'reserved'};
 const done=applyChanges(data,[update('existing',{event_status:'completed'})],now,now);assert.equal(done.data.tasks[0].status,'done');assert.deepEqual(done.effective[0].values,{event_status:'completed',status:'done'});
 for(const event_status of ['reserved','planned']){const reopened=apply(done.data,[update('existing',{event_status})],later);assert.equal(reopened.tasks[0].status,'todo');assert.equal(reopened.tasks[0].event_status,event_status);assert.equal(reopened.tasks[0].completed_at,null);}
 assert.equal(apply(data,[update('existing',{event_status:'cancelled'})]).tasks[0].status,'cancelled');
 const blocked=legacy();blocked.tasks.push(task('event',{item_type:'event',event_status:'planned',status:'blocked',dependencies:['existing']}));
 assert.throws(()=>apply(blocked,[update('event',{event_status:'completed',dependencies:[]})]),error=>error.code==='BLOCKED');
 assert.equal(apply(blocked,[update('event',{event_status:'completed'}),update('existing',{status:'done'})]).tasks.find(t=>t.id==='event').status,'done');
});

test('显式活动create补齐另一状态，双方矛盾拒绝且不修改源数据',()=>{
 for(const [values,status,event_status] of [[{event_status:'reserved'},'todo','reserved'],[{event_status:'completed'},'done','completed'],[{event_status:'cancelled'},'cancelled','cancelled'],[{status:'done'},'done','completed'],[{status:'cancelled'},'cancelled','cancelled'],[{},'todo','planned']]){
  const record=apply(legacy(),[create('event','独立活动',{item_type:'event',...values})]).tasks.find(t=>t.id==='event');assert.equal(record.status,status);assert.equal(record.event_status,event_status);assert.equal(record.completed_at,status==='done'?now:null);
 }
 for(const values of [{status:'done',event_status:'reserved'},{status:'todo',event_status:'completed'},{status:'cancelled',event_status:'planned'},{status:'done',event_status:'cancelled'}]){
  const data=legacy(),before=structuredClone(data);data.tasks[0].item_type='event';before.tasks[0].item_type='event';
  assert.throws(()=>apply(data,[update('existing',values)]),error=>error.code==='EVENT_STATUS_CONFLICT'&&error.status===400);assert.deepEqual(data,before);
  assert.throws(()=>apply(data,[create('new','冲突活动',{item_type:'event',...values})]),error=>error.code==='EVENT_STATUS_CONFLICT');
 }
});

test('隐式旧预约与普通任务不加活动状态；restore原样保留而不回填',()=>{
 const data=legacy();data.tasks[0].title='已预约活动｜历史预约';data.tasks[0].planned_date='2026-10-17';
 const done=apply(data,[update('existing',{status:'done'})]);assert.equal(done.tasks[0].event_status,undefined);assert.equal(done.tasks[0].item_type,undefined);assert.equal(schedule.getEventStatus(done.tasks[0]),'completed');
 const ordinary=apply(legacy(),[update('existing',{status:'done'})]);assert.equal(ordinary.tasks[0].event_status,undefined);
 const restored=structuredClone(data);restored.tasks[0].item_type='event';restored.tasks[0].event_status='reserved';restored.tasks[0].status='done';
 const result=apply(data,[{type:'restore',values:{data:restored}}]);assert.equal(result.tasks[0].event_status,'reserved');assert.equal(result.tasks[0].status,'done');
});

test('事项/活动枚举、真实日期、时区与上海日期一致性均验证',()=>{
 for(const values of [{item_type:'reservation'},{event_status:'done'},{event_date:'2026-02-31'},{fact_date:'2026-02-29'},{start_at:'2026-10-17T18:00:00'},{fact_at:'2026-02-31T18:00:00+08:00'},{event_date:'2026-10-16',start_at:'2026-10-16T16:00:00Z'},{fact_date:'2026-10-16',fact_at:'2026-10-16T16:00:00Z'},{attachment_ids:['not-an-image']}])assert.throws(()=>apply(legacy(),[update('existing',values)]),error=>['FIELD','DATE','DATE_CONFLICT','ATTACHMENT'].includes(error.code));
 assert.equal(apply(legacy(),[update('existing',{event_date:'2026-10-17',start_at:'2026-10-16T16:00:00Z'})]).tasks[0].start_at,'2026-10-16T16:00:00Z');
});

test('同预约按日期/上海等价时刻/地点保守拒绝，原记录保持',()=>{
 const data=apply(legacy(),[create('one','甲方邀请',{item_type:'event',event_status:'reserved',event_date:'2026-10-17',start_at:'2026-10-17T18:00:00+08:00',location:'私人宴会厅'})]);
 assert.throws(()=>apply(data,[create('two','另一个标题',{item_type:'event',event_date:'2026-10-17',start_at:'2026-10-17T10:00:00Z',location:'私人宴会厅'})]),error=>error.code==='DUPLICATE_EVENT'&&error.details.candidate.id==='one');
 assert.throws(()=>apply(data,[create('two','时间尚未明确',{item_type:'event',event_date:'2026-10-17',location:'私人宴会厅'})]),error=>error.code==='DUPLICATE_EVENT');
 assert.equal(apply(data,[create('later','晚上第二场',{item_type:'event',event_date:'2026-10-17',start_at:'2026-10-17T20:00:00+08:00',location:'私人宴会厅'})]).tasks.length,3);
 assert.equal(apply(data,[create('same-title','甲方邀请',{item_type:'event',event_date:'2026-10-18',start_at:'2026-10-18T18:00:00+08:00',location:'私人宴会厅'})]).tasks.length,3);
 assert.equal(apply(data,[create('same-title-time','甲方邀请',{item_type:'event',event_date:'2026-10-17',start_at:'2026-10-17T20:00:00+08:00',location:'私人宴会厅'})]).tasks.length,3);
});

test('prepareImage只验原字节/魔数/mime并产生稳定owner哈希，不写库',async()=>{
 const {db,repo}=fixture();try{const bytes=png(),first=await repo.prepareImage(bytes,'image/png'),second=await repo.prepareImage(bytes,'image/png');assert.equal(first.id,second.id);assert.match(first.id,/^img_[a-f0-9]{64}$/);assert.equal(first.byte_size,bytes.byteLength);assert.deepEqual(new Uint8Array(first.bytes),new Uint8Array(bytes));new Uint8Array(bytes)[8]=99;assert.notEqual(new Uint8Array(first.bytes)[8],99);assert.equal(db.countImages(),0);
  await assert.rejects(repo.prepareImage(png(),'image/jpeg'),error=>error.code==='IMAGE_TYPE');await assert.rejects(repo.prepareImage(png(),'image/svg+xml'),error=>error.code==='IMAGE_TYPE');await assert.rejects(repo.prepareImage(new ArrayBuffer(1500001),'image/png'),error=>error.code==='IMAGE_SIZE');await assert.rejects(repo.prepareImage(new ArrayBuffer(0),'image/png'),error=>error.code==='IMAGE_SIZE');
  assert.equal((await repo.prepareImage(Uint8Array.from([255,216,255,224]).buffer,'image/jpeg')).mime_type,'image/jpeg');assert.equal((await repo.prepareImage(Uint8Array.from([82,73,70,70,4,0,0,0,87,69,66,80]).buffer,'image/webp')).mime_type,'image/webp');
 }finally{db.close();}
});

test('确认提交原图+关联+回执同事务，原图读回一致，幂等重放不增项/图',async()=>{
 const {db,repo}=fixture();try{const image=await repo.prepareImage(png(),'image/png'),request=submit(1,[update('existing',{attachment_ids:[image.id],fact_date:'2026-10-16'})]);const receipt=await repo.commit(request,image);assert.equal(receipt.state,'verified');assert.equal(db.countImages(),1);assert.deepEqual(receipt.after.tasks[0].attachment_ids,[image.id]);assert.equal(JSON.stringify(receipt).includes('"bytes"'),false);assert.equal(JSON.stringify(receipt).includes('base64'),false);const stored=await repo.image(image.id);assert.deepEqual(new Uint8Array(stored.bytes),new Uint8Array(image.bytes));assert.equal(stored.sha256,image.sha256);assert.equal(stored.uploaded_at,image.uploaded_at);assert.equal((await repo.commit(request,image)).duplicate,true);assert.equal((await repo.commit(request)).duplicate,true);assert.equal(db.countImages(),1);assert.equal((await repo.read()).revision,2);assert.equal((await repo.receipt(request.operation_id)).verification,'current_fields_match');}finally{db.close();}
});

test('同图已关联事项不能再create，返回本人候选；明确update复用图片允许',async()=>{
 const {db,repo}=fixture();try{const image=await repo.prepareImage(png(),'image/png');await repo.commit(submit(1,[update('existing',{attachment_ids:[image.id]})]),image);await assert.rejects(repo.commit(submit(2,[create('duplicate','重复图片事项',{attachment_ids:[image.id]})])),error=>error.code==='DUPLICATE_IMAGE'&&error.details.candidate.id==='existing');const result=await repo.commit(submit(2,[update('existing',{next_action:'同图追加说明',attachment_ids:[image.id]})]));assert.equal(result.state,'verified');assert.equal(db.countImages(),1);assert.equal(result.after.tasks.length,1);}finally{db.close();}
});

test('calendar只读透传新事项元数据，不替旧记录回填或返回原图字节',async()=>{
 const {db,repo}=fixture();try{const image=await repo.prepareImage(png(),'image/png');await repo.commit(submit(1,[update('existing',{item_type:'event',event_status:'reserved',event_date:'2026-10-17',start_at:'2026-10-17T18:00:00+08:00',location:'宴会厅',fact_date:'2026-10-16',fact_at:now,attachment_ids:[image.id]})]),image);const before=await repo.read(),calendar=await repo.calendar();for(const key of ['item_type','event_status','event_date','start_at','location','fact_date','fact_at','attachment_ids'])assert.deepEqual(calendar.tasks[0][key],before.data.tasks[0][key]);assert.equal(JSON.stringify(calendar).includes('"bytes"'),false);assert.deepEqual(await repo.read(),before);}finally{db.close();}
});

test('同一原子组用同一图创建两个事项也拒绝，未保存的图不落库',async()=>{
 const {db,repo}=fixture();try{const image=await repo.prepareImage(png(),'image/png');await assert.rejects(repo.commit(submit(1,[create('a','预约客户饭局',{attachment_ids:[image.id]}),create('b','核对未来行程',{attachment_ids:[image.id]})]),image),error=>error.code==='DUPLICATE_IMAGE');assert.equal(db.countImages(),0);assert.equal((await repo.read()).revision,1);}finally{db.close();}
});

test('owner隔离和引用完整性：他人图片/伪造PendingImage/未引用图都不能保存',async()=>{
 const {db,repo}=fixture();try{const image=await repo.prepareImage(png(),'image/png');await assert.rejects(new Repository(db,'other-owner').prepareImage(png(),'image/png'),error=>error.status===409&&error.code==='INITIALIZE');await assert.rejects(new Repository(db,'other-owner').image(image.id),error=>error.status===404);await assert.rejects(repo.commit(submit(1,[update('existing',{attachment_ids:['img_'+'a'.repeat(64)]})])),error=>error.code==='IMAGE');await assert.rejects(repo.commit(submit(1,[update('existing',{attachment_ids:[image.id]})]),{...image,owner_id:'other-owner'}),error=>error.code==='IMAGE_OWNER');await assert.rejects(repo.commit(submit(1,[update('existing',{attachment_ids:[image.id]})]),{...image,sha256:'forged'}),error=>error.code==='IMAGE_INTEGRITY');await assert.rejects(repo.commit(submit(1,[update('existing',{next_action:'没有关联图片'})]),image),error=>error.code==='IMAGE_NOT_REFERENCED');assert.equal(db.countImages(),0);}finally{db.close();}
});

test('CAS抢占或回执插入失败，均不留下图片孤儿或部分关联',async()=>{
 for(const mode of ['cas','operation']){const {db,repo}=fixture();try{const before=await repo.read(),image=await repo.prepareImage(png(),'image/png');if(mode==='cas')db.beforeBatch=()=>db.sql.prepare('UPDATE ledgers SET revision=2,last_operation=? WHERE id=1').run('concurrent-winner');else db.failOperationInsert=true;await assert.rejects(repo.commit(submit(1,[update('existing',{attachment_ids:[image.id]})]),image),error=>error.code===(mode==='cas'?'REVISION_CONFLICT':'SAVE_FAILED'));assert.equal(db.countImages(),0);assert.deepEqual((await repo.read()).data,before.data);assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM operations').get().n,0);}finally{db.close();}}
});

test('持久化的其他owner图片对当前owner不可读、不可关联',async()=>{
 const {db,repo}=fixture();try{const id='img_'+'f'.repeat(64);db.sql.prepare('INSERT INTO images (id,owner_id,sha256,mime_type,byte_size,uploaded_at,bytes) VALUES (?,?,?,?,?,?,?)').run(id,'other-owner','foreign-hash','image/png',png().byteLength,now,new Uint8Array(png()));await assert.rejects(repo.image(id),error=>error.code==='IMAGE'&&error.status===404);await assert.rejects(repo.commit(submit(1,[update('existing',{attachment_ids:[id]})])),error=>error.code==='IMAGE'&&error.status===404);assert.equal((await repo.read()).revision,1);assert.equal((await repo.read()).data.tasks[0].attachment_ids,undefined);}finally{db.close();}
});

test('普通MCP可关联已拥有原图，可选新字段不改变旧参数或公开二进制',()=>{
 const fields={item_type:'event',event_status:'reserved',event_date:'2026-10-17',start_at:'2026-10-17T18:00:00+08:00',fact_date:null,fact_at:null,location:'宴会厅',attachment_ids:['img_'+'b'.repeat(64)]},request=submit(1,[update('existing',fields)]);assert.deepEqual(mcpCommitPayload(request),request);assert.deepEqual(mcpCommitPayload({payload_json:JSON.stringify(request)},true),request);assert.equal(changeValuesSchema.properties.bytes,undefined);assert.equal(changeValuesSchema.properties.created_at,undefined);assert.ok(changeValuesSchema.properties.dependencies);assert.ok(changeValuesSchema.properties.source_ref);assert.throws(()=>mcpCommitPayload({...request,image:'binary'}),error=>error.code==='FIELD');
});
