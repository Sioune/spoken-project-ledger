import assert from 'node:assert/strict';

// Write regressions may use another loopback port when the default is occupied.
const candidate=new URL(process.env.LEDGER_QA_BASE||'http://127.0.0.1:5186');
assert.equal(candidate.protocol,'http:','Ledger QA must use local HTTP');
assert.equal(candidate.hostname,'127.0.0.1','Ledger QA cannot target a production host');
assert.equal(candidate.username+candidate.password+candidate.search+candidate.hash,'','Ledger QA URL cannot include credentials, query, or fragment');
assert.equal(candidate.pathname,'/','Ledger QA must use a local origin');
export const base=candidate.origin;
export async function verifyLocalLedger(){
 const rpc=async(method)=>{const response=await fetch(base+'/mcp',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'qa-service-check',method})});assert.equal(response.status,200);return(await response.json()).result;};
 assert.equal((await rpc('initialize'))?.serverInfo?.name,'spoken-project-ledger','Refusing to test a different local service');
 const tools=(await rpc('tools/list'))?.tools?.map(tool=>tool.name).sort();
 assert.deepEqual(tools,['ledger_commit','ledger_commit_json','ledger_initialize','ledger_preview','ledger_read','ledger_receipt','ledger_undo']);
}

