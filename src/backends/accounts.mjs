import {AppError} from "../common.mjs";
export function registerBackendAccounts({register,send,body,backends}){
  register("GET","/api/backends/aist/accounts","read",async({res,signal})=>send(res,await backends.get("aist").admin("/api/accounts",{signal})));
  register("GET","/api/backends/aist/status","read",async({res,signal})=>send(res,await backends.get("aist").admin("/api/status",{signal})));
  register("GET","/api/backends/aist/models","read",async({res,signal})=>send(res,await backends.get("aist").admin("/api/models",{signal})));
  register("PATCH",/^\/api\/backends\/aist\/accounts\/([^/]{1,768})$/,"mutation",async({req,res,match,signal})=>{const input=await body(req);if(typeof input.enabled!=="boolean"||Object.keys(input).some(k=>!["enabled","backend"].includes(k))||input.backend!=null&&!["aist","robin"].includes(input.backend))throw new AppError(400,"仅支持切换账号启用状态");const backend=backends.get("aist"),data=await backend.admin("/api/accounts",{signal});const a=data.accounts?.find(x=>x.id===decodeURIComponent(match[1]));if(!a)throw new AppError(404,"账号不存在");send(res,await backend.admin("/api/accounts/"+encodeURIComponent(a.id),{method:"PUT",json:{label:a.label,enabled:input.enabled,backend:input.backend},signal}));});
}
