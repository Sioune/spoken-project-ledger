import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const compiled = ts.transpileModule(fs.readFileSync(new URL('../app/task-dependencies.ts', import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {wouldCreateDependencyCycle} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const tasks = [
  {id:'a',dependencies:[]},
  {id:'b',dependencies:['a']},
  {id:'c',dependencies:['b']},
  {id:'child',dependencies:[],parent_id:'c'},
  {id:'unrelated',dependencies:[]}
];

test('predecessor selection prevents cycles through dependencies and parent links', () => {
  assert.equal(wouldCreateDependencyCycle(tasks,'a','a'),true);
  assert.equal(wouldCreateDependencyCycle(tasks,'a','b'),true);
  assert.equal(wouldCreateDependencyCycle(tasks,'a','c'),true);
  assert.equal(wouldCreateDependencyCycle(tasks,'a','child'),true);
  assert.equal(wouldCreateDependencyCycle(tasks,'c','a'),false);
  assert.equal(wouldCreateDependencyCycle(tasks,'a','unrelated'),false);
  assert.equal(wouldCreateDependencyCycle(tasks,undefined,'c'),false);
});

test('cycle check terminates even with malformed existing loops', () => {
  const broken = [{id:'x',dependencies:['y']},{id:'y',dependencies:['x']}];
  assert.equal(wouldCreateDependencyCycle(broken,'z','x'),false);
  assert.equal(wouldCreateDependencyCycle(broken,'x','y'),true);
});

test('editing prerequisites preserves the backend cycle and unfinished-predecessor rules', async () => {
  const modelSource=fs.readFileSync(new URL('../lib/model.ts',import.meta.url),'utf8');
  const compiledModel=ts.transpileModule(modelSource,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const {seed,applyChanges}=await import(`data:text/javascript;base64,${Buffer.from(compiledModel).toString('base64')}`);
  const now='2026-10-29T00:00:00.000Z', ledger=seed(now);
  const update=(id,values)=>({type:'update',id,values});
  const added=applyChanges(ledger,[update('t-ui',{dependencies:['t-contract-review'],status:'todo'})],now,now).data;
  assert.deepEqual(added.tasks.find(t=>t.id==='t-ui').dependencies,['t-contract-review']);
  assert.equal(added.tasks.find(t=>t.id==='t-ui').status,'blocked');
  const removed=applyChanges(added,[update('t-ui',{dependencies:[],status:'todo'})],now,now).data;
  assert.deepEqual(removed.tasks.find(t=>t.id==='t-ui').dependencies,[]);
  assert.equal(removed.tasks.find(t=>t.id==='t-ui').status,'todo');
  assert.throws(()=>applyChanges(ledger,[update('t-ui',{dependencies:['t-ui-send']})],now,now),e=>e.code==='CYCLE');
  assert.throws(()=>applyChanges(ledger,[update('t-ui-send',{dependencies:[],status:'done'})],now,now),e=>e.code==='BLOCKED');
});
