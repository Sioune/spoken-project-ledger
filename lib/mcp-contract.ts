import {AppError} from './model';
/** Explicit value fields keep the native tool gateway contract inspectable.
 * Avoid free-form nested objects: all task, file and settings fields are typed. */
export const changeValuesSchema = {
 type: 'object',
 properties: {
  title: {type:'string'}, project_id: {type:'string'}, parent_id:{type:['string','null']},
  status:{type:'string',enum:['todo','doing','waiting','blocked','done','cancelled','active','paused','archived','open','resolved']},
  next_action:{type:'string'}, source_ref:{type:'string',description:'用户自述或外部证据的来源说明；补记来源不会把补记时刻当作现实发送时间。'},
  planned_date:{type:['string','null'],description:'真实YYYY-MM-DD日期，空值表示未设置'},
  due_at:{type:['string','null'],description:'ISO8601，需含时区'}, review_at:{type:['string','null'],description:'ISO8601，需含时区'},
  waiting_for:{type:['string','null']}, expected_result:{type:['string','null']},
  dependencies:{type:'array',items:{type:'string'}}, verification_state:{type:'string',enum:['user_reported','unverified','confirmed']},
  name:{type:'string'},goal:{type:'string'},completion_rule:{type:'string'},external_links:{type:'array',items:{type:'string'}},
  start_date:{type:['string','null'],description:'项目进场日，真实YYYY-MM-DD'},target_end_date:{type:['string','null'],description:'项目计划结束日，真实YYYY-MM-DD'},completed_date:{type:['string','null'],description:'用户明确提供的项目实际完成日，真实YYYY-MM-DD；不自动归档'},
  filename:{type:'string'},library_ref:{type:'string',pattern:'^libfile_[A-Za-z0-9]+$',description:'既有本人Library文件ID；不是公开URL或本地路径'},
  task_id:{type:'string'},summary:{type:'string'},accepted_version:{type:'string'},
  timezone:{type:'string',enum:['Asia/Shanghai']},intervalHours:{type:'integer',enum:[2]},workStart:{type:'string'},workEnd:{type:'string'},enabled:{type:'boolean'},
  question:{type:'string'},context:{type:'string'},answer:{type:'string'}
 },
 additionalProperties:false
};
export const ledgerCommitInputSchema={
 type:'object',properties:{
  operation_id:{type:'string'},idempotency_key:{type:'string'},source_event_id:{type:'string'},base_version:{type:'integer'},occurred_at:{type:'string'},raw_text:{type:'string'},
  changes:{type:'array',items:{type:'object',properties:{type:{type:'string',enum:['create','update','project','settings','document','pending']},id:{type:'string'},values:changeValuesSchema},required:['type','values'],additionalProperties:false}},
  confirmed:{type:'boolean'}
 },required:['operation_id','idempotency_key','source_event_id','base_version','occurred_at','raw_text','changes'],additionalProperties:false
};
export function mcpCommitPayload(args:unknown,jsonMode=false):Record<string,unknown>{
 let value=args;
 if(jsonMode){if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>k!=='payload_json'))throw new AppError(400,'INPUT','JSON提交仅接受payload_json字段');const raw=(args as Record<string,unknown>).payload_json;if(typeof raw!=='string'||raw.length>1000000)throw new AppError(400,'JSON','payload_json需为完整请求JSON字符串');try{value=JSON.parse(raw)}catch{throw new AppError(400,'JSON','payload_json格式无效')}}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError(400,'INPUT','提交必须是对象');
 const input=value as Record<string,unknown>,top=Object.keys(ledgerCommitInputSchema.properties),fields=Object.keys(changeValuesSchema.properties);
 if(Object.keys(input).some(k=>!top.includes(k)))throw new AppError(400,'FIELD','提交包含未公开字段');
 if(!Array.isArray(input.changes))throw new AppError(400,'CHANGES','changes必须为数组');
 for(const change of input.changes){if(!change||typeof change!=='object'||Array.isArray(change)||Object.keys(change).some(k=>!['type','id','values'].includes(k))||!['create','update','project','settings','document','pending'].includes(change.type))throw new AppError(400,'CHANGE','MCP提交的变更类型或字段无效');if(!change.values||typeof change.values!=='object'||Array.isArray(change.values)||Object.keys(change.values).some(k=>!fields.includes(k)))throw new AppError(400,'FIELD','变更包含未公开字段');}
 if(input.confirmed!==undefined&&typeof input.confirmed!=='boolean')throw new AppError(400,'CONFIRM','confirmed必须为布尔值');return input;
}
