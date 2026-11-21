import {randomUUID} from "node:crypto";
import {AppError} from "../common.mjs";
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);resolve();};const abort=()=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);reject(new AppError(499,"登录已取消","cancelled"));};const timer=setTimeout(done,ms);signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();});
export class BackendAccounts {
  constructor({backends,queue,sessions,logger}){Object.assign(this,{backends,queue,sessions,logger});this.login=null;}
  view(owner){const job=this.login;if(!job||job.owner!==owner)throw new AppError(404,"当前登录没有进行中的后端授权","login_not_found");return{id:job.id,state:job.state,view:job.remoteView||null,account_id:job.account||null,target:job.target,items:job.items||[],error:job.error||null};}
  start(owner,account,target="aist"){
    if(this.login&&["waiting","running"].includes(this.login.state))throw new AppError(409,"已有 Google 登录任务，请先完成或取消");
    const job=this.login={id:randomUUID(),view:randomUUID(),owner,state:"waiting",controller:new AbortController(),account,target};
    this.queue.add(async signal=>{
      const backend=this.backends.get("aist");job.state="running";
      try{
        const path=account?"/api/accounts/"+encodeURIComponent(account)+"/login":"/api/accounts";
        const data=await backend.admin(path,{method:"POST",json:{view:job.view,owner,target,...(!account?{locale:"zh-CN",timezone:"Asia/Shanghai",proxy:""}:{})},signal});
        job.remoteId=data.task?.id;job.remoteView=data.task?.view;
        if(!job.remoteId||job.remoteView!==job.view)throw new AppError(502,"后端未创建可用的登录窗口","backend_login_failed");
        const end=Date.now()+10*60000;
        while(Date.now()<end){
          const result=await backend.admin("/api/accounts/tasks",{signal});
          const task=result.tasks?.find(t=>t.id===job.remoteId);if(!task)throw new AppError(502,"后端登录任务已丢失","backend_login_failed");
          job.items=(task.items||[]).map(i=>({label:i.label||"",state:i.state,step:i.step||""}));
          if(task.state==="done"){job.state="done";return;}
          if(task.state==="failed")throw new AppError(task.error?.status||400,task.error?.message||"Google 登录或 AI Studio 验证未通过，请重试",task.error?.code||"backend_login_failed");
          await sleep(1000,signal);
        }
        throw new AppError(408,"Google 登录超过十分钟，请重新开始","backend_login_timeout");
      }finally{
        if(job.remoteId&&job.state!=="done")await backend.admin("/api/accounts/tasks/"+encodeURIComponent(job.remoteId),{method:"DELETE"}).catch(()=>{});
        job.remoteView=null;
      }
    },job.controller.signal,{id:job.id,key:account||null,lane:"login",cancelable:true,metadata:{kind:"login",account_name:target==="robin"?"Google / Robin":"Google / AI Studio",summary:target==="robin"?"Robin 独立授权":"Google 浏览器授权"}}).catch(error=>{job.state=error.code==="cancelled"?"cancelled":"failed";job.error=error instanceof AppError?error.message:"后端授权失败";}).finally(()=>{this.logger?.info("backend.login_finished",{stage:"aist",code:job.state});});
    return this.view(owner);
  }
  authorizeView(owner,view){const job=this.login;if(!job||job.owner!==owner||job.remoteView!==view||job.state!=="running")throw new AppError(404,"登录窗口不属于当前会话","login_not_found");}
  cancel(owner){const j=this.login;if(!j||j.owner!==owner)throw new AppError(404,"当前没有此登录任务");j.controller.abort();return{cancelled:true};}
  closeOwner(owner){if(this.login?.owner===owner)this.login.controller.abort();}
  close(){this.login?.controller.abort();}
}
export function registerBackendAccounts({register,send,body,backends,accounts,owner}){
  register("GET","/api/backends/aist/accounts","read",async({res,signal})=>send(res,await backends.get("aist").admin("/api/accounts",{signal})));
  register("GET","/api/backends/aist/status","read",async({res,signal})=>send(res,await backends.get("aist").admin("/api/status",{signal})));
  register("GET","/api/backends/aist/models","read",async({res,signal})=>send(res,await backends.get("aist").admin("/api/models",{signal})));
  register("POST","/api/backends/aist/login","mutation",async({req,res,principal})=>{const input=await body(req);if(input.account_id!=null&&(typeof input.account_id!=="string"||input.account_id.length>256))throw new AppError(400,"账号无效");const target=input.target??"aist";if(!["aist","robin"].includes(target)||Object.keys(input).some(k=>!["target","account_id"].includes(k)))throw new AppError(400,"授权目标无效");if(target==="robin"&&!input.account_id)throw new AppError(400,"请先选择已有 Google 账号");send(res,accounts.start(owner(principal),input.account_id||null,target),202);});
  register("GET","/api/backends/aist/login","read",async({res,principal})=>send(res,accounts.view(owner(principal))));
  register("DELETE","/api/backends/aist/login","mutation",async({res,principal})=>send(res,accounts.cancel(owner(principal))));
  register("PATCH",/^\/api\/backends\/aist\/accounts\/([^/]{1,768})$/,"mutation",async({req,res,match,signal})=>{const input=await body(req);if(typeof input.enabled!=="boolean"||Object.keys(input).some(k=>!["enabled","backend"].includes(k))||input.backend!=null&&!["aist","robin"].includes(input.backend))throw new AppError(400,"仅支持切换账号启用状态");const backend=backends.get("aist"),data=await backend.admin("/api/accounts",{signal});const a=data.accounts?.find(x=>x.id===decodeURIComponent(match[1]));if(!a)throw new AppError(404,"账号不存在");send(res,await backend.admin("/api/accounts/"+encodeURIComponent(a.id),{method:"PUT",json:{label:a.label,enabled:input.enabled,backend:input.backend},signal}));});
}
