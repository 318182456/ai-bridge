import {AppError} from '../common.mjs';
export const studioURL=(account={},model)=>{account=account||{};const index=Number.isInteger(account.authuser)&&account.authuser>=0&&account.authuser<100?account.authuser:0;const url=new URL(index?'https://aistudio.google.com/u/'+index+'/prompts/new_chat':'https://aistudio.google.com/prompts/new_chat');if(model)url.searchParams.set('model',model);return url.href;};
// ASVS V2.2: accept Google session cookies only; no arbitrary URLs, domains, script or browser fingerprint settings.
export function googleCookies(input){
 if(!Array.isArray(input)||!input.length||input.length>300)throw new AppError(400,'Cookie 列表无效','invalid_cookie_payload');let size=0;const unique=new Map();
 for(const row of input){if(!row||typeof row!=='object'||Array.isArray(row))throw new AppError(400,'Cookie 格式无效','invalid_cookie_payload');
  const domain=String(row.domain||'').toLowerCase(),name=row.name,value=row.value,path=row.path||'/';
  if(!/^\.?[a-z0-9.-]+$/.test(domain)||!(domain.replace(/^\./,'')==='google.com'||domain.endsWith('.google.com'))||typeof name!=='string'||!/^[!#$%&'*+\-.^_`|~A-Za-z0-9]{1,128}$/.test(name)||typeof value!=='string'||value.length>16384||/[\x00-\x20\x7f;]/.test(value)||typeof path!=='string'||!path.startsWith('/')||path.length>1024||/[\r\n\0]/.test(path))throw new AppError(400,'Cookie 属性无效','invalid_cookie_payload');
  if(name==='oauth_token')continue;if((size+=name.length+value.length+domain.length+path.length)>256*1024)throw new AppError(413,'Cookie 数据过大','invalid_cookie_payload');
  const c={name,value,domain,path,httpOnly:!!row.httpOnly,secure:!!row.secure,sameSite:({strict:'Strict',lax:'Lax',none:'None',no_restriction:'None',unspecified:'Lax'})[String(row.sameSite||'lax').toLowerCase()]||'Lax'};
  const expiration=Number(row.expires??row.expirationDate);if(Number.isFinite(expiration)&&expiration>0){if(expiration<Date.now()/1000)continue;c.expires=Math.floor(expiration);}unique.set(domain+'\n'+path+'\n'+name,c);
 }
 const rows=[...unique.values()];if(!rows.some(c=>['SID','__Secure-1PSID','__Secure-3PSID'].includes(c.name)&&c.value)||!rows.some(c=>['SAPISID','__Secure-1PAPISID','__Secure-3PAPISID'].includes(c.name)&&c.value))throw new AppError(400,'未取得完整 Google 会话，请确认脚本管理器允许读取 HttpOnly Cookie','incomplete_google_cookies');return rows;
}
