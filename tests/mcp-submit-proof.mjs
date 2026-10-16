import {base,verifyLocalLedger} from './local-base.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
await verifyLocalLedger();

const signed=await fetch(base+'/signin-with-chatgpt?return_to=/',{redirect:'manual'});const cookie=signed.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
async function rpc(name,args,cookieValue=cookie){const r=await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...(cookieValue?{cookie:cookieValue}:{})},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name,arguments:args}})});assert.equal(r.status,200);return (await r.json()).result}
const original=JSON.parse(fs.readFileSync('tests/mcp-parent-payload.json','utf8'));
const state=(await rpc('ledger_read',{})).structuredContent;
// The exact base_version=1 payload is covered by repository regression. This local
// transport test uses a fresh local event and the current local revision; production is untouched.
const runSuffix='-local-'+crypto.randomUUID();
const request={...original,base_version:state.revision,occurred_at:new Date().toISOString(),operation_id:original.operation_id+runSuffix,idempotency_key:original.idempotency_key+runSuffix,source_event_id:original.source_event_id+runSuffix};
const commit=await rpc('ledger_commit',request);assert.equal(commit.isError,false,JSON.stringify(commit));assert.equal(commit.structuredContent.state,'verified');
for(let i=0;i<3;i++){const replay=await rpc('ledger_commit_json',{payload_json:JSON.stringify(request)});assert.equal(replay.isError,false);assert.equal(replay.structuredContent.duplicate,true);assert.equal(replay.structuredContent.operation_id,request.operation_id)}
const read=(await rpc('ledger_read',{})).structuredContent,receipt=(await rpc('ledger_receipt',{operation_id:request.operation_id})).structuredContent;assert.equal(read.revision,request.base_version+1);assert.equal(receipt.state,'verified');const t=read.data.tasks.find(t=>t.id==='t-teaser-feedback');assert.equal(t.next_action,original.changes[0].values.next_action);assert.equal(t.source_ref,original.changes[0].values.source_ref);assert.equal(t.status,'waiting');
for(const id of ['t-teaser-edit','t-teaser-send'])assert.deepEqual(read.data.tasks.find(t=>t.id===id),state.data.tasks.find(t=>t.id===id));
const invalid=await rpc('ledger_commit_json',{payload_json:JSON.stringify({...request,changes:[{type:'restore',values:{data:read.data}}]})});assert.equal(invalid.isError,true);assert.equal(invalid.structuredContent.error,'CHANGE');const malformed=await rpc('ledger_commit_json',{payload_json:'{bad'});assert.equal(malformed.isError,true);assert.equal(malformed.structuredContent.error,'JSON');const unauthorized=await rpc('ledger_commit_json',{payload_json:JSON.stringify(request)},'');assert.equal(unauthorized.isError,true);assert.equal(unauthorized.structuredContent.error,'AUTH');
const report={checks:{structuredMcpCommit:true,jsonMcpReplaySameOperation3:true,independentReceiptAndRead:true,sourceRefPreserved:true,onlyTargetMetadataChanged:true,malformedJsonIsToolError:true,jsonCannotRestore:true,unauthenticatedCannotWrite:true},operation_id:request.operation_id,result_version:read.revision,production_write:false};fs.writeFileSync('.sites-runtime/mcp-submit-proof-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
