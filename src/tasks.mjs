import {AppError} from "./common.mjs";
const missing=()=>new AppError(404,"任务结果已过期或不属于当前登录","task_not_found");
export class Tasks {
  constructor({queue,ttl=15*60000,maxBytes=32*1024*1024}){Object.assign(this,{queue,ttl,maxBytes});this.entries=new Map();}
  prune(){
    let bytes=0;const finished=[];
    for(const e of this.entries.values())if(e.finished){if(Date.now()-e.finished>this.ttl)this.entries.delete(e.id);else{bytes+=e.bytes;finished.push(e);}}
    for(const e of finished.sort((a,b)=>a.finished-b.finished))if(bytes>this.maxBytes||this.entries.size>128){this.entries.delete(e.id);bytes-=e.bytes;}
  }
  start(id,owner,input,run){
    this.prune();
    if(this.entries.size>=128){for(const e of [...this.entries.values()].filter(e=>e.finished).sort((a,b)=>a.finished-b.finished)){this.entries.delete(e.id);if(this.entries.size<128)break;}}
    if(this.entries.size>=128)throw new AppError(429,"后台任务已满，请等待正在执行的任务结束");
    const entry={id,owner,input,created:Date.now(),state:"pending",controller:new AbortController()};this.entries.set(id,entry);
    Promise.resolve().then(()=>run(entry.controller.signal)).then(result=>{entry.state="completed";entry.result=result;},error=>{
      entry.state=error.code==="cancelled"?"cancelled":"failed";
      entry.error={message:error instanceof AppError?error.message:"内部执行失败",code:error.code||"internal_error",status:error.status||500,request_id:id};
    }).finally(()=>{entry.finished=Date.now();entry.bytes=Buffer.byteLength(JSON.stringify({input:entry.input,result:entry.result,error:entry.error}));this.prune();});
    return this.view(id,owner);
  }
  entry(id,owner){this.prune();const e=this.entries.get(id);if(!e||e.owner!==owner)throw missing();return e;}
  view(id,owner){const e=this.entry(id,owner);let job;try{job=this.queue.get(id);}catch{}
    return{id,request_id:id,state:job?.state||e.state,queue:job?{position:job.position,reason:job.reason,waiting_ms:job.waiting_ms,execution_ms:job.execution_ms}:null,
      created_at:new Date(e.created).toISOString(),finished_at:e.finished?new Date(e.finished).toISOString():null,input:e.input,result:e.result,error:e.error};}
  list(owner){this.prune();return[...this.entries.values()].filter(e=>e.owner===owner).reverse().map(e=>({id:e.id,state:e.state,created_at:new Date(e.created).toISOString()}));}
  cancel(id,owner){const e=this.entry(id,owner);if(e.finished)throw new AppError(409,"任务已经结束");e.controller.abort();return{cancelled:true};}
  closeOwner(owner){for(const e of this.entries.values())if(e.owner===owner&&!e.finished)e.controller.abort();}
  close(){for(const e of this.entries.values())e.controller.abort();this.entries.clear();}
}
export function registerTasks({register,send,tasks,owner}){
  register("GET","/api/tasks","read",async({res,principal})=>send(res,{items:tasks.list(owner(principal))}));
  register("GET",/^\/api\/tasks\/([a-f0-9-]{36})$/,"read",async({res,principal,match})=>send(res,tasks.view(match[1],owner(principal))));
  register("DELETE",/^\/api\/tasks\/([a-f0-9-]{36})$/,"mutation",async({res,principal,match})=>send(res,tasks.cancel(match[1],owner(principal))));
}
