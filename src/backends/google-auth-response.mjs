import {AppError} from '../common.mjs';
// ASVS 16.5.1: classify only known protocol errors; never expose response bodies, URLs or tokens.
export function authResponse(status,body,{phase}={}){
 const fields=Object.create(null);for(const line of String(body).replace(/^\uFEFF/,'').split(/\r?\n/)){const i=line.indexOf('=');if(i>0)fields[line.slice(0,i).trim()]=line.slice(i+1).trim();}
 let json;try{json=JSON.parse(String(body));}catch{}
 const oauthError=typeof json?.error==='string'?json.error:json?.error?.status;
 const jsonKnown={invalid_grant:['google_auth_invalid_grant','Google 返回授权凭据失效或不适用于此请求'],invalid_scope:['google_auth_invalid_scope','Google 拒绝请求的授权范围，请检查 Robin 访问令牌配置'],invalid_request:['google_auth_invalid_request','Google 拒绝授权请求参数，请检查程序的请求格式'],INVALID_ARGUMENT:['google_auth_invalid_request','Google 拒绝授权请求参数，请检查程序的请求格式'],unauthorized_client:['google_auth_client_rejected','Google 未允许此授权客户端'],invalid_client:['google_auth_client_rejected','Google 未接受此授权客户端']};
 const prefix=phase==='master'?'Robin 首次凭据交换：':phase==='access'?'Robin 访问令牌获取：':'';
 if(status<500&&status!==429&&jsonKnown[oauthError]){const [code,message]=jsonKnown[oauthError];throw new AppError(401,prefix+message,code);}
 const known={BadAuthentication:['google_auth_bad_authentication','Google 未接受该授权凭据，可能已过期、已使用或不适用于此次交换；请重新完成 Google 授权后同步'],NeedsBrowser:['google_auth_needs_browser','Google 要求在官方页面完成额外确认，请完成账号安全验证后重新授权'],CaptchaRequired:['google_auth_captcha','Google 要求在官方页面完成人机验证，请完成后重新授权'],AccountDisabled:['google_auth_account_disabled','Google 返回账号已停用，请在官方账号页面确认状态'],ServiceDisabled:['google_auth_service_disabled','Google 未为此账号启用该授权服务'],TermsNotAgreed:['google_auth_terms_required','请先在 Google 官方授权页确认服务条款后再同步'],DeviceManagementRequired:['google_auth_device_management','Google 要求完成组织设备管理验证，请联系账号管理员']};
 if(status===429||status>=500)throw new AppError(status===429?429:503,'Google 授权服务暂不可用，请稍后重试','google_auth_unavailable');
 if(known[fields.Error]){const [code,message]=known[fields.Error];throw new AppError(401,prefix+message,code);}
 if(status!==200||fields.Error)throw new AppError(401,prefix+'Google 返回非标准授权响应（HTTP '+status+'），需要检查授权请求或网络；未能确认具体拒绝原因','google_auth_failed');
 return fields;
}
