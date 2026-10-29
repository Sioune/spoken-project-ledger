import {AppError} from './model';

/** The browser supplies its expected identity, never the identity to use. */
export async function accountScope(userId:string):Promise<string>{
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`image-draft:${userId}`));
 return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function assertExpectedAccount(actual:string,expected:string|null|undefined){
 // undefined is reserved for the identity bootstrap and MCP transport.
 if(expected!==undefined && expected!==actual)throw new AppError(409,'ACCOUNT_CHANGED','登录账号已变化，请重新读取当前账号');
}
