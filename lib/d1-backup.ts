import {AppError} from './model';
import type {Database} from './repository';

type Schema={type:string;name:string;tbl_name:string;sql:string|null};
type Col={name:string;pk:number;hidden:number};
type Fragment={kind:string;table_name:string;row_number:number;column_name:string;value_type:string;part:number;value:string|null;byte_length:number};
type Cell={type:string;value?:string;hex?:string};
const chunkBytes=250000;
const maxBytes=12000000;
const ident=(s:string)=>'"'+s.replace(/"/g,'""')+'"';
const lit=(s:string)=>"'"+s.replace(/'/g,"''")+"'";
// D1 currently limits each compound SELECT to five terms.
function union(parts:string[]):string {while(parts.length>5){const next:string[]=[];for(let i=0;i<parts.length;i+=5)next.push(`SELECT * FROM (${parts.slice(i,i+5).join(' UNION ALL ')})`);parts=next;}return parts.join(' UNION ALL ')}
const schemaSQL="SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name";

// A custom header cannot be sent cross-origin by a browser without CORS
// preflight. The API never grants CORS and the snapshot also checks ownership.
export function assertBackupRequest(request:Request){
 const origin=request.headers.get('origin');
 const site=request.headers.get('sec-fetch-site');
 if(request.method!=='GET'||request.headers.get('x-ledger-backup')!=='download'||(origin&&origin!==new URL(request.url).origin)||(site&&site!=='same-origin'&&site!=='none'))throw new AppError(403,'ORIGIN','备份只能由本人站内下载');
}

// Export is intentionally fail-closed: unsupported schemas must be reviewed
// before their data can be captured and restored correctly.
export async function exportD1Snapshot(db:Database,owner:string){
 if(!owner)throw new AppError(401,'AUTH','请先登录');
 const authorized=await db.prepare('SELECT owner_id FROM ledgers WHERE id=1').first<{owner_id:string}>();
 if(!authorized || authorized.owner_id!==owner)throw new AppError(403,'OWNER_ONLY','仅原账本所有者可备份');
 const inventory:{tables:string[];indexes:string[];columns:Record<string,string[]>;definitions:Record<string,string>}={tables:[],indexes:[],columns:Object.create(null),definitions:Object.create(null)};
 let stage='SCHEMA_READ';
 const bad=()=>new AppError(503,'BACKUP_INCOMPLETE','备份未完整生成，未返回数据。',{stage,inventory});
 const safeName=(value:unknown)=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value)?value:'[invalid]';
 try{
 const pre=(await db.prepare(schemaSQL).all<Schema>()).results;
 if(!Array.isArray(pre)||pre.length>200)throw bad();
 inventory.tables=pre.filter(x=>x.type==='table').map(x=>safeName(x.name));
 inventory.indexes=pre.filter(x=>x.type==='index').map(x=>safeName(x.name));
 for(const name of ['__appgarden_migrations','sqlite_sequence']){
  const definition=pre.find(x=>x.type==='table'&&x.name===name)?.sql;
  if(typeof definition==='string'&&definition.length<=2048)inventory.definitions[name]=definition;
 }
 stage='COLUMN_READ';
 for(const entry of pre.filter(x=>x.type==='table'&&!x.name.startsWith('_cf_')&&!x.name.startsWith('sqlite_'))){
  const name=safeName(entry.name);if(name==='[invalid]')throw bad();
  const found=(await db.prepare(`PRAGMA table_xinfo(${ident(name)})`).all<Col>()).results;
  if(!Array.isArray(found)||found.length>100)throw bad();
  inventory.columns[name]=found.map(c=>safeName(c.name));
 }
 stage='SCHEMA_VALIDATE';
 // Only explicitly identified Cloudflare system tables are excluded.
 const systemTables=new Set(['_cf_KV','_cf_METADATA']);
 if(pre.some(x=>x.type==='table'&&x.name.startsWith('_cf_')&&!systemTables.has(x.name)))throw bad();
 const tables=pre.filter(x=>x.type==='table'&&!systemTables.has(x.name)&&!x.name.startsWith('sqlite_')).map(x=>x.name);
 if(pre.some(x=>!['table','index'].includes(x.type)))throw bad();
 const required=['ledgers','operations','images','image_recognitions'];
 const allowed=new Set(required);
 if(required.some(x=>!tables.includes(x))||tables.some(x=>!allowed.has(x))||new Set(tables).size!==tables.length)throw bad();
 if(pre.some(x=>x.type==='table'&&x.name.startsWith('sqlite_')))throw bad();
 tables.sort();
 const columns:Record<string,Col[]>={};
 const expectedColumns:Record<string,string[]>={ledgers:['id','owner_id','revision','data','last_operation'],operations:['id','owner_id','idempotency_key','source_event_id','payload_hash','receipt','created_at'],images:['id','owner_id','sha256','mime_type','byte_size','uploaded_at','bytes'],image_recognitions:['id','owner_id','fingerprint','state','result_json','error_code','created_at','finished_at']};
 const allowedIndexes=new Set(['owner_key','owner_source','recognitions_owner_created','recognitions_owner_fingerprint','images_owner_hash']);
 if(pre.some(s=>s.type==='index'&&!s.name.startsWith('sqlite_autoindex_')&&!allowedIndexes.has(s.name)))throw bad();
 for(const table of tables){
  const cols=(await db.prepare(`PRAGMA table_xinfo(${ident(table)})`).all<Col>()).results;
  if(!cols.length||cols.length>100||cols.some(c=>c.hidden!==0||!/^\w+$/.test(c.name)))throw bad();
  if(JSON.stringify(cols.map(c=>c.name))!==JSON.stringify(expectedColumns[table]))throw bad();
  columns[table]=cols.map(({name,pk,hidden})=>({name,pk,hidden}));
 }
 stage='SIZE_CHECK';
 // Bound memory before making the transaction-sized read. A changed database
 // is checked again after the read; over-limit output is never returned.
 const sizeParts=tables.map(t=>`SELECT COALESCE(SUM(${columns[t].map(c=>`COALESCE(length(CAST(${ident(c.name)} AS BLOB)),0)`).join('+')}),0) AS n FROM ${ident(t)}`);
 const size=(await db.prepare(`SELECT SUM(n) AS n FROM (${union(sizeParts)})`).first<{n:number}>())?.n;
 if(typeof size!=='number'||size>maxBytes)throw bad();
 const ctes=tables.map((t,i)=>`r${i} AS MATERIALIZED (SELECT row_number() OVER () AS __backup_row, ${columns[t].map(c=>ident(c.name)).join(',')} FROM ${ident(t)})`);
 const selects=["SELECT 'schema' kind,name table_name,0 row_number,type column_name,tbl_name value_type,0 part,sql value,0 byte_length FROM sqlite_schema"];
 tables.forEach((t,i)=>{
  selects.push(`SELECT 'count',${lit(t)},count(*),'','',0,NULL,0 FROM r${i}`);
  const cellSelects:string[]=[];
  for(const c of columns[t]){
   const ref=`r.${ident(c.name)}`,type=`typeof(${ref})`,length=`length(CAST(${ref} AS BLOB))`;
   cellSelects.push(`SELECT 'cell',${lit(t)},r.__backup_row,${lit(c.name)},${type},n,CASE WHEN ${type} IN ('text','blob') THEN hex(substr(CAST(${ref} AS BLOB),n*${chunkBytes}+1,${chunkBytes})) WHEN ${type}='integer' THEN CAST(${ref} AS TEXT) WHEN ${type}='real' THEN printf('%!.17g',${ref}) ELSE NULL END,CASE WHEN ${type} IN ('text','blob') THEN ${length} ELSE 0 END FROM r${i} r JOIN chunks ON CASE WHEN ${type} IN ('text','blob') THEN (n*${chunkBytes}<${length} OR (n=0 AND ${length}=0)) ELSE n=0 END`);
  }
  selects.push(`SELECT * FROM (${union(cellSelects)})`);
 });
 const sql=`WITH RECURSIVE chunks(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM chunks WHERE n<7), ${ctes.join(', ')} ${union(selects)} ORDER BY 1,2,3,4,6`;
 if(sql.length>95000)throw bad();
 stage='SNAPSHOT_READ';
 const result=await db.prepare(sql).all<Fragment>();
 stage='SNAPSHOT_VALIDATE';
 if(!Array.isArray(result.results))throw bad();
 const actual=result.results.filter(x=>x.kind==='schema').map(x=>({type:x.column_name,name:x.table_name,tbl_name:x.value_type,sql:x.value})).sort((a,b)=>a.type.localeCompare(b.type)||a.name.localeCompare(b.name)||a.tbl_name.localeCompare(b.tbl_name));
 const expected=[...pre].sort((a,b)=>a.type.localeCompare(b.type)||a.name.localeCompare(b.name)||a.tbl_name.localeCompare(b.tbl_name));
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw bad();
 const rows:Record<string,Cell[][]>={};const counts:Record<string,number>={};const expectedLengths=new Map<string,number>();const seenParts=new Set<string>();let total=0;
 for(const table of tables)rows[table]=[];
 for(const f of result.results){
  if(f.kind==='schema')continue;
  if(!Object.hasOwn(rows,f.table_name))throw bad();
  if(f.kind==='count'){if(Object.hasOwn(counts,f.table_name)||!Number.isSafeInteger(f.row_number)||f.row_number<0)throw bad();counts[f.table_name]=f.row_number;continue}
  if(f.kind!=='cell'||!Number.isSafeInteger(f.row_number)||f.row_number<1||!Number.isInteger(f.part)||f.part<0||f.part>=8)throw bad();
  const idx=columns[f.table_name].findIndex(c=>c.name===f.column_name);if(idx<0)throw bad();
  const key=JSON.stringify([f.table_name,f.row_number,idx]);const partKey=key+':'+f.part;
  if(seenParts.has(partKey))throw bad();seenParts.add(partKey);
  if(!Number.isSafeInteger(f.byte_length)||f.byte_length<0)throw bad();
  if(expectedLengths.has(key)&&expectedLengths.get(key)!==f.byte_length)throw bad();expectedLengths.set(key,f.byte_length);
  const row=rows[f.table_name][f.row_number-1]??(rows[f.table_name][f.row_number-1]=[]);
  let cell=row[idx];
  if(!cell){if(f.part!==0)throw bad();cell=row[idx]={type:f.value_type};}
  if(cell.type!==f.value_type)throw bad();
  if(f.value_type==='text'||f.value_type==='blob'){
   if(typeof f.value!=='string'||!/^(?:[0-9A-F]{2})*$/.test(f.value))throw bad();
   if(f.part!==Math.floor((cell.hex?.length??0)/(chunkBytes*2)))throw bad();
   cell.hex=(cell.hex??'')+f.value;total+=f.value.length/2;
  }else if(f.value_type==='integer'||f.value_type==='real'){
   if(f.part!==0||typeof f.value!=='string'||cell.value!==undefined)throw bad();cell.value=f.value;total+=f.value.length;
  }else if(f.value_type!=='null'||f.part!==0||f.value!==null)throw bad();
 }
 if(total>maxBytes)throw bad();
 for(const table of tables){if(counts[table]===undefined||rows[table].length!==counts[table]||Array.from({length:counts[table]},(_,i)=>rows[table][i]).some((row,ri)=>!row||row.length!==columns[table].length||Array.from({length:columns[table].length},(_,i)=>row[i]).some((c,i)=>!c||((c.type==='blob'||c.type==='text')&&(c.hex?.length??-1)!==2*expectedLengths.get(JSON.stringify([table,ri+1,i]))!))))throw bad()}
 const ownerCol=columns.ledgers.findIndex(c=>c.name==='owner_id'),idCol=columns.ledgers.findIndex(c=>c.name==='id');
 const ownerHex=Array.from(new TextEncoder().encode(owner),n=>n.toString(16).padStart(2,'0')).join('').toUpperCase();
 const ownerRows=rows.ledgers.filter(r=>r[idCol]?.type==='integer'&&r[idCol]?.value==='1');
 if(ownerRows.length!==1||ownerRows[0][ownerCol]?.type!=='text'||ownerRows[0][ownerCol]?.hex!==ownerHex)throw new AppError(403,'OWNER_ONLY','仅原账本所有者可备份');
 return {format:'d1-logical-snapshot-v1',captured_at:new Date().toISOString(),complete:true,schema:actual,row_counts:counts,tables:Object.fromEntries(tables.map(t=>[t,{columns:columns[t],rows:rows[t]}]))};
 }catch(error){
  if(error instanceof AppError&&(error.status===403||error.code==='BACKUP_INCOMPLETE'))throw error;
  throw bad();
 }
}
