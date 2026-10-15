import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Miniflare} from 'miniflare';
import ts from 'typescript';
const build=path.resolve('.sites-runtime/testbuild');fs.mkdirSync(build,{recursive:true});
for(const n of ['model','repository'])fs.writeFileSync(path.join(build,n+'.mjs'),ts.transpileModule(fs.readFileSync('lib/'+n+'.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace("'./model'","'./model.mjs'"));
const {Repository}=await import(new URL('../.sites-runtime/testbuild/repository.mjs',import.meta.url));
const run=crypto.randomUUID(),persist=path.resolve('.sites-runtime/d1-proof',run);
const options={modules:true,script:'export default { fetch(){return new Response("isolated D1 QA")} }',compatibilityDate:'2026-05-15',d1Databases:{DB:'00000000-0000-4000-8000-000000000000'},d1Persist:persist};
let mf=new Miniflare(options);
try{
 let db=await mf.getD1Database('DB');for(const f of fs.readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())for(const sql of fs.readFileSync('drizzle/'+f,'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))await db.prepare(sql).run();
 let repo=new Repository(db,'d1-test-owner');await repo.initialize();
 const make=(title)=>{const id=crypto.randomUUID();return {operation_id:id,idempotency_key:id,source_event_id:id,base_version:1,occurred_at:new Date().toISOString(),raw_text:'虚构D1并发测试',changes:[{type:'create',values:{project_id:'p-inbox',title}}]}};
 const a=make('虚构D1竞争A'),b=make('虚构D1竞争B');const outcomes=await Promise.allSettled([repo.commit(a),repo.commit(b)]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.find(x=>x.status==='rejected').reason.code,'REVISION_CONFLICT');
 const winner=outcomes.find(x=>x.status==='fulfilled').value;assert.equal(winner.state,'verified');assert.equal((await repo.read()).data.tasks.filter(t=>t.title.startsWith('虚构D1竞争')).length,1);
 const snapshot=await repo.read();await assert.rejects(db.batch([db.prepare('UPDATE ledgers SET data=? WHERE id=1').bind('{"corrupt":true}'),db.prepare('INSERT INTO deliberately_missing_table (id) VALUES (1)')]));assert.deepEqual(await repo.read(),snapshot);
 const foreign=new Repository(db,'foreign-user');await assert.rejects(foreign.read(),e=>e.status===403);
 await mf.dispose();mf=new Miniflare(options);db=await mf.getD1Database('DB');repo=new Repository(db,'d1-test-owner');const restarted=await repo.read();assert.equal(restarted.revision,2);assert.equal((await repo.receipt(winner.operation_id)).state,'verified');
 const report={runtime:'Miniflare / workerd real D1',run,checks:{concurrentCAS:true,atomicRollback:true,foreignIdentity403:true,reopenPersistence:true,receiptVerified:true},operation_id:winner.operation_id,result_version:2};fs.writeFileSync('.sites-runtime/d1-proof-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await mf.dispose()}
