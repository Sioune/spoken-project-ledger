import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import ts from 'typescript';
const compile=file=>ts.transpileModule(fs.readFileSync(`lib/${file}.ts`,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const model='data:text/javascript;base64,'+Buffer.from(compile('model')).toString('base64');
const account='data:text/javascript;base64,'+Buffer.from(compile('account').replace("'./model'",JSON.stringify(model))).toString('base64');
const {ensureAccount}=await import(account);
test('authenticated subjects register separately and disabled accounts cannot be reactivated by login',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync('drizzle/0002_regular_storm.sql','utf8').split('--> statement-breakpoint')[0]);
 const adapter={prepare(sql){let values=[];const q={bind(...v){values=v;return q},async run(){return db.prepare(sql).run(...values)},async first(){return db.prepare(sql).get(...values)??null}};return q}};
 try {await ensureAccount(adapter,{userId:'owner',displayName:'Owner'});await ensureAccount(adapter,{userId:'new',displayName:'New'});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,2);
 db.prepare('UPDATE accounts SET status=? WHERE id=?').run('disabled','owner');await assert.rejects(ensureAccount(adapter,{userId:'owner',displayName:'Owner'}),e=>e.status===403);assert.equal(db.prepare('SELECT status FROM accounts WHERE id=?').get('owner').status,'disabled');await assert.rejects(ensureAccount(adapter,{userId:'',displayName:'Invalid'}),e=>e.status===401);
 }finally{db.close()}
});
