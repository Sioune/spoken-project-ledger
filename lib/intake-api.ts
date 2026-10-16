import {AppError,type Submit} from './model';
import type {Database,PendingImage,Repository} from './repository';
import {buildIntakePreview} from './intake';
import type {IntakeFields,RecognitionResult} from './intake-types';
import {recognizeImage,parseRecognition,visionCapabilities,VISION_MODEL,VISION_DAILY_LIMIT,type VisionConfig} from './vision';
import {shanghaiDay} from './schedule';

type IntakeContext={repo:Repository;db:Database;ownerId:string};
type RecognitionRow={id:string;owner_id:string;fingerprint:string;state:string;result_json:string|null;error_code:string|null;created_at:string;finished_at:string|null};
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Cross-Origin-Resource-Policy':'same-origin'};
const reply=(value:unknown)=>Response.json(value,{headers});
async function digest(value:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function parseJSON(value:FormDataEntryValue|null,name:string):Record<string,unknown>{if(typeof value!=='string'||value.length>40000)throw new AppError(400,'INTAKE_INPUT',`${name}格式无效或过大`);try{const result=JSON.parse(value);if(!object(result))throw Error();return result;}catch{throw new AppError(400,'INTAKE_INPUT',`${name}不是有效JSON对象`);}}
async function form(request:Request){
 const contentType=request.headers.get('content-type')||'';
 if(!contentType.startsWith('multipart/form-data'))throw new AppError(415,'INTAKE_MULTIPART','图片录入需要multipart/form-data。');
 const limit=1700000;if(Number(request.headers.get('content-length')??0)>limit)throw new AppError(413,'IMAGE_SIZE','图片与说明总大小超过限制，请选择1.5 MB以内原图。');
 const reader=request.body?.getReader();if(!reader)throw new AppError(400,'INTAKE_INPUT','缺少图片录入内容');
 let size=0;const chunks:Uint8Array[]=[];
 while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit){await reader.cancel();throw new AppError(413,'IMAGE_SIZE','图片与说明总大小超过限制，原图没有被缩小或保存。');}chunks.push(part.value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 try{return await new Response(bytes,{headers:{'Content-Type':contentType}}).formData();}catch{throw new AppError(400,'INTAKE_MULTIPART','无法读取图片表单，请重新选择原图；未保存事项。');}
}
async function prepare(formData:FormData,repo:Repository,required=false){const image=formData.get('image');if(image===null&&!required)return undefined;if(!image||typeof image==='string'||typeof image.arrayBuffer!=='function')throw new AppError(400,'IMAGE_REQUIRED','请选择需要识别的原图。');return repo.prepareImage(await image.arrayBuffer(),image.type);}
function imageMeta(image?:PendingImage){if(!image)return null;const {id,sha256,mime_type,byte_size,uploaded_at}=image;return {id,sha256,mime_type,byte_size,uploaded_at};}

export async function handleIntake(request:Request,path:string[],context:IntakeContext,config:VisionConfig):Promise<Response>{
 const {repo,db,ownerId}=context;
 // The original owner boundary is checked even for capabilities and image IDs.
 const state=await repo.read();
 if(path[0]==='images'&&path.length===2&&request.method==='GET'){
  const image=await repo.image(path[1]);
  return new Response(image.bytes,{headers:{...headers,'Content-Type':image.mime_type,'Content-Length':String(image.byte_size),'Content-Disposition':`inline; filename="private-image.${image.mime_type==='image/png'?'png':image.mime_type==='image/jpeg'?'jpg':'webp'}"`,'Content-Security-Policy':"default-src 'none'; sandbox"}});
 }
 if(path.join('/')==='intake/capabilities'&&request.method==='GET')return reply({vision:visionCapabilities(config),max_image_bytes:1500000,allowed_types:['image/png','image/jpeg','image/webp'],storage_text:'选图后原图与未保存草稿保留在本机；识别时原图临时转发视觉服务；只有确认保存后，原始图片才保存在现有私有D1数据库并关联事项。原图长期保留以供核对；没有新增R2或公开链接。识别结果缓存7天，到期访问时清理。',draft_scope:await digest(`image-draft:${ownerId}`)});
 if(!state.data)throw new AppError(409,'INITIALIZE','请先读取已初始化的项目簿。');
 if(request.method!=='POST')throw new AppError(404,'ROUTE','接口不存在');
 const input=await form(request);
 if(path.join('/')==='intake/codex-result'){
  if([...input.keys()].some(key=>!['image','result_json'].includes(key)||input.getAll(key).length!==1))throw new AppError(400,'CODEX_RESULT','本机识图结果包含不允许或重复的字段。');
  const image=await prepare(input,repo,true),result=parseJSON(input.get('result_json'),'本机识图结果');
  if(Object.keys(result).some(key=>!['result','model','request_id','image_sha256','provider','completed','cached'].includes(key))||!object(result.result)||result.completed!==true||result.provider!=='codex-local-plan'||typeof result.model!=='string'||!result.model.match(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/)||typeof result.request_id!=='string'||!result.request_id||result.request_id.length>200||result.image_sha256!==image!.sha256||result.cached!==undefined&&typeof result.cached!=='boolean')throw new AppError(400,'CODEX_RESULT','本机识图未完整完成，或结果与当前原图不一致；没有保存事项，请保留图片和原编号。');
  // This endpoint validates an untrusted candidate. It does not attest to a
  // client-provided model response, invoke a provider, or write the ledger.
  const candidate=parseRecognition(result.result,state.data.projects.map(project=>({id:project.id,name:project.name})));
  return reply({...candidate,provider:'Codex 模型（本机 ChatGPT 授权）',model:result.model,...(result.cached===true?{cached:true}:{})});
 }
 if(path.join('/')==='intake/preview'){
  const draft=parseJSON(input.get('draft_json'),'录入草稿'),image=await prepare(input,repo);
  if(!object(draft.fields)||typeof draft.note!=='string'||draft.note.length>2000||typeof draft.source_event_id!=='string'||!draft.source_event_id||draft.source_event_id.length>200)throw new AppError(400,'INTAKE_INPUT','录入字段、说明或来源编号无效。');
  const questions=draft.questions??draft.recognitionQuestions;
  if(questions!==undefined&&(!Array.isArray(questions)||questions.some(q=>typeof q!=='string'||q.length>500)))throw new AppError(400,'INTAKE_INPUT','待确认问题格式无效。');
  return reply(buildIntakePreview(state.data,state.revision,{fields:draft.fields as unknown as IntakeFields,note:draft.note,source_event_id:draft.source_event_id,questions:questions as string[]|undefined},imageMeta(image)));
 }
 if(path.join('/')==='intake/commit'){
  const payload=parseJSON(input.get('payload_json'),'保存请求'),image=await prepare(input,repo);
  if(payload.confirmed!==true||!Array.isArray(payload.changes)||payload.changes.length!==1||payload.changes.some(c=>!object(c)||!['create','update'].includes(String(c.type))||!object(c.values)))throw new AppError(400,'INTAKE_CONFIRM','请核对预览后确认保存一项任务、活动或资料。');
  if(image&&!payload.changes.every(c=>Array.isArray(c.values.attachment_ids)&&c.values.attachment_ids.includes(image.id)))throw new AppError(400,'IMAGE_LINK','保存请求未关联本次原图，请重新预览；尚未保存。');
  return reply(await repo.commit(payload as unknown as Submit,image));
 }
 if(path.join('/')==='intake/recognize'){
  const capabilities=visionCapabilities(config);
  if(!capabilities.enabled)throw new AppError(503,capabilities.configured?'VISION_NOT_AUTHORIZED':'VISION_NOT_CONFIGURED','尚未启用获授权的视觉API，图片未发送给服务商。请手动填写，原图和草稿会保留。');
  if(input.get('consent')!=='true')throw new AppError(400,'VISION_CONSENT','请先确认将原图与说明发送给已披露的视觉服务商，并知晓按量计费。');
  const image=await prepare(input,repo,true),note=input.get('note'),requestId=input.get('request_id');
  if(typeof note!=='string'||note.length>2000||typeof requestId!=='string'||!requestId||requestId.length>200)throw new AppError(400,'INTAKE_INPUT','识别说明或请求编号无效。');
  const id=await digest(`${ownerId}:${requestId}`),fingerprint=await digest(JSON.stringify({sha256:image!.sha256,note,model:VISION_MODEL,projects:state.data.projects.map(p=>({id:p.id,name:p.name}))}));
  const now=new Date().toISOString(),cutoff=new Date(Date.now()-7*86400000).toISOString();
  await db.prepare('DELETE FROM image_recognitions WHERE owner_id=? AND created_at<?').bind(ownerId,cutoff).run();
  const prior=await db.prepare('SELECT * FROM image_recognitions WHERE id=? AND owner_id=?').bind(id,ownerId).first<RecognitionRow>();
  if(prior){
   if(prior.fingerprint!==fingerprint)throw new AppError(409,'RECOGNITION_ID_REUSED','原识别编号已用于另一份图片或说明，请明确发起新的识别。');
   if(prior.state==='succeeded'&&prior.result_json)return reply({...JSON.parse(prior.result_json),cached:true});
   if(prior.state==='failed'){
    const reasons:Record<string,string>={VISION_PROVIDER_AUTH:'服务端视觉密钥或访问权限异常。',VISION_PROVIDER_QUOTA:'视觉服务额度不足或请求受限。',VISION_PROVIDER_ERROR:'视觉服务返回错误。',VISION_NETWORK:'视觉服务连接或响应读取中断，请求可能已经计费。',VISION_TIMEOUT:'视觉服务识别或响应读取超时，请求可能已经计费。',VISION_INVALID_RESPONSE:'视觉服务返回的格式或字段证据无效。',VISION_REFUSED:'视觉服务拒绝识别这张图片。',VISION_INCOMPLETE:'视觉服务没有完整返回识别结果。'};
    throw new AppError(502,prior.error_code||'VISION_PREVIOUS_FAILED',(reasons[prior.error_code||'']||'这次识别未成功。')+'原编号不会重复调用付费服务。可明确重新识别或手动填写；原图和草稿仍在。');
   }
   throw new AppError(409,'RECOGNITION_PENDING','同一图片识别仍在进行或结果待确认，请保留原编号稍后查询，不会再次调用服务。');
  }
  const cached=await db.prepare("SELECT * FROM image_recognitions WHERE owner_id=? AND fingerprint=? AND state='succeeded' AND created_at>=? ORDER BY created_at DESC LIMIT 1").bind(ownerId,fingerprint,cutoff).first<RecognitionRow>();
  if(cached?.result_json)return reply({...JSON.parse(cached.result_json),cached:true});
  const dayStart=new Date(`${shanghaiDay()!}T00:00:00+08:00`).toISOString();
  const inserted=await db.prepare("INSERT OR IGNORE INTO image_recognitions (id,owner_id,fingerprint,state,created_at) SELECT ?,?,?,'pending',? WHERE (SELECT COUNT(*) FROM image_recognitions WHERE owner_id=? AND created_at>=?)<?").bind(id,ownerId,fingerprint,now,ownerId,dayStart,VISION_DAILY_LIMIT).run() as {meta?:{changes?:number};changes?:number};
  if((inserted.meta?.changes??inserted.changes)!==1){
   const existing=await db.prepare('SELECT id FROM image_recognitions WHERE id=? AND owner_id=?').bind(id,ownerId).first();
   throw new AppError(existing?409:429,existing?'RECOGNITION_PENDING':'VISION_DAILY_LIMIT',existing?'同一识别请求已被接收，请稍后查询。':'今日10次识别额度已用完，未向服务商发送图片；仍可手动录入。');
  }
  try{
   const result:RecognitionResult=await recognizeImage({bytes:image!.bytes,mime_type:image!.mime_type,note,projects:state.data.projects.map(p=>({id:p.id,name:p.name}))},config);
   await db.prepare("UPDATE image_recognitions SET state='succeeded',result_json=?,finished_at=? WHERE id=? AND owner_id=?").bind(JSON.stringify(result),new Date().toISOString(),id,ownerId).run();
   return reply(result);
  }catch(error){await db.prepare("UPDATE image_recognitions SET state='failed',error_code=?,finished_at=? WHERE id=? AND owner_id=?").bind(error instanceof AppError?error.code:'VISION_FAILED',new Date().toISOString(),id,ownerId).run();throw error;}
 }
 throw new AppError(404,'ROUTE','接口不存在');
}
