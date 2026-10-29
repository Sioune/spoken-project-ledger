// End-to-end API/repository proof against an isolated Miniflare D1. Only the
// Sites identity/binding adapters are replaced, with fictional identities.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';

const id=crypto.randomUUID(),store=path.resolve('.sites-runtime/account-api-proof',id);
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated test only")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'00000000-0000-4000-8000-000000000000'},d1Persist:store});
try{
 const db=await mf.getD1Database('DB');const apply=async name=>{for(const statement of fs.readFileSync('drizzle/'+name,'utf8').split('--> statement-breakpoint').filter(x=>x.trim()))await db.prepare(statement).run()};
 await apply('0000_outstanding_ultimatum.sql');await apply('0001_sharp_yellowjacket.sql');
 const fixture=JSON.parse(fs.readFileSync('tests/visual-fixture.json','utf8')).data;
 const owner='fictional-legacy-owner',visitor='fictional-second-user';
 const legacy={state:'saved',operation_id:'legacy-op',result_version:5,created_at:'2026-10-01T00:00:00Z',occurred_at:'2026-10-01T00:00:00Z',timezone:'Asia/Shanghai',changes:[],before:fixture,after:fixture,source_event_id:'legacy-source',raw_text:'虚构旧记录'};
 await db.prepare('INSERT INTO ledgers (id,owner_id,revision,data,last_operation) VALUES (1,?,?,?,?)').bind(owner,5,JSON.stringify(fixture),'legacy-op').run();
 await db.prepare('INSERT INTO operations (id,owner_id,idempotency_key,source_event_id,payload_hash,receipt,created_at) VALUES (?,?,?,?,?,?,?)').bind('legacy-op',owner,'legacy-key','legacy-source','legacy-hash',JSON.stringify(legacy),legacy.created_at).run();
 await db.prepare('INSERT INTO images (id,owner_id,sha256,mime_type,byte_size,uploaded_at,bytes) VALUES (?,?,?,?,?,?,?)').bind('legacy-image',owner,'fixture-hash','image/png',3,'2026-10-01T00:00:00Z',new Uint8Array([0,1,255])).run();
 const before=await db.prepare('SELECT * FROM ledgers WHERE id=1').first();
 await apply('0002_regular_storm.sql');assert.deepEqual(await db.prepare('SELECT * FROM ledgers WHERE id=1').first(),before);
 const auth=new AsyncLocalStorage();globalThis.__accountProof={db,auth};
 const replacement={name:'fictional-sites-auth-and-isolated-d1',setup(b){
  b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'worker',namespace:'fixture'}));
  b.onResolve({filter:/^@\/app\/chatgpt-auth$/},()=>({path:'auth',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='worker'?'export const env={DB:globalThis.__accountProof.db};':'export async function getChatGPTUser(){return globalThis.__accountProof.auth.getStore()??null}',loader:'js'}));
 }};
 const bundled=await build({entryPoints:['lib/api.ts'],bundle:true,write:false,platform:'node',format:'esm',alias:{'@':process.cwd()},plugins:[replacement]});
 const {api,action}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
 async function call(who,method,route,{scope,body}={}){
  const headers={};if(scope!==undefined)headers['X-Ledger-Account-Scope']=scope;if(body!==undefined)headers['Content-Type']='application/json';
  const request=new Request('https://fixture.invalid/api/'+route,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const user=who?{userId:who,displayName:who,email:who+'@fixture.invalid'}:null;
  return auth.run(user,async()=>{const response=await api(request,route.split('/'));const type=response.headers.get('content-type')||'';return {status:response.status,body:type.includes('application/json')?await response.json():await response.arrayBuffer()}});
 }
 const original=await call(owner,'GET','state'),newAccount=await call(visitor,'GET','state');
 assert.equal(original.status,200);assert.equal(original.body.revision,5);assert.deepEqual(original.body.data,fixture);assert.equal(newAccount.body.initialized,false);assert.equal(newAccount.body.data,null);
 const a=original.body.identity.draftScope,b=newAccount.body.identity.draftScope;assert.notEqual(a,b);
 assert.equal((await call(visitor,'POST','initialize',{scope:b,body:{}})).status,200);
 assert.deepEqual((await call(visitor,'GET','state')).body.data.projects,[]);
 const noScope=await call(visitor,'POST','initialize',{body:{}});assert.equal(noScope.status,409);assert.equal(noScope.body.error,'ACCOUNT_CHANGED');
 const legacyA=await call(owner,'GET','operations/legacy-op',{scope:a});assert.equal(legacyA.status,200);assert.equal(legacyA.body.operation_id,'legacy-op');
 assert.equal((await call(visitor,'GET','operations/legacy-op',{scope:b})).status,404);
 assert.equal((await call(visitor,'GET','images/legacy-image')).status,404);
 assert.deepEqual([...new Uint8Array((await call(owner,'GET','images/legacy-image')).body)],[0,1,255]);
 const now=new Date().toISOString(),make=(title,base)=>({operation_id:'same-op',idempotency_key:'same-key',source_event_id:'same-source',base_version:base,occurred_at:now,raw_text:title,confirmed:true,changes:[{type:'project',id:'same-project',values:{name:title,goal:'虚构隔离测试',status:'active',external_links:[]}}]});
 const stale=await call(visitor,'POST','operations',{scope:a,body:make('A 的私有内容',1)});assert.equal(stale.status,409);assert.equal(stale.body.error,'ACCOUNT_CHANGED');assert.equal((await call(visitor,'GET','state')).body.revision,1);
 const [ar,br]=await Promise.all([call(owner,'POST','operations',{scope:a,body:make('A 的项目',5)}),call(visitor,'POST','operations',{scope:b,body:make('B 的项目',1)})]);
 assert.equal(ar.status,200,JSON.stringify(ar.body));assert.equal(br.status,200,JSON.stringify(br.body));assert.equal(ar.body.state,'verified');assert.equal(br.body.state,'verified');
 const [afterA,afterB]=await Promise.all([call(owner,'GET','state'),call(visitor,'GET','state')]);assert.equal(afterA.body.revision,6);assert.equal(afterB.body.revision,2);assert.equal(afterA.body.data.projects.find(p=>p.id==='same-project').name,'A 的项目');assert.equal(afterB.body.data.projects.find(p=>p.id==='same-project').name,'B 的项目');
 assert.equal((await call(owner,'GET','operations/same-op',{scope:a})).body.after.projects.find(p=>p.id==='same-project').name,'A 的项目');assert.equal((await call(visitor,'GET','operations/same-op',{scope:b})).body.after.projects.find(p=>p.id==='same-project').name,'B 的项目');
 const [race1,race2]=await Promise.all([call(visitor,'POST','operations',{scope:b,body:{...make('并发 B 一',2),operation_id:'b-race-1',idempotency_key:'b-key-1',source_event_id:'b-source-1'}}),call(visitor,'POST','operations',{scope:b,body:{...make('并发 B 二',2),operation_id:'b-race-2',idempotency_key:'b-key-2',source_event_id:'b-source-2'}})]);
 assert.deepEqual([race1.status,race2.status].sort(),[200,409]);
 assert.equal((await call(null,'GET','state')).status,401);
 const mcp=await auth.run({userId:owner,displayName:owner,email:'owner@fixture.invalid'},()=>action('state',{}));assert.equal(mcp.revision,6);
 console.log(JSON.stringify({status:'verified',runtime:'isolated Miniflare D1',realApi:true,fictionalIdentityAdapter:true,legacyPreserved:true,emptySecondAccount:true,staleScopeRejected:true,legacyReceiptAndImageIsolated:true,concurrentUsersSameOperationId:true,sameAccountConflict:true,mcpAuthenticatedPath:true}));
}finally{await mf.dispose();delete globalThis.__accountProof}
