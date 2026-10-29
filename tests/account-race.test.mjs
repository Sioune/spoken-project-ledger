import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

function moduleURL(source) { return 'data:text/javascript;base64,'+Buffer.from(source).toString('base64'); }
function compile(path){return ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;}
const epoch=await import(moduleURL(compile('app/account-epoch.ts')));
const model=moduleURL(`export class AppError extends Error { constructor(status,code,message){super(message);this.status=status;this.code=code;this.details={}} } export function preview(){return {questions:[],changes:[]}}`);
const scopeMod=moduleURL(compile('lib/account-scope.ts').replace("'./model'",JSON.stringify(model)));
const repo=moduleURL(`export class Repository { constructor(db,id){this.id=id} async read(){return {initialized:true,revision:1,data:{pending:[]}}} async commit(){globalThis.__writes++;return {ok:true}} async initialize(){globalThis.__writes++;return {ok:true}} async calendar(){return {}} async history(){return {operations:[]}} async receipt(){return {}} async undo(){globalThis.__writes++;return {}} }`);
const auth=moduleURL(`export async function getChatGPTUser(){return globalThis.__testUser}`);
const account=moduleURL(`export async function ensureAccount(){globalThis.__registrations++}`);
const worker=moduleURL(`export const env={DB:{}}`);
const intake=moduleURL(`export async function handleIntake(){globalThis.__writes++;return Response.json({ok:true})}`);
const backup=moduleURL(`export function assertAccountBackupRequest(){} export async function exportAccountSnapshot(){return {}}`);
const source=compile('lib/api.ts').replace("'cloudflare:workers'",JSON.stringify(worker)).replace("'@/app/chatgpt-auth'",JSON.stringify(auth)).replace("'./repository'",JSON.stringify(repo)).replace("'./model'",JSON.stringify(model)).replace("'./account'",JSON.stringify(account)).replace("'./account-scope'",JSON.stringify(scopeMod)).replace("'./intake-api'",JSON.stringify(intake)).replace("'./account-backup'",JSON.stringify(backup));
const {api,action}=await import(moduleURL(source));
const {accountScope}=await import(scopeMod);

test('late results are invalidated on revalidation, signout and account change',()=>{
 const g=new epoch.AccountEpoch();g.set('A');const old=g.capture();assert.ok(g.valid(old));g.suspend();assert.equal(g.valid(old),false);const a=g.capture();assert.ok(g.valid(a));g.set('B');assert.equal(g.valid(a),false);const b=g.capture();assert.equal(b.scope,'B');g.set(null);assert.equal(g.valid(b),false);
});

test('old page scope cannot create an account or submit old text into a new signed-in user',async()=>{
 globalThis.__writes=0;globalThis.__registrations=0;globalThis.__testUser={userId:'user-A',displayName:'A'};
 const original=await (await api(new Request('https://ledger.test/api/state'),['state'])).json();assert.equal(original.identity.draftScope,await accountScope('user-A'));
 const a=original.identity.draftScope;globalThis.__testUser={userId:'user-B',displayName:'B'};let registrations=globalThis.__registrations;
 for(const path of ['initialize','preview','operations','undo','intake/commit']){
  const r=await api(new Request('https://ledger.test/api/'+path,{method:'POST',headers:{'content-type':'application/json','x-ledger-account-scope':a},body:'{}'}),path.split('/'));
  assert.equal(r.status,409,path);assert.equal((await r.json()).error,'ACCOUNT_CHANGED',path);assert.equal(globalThis.__registrations,registrations,path);assert.equal(globalThis.__writes,0,path);
 }
 const noScope=await api(new Request('https://ledger.test/api/operations',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),['operations']);assert.equal(noScope.status,409);assert.equal(globalThis.__registrations,registrations);
 const b=await accountScope('user-B');const ok=await api(new Request('https://ledger.test/api/operations',{method:'POST',headers:{'content-type':'application/json','x-ledger-account-scope':b},body:'{}'}),['operations']);assert.equal(ok.status,200);assert.equal(globalThis.__writes,1);
 // Native MCP action retains authenticated-user routing without the browser guard.
 await action('initialize',{});assert.equal(globalThis.__writes,2);
});

test('old scope cannot read another account history, calendar, export, or intake capabilities',async()=>{
 globalThis.__testUser={userId:'user-B',displayName:'B'}; const old=await accountScope('user-A'); const before=globalThis.__registrations;
 for(const path of ['calendar','operations','operations/id','export','intake/capabilities']){
  const r=await api(new Request('https://ledger.test/api/'+path,{headers:{'x-ledger-account-scope':old}}),path.split('/'));
  assert.equal(r.status,409,path);assert.equal((await r.json()).error,'ACCOUNT_CHANGED',path);assert.equal(globalThis.__registrations,before,path);
 }
});
