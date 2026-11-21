import {backendEnabled} from './account-state.mjs';
import {GoogleAccounts} from "./google-store.mjs";
import {randomUUID} from "node:crypto";
import {join} from "node:path";
import {RobinRPC} from "./robin-rpc.mjs";
import {message,decodeModes,queryFrames,decodeAnswer} from "./robin-wire.mjs";
import {prepareChat,toolMessage} from "../chat.mjs";
import {AppError} from "../common.mjs";
// Native in-process implementation. No sidecar server, vendored service or localhost HTTP.
export class Robin {
 constructor({dataDir,logger,rpc=new RobinRPC(),tokenProvider,accounts=new GoogleAccounts(dataDir)}={}){Object.assign(this,{dir:join(dataDir,"backends","robin"),logger,rpc,tokenProvider,registry:accounts});this.cursor=0;this.active=0;this.conversations=new Map();this.cache=new Map();}
 status(){return{id:"robin",state:this.active?"ready":"managed",active_requests:this.active,resident_processes:0};}
 async catalogEntries(){return(await this.registry.list()).flatMap(a=>(a.robin_models||[]).map(model=>({model,account:{id:a.id,name:a.email},available:backendEnabled(a,"robin")&&["verified","authenticated"].includes(a.grants?.robin),checked_at:a.checked_at})));}
 async accountIdentity(id){const a=await this.registry.get(id);return{id:a.id,name:a.email};}
 async recordUsage(id,success,tokens){await this.registry.recordUsage(id,"robin",success,tokens);}
 async accounts(){return(await this.registry.list()).map(a=>({...a,state:a.grants?.robin==="verified"?"ready":a.grants?.robin||"not_authorized"}));}
 async save(accounts){for(const account of accounts){const current=await this.registry.get(account.id);current.enabled=account.enabled;if(account.state==="needs_conversation_cleanup")current.grants.robin="needs_conversation_cleanup";await this.registry.put(current);}}
 async verify(account,signal){const models=await this.modes(account,signal),model=models.find(m=>/flash/i.test(m.id))||models[0];if(!model)throw new AppError(503,"Robin 没有可验证模型");const result=await this.execute("/v1/chat/completions",{json:{model:model.id,messages:[{role:"user",content:"Reply with OK only."}]},signal,verificationAccount:account});const response=await result.response.json();if(!response.choices?.[0]?.message?.content)throw new AppError(502,"Robin 生成校验未返回正文");account.robin_models=models;account.grants.robin="verified";await this.registry.put(account);}
 async selectAccount(input){const all=(await this.accounts()).filter(a=>backendEnabled(a,"robin")&&["verified","authenticated"].includes(a.grants?.robin)&&(!input.account_id||input.account_id===a.id));const base=input.model.replace(/-(?:low|medium|high)$/,"");const accounts=all.filter(a=>!a.robin_models?.length||(a.robin_models||[]).some(m=>m.id===input.model||m.id===base));if(!accounts.length)throw new AppError(503,"没有支持此模型的已验证 Robin 账号","no_eligible_account");return accounts[input.account_id?0:this.cursor++%accounts.length].id;}
 async open(path,options){return this.execute(path,options);}
 async token(account){if(!this.tokenProvider)throw new AppError(401,"请完成 Google / Robin 授权","backend_auth_required");return this.tokenProvider(account.id);}
 async modes(account,signal){const cache=this.cache.get(account.id);if(cache&&Date.now()-cache.at<300000)return cache.models;const token=await this.token(account);let models=[];for await(const frame of this.rpc.call("GetUserStatus",[{data:message([[1,message([[4,2]])]])}],{token,signal}))models.push(...decodeModes(frame));if(!models.length)throw new AppError(503,"Robin 未返回账号实时模型目录","backend_models_failed");this.cache.set(account.id,{at:Date.now(),models});account.robin_models=models;account.catalog_updated_at={...account.catalog_updated_at,robin:new Date().toISOString()};await this.registry.put(account);return models;}
 async execute(path,{signal,json:input,verificationAccount}={}){
  const accounts=verificationAccount?[verificationAccount]:(await this.accounts()).filter(a=>backendEnabled(a,"robin")&&["verified","authenticated"].includes(a.grants?.robin));if(!accounts.length)throw new AppError(401,"请先完成 Google / Robin 授权","backend_auth_required");
  if(path==="/v1/models"){const all=new Map();for(const account of accounts)for(const m of await this.modes(account,signal))all.set(m.id,{id:m.id,object:"model",owned_by:"robin"});return{response:Response.json({object:"list",data:[...all.values()]}),release:()=>{}};}
  if(path!=="/v1/chat/completions")throw new AppError(400,"不支持此 Robin 接口");
  const parsed=prepareChat(input,value=>value);if(input.reasoning_effort&&!['low','medium','high'].includes(input.reasoning_effort))throw new AppError(400,"Robin 支持 low、medium、high 思考强度","unsupported_parameter");
  const account=input.account_id?accounts.find(a=>a.id===input.account_id):accounts[this.cursor++%accounts.length];if(!account)throw new AppError(404,"指定 Robin 账号不可用","no_eligible_account");
  const owner=Symbol();this.active++;
  let conversation="",cleaned=false,submitted=false;
  try{
   const models=await this.modes(account,signal),base=input.model.replace(/-(?:low|medium|high)$/,""),model=models.find(m=>m.id===input.model||m.id===base);if(!model)throw new AppError(404,"Robin 账号不支持此模型","model_not_found");
   const token=await this.token(account),shards=new Map();let confirmed=false;submitted=true;
   for await(const frame of this.rpc.call("ProcessQuery",queryFrames(parsed.prompt,model.mode,{low:1,medium:4,high:2}[input.reasoning_effort]),{token,signal,bidi:true})){
    const answer=decodeAnswer(frame);if(answer.conversation){if(this.conversations.has(answer.conversation)&&this.conversations.get(answer.conversation)!==owner)throw new AppError(502,"Robin 返回了另一请求正在使用的会话","backend_isolation_failed");if(conversation&&conversation!==answer.conversation)throw new AppError(502,"Robin 在生成中切换了会话","backend_isolation_failed");conversation=answer.conversation;this.conversations.set(conversation,owner);}
    if(answer.effectiveMode&&answer.effectiveMode!==model.mode)throw new AppError(502,"Robin 上游切换了请求的模型，已拒绝冒充原模型返回","backend_model_changed");
    for(const part of answer.shards)if(part.text)shards.set(part.id||"default",part.text);
    if([...shards.values()].join("").length>8*1024*1024)throw new AppError(502,"Robin 响应过大");
    if(answer.done){confirmed=true;break;}
   }
   const text=[...shards.values()].join("");if(!text.trim())throw new AppError(502,"Robin 返回空响应","backend_response_empty");
   const assistant=toolMessage({response:text},parsed.tooling);const payload={id:"chatcmpl-"+randomUUID(),object:"chat.completion",created:Math.floor(Date.now()/1000),model:input.model,choices:[{index:0,message:assistant,finish_reason:assistant.tool_calls?.length?"tool_calls":"stop"}],ai_bridge:{backend:"robin",account_id:account.id,completion_confirmed:confirmed,usage_source:"not_reported",ignored_parameters:parsed.ignoredParameters,tool_mode:parsed.tooling?"prompt-emulated":null}};
   if(!conversation)throw new AppError(502,"Robin 缺少会话标识，无法确认上下文隔离","backend_isolation_failed");
   for await(const _ of this.rpc.call("DeleteConversation",[{data:message([[1,conversation],[2,message([[4,2]])]])}],{token})){}cleaned=true;
   if(!verificationAccount&&account.grants?.robin==="authenticated"){account.grants.robin="verified";account.state="ready";account.checked_at=new Date().toISOString();await this.registry.put(account);}
   if(input.stream){const chunk={...payload,object:"chat.completion.chunk",choices:[{index:0,delta:assistant,finish_reason:null}]};const finish={...payload,object:"chat.completion.chunk",choices:[{index:0,delta:{},finish_reason:payload.choices[0].finish_reason}]};return{response:new Response("data: "+JSON.stringify(chunk)+"\n\ndata: "+JSON.stringify(finish)+"\n\ndata: [DONE]\n\n",{headers:{"content-type":"text/event-stream","x-stream-mode":"buffered"}}),release:()=>{}};}
   return{response:Response.json(payload),release:()=>{}};
  }finally{
   if(conversation&&!cleaned){try{const token=await this.token(account);for await(const _ of this.rpc.call("DeleteConversation",[{data:message([[1,conversation],[2,message([[4,2]])]])}],{token})){}cleaned=true;}catch{}}
   try{if(submitted&&!cleaned){account.enabled=false;account.state="needs_conversation_cleanup";await this.save([account]);}}finally{if(this.conversations.get(conversation)===owner)this.conversations.delete(conversation);this.active--;}
  }
 }
 async close(){this.rpc.close();}
}
