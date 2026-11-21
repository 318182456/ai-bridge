import {AppError} from '../common.mjs';
import {parse} from './studio-wire.mjs';
const rpcStates={3:'INVALID_ARGUMENT',4:'DEADLINE_EXCEEDED',5:'NOT_FOUND',7:'PERMISSION_DENIED',8:'RESOURCE_EXHAUSTED',9:'FAILED_PRECONDITION',13:'INTERNAL',14:'UNAVAILABLE',16:'UNAUTHENTICATED'};
const states=new Set(['INVALID_ARGUMENT','UNAUTHENTICATED','PERMISSION_DENIED','FAILED_PRECONDITION','RESOURCE_EXHAUSTED','NOT_FOUND','UNAVAILABLE','INTERNAL','DEADLINE_EXCEEDED']);
async function boundedText(response){
 if(typeof response.body==='function'){
  const length=Number(await response.headerValue?.('content-length'));if(length>65536)return '';
  let timer;try{const bytes=await Promise.race([response.body(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),5000);})]);return bytes.length<=65536?bytes.toString('utf8'):'';}catch{return '';}finally{clearTimeout(timer);}
 }
 if(!response.body?.getReader)return '';
 const reader=response.body.getReader(),parts=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel().catch(()=>{});return '';}parts.push(value);}return Buffer.concat(parts).toString('utf8');}catch{return '';}finally{reader.releaseLock();}
}
// ASVS V16.5.1: classify known upstream failures; never reflect response HTML, tokens or request contents.
export async function studioFailure(response){
 const code=typeof response.status==='function'?response.status():response.status;
 const status=Number.isInteger(code)&&code>=400&&code<=599?code:502;
 const raw=await boundedText(response);let error;
 const unwrap=value=>{
  if(value&&typeof value==='object'&&!Array.isArray(value))return value.error&&typeof value.error==='object'?value.error:value;
  if(!Array.isArray(value))return null;
  if(Number.isInteger(value[0])&&rpcStates[value[0]]&&typeof value[1]==='string')return{message:value[1],status:rpcStates[value[0]]};
  // Recognize only the documented singleton wrapper or GenerateContent stream-tail status.
  const nested=value.length===1?value[0]:value[1];
  if(Array.isArray(nested)&&Number.isInteger(nested[0])&&rpcStates[nested[0]]&&typeof nested[1]==='string')return{message:nested[1],status:rpcStates[nested[0]]};
  return null;
 };
 let text=raw;
 try{error=unwrap(parse(text));}catch{}
 // Google can base64-wrap executable JSON responses. Decode only bounded, valid JSON.
 if(!error&&/^[A-Za-z0-9+/=\r\n]+$/.test(raw)&&raw.length>=8)try{const decoded=Buffer.from(raw.replace(/\s/g,''),'base64').toString('utf8');const value=unwrap(parse(decoded));if(value){error=value;text=decoded;}}catch{}
 const message=typeof error?.message==='string'?error.message:'';const state=states.has(error?.status)?error.status:null;
 let reason='上游没有返回可识别的错误原因';
 if(/disabled.*(?:terms|violation)|violation of terms/i.test(message))reason='Google 已限制该账号的服务权限';
 else if(/(?:location|region).*not supported|unsupported.*(?:region|location)|not available.*(?:country|region)/i.test(message))reason='Google 拒绝当前账号或出口地区';
 else if(/captcha|bot|unusual traffic|automated|proof|challenge/i.test(message)||/<html/i.test(text)&&[403,429].includes(status))reason='Google 要求额外验证或拒绝当前请求环境';
 else if(/account.*not supported/i.test(message))reason='Google 不支持当前账号使用 AI Studio';
 else if(/billing|payment|paid tier|credits/i.test(message))reason='该模型需要计费权限或可用额度';
 else if(status===401||state==='UNAUTHENTICATED')reason='Google 登录会话无效或已过期';
 else if(status===429||state==='RESOURCE_EXHAUSTED')reason='Google 请求频率或账号额度已达到限制';
 else if(status===404||state==='NOT_FOUND')reason='当前账号无法使用所选模型或接口';
 else if(/permission|access denied|not authorized/i.test(message)||state==='PERMISSION_DENIED')reason=message==='The caller does not have permission'?'Google 拒绝当前会话的生成请求（The caller does not have permission）':'Google 拒绝当前会话的生成请求';
 else if(state==='FAILED_PRECONDITION')reason='当前账号或请求未满足 Google 的生成前置条件';
 else if(status===400||state==='INVALID_ARGUMENT'){
  const field=message.match(/Unknown name ["']([A-Za-z][A-Za-z0-9_]{0,60})["']/)?.[1];
  reason=field?'Google 不接受请求字段 '+field:'生成请求参数不符合 Google 当前协议';
 }else if(status>=500)reason='Google 上游服务暂时不可用';
 return new AppError(status,'AI Studio 拒绝生成请求（HTTP '+status+(state?' / '+state:'')+'）：'+reason,'studio_request_failed');
}
