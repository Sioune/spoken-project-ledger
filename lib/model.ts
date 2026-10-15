export type TaskStatus = 'todo'|'doing'|'waiting'|'blocked'|'done'|'cancelled';
export type Task = {id:string;project_id:string;parent_id?:string|null;title:string;status:TaskStatus;next_action:string;dependencies:string[];version:number;updated_at:string;completed_at?:string|null;planned_date?:string|null;due_at?:string|null;waiting_for?:string|null;expected_result?:string|null;review_at?:string|null;verification_state:string;source_ref:string};
export type Project = {id:string;name:string;goal:string;status:string;completion_rule:string;external_links:string[];version:number};
export type Doc = {id:string;project_id:string;task_id?:string;filename:string;versions:{id:string;library_ref:string;summary:string;created_at:string;checksum?:string}[];current_version:string;accepted_version?:string|null};
export type Ledger = {projects:Project[];tasks:Task[];documents:Doc[];pending:{id:string;question:string;status:string;context:string;answer?:string;resolved_at?:string}[];settings:{timezone:string;intervalHours:number;workStart:string;workEnd:string;enabled:boolean};reminderLog:unknown[]};
export type Change = {type:'create'|'update'|'project'|'settings'|'document'|'pending'|'restore';id?:string;values:Record<string,unknown>};
export type Submit = {operation_id:string;idempotency_key:string;source_event_id:string;base_version:number;occurred_at:string;raw_text:string;changes:Change[];confirmed?:boolean;undo_of?:string};
export class AppError extends Error {constructor(public status:number,public code:string,message:string,public details:Record<string,unknown>={}){super(message)}}
export const normalize = (s:string) => s.normalize('NFKC').toLowerCase().replace(/[\s，。！？、,.!?：:;；“”"'‘’]/g,'');
const uid = () => crypto.randomUUID();
const clone = <T>(v:T):T => structuredClone(v);
const str=(v:unknown,max=1000) => {if(typeof v!=='string'||v.length>max)throw new AppError(400,'INVALID','文本字段无效或过长');return v.trim()};
export function seed(now=new Date().toISOString()):Ledger {
 const specs=[['p-contract','罗莱家纺合同','先审核合同，再发送罗莱家纺'],['p-gravity','语义引力','UI设计 → 发张锦华 → 等跑通反馈'],['p-registration','杨浦公司注册','深析材料 → 选择谈判对象 → 推进实际注册'],['p-topics','选题网站 / 2.0','记录现有Codex项目状态与成果，执行状态未核'],['p-copyright','凤阙九死红果','补材包已交；未提交、未上线；现有13总装21:26.928'],['p-teaser','teaser','制作发送已完成，等待松叶反馈'],['p-inbox','收件箱','尚未归属项目的明确本人待办']];
 const data:Ledger={projects:specs.map(([id,name,goal])=>({id,name,goal,status:'active',completion_rule:'用户核实全部关键后续后确认归档',external_links:[],version:1})),tasks:[],documents:[],pending:[{id:'q-topics',question:'选题网站 / 2.0 的当前状态及现有执行入口是什么？',status:'open',context:'由用户的新Codex对话开发，本应用不接管。'},{id:'q-contact',question:'松叶与宋业是否为同一人？',status:'open',context:'当前等待对象保留“松叶”，未合并联系人。'}],settings:{timezone:'Asia/Shanghai',intervalHours:2,workStart:'09:00',workEnd:'19:00',enabled:false},reminderLog:[]};
 const task=(id:string,p:string,title:string,status:TaskStatus,deps:string[]=[],extra:Partial<Task>={})=>data.tasks.push({id,project_id:p,title,status,next_action:title,dependencies:deps,version:1,updated_at:now,completed_at:null,verification_state:'user_reported',source_ref:'用户初始六项工作自述；实际完成时刻未知；现实结果未经外部核验',...extra});
 task('t-contract-review','p-contract','审核合同','todo');task('t-contract-send','p-contract','发罗莱家纺','blocked',['t-contract-review']);
 task('t-ui','p-gravity','完成语义引力 UI 设计','todo');task('t-ui-send','p-gravity','发张锦华让他跑通','blocked',['t-ui']);task('t-ui-feedback','p-gravity','等待张锦华跑通反馈','blocked',['t-ui-send'],{waiting_for:'张锦华',expected_result:'语义引力实际跑通反馈'});
 task('t-research','p-registration','深析杨浦公司注册材料','todo');task('t-negotiate','p-registration','选择谈判对象','blocked',['t-research']);task('t-register','p-registration','推进实际公司注册','blocked',['t-negotiate']);
 task('t-topics','p-topics','核实选题网站闭环 / 2.0 进度','todo',[],{verification_state:'unverified',next_action:'向现有开发对话核实状态及入口，不接管执行'});
 task('t-package','p-copyright','补材审核包交付','done');task('t-rights','p-copyright','确认权利主体与提交范围','waiting',[],{waiting_for:'权利主体 / 提交范围确认',expected_result:'确认权利主体、提交范围'});task('t-screenshots','p-copyright','补齐 3 张真实制作过程截图','todo');task('t-submit','p-copyright','正式提交红果补材','blocked',['t-rights','t-screenshots']);task('t-online','p-copyright','核实审核及上线结果','blocked',['t-submit']);
 task('t-teaser-edit','p-teaser','更新 teaser','done');task('t-teaser-send','p-teaser','发送 teaser 给松叶','done',['t-teaser-edit']);task('t-teaser-feedback','p-teaser','等待 teaser 反馈','waiting',['t-teaser-send'],{waiting_for:'松叶',expected_result:'teaser反馈；松叶 / 宋业关系待核'});
 return data;
}
function validate(data:Ledger){
 if(!data||!Array.isArray(data.projects)||!Array.isArray(data.tasks)||!Array.isArray(data.documents)||!Array.isArray(data.pending)||data.tasks.length>10000||data.projects.length>1000)throw new AppError(400,'DATA','状态库格式无效');
 for(const p of data.projects){for(const value of [p.id,p.name,p.goal,p.status])if(typeof value!=='string')throw new AppError(400,'PROJECT','项目字段无效');if(!p.id||!p.name.trim()||!Array.isArray(p.external_links))throw new AppError(400,'PROJECT','项目字段无效');}
 const ids=new Set(data.tasks.map(t=>t.id)); if(ids.size!==data.tasks.length)throw new AppError(400,'DUPLICATE_ID','任务ID重复');
 for(const t of data.tasks){
  for(const value of [t.id,t.project_id,t.title,t.next_action,t.verification_state])if(typeof value!=='string'||!value.trim())throw new AppError(400,'TASK_FIELD','任务必填字段不能为空');if(!Array.isArray(t.dependencies)||t.dependencies.some(x=>typeof x!=='string')||!Number.isInteger(t.version)||!Number.isFinite(Date.parse(t.updated_at)))throw new AppError(400,'TASK_FIELD','任务依赖或版本无效');
  for(const key of ['due_at','review_at'] as const)if(t[key]&&(!/(Z|[+-]\d\d:\d\d)$/.test(t[key])||!Number.isFinite(Date.parse(t[key]))))throw new AppError(400,'DATE','时间需包含时区');if(t.planned_date&&!/^\d{4}-\d{2}-\d{2}$/.test(t.planned_date))throw new AppError(400,'DATE','计划日格式应为YYYY-MM-DD');if(!['user_reported','unverified','confirmed'].includes(t.verification_state))throw new AppError(400,'VERIFICATION','核实状态无效');
  if(!data.projects.some(p=>p.id===t.project_id))throw new AppError(400,'PROJECT','项目不存在');
  if(!['todo','doing','waiting','blocked','done','cancelled'].includes(t.status))throw new AppError(400,'STATUS','状态无效');
  for(const d of t.dependencies)if(!ids.has(d))throw new AppError(400,'DEPENDENCY','前序任务不存在');
  if(t.parent_id&&!ids.has(t.parent_id))throw new AppError(400,'PARENT','父任务不存在');
  const walk=(id:string,path:Set<string>)=>{if(path.has(id))throw new AppError(400,'CYCLE','依赖或子任务不能成环');const p=new Set(path).add(id);const n=data.tasks.find(x=>x.id===id)!;for(const dep of [...n.dependencies,...(n.parent_id?[n.parent_id]:[])])walk(dep,p)}; walk(t.id,new Set());
  if(['done','doing','waiting'].includes(t.status)&&t.dependencies.some(id=>data.tasks.find(d=>d.id===id)?.status!=='done'))throw new AppError(409,'BLOCKED','前序任务尚未完成，不能开始、等待或完成此任务',{task_id:t.id});
  if(t.status==='waiting'&&!t.waiting_for)throw new AppError(400,'WAITING','请填写等待对象');
 }
 for(const d of data.documents){if(!data.projects.some(p=>p.id===d.project_id)|| (d.task_id&&(!ids.has(d.task_id)||data.tasks.find(t=>t.id===d.task_id)?.project_id!==d.project_id)))throw new AppError(400,'DOCUMENT','文件项目或任务不存在，或任务不属于此项目');if(!d.versions.some(v=>v.id===d.current_version)||d.accepted_version&&!d.versions.some(v=>v.id===d.accepted_version))throw new AppError(400,'DOCUMENT','文件版本不存在');}
}
export function applyChanges(current:Ledger,changes:Change[],now:string,occurredAt:string):{data:Ledger;effective:Change[]}{
 if(!Array.isArray(changes)||changes.length>100)throw new AppError(400,'CHANGES','每组最多100项变更');
 const data=clone(current),effective:Change[]=[];
 for(const c of changes){if(!c||typeof c.values!=='object'||!c.values||Array.isArray(c.values))throw new AppError(400,'CHANGE','变更格式不正确');const v=c.values;
  if(c.type==='create'){
   const title=str(v.title,300);if(!title)throw new AppError(400,'TITLE','请输入任务名称');
   const project_id=str(v.project_id??'p-inbox',100);const exact=data.tasks.find(t=>t.project_id===project_id&&normalize(t.title)===normalize(title)&&t.status!=='cancelled');if(exact)continue;
   const candidate=data.tasks.find(t=>t.project_id===project_id&&t.status!=='cancelled'&&Math.min(normalize(t.title).length,normalize(title).length)>3&&(normalize(t.title).includes(normalize(title))||normalize(title).includes(normalize(t.title))));
   if(candidate)throw new AppError(409,'POSSIBLE_DUPLICATE','发现相近待办，请核实是已有任务还是新任务',{candidate});
   const id=c.id?str(c.id,100):uid();if(data.tasks.some(t=>t.id===id))throw new AppError(409,'DUPLICATE_ID','任务ID已存在');
   const t:Task={id,project_id,title,status:(v.status?str(v.status,30):'todo') as TaskStatus,next_action:typeof v.next_action==='string'&&v.next_action.trim()?str(v.next_action):title,parent_id:typeof v.parent_id==='string'&&v.parent_id?v.parent_id:null,dependencies:Array.isArray(v.dependencies)?v.dependencies.map(x=>str(x,100)):[],version:1,updated_at:now,completed_at:null,verification_state:v.verification_state?str(v.verification_state,100):'user_reported',source_ref:typeof v.source_ref==='string'?str(v.source_ref):'用户自述'};
   for(const k of ['planned_date','due_at','review_at','waiting_for','expected_result'] as const){const value=v[k];t[k]=value===undefined||value===null||value===''?null:str(value,2000)}if(t.status==='done')t.completed_at=occurredAt;data.tasks.push(t);effective.push({...c,id,values:t});
  }else if(c.type==='update'){
   const t=data.tasks.find(t=>t.id===c.id);if(!t)throw new AppError(404,'TASK','任务不存在');
   if(new Date(occurredAt).getTime()<new Date(t.updated_at).getTime()-1000)throw new AppError(409,'STALE_EVENT','这条输入早于当前事实，请读取最新状态再确认',{task:t});
   const allowed=['title','project_id','status','next_action','planned_date','due_at','waiting_for','expected_result','review_at','dependencies','verification_state','source_ref','parent_id']; const delta:Record<string,unknown>={};for(const [k,original]of Object.entries(v)){const val=original===''&&!['title','project_id','status','next_action','verification_state','source_ref'].includes(k)?null:original;if(!allowed.includes(k))throw new AppError(400,'FIELD','不允许修改字段：'+k);if(['title','project_id','status','next_action','verification_state','source_ref'].includes(k)&&(val===null||typeof val!=='string'||!val.trim()))throw new AppError(400,'FIELD','此字段不能为空：'+k);if(k==='dependencies'){if(!Array.isArray(val))throw new AppError(400,'DEPENDENCY','依赖必须为数组');delta[k]=val.map(x=>str(x,100))}else{delta[k]=val===null?null:str(val,k==='title'?300:2000);if(['due_at','review_at'].includes(k)&&val!==null&&(!String(val).match(/(Z|[+-]\d\d:\d\d)$/)||!Number.isFinite(Date.parse(String(val)))))throw new AppError(400,'DATE','时间需包含时区');if(k==='planned_date'&&val!==null&&!/^\d{4}-\d{2}-\d{2}$/.test(String(val)))throw new AppError(400,'DATE','计划日格式应为YYYY-MM-DD');}}
   if(Object.entries(delta).every(([k,val])=>JSON.stringify(t[k as keyof Task])===JSON.stringify(val)))continue;
   const oldStatus=t.status,oldCompletedAt=t.completed_at;Object.assign(t,delta,{version:t.version+1,updated_at:now});t.completed_at=t.status==='done'?(oldStatus==='done'?oldCompletedAt:occurredAt):null;effective.push(c);
  }else if(c.type==='project'){
   let p=data.projects.find(p=>p.id===c.id);if(!p){p={id:c.id??uid(),name:str(v.name,300),goal:str(v.goal??'',2000),status:'active',completion_rule:'用户确认关键后续完成后归档',external_links:[],version:1};data.projects.push(p)}else p.version++;
   for(const [k,val] of Object.entries(v)){if(k==='external_links'){if(!Array.isArray(val))throw new AppError(400,'LINK','入口必须为数组');p.external_links=val.map(x=>{const link=str(x,1000);if(!/^(https:\/\/|codex:\/\/threads\/)/.test(link))throw new AppError(400,'LINK','仅接受已核实的HTTPS或Codex任务入口');return link})}else if(['name','goal','status','completion_rule'].includes(k)){(p as unknown as Record<string,unknown>)[k]=str(val,2000)}else throw new AppError(400,'FIELD','项目字段无效')}
   if(!['active','paused','archived'].includes(p.status))throw new AppError(400,'STATUS','项目状态无效');if(p.status==='archived'&&data.tasks.some(t=>t.project_id===p.id&&!['done','cancelled'].includes(t.status)))throw new AppError(409,'FOLLOW_UP','仍有未完成后续，请先处理或取消后确认归档');effective.push({...c,id:p.id});
  }else if(c.type==='settings'){
   const settings={...data.settings};for(const [k,val] of Object.entries(v)){if(k==='timezone'){if(val!=='Asia/Shanghai')throw new AppError(400,'TIMEZONE','此版本提醒时区固定为Asia/Shanghai');settings.timezone=val}else if(k==='intervalHours'){if(val!==2)throw new AppError(400,'INTERVAL','此版本支持每2小时整点');settings.intervalHours=2}else if(k==='enabled'){if(typeof val!=='boolean')throw new AppError(400,'SETTING','开关无效');settings.enabled=val}else if(k==='workStart'||k==='workEnd'){if(typeof val!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(val))throw new AppError(400,'SETTING','工作时段无效');settings[k]=val}else throw new AppError(400,'SETTING','设置字段无效')};if(settings.workStart>=settings.workEnd)throw new AppError(400,'SETTING','结束需晚于开始');data.settings=settings;effective.push(c);
  }else if(c.type==='document'){
   let d=data.documents.find(d=>d.id===c.id);
   if(v.accepted_version){if(!d)throw new AppError(404,'DOCUMENT','文件不存在');const accepted=str(v.accepted_version,100);if(!d.versions.some(x=>x.id===accepted))throw new AppError(400,'DOCUMENT','版本不存在');d.accepted_version=accepted;effective.push(c);continue;}
   const library_ref=str(v.library_ref,250);if(!/^libfile_[A-Za-z0-9]+$/.test(library_ref))throw new AppError(400,'LIBRARY_REF','请提供现有Library文件ID（libfile_…），不接受公开URL或本地路径');
   const version={id:uid(),library_ref,summary:str(v.summary??'',2000),created_at:now};
   if(!d){d={id:c.id??uid(),project_id:str(v.project_id,100),task_id:v.task_id?str(v.task_id,100):undefined,filename:str(v.filename,300),versions:[],current_version:version.id,accepted_version:null};data.documents.push(d)}
   if(d.versions.some(x=>x.library_ref===library_ref))continue;d.versions.push(version);d.current_version=version.id;effective.push({...c,id:d.id,values:{...v,version_id:version.id}});
  }else if(c.type==='pending'){
   const q=data.pending.find(q=>q.id===c.id);if(q){q.status=v.status==='resolved'?'resolved':'open';if(v.answer){q.answer=str(v.answer,4000);q.resolved_at=now}effective.push(c)}else{const id=c.id??uid();data.pending.push({id,question:str(v.question,1000),context:str(v.context??'',2000),status:'open'});effective.push({...c,id})}
  }else if(c.type==='restore'){
   const restored=v.data as Ledger;if(!restored||!Array.isArray(restored.tasks)||!Array.isArray(restored.projects)||!Array.isArray(restored.documents)||!Array.isArray(restored.pending)||!restored.settings)throw new AppError(400,'RESTORE','备份格式无效');
   validate(restored);const copy=clone(restored);for(const t of copy.tasks){const prior=current.tasks.find(x=>x.id===t.id);const compare=(x:Task)=>JSON.stringify({...x,version:0,updated_at:''});if(prior&&compare(t)!==compare(prior)){t.version=Math.max(t.version,prior.version)+1;t.updated_at=now}else if(prior){t.version=prior.version;t.updated_at=prior.updated_at}}Object.assign(data,copy,{reminderLog:[]});effective.push(c);
  }else throw new AppError(400,'CHANGE','变更类型不支持');
 }
 // A released prerequisite makes the next action available; it never completes it.
 for(const t of data.tasks){if(t.status==='blocked'&&t.dependencies.length&&t.dependencies.every(id=>data.tasks.find(d=>d.id===id)?.status==='done')){t.status=t.waiting_for?'waiting':'todo';t.version++;t.updated_at=now;effective.push({type:'update',id:t.id,values:{status:t.status}})}else if(t.status==='todo'&&t.dependencies.some(id=>data.tasks.find(d=>d.id===id)?.status!=='done')){t.status='blocked';t.version++;t.updated_at=now;effective.push({type:'update',id:t.id,values:{status:'blocked'}})}}
 validate(data);return {data,effective};
}
export function preview(text:string,data:Ledger,base_version:number,source_event_id:string,occurred_at:string){
 text=str(text,10000);const questions:string[]=[],changes:Change[]=[];let summary='请检查变更后保存。';
 if(!text)throw new AppError(400,'EMPTY','请输入口述文字');
 const negation=/(准备|打算|应该|可能|预计|计划|未|没|不|并非|否|无需|[？?吗])/;
 const negative=negation.test(text);
 if(/teaser/i.test(text)&&/(发|更新|改好|反馈)/.test(text)){
  {
   const receiver=text.match(/(?:发给|发了给|发送给)\s*([^，。；,;\s了]+?)(?:了|，|。|；|,|;|\s|$)/)?.[1];
   const receiverUnclear=!!receiver&&receiver!=='松叶'||/宋业/.test(text);
   const affirmative=text.split(/[，,；;。]|但是|但|不过/).filter(s=>!negation.test(s)).join('，');
   if(/已(?:经)?更新|更新(?:好|完|完成|了)|改好|做好/.test(affirmative))changes.push({type:'update',id:'t-teaser-edit',values:{status:'done'}});
   if(!receiverUnclear&&/已(?:经)?.*发|发.*了|发出了/.test(affirmative))changes.push({type:'update',id:'t-teaser-send',values:{status:'done'}});
   if(!receiverUnclear&&/收到.*反馈|反馈.*(?:收到|已到)/.test(affirmative))changes.push({type:'update',id:'t-teaser-feedback',values:{status:'done'}});
   else if(!receiverUnclear&&/等(?:待)?.*反馈|等松叶/.test(affirmative))changes.push({type:'update',id:'t-teaser-feedback',values:{status:'waiting',waiting_for:data.tasks.find(t=>t.id==='t-teaser-feedback')?.waiting_for??'松叶',expected_result:'teaser反馈；松叶 / 宋业关系待核'}});
   if(receiverUnclear)questions.push('原记录等待对象为“松叶”，本次对象“'+(receiver??'宋业')+'”尚未核实。请确认新任务或在详情明确改名。');
   if(!changes.length&&!receiverUnclear)questions.push('未识别到明确完成事实。请在任务详情选择具体步骤，计划与否定不会写成完成。');
   if(/周|明天|后天|下次|提醒/.test(text))questions.push('请确认复查的具体日期与时间（Asia/Shanghai），本次先保留明确制作/发送事实。');
   summary='制作、发送与反馈分开保存。没有设置未确认的复查时间。';
  }
 }else if(/都做完|全部完成|全部关闭|上线|注册完成|已提交/.test(text)){
  questions.push('请选定任务并核对完成范围及证据，避免关闭尚有后续的步骤。');summary='重大状态变更需要明确任务范围。';
 }else{
  const title=text.replace(/^(新增|新建|添加|记下|帮我记)(一个)?(任务|待办)?[：:，,\s]*/,'').trim();
  const matches=data.tasks.filter(t=>normalize(t.title)===normalize(title));
  if(matches.length){summary='已有相同任务，无需重复新增。'}
  else {const project=data.projects.filter(p=>text.includes(p.name));const near=data.tasks.filter(t=>normalize(t.title).length>3&&(normalize(title).includes(normalize(t.title))||normalize(t.title).includes(normalize(title))));
   if(near.length){questions.push('可能是已有任务：'+near.map(t=>t.title).join('、')+'。请在任务详情更新，或改写为明确的新任务。');summary='找到相近记录，尚未新增。'}
   else if(negative){questions.push('这是一条计划还是对已有任务的更新？请明确动作。');summary='未把不确定陈述转为已完成。'}
   else {changes.push({type:'create',id:uid(),values:{title,project_id:project.length===1?project[0].id:'p-inbox',source_ref:'文本模拟转写 / 用户自述'}});summary='新增本人待办；未编造截止日。'}
  }
 }
 return {changes,questions,summary,base_version,source_event_id,occurred_at};
}
