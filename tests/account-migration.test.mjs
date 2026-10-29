import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';

const migration = name => readFileSync(new URL(`../drizzle/${name}`,import.meta.url),'utf8').replaceAll('--> statement-breakpoint','');
test('schema-only account migration preserves legacy rows and original primary keys',()=>{
 const db = new DatabaseSync(':memory:');
 try {
  db.exec(migration('0000_outstanding_ultimatum.sql'));db.exec(migration('0001_sharp_yellowjacket.sql'));
  db.prepare('INSERT INTO ledgers VALUES (1,?,?,?,?)').run('owner',7,'{"tasks":[{"id":"private"}]}','op');
  db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?)').run('op','owner','key','source','hash','{"result_version":7}','2026-01-01');
  db.prepare('INSERT INTO images VALUES (?,?,?,?,?,?,?)').run('img','owner','sha','image/png',3,'2026-01-01',new Uint8Array([1,2,3]));
  db.prepare('INSERT INTO image_recognitions VALUES (?,?,?,?,?,?,?,?)').run('r','owner','hash','succeeded','{"ok":true}',null,'2026-01-01','2026-01-01');
  const change=migration('0002_regular_storm.sql');
  assert.doesNotMatch(change,/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
  db.exec(change);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,0);
  assert.deepEqual({...db.prepare('SELECT * FROM ledgers WHERE owner_id=?').get('owner')},{id:1,owner_id:'owner',revision:7,data:'{"tasks":[{"id":"private"}]}',last_operation:'op'});
  assert.equal(db.prepare('SELECT receipt FROM operations WHERE owner_id=? AND id=?').get('owner','op').receipt,'{"result_version":7}');
  assert.deepEqual([...db.prepare('SELECT bytes FROM images WHERE owner_id=?').get('owner').bytes],[1,2,3]);
  assert.equal(db.prepare('SELECT result_json FROM image_recognitions WHERE owner_id=?').get('owner').result_json,'{"ok":true}');
  db.prepare('INSERT INTO ledgers (owner_id,revision,data,last_operation) VALUES (?,?,?,?)').run('second',1,'{}','op');
  assert.throws(()=>db.prepare('INSERT INTO ledgers (owner_id,revision,data,last_operation) VALUES (?,?,?,?)').run('owner',1,'{}','op'));
  assert.throws(()=>db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?)').run('op','second','key','source','other','{}','2026-01-01'));
  assert.throws(()=>db.prepare('INSERT INTO image_recognitions VALUES (?,?,?,?,?,?,?,?)').run('r','second','other','pending',null,null,'2026-01-01',null));
 } finally {db.close();}
});
