import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Miniflare} from 'miniflare';
import ts from 'typescript';
const build=path.resolve('.sites-runtime/testbuild');fs.mkdirSync(build,{recursive:true});
for(const n of ['model','repository'])fs.writeFileSync(path.join(build,n+'.mjs'),ts.transpileModule(fs.readFileSync('lib/'+n+'.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace("'./model'","'./model.mjs'"));
const {Repository}=await import(new URL('../.sites-runtime/testbuild/repository.mjs',import.meta.url));
// Exercise the actual previously published repository and model implementation.
for(const n of ['model','repository']){
 const original=execFileSync('git',['show',`e2b268e521b1d0f2305802f40e9d343a85cf4103:lib/${n}.ts`],{encoding:'utf8'});
 const js=ts.transpileModule(original,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace("'./model'","'./legacy-model.mjs'");
 fs.writeFileSync(path.join(build,'legacy-'+n+'.mjs'),js);
}
const {Repository:LegacyRepository}=await import(new URL('../.sites-runtime/testbuild/legacy-repository.mjs',import.meta.url));
const run=crypto.randomUUID(),persist=path.resolve('.sites-runtime/d1-proof',run);
const options={modules:true,script:'export default { fetch(){return new Response("isolated D1 QA")} }',compatibilityDate:'2026-05-15',d1Databases:{DB:'00000000-0000-4000-8000-000000000000'},d1Persist:persist};
let mf=new Miniflare(options);
try{
 let db=await mf.getD1Database('DB');for(const f of fs.readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())for(const sql of fs.readFileSync('drizzle/'+f,'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))await db.prepare(sql).run();
 let repo=new Repository(db,'d1-test-owner');await repo.initialize();const empty=(await repo.read()).data;empty.projects.push({id:'p-inbox',name:'虚构项目',goal:'测试',status:'active',completion_rule:'测试',external_links:[],version:1});await db.prepare('UPDATE ledgers SET data=? WHERE owner_id=?').bind(JSON.stringify(empty),'d1-test-owner').run();
 const make=(title)=>{const id=crypto.randomUUID();return {operation_id:id,idempotency_key:id,source_event_id:id,base_version:1,occurred_at:new Date().toISOString(),raw_text:'虚构D1并发测试',changes:[{type:'create',values:{project_id:'p-inbox',title}}]}};
 const a=make('虚构D1竞争A'),b=make('虚构D1竞争B');const outcomes=await Promise.allSettled([repo.commit(a),repo.commit(b)]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.find(x=>x.status==='rejected').reason.code,'REVISION_CONFLICT');
 const winner=outcomes.find(x=>x.status==='fulfilled').value;assert.equal(winner.state,'verified');assert.equal((await repo.read()).data.tasks.filter(t=>t.title.startsWith('虚构D1竞争')).length,1);
 const snapshot=await repo.read();await assert.rejects(db.batch([db.prepare('UPDATE ledgers SET data=? WHERE id=1').bind('{"corrupt":true}'),db.prepare('INSERT INTO deliberately_missing_table (id) VALUES (1)')]));assert.deepEqual(await repo.read(),snapshot);
 const foreign=new Repository(db,'foreign-user');assert.equal((await foreign.read()).initialized,false);assert.deepEqual((await foreign.initialize()).data.tasks,[]);await assert.rejects(foreign.receipt(winner.operation_id),e=>e.status===404);
 const foreignData=(await foreign.read()).data;foreignData.projects.push({id:'p-inbox',name:'另一个虚构项目',goal:'测试',status:'active',completion_rule:'测试',external_links:[],version:1});await db.prepare('UPDATE ledgers SET data=? WHERE owner_id=?').bind(JSON.stringify(foreignData),'foreign-user').run();
 const sameInput=winner.operation_id===a.operation_id?a:b;const foreignReceipt=await foreign.commit(sameInput);assert.equal(foreignReceipt.operation_id,winner.operation_id);assert.equal(foreignReceipt.state,'verified');assert.equal((await foreign.commit(sameInput)).duplicate,true);assert.equal((await repo.receipt(winner.operation_id)).after.projects[0].name,'虚构项目');assert.equal((await foreign.receipt(winner.operation_id)).after.projects[0].name,'另一个虚构项目');
 const legacy=new LegacyRepository(db,'d1-test-owner');assert.equal((await legacy.receipt(winner.operation_id)).state,'verified');assert.equal((await legacy.commit(sameInput)).duplicate,true);
 const undone=await legacy.undo(winner.operation_id,2,'rollback-undo');assert.equal(undone.undo_of,winner.operation_id);assert.equal(undone.state,'verified');
 const legacyNext={...make('旧版回退后继续写入'),base_version:3};const legacySaved=await legacy.commit(legacyNext);assert.equal(legacySaved.state,'verified');assert.equal((await repo.receipt(legacySaved.operation_id)).state,'verified');
 const otherStorageId=(await db.prepare('SELECT id FROM operations WHERE owner_id=? AND idempotency_key=?').bind('foreign-user',sameInput.idempotency_key).first()).id;
 const forbidden={...make('禁止占用其他账号编号'),base_version:4,operation_id:otherStorageId};await assert.rejects(repo.commit(forbidden),e=>e.code==='RESERVED_OPERATION_ID');assert.equal((await repo.read()).revision,4);
 // Old versions did not reserve this prefix. A previously saved legacy ID
 // remains readable and safely retryable after switching back to the new code.
 const legacyPrefixed={...make('旧版保留前缀编号'),base_version:4,operation_id:'account-op:legacy-fixture'};assert.equal((await legacy.commit(legacyPrefixed)).state,'verified');assert.equal((await repo.receipt(legacyPrefixed.operation_id)).state,'verified');assert.equal((await repo.commit(legacyPrefixed)).duplicate,true);
 await mf.dispose();mf=new Miniflare(options);db=await mf.getD1Database('DB');repo=new Repository(db,'d1-test-owner');const restarted=await repo.read();assert.equal(restarted.revision,5);assert.equal((await repo.receipt(winner.operation_id)).state,'verified');
 const report={runtime:'Miniflare / workerd real D1',run,checks:{concurrentCAS:true,atomicRollback:true,foreignIdentityIsolated:true,identicalOperationIdAcrossAccounts:true,legacyReceiptRetryUndoAndWrite:true,reservedPrefixCollisionRejected:true,legacyReservedPrefixRetry:true,reopenPersistence:true,receiptVerified:true},operation_id:winner.operation_id,result_version:2};fs.writeFileSync('.sites-runtime/d1-proof-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await mf.dispose()}
