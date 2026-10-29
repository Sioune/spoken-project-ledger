import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const compiled = ts.transpileModule(fs.readFileSync(new URL('../app/text-draft-storage.ts', import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {readTextDraft, writeTextDraft} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
function storage() { const map = new Map(); return { map, getItem:k=>map.get(k)??null, setItem:(k,v)=>map.set(k,v), removeItem:k=>map.delete(k) }; }
test('switching accounts keeps text and pending operation drafts separate', () => {
  const s=storage(), a='a'.repeat(64), b='b'.repeat(64);
  const old='spoken-projects:temporary-draft:v1';s.setItem(old,JSON.stringify({text:'legacy owner secret'}));
  writeTextDraft(s,a,{text:'account A private note',pendingRequest:{operation_id:'pending-A'}});
  assert.equal(readTextDraft(s,b),null);
  writeTextDraft(s,b,{text:'account B note'});
  assert.deepEqual(readTextDraft(s,a),{text:'account A private note',pendingRequest:{operation_id:'pending-A'}});
  assert.deepEqual(readTextDraft(s,b),{text:'account B note'});
  writeTextDraft(s,b,{text:''});assert.equal(readTextDraft(s,b),null);
  assert.equal(readTextDraft(s,a).text,'account A private note');assert.ok(s.getItem(old));
});
test('rejects absent, malformed, and attacker-selected scope strings', () => {
  const s=storage();for(const scope of ['', 'same display name','../owner','A'.repeat(64)]) {
    assert.throws(()=>writeTextDraft(s,scope,{text:'private'}));
    assert.throws(()=>readTextDraft(s,scope));
  } assert.equal(s.map.size,0);
});
