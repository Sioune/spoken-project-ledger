import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// No seed, database, build directory or production API: IDs and contacts belong to this fixture.
const source=fs.readFileSync(new URL('../lib/model.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {preview,applyChanges}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const now='2026-10-16T08:00:00.000Z';
const project=(id='video-project',name='teaser')=>({id,name,goal:'虚构测试',status:'active',completion_rule:'本人核实',external_links:[],version:1});
const task=(id,title,status='todo',dependencies=[],extra={})=>({id,project_id:'video-project',title,status,next_action:title,dependencies,version:1,updated_at:'2026-10-15T01:00:00.000Z',completed_at:status==='done'?null:null,verification_state:'user_reported',source_ref:'旧原话含松叶/宋业，不用于当前联系人判断',...extra});
function fixture({compound=true,chain=false}={}){
 const tasks=[task('previous-cut','更新 teaser','done'),task('previous-send','发送 teaser 给松叶','done',['previous-cut']),task('previous-reply','等待 teaser 反馈','waiting',['previous-send'],{waiting_for:'宋晔',expected_result:'保留已核实的当前反馈说明'})];
 if(compound)tasks.push(task('current-round','10月16日 teaser 新一轮修订及同步宋晔'));
 if(chain)tasks.push(task('second-cut','10月16日 teaser 第2轮更新'),task('second-send','10月16日 teaser 第2轮发送给宋晔','blocked',['second-cut']),task('second-reply','10月16日 teaser 第2轮等待反馈','blocked',['second-send'],{waiting_for:'宋晔',expected_result:'第二轮反馈'}));
 return {projects:[project()],tasks,documents:[],pending:[],settings:{timezone:'Asia/Shanghai',intervalHours:2,workStart:'09:00',workEnd:'19:00',enabled:false},reminderLog:[]};
}
const parse=(text,data)=>preview(text,data,8,'fixture-source',now);
const targets=result=>result.changes.map(c=>[c.id,c.values.status]);
const conservative=(text,data)=>{const result=parse(text,data);assert.deepEqual(result.changes,[],text);assert.ok(result.questions.length,text);return result;};

test('四条原问题输入在新旧轮次并存时均不触碰前轮或贸然完成复合任务',()=>{
 const data=fixture(),before=structuredClone(data);
 for(const text of ['10月16日新一轮 teaser 已更新并发给宋晔了，现在等他反馈。','10月16日新一轮 teaser 已经更新并发出了，等待反馈。','宋晔说10月16日新一轮 teaser 反馈收到了。','新增待办：10月16日 teaser 新一轮更新并同步宋晔。'])conservative(text,data);
 assert.deepEqual(data,before);
});

test('无日期的反馈或制作事实不能因前轮有唯一反馈任务而串轮',()=>{
 const data=fixture();for(const text of ['teaser反馈收到了','teaser已更新并发给宋晔了，等待反馈','新一轮 teaser 反馈收到了','已经更新 teaser','新一轮已经更新 teaser','新一轮已经发送 teaser 给松叶了','not-previous-cut teaser 已更新'])conservative(text,data);
 assert.deepEqual(targets(parse('previous-cut teaser 已更新',data)),[['previous-cut','done']]);
});

test('明确日期与第几轮匹配实时步骤、联系人和依赖，旧任务保持不变',()=>{
 const data=fixture({compound:false,chain:true});
 const result=parse('10月16日 teaser 第2轮已经更新并发给宋晔了，等待反馈。',data);
 assert.deepEqual(targets(result),[['second-cut','done'],['second-send','done'],['second-reply','waiting']]);
 assert.deepEqual(result.questions,[]);
 const after=applyChanges(data,result.changes,now,now).data;
 assert.deepEqual(after.tasks.slice(0,3),data.tasks.slice(0,3));
 assert.equal(after.tasks.find(t=>t.id==='second-reply').expected_result,'第二轮反馈');
});

test('日期支持ISO与中文，不从updated_at猜轮次',()=>{
 const data=fixture({compound:false,chain:true});
 const result=parse('2026-10-16 teaser 第2轮已经更新并发给宋晔了，等待反馈。',data);
 assert.deepEqual(targets(result),[['second-cut','done'],['second-send','done'],['second-reply','waiting']]);
 conservative('10月17日 teaser 已更新',data);
});

test('明确实时任务编号或完整标题可定位旧轮次反馈，保留当前文案',()=>{
 const data=fixture();
 assert.deepEqual(targets(parse('previous-reply 的 teaser 反馈收到了',data)),[['previous-reply','done']]);
 assert.deepEqual(targets(parse('“等待 teaser 反馈”的反馈收到了',data)),[['previous-reply','done']]);
 const single=fixture({compound:false});
 const result=parse('teaser 已更新并发给宋晔了，等待反馈',single);
 assert.deepEqual(targets(result),[['previous-cut','done'],['previous-send','done'],['previous-reply','waiting']]);
 assert.deepEqual(result.changes[2].values,{status:'waiting'});
});

test('仅单轮仍支持收到反馈，不依赖固定ID或松叶姓名',()=>{
 const data=fixture({compound:false});
 assert.deepEqual(targets(parse('宋晔说 teaser反馈收到了',data)),[['previous-reply','done']]);
 assert.deepEqual(targets(parse('teaser反馈收到了',data)),[['previous-reply','done']]);
 data.tasks[2].waiting_for='王宁';
 assert.deepEqual(targets(parse('teaser已经发给王宁了，等待反馈',data)),[['previous-send','done'],['previous-reply','waiting']]);
});

test('原单轮松叶记录仍由实时waiting_for兼容，不从旧source_ref认定联系人',()=>{
 const data=fixture({compound:false});data.tasks[2].waiting_for='松叶';
 assert.deepEqual(targets(parse('teaser 已更新并发给松叶了，等待反馈',data)),[['previous-cut','done'],['previous-send','done'],['previous-reply','waiting']]);
 data.tasks[2].waiting_for='宋晔';
 for(const text of ['teaser已更新并发给松叶了，等待反馈','teaser已发给宋业了，等待反馈','张锦华说 teaser反馈收到了','宋业反馈收到了，teaser已更新'])conservative(text,data);
});

test('接收反馈的具名结构逐一匹配当前联系人，不把动词当姓名',()=>{
 const data=fixture({compound:false});
 for(const text of ['teaser 收到宋业反馈','teaser 已收到宋业反馈','teaser 收到张三反馈','teaser 收到宋业的反馈','宋业反馈收到了，teaser已更新'])conservative(text,data);
 for(const text of ['teaser 收到宋晔反馈','teaser 已收到宋晔反馈','teaser 收到宋晔的反馈','teaser 已收到宋晔的反馈','teaser 收到反馈','teaser 收到teaser反馈'])assert.deepEqual(targets(parse(text,data)),[['previous-reply','done']],text);
});

test('异常发送与未知的发送/等待对象不能被误认为成功',()=>{
 const data=fixture({compound:false});
 for(const text of ['teaser 发送失败了','teaser已经更新，但发送出错了','teaser已经更新，发送 teaser 给张三了','teaser 已发送给张三了','teaser 已经发送给张三了','已经发送 teaser 给张三了','teaser 给张三发了','teaser 等张三反馈','teaser 等宋业反馈'])conservative(text,data);
 assert.deepEqual(targets(parse('teaser 已发送给宋晔了',data)),[['previous-send','done']]);
 assert.deepEqual(targets(parse('teaser已经发送 teaser 给宋晔了，等他反馈',data)),[['previous-send','done'],['previous-reply','waiting']]);
});

test('否定、疑问、计划、条件及混合不明确意图不部分写入',()=>{
 const data=fixture({compound:false});
 for(const text of ['teaser还未更新','teaser未改好','teaser未收到反馈','teaser不是已经更新了','teaser更新完成了吗？','teaser已更新，但尚未发给宋晔','teaser已经更新，下周发给宋晔','如果收到teaser反馈后再更新','teaser反馈收到了，继续等待反馈'])conservative(text,data);
});

test('已更新之后的发送计划不能被宽泛的“已…发”误认',()=>{
 const data=fixture({compound:false});
 const result=parse('teaser已经更新，发送给宋晔',data);
 assert.deepEqual(targets(result),[['previous-cut','done']]);
});

test('多个日期、多个轮次、跨轮任务ID都只提问',()=>{
 const data=fixture({compound:false,chain:true});
 for(const text of ['10月15日和10月16日 teaser 已更新','teaser第1轮和第2轮反馈收到了','上一轮 teaser 更新好了，新一轮已经发出了','previous-reply 和 second-reply 的teaser反馈收到了'])conservative(text,data);
});

test('同一日期仍有多个独立轮次时不能凭数组顺序选择',()=>{
 const data=fixture();data.tasks.push(task('another-round','10月16日 teaser 新一轮制作'));
 conservative('10月16日 teaser 已经更新',data);
});

test('选择未完成前序的反馈时不能跳过依赖或自动完成前序',()=>{
 const data=fixture({compound:false,chain:true});
 conservative('10月16日 teaser 第2轮反馈收到了',data);
 conservative('10月16日 teaser 第2轮已经发给宋晔了，等待反馈',data);
});

test('已有done反馈不能因“等反馈”重新打开',()=>{
 const data=fixture({compound:false});data.tasks[2].status='done';
 conservative('teaser 等待反馈',data);
});

test('跨项目teaser不串；明确项目可选择对应步骤',()=>{
 const data=fixture({compound:false});
 data.projects[0].name='甲方 teaser';data.projects.push(project('other-video','乙方 teaser'));
 data.tasks.push(task('other-cut','更新 teaser','done',[],{project_id:'other-video'}),task('other-send','发送 teaser 给王宁','done',['other-cut'],{project_id:'other-video'}),task('other-reply','等待 teaser 反馈','waiting',['other-send'],{project_id:'other-video',waiting_for:'王宁'}));
 conservative('teaser反馈收到了',data);
 assert.deepEqual(targets(parse('甲方 teaser 反馈收到了',data)),[['previous-reply','done']]);
 conservative('甲方 teaser 和乙方 teaser反馈收到了',data);
});

test('不同轮次的日期和步骤通过同一依赖图关联也不能选错反馈',()=>{
 const data=fixture({compound:false,chain:true});data.tasks.find(t=>t.id==='second-cut').dependencies=['previous-reply'];
 conservative('10月16日 teaser 第2轮反馈收到了',data);
});
