// Real MCP route + repository on an isolated local D1 with fictional identities.
// This does not exercise Sites authentication, an external client, or production.
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';

const mf = new Miniflare({modules:true,script:'export default { fetch(){return new Response("isolated test only")} }',compatibilityDate:'2026-05-15',d1Databases:{DB:'00000000-0000-4000-8000-000000000000'},d1Persist:path.resolve('.sites-runtime/account-mcp-proof',crypto.randomUUID())});
try {
 const db=await mf.getD1Database('DB');
 for(const name of ['0000_outstanding_ultimatum.sql','0001_sharp_yellowjacket.sql','0002_regular_storm.sql'])
  for(const sql of fs.readFileSync('drizzle/'+name,'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))await db.prepare(sql).run();
 const auth=new AsyncLocalStorage();globalThis.__mcpProof={db,auth};
 const adapters={name:'isolated-mcp-auth',setup(b){
  b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'worker',namespace:'fixture'}));
  b.onResolve({filter:/^@\/app\/chatgpt-auth$/},()=>({path:'auth',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='worker'?'export const env={DB:globalThis.__mcpProof.db};':'export async function getChatGPTUser(){return globalThis.__mcpProof.auth.getStore()??null}',loader:'js'}));
 }};
 const bundle=await build({entryPoints:['app/mcp/route.ts'],bundle:true,write:false,platform:'node',format:'esm',alias:{'@':process.cwd()},plugins:[adapters]});
 const {POST}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
 const owner={userId:'fixture-owner',displayName:'Owner',email:'owner@fixture.invalid'},other={userId:'fixture-other',displayName:'Other',email:'other@fixture.invalid'};
 async function rpc(user,method,params={}){
  const request=new Request('https://fixture.invalid/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  return auth.run(user,async()=>{const response=await POST(request);assert.equal(response.status,200);return response.json()});
 }
 async function call(user,name,args={}) {return (await rpc(user,'tools/call',{name,arguments:args})).result;}
 function ok(result){assert.equal(result.isError,false,JSON.stringify(result));return result.structuredContent;}
 function failure(result,code){assert.equal(result.isError,true);assert.equal(result.structuredContent.error,code);}
 const listed=(await rpc(owner,'tools/list')).result.tools.map(t=>t.name);
 assert.deepEqual(listed,['ledger_read','ledger_initialize','ledger_preview','ledger_commit','ledger_commit_json','ledger_receipt','ledger_undo']);
 failure(await call(null,'ledger_read'),'AUTH');
 assert.deepEqual((await db.prepare('SELECT COUNT(*) AS n FROM accounts').first()).n,0);
 assert.equal(ok(await call(owner,'ledger_read')).initialized,false);
 assert.equal(ok(await call(other,'ledger_read')).initialized,false);
 assert.equal(ok(await call(owner,'ledger_initialize')).revision,1);
 assert.equal(ok(await call(other,'ledger_initialize')).revision,1);
 const make=(op,version,changes)=>({operation_id:op,idempotency_key:op+'-key',source_event_id:op+'-source',base_version:version,occurred_at:new Date().toISOString(),raw_text:'虚构隔离验收',changes,confirmed:true});
 const createProject=(name)=>[{type:'project',id:'shared-project-id',values:{name,goal:'隔离测试',status:'active',external_links:[]}}];
 const ownerProject=make('same-operation',1,[...createProject('A 的项目'),{type:'project',id:'owner-only-project',values:{name:'A 的私有 teaser',goal:'隔离测试',status:'active',external_links:[]}}]);
 const explicitNo={...ownerProject,confirmed:false};
 const opCountBefore=(await db.prepare('SELECT count(*) AS n FROM operations').first()).n;
 failure(await call(owner,'ledger_commit',explicitNo),'CONFIRM');
 failure(await call(owner,'ledger_commit_json',{payload_json:JSON.stringify(explicitNo)}),'CONFIRM');
 assert.equal((await db.prepare('SELECT count(*) AS n FROM operations').first()).n,opCountBefore);
 assert.equal(ok(await call(owner,'ledger_read')).revision,1);
 // Omission retains already-authorized legacy callers; false does not.
 const legacyProject={...ownerProject};delete legacyProject.confirmed;
 ok(await call(owner,'ledger_commit',legacyProject));
 assert.equal(ok(await call(owner,'ledger_commit',legacyProject)).duplicate,true);
 failure(await call(owner,'ledger_commit',explicitNo),'CONFIRM');
 failure(await call(owner,'ledger_commit_json',{payload_json:JSON.stringify(explicitNo)}),'CONFIRM');
 assert.equal((await db.prepare('SELECT count(*) AS n FROM operations').first()).n,opCountBefore+1);
 assert.equal(ok(await call(owner,'ledger_read')).revision,2);
 assert.equal(ok(await call(owner,'ledger_receipt',{operation_id:ownerProject.operation_id})).state,'verified');
 const otherProject=make('same-operation',1,createProject('B 的项目'));delete otherProject.confirmed;
 ok(await call(other,'ledger_commit_json',{payload_json:JSON.stringify(otherProject)}));
 assert.equal(ok(await call(other,'ledger_commit_json',{payload_json:JSON.stringify(otherProject)})).duplicate,true);
 const taskA=make('a-task',2,[{type:'create',id:'owner-task',values:{title:'更新 teaser',project_id:'owner-only-project'}}]);
 const taskB=make('b-task',2,[{type:'create',id:'other-task',values:{title:'B 的任务',project_id:'shared-project-id'}}]);
 ok(await call(owner,'ledger_commit',taskA));ok(await call(other,'ledger_commit',taskB));
 let stateA=ok(await call(owner,'ledger_read')),stateB=ok(await call(other,'ledger_read'));
 assert.deepEqual(stateA.data.tasks.map(t=>t.id),['owner-task']);
 assert.deepEqual(stateB.data.tasks.map(t=>t.id),['other-task']);
 assert.equal(stateA.data.projects[0].name,'A 的项目');assert.equal(stateB.data.projects[0].name,'B 的项目');
 // Preview derives from the caller's own ledger, and neither a proposed change
 // nor the pending question is persisted until a later, explicit commit.
 const countsBefore=(await db.prepare('SELECT (SELECT count(*) FROM operations) ops,(SELECT count(*) FROM ledgers) ledgers').first());
 const requestPreview=text=>({text,source_event_id:'preview-only',occurred_at:new Date().toISOString()});
 const privateTaskText='A 的私有 teaser 已更新';
 const previewA=ok(await call(owner,'ledger_preview',requestPreview(privateTaskText)));
 const previewB=ok(await call(other,'ledger_preview',requestPreview(privateTaskText)));
 assert.ok(previewA.changes.some(c=>c.type==='update'&&c.id==='owner-task'));
 assert.ok(previewB.questions.length>0);assert.ok(!previewB.changes.some(c=>c.type==='update'||c.id==='owner-task'));
 const privateProjectText='新增任务：A 的私有 teaser 撰写方案';
 const projectPreviewA=ok(await call(owner,'ledger_preview',requestPreview(privateProjectText)));
 const projectPreviewB=ok(await call(other,'ledger_preview',requestPreview(privateProjectText)));
 assert.ok(projectPreviewA.changes.some(c=>c.type==='create'&&c.values.project_id==='owner-only-project'));
 assert.ok(projectPreviewB.questions.length>0);assert.ok(!projectPreviewB.changes.some(c=>c.type==='create'||c.values?.project_id==='owner-only-project'));
 assert.deepEqual(ok(await call(owner,'ledger_read')).data,stateA.data);assert.deepEqual(ok(await call(other,'ledger_read')).data,stateB.data);
 assert.equal(ok(await call(owner,'ledger_read')).revision,stateA.revision);assert.equal(ok(await call(other,'ledger_read')).revision,stateB.revision);
 assert.deepEqual(await db.prepare('SELECT (SELECT count(*) FROM operations) ops,(SELECT count(*) FROM ledgers) ledgers').first(),countsBefore);
 assert.equal(ok(await call(owner,'ledger_receipt',{operation_id:'same-operation'})).after.projects[0].name,'A 的项目');
 assert.equal(ok(await call(other,'ledger_receipt',{operation_id:'same-operation'})).after.projects[0].name,'B 的项目');
 failure(await call(other,'ledger_receipt',{operation_id:'a-task'}),'OPERATION');
 failure(await call(other,'ledger_commit',make('forbidden-update',stateB.revision,[{type:'update',id:'owner-task',values:{title:'跨账号写入'}}])),'TASK');
 failure(await call(other,'ledger_commit',make('forbidden-project',stateB.revision,[{type:'create',values:{title:'跨账号项目写入',project_id:'owner-only-project'}}])),'PROJECT');
 const mark=make('b-complete',stateB.revision,[{type:'update',id:'other-task',values:{status:'done'}}]);
 ok(await call(other,'ledger_commit',mark));
 assert.equal(ok(await call(other,'ledger_read')).data.tasks[0].status,'done');
 assert.equal(ok(await call(owner,'ledger_read')).data.tasks[0].status,'todo');
 const duplicate=ok(await call(other,'ledger_commit',mark));assert.equal(duplicate.duplicate,true);
 failure(await call(other,'ledger_commit',{...mark,raw_text:'不同内容'}),'IDEMPOTENCY_MISMATCH');
 failure(await call(null,'ledger_commit',make('anonymous',0,[])),'AUTH');
 console.log(JSON.stringify({status:'verified',runtime:'isolated Miniflare D1',actualMcpRoute:true,fictionalSitesIdentities:true,toolCount:listed.length,independentSameIds:true,ownTasks:true,foreignReceiptRejected:true,foreignWriteRejected:true,previewUsesOwnLedger:true,previewDoesNotPersist:true,foreignProjectRejected:true,anonymousRejected:true,explicitFalseRejected:true,omittedConfirmationCompatible:true,exactRetry:true}));
} finally {await mf.dispose();delete globalThis.__mcpProof}
