import {api} from '@/lib/api';
export const dynamic='force-dynamic';
export async function GET(r:Request,{params}:{params:Promise<{path:string[]}>}){return api(r,(await params).path)}
export async function POST(r:Request,{params}:{params:Promise<{path:string[]}>}){return api(r,(await params).path)}
