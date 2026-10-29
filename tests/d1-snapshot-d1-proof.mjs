import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Miniflare} from 'miniflare';

// All content is generated fixture data and the database is a fresh local D1.
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ledger-snapshot-d1-'));
const fixtureScript=`import importlib.util,json,sys\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('fixture',Path('tests/d1-snapshot-restore.test.py'))\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nx=m.fixture()\nr=next(i for i,c in enumerate(x['tables']['operations']['columns']) if c['name']=='receipt')\nb=next(i for i,c in enumerate(x['tables']['images']['columns']) if c['name']=='bytes')\nx['tables']['operations']['rows'][0][r]['hex']='007bff7d'*40000\nx['tables']['images']['rows'][0][b]['hex']='00ff017f'*50000\nPath(sys.argv[1]).write_text(json.dumps(x))\nm.mod.restore(x,sys.argv[2])\nm.mod.write_d1_sql(x,sys.argv[3])\n`;
let mf;
try {
 const snapshotPath=path.join(temp,'snapshot.json');
 const sqlPath=path.join(temp,'restore.sql');
 execFileSync('python3',['-c',fixtureScript,snapshotPath,path.join(temp,'sqlite.db'),sqlPath]);
 const snapshot=JSON.parse(fs.readFileSync(snapshotPath,'utf8'));
 mf=new Miniflare({modules:true,script:'export default { fetch(){return new Response("isolated test")} }',compatibilityDate:'2026-05-15',d1Databases:{DB:'00000000-0000-4000-8000-000000000000'},d1Persist:path.join(temp,'d1')});
 const db=await mf.getD1Database('DB');
 // Trusted generated baseline has no semicolons in literals or triggers.
 for(const stmt of fs.readFileSync(sqlPath,'utf8').split(';').filter(s=>s.trim())) await db.prepare(stmt).run();
 const master=(await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all()).results;
 const expectedSchema=snapshot.schema.filter(s=>!s.name.startsWith('sqlite_')&&!s.name.startsWith('_cf_')).sort((a,b)=>a.type.localeCompare(b.type)||a.name.localeCompare(b.name));
 assert.deepEqual(master,expectedSchema);
 for(const [table, data] of Object.entries(snapshot.tables)){
  const parts=data.columns.flatMap(({name})=>{let q='"'+name.replaceAll('"','""')+'"';return [`typeof(${q})`,`CASE typeof(${q}) WHEN 'null' THEN NULL WHEN 'integer' THEN CAST(${q} AS TEXT) WHEN 'real' THEN printf('%!.17g', ${q}) ELSE lower(hex(CAST(${q} AS BLOB))) END`];});
  const {results}=await db.prepare(`SELECT ${parts.map((p,i)=>`${p} AS c${i}`).join(',')} FROM "${table}"`).all();
  const canonical=a=>a.map(row=>JSON.stringify(row)).sort();
  const got=results.map(row=>data.columns.map((_,i)=>[row[`c${2*i}`],row[`c${2*i+1}`]]));
  const expected=data.rows.map(row=>row.map(c=>[c.type,c.type==='null'?null:(c.hex??c.value)]));
  assert.deepEqual(canonical(got),canonical(expected),table);
 }
 const check=(await db.prepare('PRAGMA quick_check').all()).results;
 assert.deepEqual(Object.values(check[0]),['ok']);
 assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
 console.log(JSON.stringify({status:'verified',runtime:'isolated Miniflare D1',schema:true,allCells:true,quickCheck:true,foreignKeyCheck:true}));
} finally {
 if(mf) await mf.dispose();
 fs.rmSync(temp,{recursive:true,force:true});
}
