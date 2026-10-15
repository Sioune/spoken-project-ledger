import {AppError,applyChanges,seed,type Ledger,type Submit} from './model';
export type Statement={bind:(...v:unknown[])=>Statement;first:<T=Record<string,unknown>>()=>Promise<T|null>;all:<T=Record<string,unknown>>()=>Promise<{results:T[]}>;run:()=>Promise<unknown>};
export type Database={prepare:(sql:string)=>Statement;batch:(s:Statement[])=>Promise<unknown[]>};
type Row={id:number;owner_id:string;revision:number;data:string;last_operation:string};
type Op={id:string;owner_id:string;idempotency_key:string;source_event_id:string;payload_hash:string;receipt:string;created_at:string};
export type Receipt={state:string;operation_id:string;result_version:number;created_at:string;occurred_at:string;timezone:string;changes:unknown[];before:Ledger;after:Ledger;source_event_id:string;raw_text:string;undo_of?:string;duplicate?:boolean;current_revision?:number;verification?:string};
const canonical=(v:unknown):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
async function hash(v:unknown){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(v)));return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('')}
export class Repository{
 constructor(private db:Database,private owner:string){if(!owner)throw new AppError(401,'AUTH','请先以本人身份登录')}
 async state(){const row=await this.db.prepare('SELECT * FROM ledgers WHERE id=1').first<Row>();if(row&&row.owner_id!==this.owner)throw new AppError(403,'OWNER_ONLY','仅本人可以访问此状态库');return row}
 async initialize(){
  const existing=await this.state();if(existing)return {initialized:true,revision:existing.revision,data:JSON.parse(existing.data),operation_id:'initialize',duplicate:true};
  const now=new Date().toISOString(),data=seed(now),before={...data,projects:[],tasks:[],documents:[],pending:[]};
  const receipt:Receipt={state:'saved',operation_id:'initialize',result_version:1,created_at:now,occurred_at:now,timezone:'Asia/Shanghai',changes:[{type:'initialize',values:{source_ref:'用户批准的六项初始自述'}}],before,after:data,source_event_id:'initialize',raw_text:'导入已授权的六项初始工作；未填未知完成时刻、截止日与提醒时间'};
  await this.db.batch([
   this.db.prepare('INSERT OR IGNORE INTO ledgers (id,owner_id,revision,data,last_operation) VALUES (1,?,1,?,?)').bind(this.owner,JSON.stringify(data),'initialize'),
   this.db.prepare('INSERT OR IGNORE INTO operations (id,owner_id,idempotency_key,source_event_id,payload_hash,receipt,created_at) SELECT ?,?,?,?,?,?,? FROM ledgers WHERE id=1 AND owner_id=? AND last_operation=?').bind('initialize',this.owner,'initialize','initialize',await hash(data),JSON.stringify(receipt),now,this.owner,'initialize')
  ]);const row=await this.state();if(!row)throw new AppError(503,'SAVE_FAILED','初始化未读回，请重试');return {initialized:true,revision:row.revision,data:JSON.parse(row.data),operation_id:'initialize'};
 }
 async read(){const row=await this.state();return row?{initialized:true,revision:row.revision,data:JSON.parse(row.data) as Ledger}:{initialized:false,revision:0,data:null}}
 private async opById(id:string){return this.db.prepare('SELECT * FROM operations WHERE id=? AND owner_id=?').bind(id,this.owner).first<Op>()}
 async receipt(id:string){await this.state();const op=await this.opById(id);if(!op)throw new AppError(404,'OPERATION','操作编号不存在，不能确认保存成功');const receipt=JSON.parse(op.receipt) as Receipt;try {const row=await this.state();if(!row||row.revision<receipt.result_version)throw Error('readback');if(row.revision===receipt.result_version&&canonical(JSON.parse(row.data))!==canonical(receipt.after))throw Error('mismatch');return {...receipt,state:'verified',current_revision:row.revision,verification:row.revision===receipt.result_version?'current_fields_match':'historical_commit_current_is_newer'}}catch(e){if(e instanceof AppError&&e.status===403)throw e;return {...receipt,state:'pending_verification',verification:'readback_unavailable'}}}
 async history(){await this.state();const result=await this.db.prepare('SELECT * FROM operations WHERE owner_id=? ORDER BY created_at DESC LIMIT 100').bind(this.owner).all<Op>();return {operations:result.results.map(op=>JSON.parse(op.receipt))}}
 async commit(input:Submit){
  if(!input||typeof input!=='object')throw new AppError(400,'INPUT','请求无效');
  for(const k of ['operation_id','idempotency_key','source_event_id','occurred_at','raw_text'] as const)if(typeof input[k]!=='string'||input[k].length>(k==='raw_text'?10000:250))throw new AppError(400,'INPUT','缺少或无效字段：'+k);
  if(!input.operation_id||!input.idempotency_key||!input.source_event_id||!Number.isInteger(input.base_version)||!Number.isFinite(Date.parse(input.occurred_at)))throw new AppError(400,'INPUT','操作编号、版本或发生时间无效');
  if(Date.parse(input.occurred_at)>Date.now()+300000)throw new AppError(400,'FUTURE_EVENT','发生时间超前，请确认时区');
  if(input.changes?.some(c=>c.type==='restore'||(c.type==='project'&&c.values?.status==='archived'))&&!input.confirmed)throw new AppError(400,'CONFIRM','恢复或归档需核对影响后确认');
  const payloadHash=await hash({source_event_id:input.source_event_id,base_version:input.base_version,occurred_at:input.occurred_at,raw_text:input.raw_text,changes:input.changes,undo_of:input.undo_of??null});
  const existing=await this.db.prepare('SELECT * FROM operations WHERE owner_id=? AND (id=? OR idempotency_key=? OR source_event_id=?)').bind(this.owner,input.operation_id,input.idempotency_key,input.source_event_id).first<Op>();
  if(existing){if(existing.payload_hash!==payloadHash)throw new AppError(409,'IDEMPOTENCY_MISMATCH','相同操作、来源或幂等编号已用于不同内容，请核对原回执');return {...await this.receipt(existing.id),duplicate:true}}
  const row=await this.state();if(!row)throw new AppError(409,'INITIALIZE','请先初始化状态库');
  if(row.revision!==input.base_version)throw new AppError(409,'REVISION_CONFLICT','当前状态已有更新，请刷新并核对差异',{current_revision:row.revision,current_data:JSON.parse(row.data)});
  const now=new Date().toISOString(),before=JSON.parse(row.data) as Ledger,{data:after,effective}=applyChanges(before,input.changes,now,input.occurred_at);
  const receipt:Receipt={state:'saved',operation_id:input.operation_id,result_version:row.revision+1,created_at:now,occurred_at:input.occurred_at,timezone:after.settings.timezone,changes:effective,before,after,source_event_id:input.source_event_id,raw_text:input.raw_text,...(input.undo_of?{undo_of:input.undo_of}:{})};
  try{
   await this.db.batch([
    this.db.prepare('UPDATE ledgers SET data=?,revision=revision+1,last_operation=? WHERE id=1 AND owner_id=? AND revision=?').bind(JSON.stringify(after),input.operation_id,this.owner,input.base_version),
    this.db.prepare('INSERT INTO operations (id,owner_id,idempotency_key,source_event_id,payload_hash,receipt,created_at) SELECT ?,?,?,?,?,?,? FROM ledgers WHERE id=1 AND owner_id=? AND last_operation=? AND revision=?').bind(input.operation_id,this.owner,input.idempotency_key,input.source_event_id,payloadHash,JSON.stringify(receipt),now,this.owner,input.operation_id,row.revision+1)
   ]);
  }catch{
   const saved=await this.opById(input.operation_id);if(saved&&saved.payload_hash===payloadHash)return {...await this.receipt(saved.id),duplicate:true};throw new AppError(503,'SAVE_FAILED','保存未能确认。请按原操作编号查询；保留编号重试，不能报告成功',{operation_id:input.operation_id});
  }
  const saved=await this.opById(input.operation_id);if(!saved){const latest=await this.state();throw new AppError(409,'REVISION_CONFLICT','提交期间发生并发更新，请刷新核对',{current_revision:latest?.revision,current_data:latest?JSON.parse(latest.data):null})}
  return this.receipt(input.operation_id);
 }
 async undo(id:string,base:number,key:string){
  const row=await this.state();if(!row)throw new AppError(404,'STATE','状态库不存在');
  const original=await this.opById(id);if(!original)throw new AppError(404,'OPERATION','未找到原操作');const receipt=JSON.parse(original.receipt) as Receipt;
  if(!id||!key||id==='undefined'||key==='undefined'||key.length>150||!Number.isInteger(base)||base<1)throw new AppError(400,'UNDO_INPUT','请提供原操作编号、版本和有效幂等编号');
  const undoId='undo-'+key;const existing=await this.opById(undoId);if(existing){const prior=JSON.parse(existing.receipt) as Receipt;if(prior.undo_of!==id||prior.result_version!==base+1)throw new AppError(409,'IDEMPOTENCY_MISMATCH','此撤销编号已用于不同操作或版本');return {...await this.receipt(undoId),duplicate:true}};
  if(row.revision!==base||row.last_operation!==id)throw new AppError(409,'UNDO_CONFLICT','该操作之后已有编辑。请查看历史与当前差异，不能自动覆盖',{current_revision:row.revision,current_data:JSON.parse(row.data)});
  return this.commit({operation_id:undoId,idempotency_key:key,source_event_id:undoId,base_version:base,occurred_at:new Date().toISOString(),raw_text:'撤销应用记录 '+id,changes:[{type:'restore',values:{data:receipt.before}}],confirmed:true,undo_of:id});
 }
}
