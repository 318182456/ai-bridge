import {backendEnabled} from './account-state.mjs';
import {BrowserEngine} from "./browser-engine.mjs";
import {AppError} from "../common.mjs";
import {toStudioRequest,StudioChat} from "./aist-protocol.mjs";
export class AIStudio {
 constructor({dataDir,logger,engine}={}){this.engine=engine||new BrowserEngine({root:dataDir,logger});this.logger=logger;this.active=0;}
 status(){return{id:"aist",state:this.active?"ready":"managed",active_requests:this.active,resident_processes:0};}
 async catalogEntries(){return(await this.engine.accounts?.list()||[]).flatMap(a=>(a.models||[]).map(model=>({model,account:{id:a.id,name:a.email},available:backendEnabled(a,"aist")&&["verified","authenticated","synced"].includes(a.grants?.aist),checked_at:a.checked_at})));}
 async accountIdentity(id){const a=await this.engine.accounts.get(id);return{id:a.id,name:a.email};}
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
  if(method==="PUT"&&/^\/api\/accounts\/[^/]+$/.test(path))return this.result("set_enabled",{id:decodeURIComponent(path.split("/").at(-1)),enabled:input.enabled,backend:input.backend},signal);
  throw new AppError(400,"不支持此 AI Studio 操作");
 }
 async close(){await this.engine.close();}
}
