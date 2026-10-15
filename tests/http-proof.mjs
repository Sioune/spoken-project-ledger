import assert from 'node:assert/strict';
import fs from 'node:fs';
const base='http://127.0.0.1:5186';
const publicRead=await fetch(base+'/api/state');assert.equal(publicRead.status,401);
const forged=await fetch(base+'/api/state',{headers:{'oai-authenticated-user-id':'forged','oai-authenticated-user-email':'forged@example.test'}});assert.equal(forged.status,401);
const signed=await fetch(base+'/signin-with-chatgpt?return_to=/',{redirect:'manual'});const cookie=signed.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
async function call(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const result=await r.json();return {status:r.status,result}}
assert.equal((await call('/api/initialize',{})).status,200);let s=(await call('/api/state')).result;assert.equal(s.initialized,true);
const id=crypto.randomUUID();const p=(await call('/api/preview',{text:'新增任务：虚构HTTP联调待办 '+id,source_event_id:id,occurred_at:new Date().toISOString()})).result;
const req={operation_id:id,idempotency_key:id,source_event_id:p.source_event_id,base_version:p.base_version,occurred_at:p.occurred_at,raw_text:'虚构HTTP联调',changes:p.changes,confirmed:true};
const saved=await call('/api/operations',req);assert.equal(saved.status,200);assert.equal(saved.result.state,'verified');for(let i=0;i<3;i++){const replay=await call('/api/operations',req);assert.equal(replay.result.duplicate,true);assert.equal(replay.result.operation_id,id)}
s=(await call('/api/state')).result;assert.equal(s.data.tasks.filter(t=>t.title.includes(id)).length,1);const receipt=await call('/api/operations/'+id);assert.equal(receipt.result.state,'verified');
const mismatch=await call('/api/operations',{...req,raw_text:'不同内容'});assert.equal(mismatch.status,409);
const undo=await call('/api/undo',{operation_id:id,base_version:s.revision,idempotency_key:'http-undo-'+id});assert.equal(undo.result.state,'verified');assert.equal((await call('/api/state')).result.data.tasks.some(t=>t.title.includes(id)),false);
const stale=await call('/api/operations',{...req,operation_id:'stale-'+id,idempotency_key:'stale-'+id,source_event_id:'stale-'+id});assert.equal(stale.status,409);
const invalid=await call('/api/operations',{operation_id:'invalid-'+id,idempotency_key:'invalid-'+id,source_event_id:'invalid-'+id,base_version:undo.result.result_version,occurred_at:new Date().toISOString(),raw_text:'不存在的任务',changes:[{type:'update',id:'missing',values:{status:'done'}}]});assert.equal(invalid.status,404);assert.equal(invalid.result.state,undefined);
const cross=await fetch(base+'/api/operations',{method:'POST',headers:{cookie,'Content-Type':'application/json',Origin:'https://other.invalid'},body:JSON.stringify(req)});assert.equal(cross.status,403);
const discovery=await call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'});assert.equal(discovery.result.result.tools.length,6);
const mcp=await call('/mcp',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'ledger_read',arguments:{}}});assert.equal(mcp.result.result.structuredContent.initialized,true);
const mcpFail=await call('/mcp',{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'ledger_commit',arguments:{}}});assert.equal(mcpFail.result.result.isError,true);
const report={base,checks:{unauthenticated401:true,forgedIdentity401:true,createReadReceipt:true,replay3NoDuplicate:true,keyMismatch409:true,undo:true,staleConflict409:true,failedWriteNoSuccess:true,crossOrigin403:true,mcpReadAndError:true},operation_id:id,result_version:saved.result.result_version};fs.writeFileSync('.sites-runtime/http-proof-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
