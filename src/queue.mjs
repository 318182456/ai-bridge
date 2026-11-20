import {randomUUID} from "node:crypto";
import {AppError} from "./common.mjs";
const cancelled=()=>new AppError(499,"请求已取消","cancelled");
const bounded=(value,max=160)=>typeof value==="string"?value.slice(0,max):null;
export class SerialQueue {
  constructor(limit=32,concurrency=1){
    if(!Number.isInteger(limit)||limit<1||limit>1000||!Number.isInteger(concurrency)||concurrency<1||concurrency>16)throw Error("QUEUE_LIMIT must be 1–1000 and MAX_CONCURRENCY 1–16");
    Object.assign(this,{limit,concurrency});this.waiting=[];this.running=0;this.activeKeys=new Set();this.activeResources=new Set();this.exclusive=false;this.jobs=new Map();
  }
  get activeAccount(){return this.activeKeys.values().next().value||null;}
  add(action,signal,{key=null,resource=null,exclusive=false,id=randomUUID(),metadata={},cancelable=false,onCancel=null,checkCancelable=null}={}){
    if(signal?.aborted)return Promise.reject(cancelled());
    if(this.waiting.length>=this.limit)return Promise.reject(new AppError(429,"任务队列已满，请稍后重试","queue_full"));
    if(this.jobs.has(id))return Promise.reject(new AppError(409,"请求已在执行队列中","duplicate_job"));
    return new Promise((resolve,reject)=>{
      const controller=new AbortController();
      const job={id,action,resolve,reject,key,resource,exclusive,controller,cancelable,onCancel,checkCancelable,created:Date.now(),started:null,state:"waiting",
        metadata:{kind:bounded(metadata.kind),account_id:key,resource_name:bounded(metadata.resource_name),account_name:bounded(metadata.account_name),model:bounded(metadata.model),source:bounded(metadata.source),api_key_name:bounded(metadata.api_key_name),summary:bounded(metadata.summary,320),content:bounded(metadata.content,512*1024)}};
      job.unlink=()=>signal?.removeEventListener("abort",job.externalAbort);
      job.abort=()=>{
        const index=this.waiting.indexOf(job);
        if(index>=0){this.waiting.splice(index,1);this.jobs.delete(id);job.unlink();reject(cancelled());this.drain();}
      };
      job.externalAbort=()=>controller.abort();
      controller.signal.addEventListener("abort",job.abort,{once:true});
      signal?.addEventListener("abort",job.externalAbort,{once:true});
      this.jobs.set(id,job);this.waiting.push(job);this.drain();
    });
  }
  drain(){
    while(!this.exclusive&&this.running<this.concurrency&&this.waiting.length){
      let index=-1;
      for(let i=0;i<this.waiting.length;i++){const job=this.waiting[i];if(job.exclusive){if(i===0&&this.running===0)index=i;break;}if((!job.key||!this.activeKeys.has(job.key))&&(!job.resource||!this.activeResources.has(job.resource))){index=i;break;}}
      if(index<0)return;
      const [job]=this.waiting.splice(index,1);
      if(job.controller.signal.aborted){this.jobs.delete(job.id);job.unlink();job.reject(cancelled());continue;}
      this.running++;if(job.resource)this.activeResources.add(job.resource);if(job.key)this.activeKeys.add(job.key);if(job.exclusive)this.exclusive=true;
      job.state="running";job.started=Date.now();
      const finish=()=>{this.jobs.delete(job.id);job.unlink();this.running--;if(job.resource)this.activeResources.delete(job.resource);if(job.key)this.activeKeys.delete(job.key);if(job.exclusive)this.exclusive=false;this.drain();};
      Promise.resolve().then(()=>job.action(job.controller.signal)).then(value=>{finish();job.resolve(value);},error=>{finish();job.reject(error);});
    }
  }
  reason(job){
    if(job.state!=="waiting")return job.controller.signal.aborted?"正在终止进程并回收资源":"正在执行";
    if(this.exclusive)return "等待登录或校验结束";
    const position=this.waiting.indexOf(job);
    if(this.waiting.slice(0,position).some(j=>j.exclusive))return "等待前方排他任务";
    if(job.exclusive&&this.running)return "等待在途任务结束（登录排他）";
    if(job.resource&&this.activeResources.has(job.resource))return "等待"+(job.metadata.resource_name||"后端共享资源");
    if(job.key&&this.activeKeys.has(job.key))return "等待该账号当前任务完成";
    if(this.running>=this.concurrency)return "等待全局并发位置";
    return "等待调度";
  }
  view(job,detail=false){
    const {content,...metadata}=job.metadata;
    return {id:job.id,...metadata,state:job.controller.signal.aborted?"cancelling":job.state,
      position:job.state==="waiting"?this.waiting.indexOf(job)+1:null,reason:this.reason(job),
      created_at:new Date(job.created).toISOString(),started_at:job.started?new Date(job.started).toISOString():null,
      waiting_ms:(job.started||Date.now())-job.created,execution_ms:job.started?Date.now()-job.started:0,
      can_cancel:!job.controller.signal.aborted&&(job.state==="waiting"||job.cancelable),...(detail?{content}: {})};
  }
  list(){return [...[...this.jobs.values()].filter(j=>j.state!=="waiting").sort((a,b)=>a.started-b.started),...this.waiting].map(j=>this.view(j));}
  get(id){const job=this.jobs.get(id);if(!job)throw new AppError(404,"任务已结束或不存在","job_not_found");return this.view(job,true);}
  async cancel(id){
    const job=this.jobs.get(id);if(!job)throw new AppError(404,"任务已结束或不存在","job_not_found");
    if(job.controller.signal.aborted)return this.view(job);
    if(job.state!=="waiting"&&!job.cancelable)throw new AppError(409,"该任务当前不能终止");
    job.checkCancelable?.();
    await job.onCancel?.();
    job.controller.abort();return {...this.view(job),state:job.state==="waiting"?"cancelled":"cancelling"};
  }
  promote(id){
    const job=this.jobs.get(id);if(!job)throw new AppError(404,"任务已结束或不存在","job_not_found");
    const index=this.waiting.indexOf(job);if(index<0)throw new AppError(409,"只可调整等待中的任务");
    this.waiting.splice(index,1);this.waiting.unshift(job);this.drain();return this.view(job);
  }
  get status(){return {running:this.running,waiting:this.waiting.length,limit:this.limit,concurrency:this.concurrency,exclusive:this.exclusive,active_account:this.activeAccount,active_accounts:[...this.activeKeys]};}
}
