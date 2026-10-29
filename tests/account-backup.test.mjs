import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Miniflare} from 'miniflare';
import ts from 'typescript';

const build=path.resolve('.sites-runtime/account-backup-testbuild');
fs.mkdirSync(build,{recursive:true});
for(const n of ['model','account-backup'])fs.writeFileSync(path.join(build,n+'.mjs'),ts.transpileModule(fs.readFileSync('lib/'+n+'.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace("'./model'","'./model.mjs'"));
const {exportAccountSnapshot,assertAccountBackupRequest}=await import(new URL('../.sites-runtime/account-backup-testbuild/account-backup.mjs',import.meta.url));
const url='https://private.example/api/account-backup';
assert.doesNotThrow(()=>assertAccountBackupRequest(new Request(url,{headers:{'x-ledger-backup':'download','origin':'https://private.example'}})));
assert.throws(()=>assertAccountBackupRequest(new Request(url)),e=>e.status===403);
assert.throws(()=>assertAccountBackupRequest(new Request(url,{headers:{'x-ledger-backup':'download','origin':'https://evil.example'}})),e=>e.status===403);
const mf=new Miniflare({modules:true,script:'export default { fetch(){return new Response("local only")} }',compatibilityDate:'2026-05-15',d1Databases:{DB:'00000000-0000-4000-8000-000000000000',DRIFT:'00000000-0000-4000-8000-000000000001'}});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'account-snapshot-proof-'));
try {
 const db=await mf.getD1Database('DB');
 for(const f of ['0000_outstanding_ultimatum.sql','0001_sharp_yellowjacket.sql','0002_regular_storm.sql'])for(const sql of fs.readFileSync('drizzle/'+f,'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))await db.prepare(sql).run();
 for(const id of ['owner','other','empty',"bad' OR 1=1 --"])await db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').bind(id,id,'now','active').run();
 await db.prepare('INSERT INTO ledgers VALUES (1,?,?,?,?)').bind('owner',7,'owner ledger 中文\0','last').run();
 await db.prepare('INSERT INTO ledgers VALUES (2,?,?,?,?)').bind('other',8,'SECRET-OTHER-LEDGER-75ac1','foreign').run();
 for(let i=0;i<80;i++)await db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?)').bind('owner-op'+i,'owner','key'+i,'source'+i,'hash','owner receipt '.repeat(4000),'now').run();
 await db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?)').bind('foreign-op','other','foreign-key','foreign-source','hash','SECRET-OTHER-RECEIPT-75ac1','now').run();
 const bytes=Uint8Array.from({length:1500000},(_,i)=>i%256);
 await db.prepare('INSERT INTO images VALUES (?,?,?,?,?,?,?)').bind('owner-image','owner','h1','image/png',bytes.length,'now',bytes).run();
 await db.prepare('INSERT INTO images VALUES (?,?,?,?,?,?,?)').bind('foreign-image','other','h2','image/png',3,'now',new Uint8Array([3,2,1])).run();
 await db.prepare('INSERT INTO image_recognitions VALUES (?,?,?,?,?,?,?,?)').bind('foreign-recognition','other','fp','done','SECRET-OTHER-RESULT-75ac1',null,'now','now').run();
 await db.prepare('CREATE TABLE "__appgarden_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)').run();
 await db.prepare('INSERT INTO __appgarden_migrations (name,applied_at) VALUES (?,?)').bind('SECRET-PLATFORM-HISTORY-75ac1','now').run();
 const owner=await exportAccountSnapshot(db,'owner');
 assert.deepEqual(owner.row_counts,{accounts:1,image_recognitions:0,images:1,ledgers:1,operations:80});
 assert.equal(owner.scope,'authenticated-account');assert.equal(owner.format,'d1-account-snapshot-v1');
 assert.deepEqual(Buffer.from(owner.tables.images.rows[0][6].hex,'hex'),Buffer.from(bytes));
 for(const foreign of ['SECRET-OTHER-LEDGER-75ac1','SECRET-OTHER-RECEIPT-75ac1','SECRET-OTHER-RESULT-75ac1','SECRET-PLATFORM-HISTORY-75ac1'])assert.equal(JSON.stringify(owner).includes(Buffer.from(foreign).toString('hex').toUpperCase()),false);
 assert.equal(Object.hasOwn(owner.tables,'__appgarden_migrations'),false);
 const other=await exportAccountSnapshot(db,'other');assert.equal(other.row_counts.ledgers,1);assert.equal(other.row_counts.operations,1);assert.equal(other.row_counts.images,1);assert.equal(other.row_counts.image_recognitions,1);
 for(const id of ['empty',"bad' OR 1=1 --"]){const empty=await exportAccountSnapshot(db,id);assert.equal(empty.row_counts.accounts,1);for(const table of ['ledgers','operations','images','image_recognitions'])assert.equal(empty.row_counts[table],0);}
 await assert.rejects(exportAccountSnapshot(db,'nonexistent'),e=>e.code==='BACKUP_INCOMPLETE');
 const mutateResult=fn=>({prepare(sql){const stmt=db.prepare(sql);if(!sql.startsWith('WITH RECURSIVE chunks'))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {all:async()=>{const result=await bound.all();return {...result,results:fn(result.results)}}}}}}});
 await assert.rejects(exportAccountSnapshot(mutateResult(rs=>rs.filter(r=>!(r.kind==='cell'&&r.table_name==='images'&&r.column_name==='bytes'&&r.part===1))),'owner'),e=>e.code==='BACKUP_INCOMPLETE');
 await assert.rejects(exportAccountSnapshot(mutateResult(rs=>rs.map(r=>r.kind==='cell'&&r.table_name==='ledgers'&&r.column_name==='owner_id'?{...r,value:Buffer.from('other').toString('hex').toUpperCase(),byte_length:5}:r)),'owner'),e=>e.code==='BACKUP_INCOMPLETE');
 await assert.rejects(exportAccountSnapshot(mutateResult(rs=>rs.map(r=>r.kind==='cell'&&r.table_name==='accounts'&&r.column_name==='status'?{...r,value:Buffer.from('disabled').toString('hex').toUpperCase(),byte_length:8}:r)),'owner'),e=>e.code==='ACCOUNT_DISABLED');
 const snapshot=path.join(temp,'snapshot.json'),out=path.join(temp,'restored.sqlite3'),sql=path.join(temp,'restored.sql');
 fs.writeFileSync(snapshot,JSON.stringify(owner),{mode:0o600});
 let restore=spawnSync('python3',['scripts/restore-account-snapshot.py',snapshot,out,'--d1-sql',sql],{encoding:'utf8'});assert.equal(restore.status,0,restore.stderr);
 let proof=spawnSync(process.execPath,['scripts/verify-account-restore.mjs',snapshot,sql],{encoding:'utf8',timeout:120000});assert.equal(proof.status,0,proof.stderr);
 const emptySnapshot=path.join(temp,'empty.json'),emptyOut=path.join(temp,'empty.sqlite3'),emptySql=path.join(temp,'empty.sql');fs.writeFileSync(emptySnapshot,JSON.stringify(await exportAccountSnapshot(db,'empty')));
 restore=spawnSync('python3',['scripts/restore-account-snapshot.py',emptySnapshot,emptyOut,'--d1-sql',emptySql],{encoding:'utf8'});assert.equal(restore.status,0,restore.stderr);
 proof=spawnSync(process.execPath,['scripts/verify-account-restore.mjs',emptySnapshot,emptySql],{encoding:'utf8',timeout:120000});assert.equal(proof.status,0,proof.stderr);
 const bad=structuredClone(owner);bad.tables.ledgers.rows[0][1].hex=Buffer.from('other').toString('hex').toUpperCase();const badPath=path.join(temp,'bad.json');fs.writeFileSync(badPath,JSON.stringify(bad));
 restore=spawnSync('python3',['scripts/restore-account-snapshot.py',badPath,path.join(temp,'bad.sqlite3')],{encoding:'utf8'});assert.notEqual(restore.status,0);
 // Missing and counterfeit same-named indexes must fail before export.
 await db.prepare('DROP INDEX owner_source').run();
 await assert.rejects(exportAccountSnapshot(db,'owner'),e=>e.code==='BACKUP_INCOMPLETE'&&e.details.stage==='SCHEMA_VALIDATE');
 await db.prepare('CREATE INDEX owner_source ON operations(owner_id,source_event_id)').run();
 await assert.rejects(exportAccountSnapshot(db,'owner'),e=>e.code==='BACKUP_INCOMPLETE'&&e.details.stage==='SCHEMA_VALIDATE');
 await db.prepare('DROP INDEX owner_source').run();
 await db.prepare('CREATE UNIQUE INDEX `owner_source` ON `operations` (`owner_id`,`source_event_id`)').run();
 // Same column names and index names do not excuse table DDL drift.
 const drift=await mf.getD1Database('DRIFT');
 for(const f of ['0000_outstanding_ultimatum.sql','0001_sharp_yellowjacket.sql','0002_regular_storm.sql']){
  let text=fs.readFileSync('drizzle/'+f,'utf8');if(f.startsWith('0002'))text=text.replace('`status` text NOT NULL','`status` text');
  for(const sql of text.split('--> statement-breakpoint').filter(s=>s.trim()))await drift.prepare(sql).run();
 }
 await drift.prepare('INSERT INTO accounts VALUES (?,?,?,?)').bind('owner','owner','now','active').run();
 await assert.rejects(exportAccountSnapshot(drift,'owner'),e=>e.code==='BACKUP_INCOMPLETE'&&e.details.stage==='SCHEMA_VALIDATE');
 // More than 12 MB fails before the read; growth after preflight is also
 // checked on the actual result, never producing a partial success.
 await db.prepare("UPDATE operations SET receipt=receipt||receipt||receipt WHERE owner_id='owner'").run();
 await assert.rejects(exportAccountSnapshot(db,'owner'),e=>e.code==='BACKUP_INCOMPLETE'&&e.details.stage==='SIZE_CHECK');
 await db.prepare("UPDATE operations SET receipt=? WHERE owner_id='owner'").bind('owner receipt '.repeat(4000)).run();
 let changed=false;
 const growing={prepare(sql){const stmt=db.prepare(sql);if(!sql.startsWith('WITH RECURSIVE chunks'))return stmt;return {bind(...args){const bound=stmt.bind(...args);return {all:async()=>{if(!changed){changed=true;await db.prepare("UPDATE operations SET receipt=receipt||receipt||receipt WHERE owner_id='owner'").run()}return bound.all()}}}}}};
 await assert.rejects(exportAccountSnapshot(growing,'owner'),e=>e.code==='BACKUP_INCOMPLETE'&&['SNAPSHOT_READ','SNAPSHOT_VALIDATE'].includes(e.details.stage));
 assert.equal(changed,true);
 console.log(JSON.stringify({accountScope:true,otherUserExcluded:true,emptyAccount:true,largeImageBytes:bytes.length,history:80,missingChunkRejected:true,foreignRowRejected:true,sqliteAndIsolatedD1Restore:true,missingIndexRejected:true,counterfeitIndexRejected:true,ddlDriftRejected:true,oversizeRejected:true,growthRejected:true}));
} finally {await mf.dispose();fs.rmSync(temp,{recursive:true,force:true});}
