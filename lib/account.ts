import {AppError} from './model';
import type {Database} from './repository';

// The caller provides only the authenticated platform subject, never a client-supplied account id.
export async function ensureAccount(db:Database, user:{userId:string;displayName:string}) {
 if (!user.userId) throw new AppError(401,'AUTH','请先登录');
 await db.prepare('INSERT OR IGNORE INTO accounts (id,display_name,created_at,status) VALUES (?,?,?,?)').bind(user.userId,user.displayName,new Date().toISOString(),'active').run();
 const account=await db.prepare('SELECT id,status FROM accounts WHERE id=?').bind(user.userId).first<{id:string;status:string}>();
 if (!account || account.status!=='active') throw new AppError(403,'ACCOUNT_DISABLED','当前账号不可用');
 return account;
}
