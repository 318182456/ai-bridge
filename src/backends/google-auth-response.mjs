import {AppError} from '../common.mjs';
// ASVS 16.5.1: classify only known protocol errors; never expose response bodies, URLs or tokens.
export function authResponse(status,body){
 const fields=Object.create(null);for(const line of String(body).split(/\r?\n/)){const i=line.indexOf('=');if(i>0)fields[line.slice(0,i)]=line.slice(i+1);}
 const known={BadAuthentication:['google_auth_bad_authentication','Google 未接受该授权凭据，可能已过期、已使用或不适用于此次交换；请重新完成 Google 授权后同步'],NeedsBrowser:['google_auth_needs_browser','Google 要求在官方页面完成额外确认，请完成账号安全验证后重新授权'],CaptchaRequired:['google_auth_captcha','Google 要求在官方页面完成人机验证，请完成后重新授权'],AccountDisabled:['google_auth_account_disabled','Google 返回账号已停用，请在官方账号页面确认状态'],ServiceDisabled:['google_auth_service_disabled','Google 未为此账号启用该授权服务'],TermsNotAgreed:['google_auth_terms_required','请先在 Google 官方授权页确认服务条款后再同步'],DeviceManagementRequired:['google_auth_device_management','Google 要求完成组织设备管理验证，请联系账号管理员']};
 if(status===429||status>=500)throw new AppError(status===429?429:503,'Google 授权服务暂不可用，请稍后重试','google_auth_unavailable');
 if(known[fields.Error]){const [code,message]=known[fields.Error];throw new AppError(401,message,code);}
 if(status!==200||fields.Error)throw new AppError(401,'Google 拒绝授权交换（HTTP '+status+'）；未返回可识别的错误类别，请重新完成官方授权','google_auth_failed');
 return fields;
}
