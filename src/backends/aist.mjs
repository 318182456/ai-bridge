import {randomUUID} from "node:crypto";
import {BrowserEngine} from "./browser-engine.mjs";
import {AppError} from "../common.mjs";
import {toStudioRequest,StudioChat} from "./aist-protocol.mjs";
export class AIStudio {
 constructor({dataDir,logger,engine}={}){this.engine=engine||new BrowserEngine({root:dataDir,logger});this.logger=logger;this.tasks=new Map();this.active=0;}
 status(){return{id:"aist",state:this.active?"ready":"managed",active_requests:this.active,resident_processes:0};}
 async catalogEntries(){return(await this.engine.accounts?.list()||[]).flatMap(a=>(a.models||[]).map(model=>({model,account:{id:a.id,name:a.email},available:a.enabled&&a.grants?.aist==="verified",checked_at:a.checked_at})));}
 async recordUsage(id,success,tokens){await this.engine.accounts?.recordUsage(id,"aist",success,tokens);}
 async result(op,input,signal){let result={};for await(const event of this.engine.run(op,input,signal))if(event.result)result=event.result;return result;}
 async selectAccount(input){return this.engine.selectAccount?this.engine.selectAccount(input):input.account_id||null;}
 async open(path,{signal,json:input}={}){
  if(path==="/v1/models"){const result=await this.result("models",{},signal);return{response:Response.json({object:"list",data:(result.models||[]).map(m=>({id:m.id,object:"model",owned_by:"aist",capabilities:m.capabilities}))}),release:()=>{}};}
  if(path!=="/v1/chat/completions")throw new AppError(400,"不支持此 AI Studio 接口");
  const request=toStudioRequest(input),chat=new StudioChat(input.model,input.tools||[]);this.active++;
  if(!input.stream){try{for await(const message of this.engine.run("generate",request,signal))if(message.event)chat.accept(message.event);return{response:Response.json(chat.finish()),release:()=>{}};}finally{this.active--;}}
  const engine=this.engine;const backend=this;const encode=new TextEncoder();
  const iterable=(async function*(){try{for await(const message of engine.run("generate",request,signal)){if(!message.event)continue;for(const chunk of chat.accept(message.event))yield encode.encode("data: "+JSON.stringify(chunk)+"\n\n");}const result=chat.finish();yield encode.encode("data: "+JSON.stringify(chat.finalChunk(result))+"\n\n");yield encode.encode("data: [DONE]\n\n");}catch(e){yield encode.encode("data: "+JSON.stringify({error:{message:e instanceof AppError?e.message:"AI Studio 流中断",code:e.code||"native_stream_failed"}})+"\n\ndata: [DONE]\n\n");}finally{backend.active--;}})();
  return{response:new Response(new ReadableStream({async pull(c){const v=await iterable.next();if(v.done)c.close();else c.enqueue(v.value);},async cancel(){await iterable.return?.();}}),{headers:{"content-type":"text/event-stream","x-stream-mode":"buffered"}}),release:()=>{}};
 }
 async admin(path,{signal,method="GET",json:input={}}={}){
  if(method==="GET"&&path==="/api/accounts")return this.result("accounts",{},signal);
  if(method==="GET"&&path==="/api/models")return this.result("models",{},signal);
  if(method==="GET"&&path==="/api/status")return this.status();
  if(method==="GET"&&path==="/api/accounts/tasks")return{tasks:[...this.tasks.values()].map(t=>({id:t.id,view:t.view,state:t.state,items:t.items,error:t.error||null}))};
  if(method==="POST"&&(path==="/api/accounts"||/^\/api\/accounts\/[^/]+\/login$/.test(path))){
   if([...this.tasks.values()].some(t=>t.state==="running"))throw new AppError(409,"已有 Google 登录在进行");
   for(const [id,t]of this.tasks)if(t.state!=="running")this.tasks.delete(id);
   const task={id:randomUUID(),view:input.view,state:"running",items:[{state:"running",step:"login",label:""}],controller:new AbortController(),clients:new Set()};this.tasks.set(task.id,task);
   task.work=(async()=>{try{for await(const event of this.engine.run("login",{locale:input.locale||"zh-CN",timezone:input.timezone||"Asia/Shanghai",proxy:input.proxy||"",owner:input.owner,target:input.target||"aist",account_id:path!=="/api/accounts"?decodeURIComponent(path.split("/")[3]):null},task.controller.signal)){
      task.nativeId=event.native_job;
      if(event.browser_meta){task.lastMeta=event.browser_meta;if(event.browser_meta.type==="status")task.lastStatus=event.browser_meta;if(event.browser_meta.type==="frame")task.frameMeta=event.browser_meta;for(const client of task.clients)if(client.readyState===1&&client.bufferedAmount<1024*1024)client.send(JSON.stringify(event.browser_meta));}
      if(event.browser_binary){const bytes=Buffer.from(event.browser_binary,"base64");if(bytes.length<=1024*1024)task.lastFrame=bytes;for(const client of task.clients)if(client.readyState===1&&client.bufferedAmount<1024*1024)client.send(bytes,{binary:true});}
      if(event.result?.account){task.items=[{state:"done",label:event.result.account.email}];task.result=event.result;}
    }task.state="done";}catch(e){task.state="failed";task.error={status:e instanceof AppError?e.status:503,code:e.code||"native_login_failed",message:e instanceof AppError?e.message:"Google 登录未完成，请重试"};task.items=[{state:"failed",label:""}];this.logger?.warn("backend.login_failed",{stage:"aist",status:task.error.status,code:e.code||"native_login_failed"});}finally{for(const client of task.clients)client.close(1000);task.clients.clear();task.lastMeta=null;task.lastStatus=null;task.frameMeta=null;task.lastFrame=null;task.nativeId=null;}})();
   return{task:{id:task.id,view:task.view,state:task.state,items:task.items}};
  }
  if(method==="DELETE"&&path.startsWith("/api/accounts/tasks/")){const id=decodeURIComponent(path.split("/").at(-1));const task=this.tasks.get(id);task?.controller.abort();await task?.work;return{};}
  if(method==="PUT"&&/^\/api\/accounts\/[^/]+$/.test(path))return this.result("set_enabled",{id:decodeURIComponent(path.split("/").at(-1)),enabled:input.enabled},signal);
  throw new AppError(400,"不支持此 AI Studio 操作");
 }
 async loginSocket(view){const task=[...this.tasks.values()].find(t=>t.view===view&&t.state==="running");if(!task)throw new AppError(404,"登录窗口已结束");return{attach:socket=>{task.clients.add(socket);if(task.lastStatus)socket.send(JSON.stringify(task.lastStatus));if(task.lastMeta)socket.send(JSON.stringify(task.lastMeta));if(task.frameMeta&&task.lastFrame){socket.send(JSON.stringify(task.frameMeta));socket.send(task.lastFrame,{binary:true});}socket.on("message",(data,binary)=>{if(binary||!task.nativeId)return;let value;try{value=JSON.parse(data.toString());}catch{return;}if(["pointer","wheel","key","text","dialog","viewport","confirm","skip"].includes(value.type))this.engine.input(task.nativeId,value);});socket.once("close",()=>task.clients.delete(socket));},release:()=>{}};}
 async close(){for(const task of this.tasks.values())task.controller.abort();await Promise.allSettled([...this.tasks.values()].map(t=>t.work));await this.engine.close();}
}
