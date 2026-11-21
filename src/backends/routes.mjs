import {once} from "node:events";
import {AppError} from "../common.mjs";
// A bounded inspector keeps usage metadata without retaining response bodies.
export class UsageInspector {
  constructor(stream){this.stream=stream;this.text="";this.decoder=new TextDecoder();this.total=null;this.error=false;this.discardLine=false;this.truncated=false;}
  object(value){if(value?.ai_bridge?.account_id)this.accountId=value.ai_bridge.account_id;if(value?.error)this.error=true;const n=value?.usage?.total_tokens;if(Number.isSafeInteger(n)&&n>=0)this.total=n;}
  line(line){if(line.startsWith("data:")){try{this.object(JSON.parse(line.slice(5).trim()));}catch{}}}
  push(bytes){const text=this.decoder.decode(bytes,{stream:true});if(!this.stream){if(this.text.length+text.length<=1024*1024)this.text+=text;else{this.truncated=true;this.text="";}return;}
    for(const part of text.split(/(?<=\n)/)){if(this.discardLine){if(part.endsWith("\n"))this.discardLine=false;continue;}if(this.text.length+part.length>1024*1024){this.text="";this.discardLine=!part.endsWith("\n");continue;}this.text+=part;if(part.endsWith("\n")){this.line(this.text);this.text="";}}
  }
  finish(){this.text+=this.decoder.decode();if(this.stream){if(!this.discardLine)this.line(this.text);}else if(!this.truncated){try{this.object(JSON.parse(this.text));}catch{}}}
}
export function registerAIStudio({register,body,send,backends,queue,store,logger},id="aist"){
  const label=id==="aist"?"AI Studio":"Robin";
  register("GET","/"+id+"/v1/models","api",async({res,signal})=>{
    const backend=backends.get(id),{response,release}=await backend.open("/v1/models",{signal});
    try{if(!response.ok)throw new AppError(response.status,label+" 模型目录查询失败","backend_models_failed");const text=await limitedText(response,2*1024*1024);let data;try{data=JSON.parse(text);}catch{throw new AppError(502,label+" 模型目录格式无效");}send(res,data);}finally{await response.body?.cancel().catch(()=>{});release();}
  });
  async function chat({req,res,signal,principal,requestId},input){
    const started=Date.now();
    const existing=req.trace;
    const context=req.trace=existing||{id:requestId,key_id:principal.key_id,key_name:principal.key_name,stage:"request_prepare",started};
    context.model=typeof input.model==="string"?input.model.slice(0,160):"未提供模型";
    if(!existing)store.beginKeyRequest(principal.key_id);
    const backend=backends.get(id);context.backend=id;store.beginBackendRequest(id);
    if(typeof input.model!=="string"||input.model.length>160||!Array.isArray(input.messages)||!input.messages.length)throw new AppError(400,"请提供模型名称和 messages");
    if(input.session_id!=null)throw new AppError(400,"此后端暂不支持 CLI session_id","unsupported_parameter");
    if(input.stream!=null&&typeof input.stream!=="boolean")throw new AppError(400,"stream 必须为布尔值");
    const {backend:selector,...payload}=input;
    const account=await backend.selectAccount?.(payload);if(account)payload.account_id=account;
    context.account_id=account||null;
    // ASVS 8.3.1: attribution comes from the selected server-side account, never from client-supplied labels.
    const identity=account?await backend.accountIdentity?.(account):null;
    context.account_name=identity?.name||null;context.stage="queue";
    let heartbeat;
    if(input.stream){
      res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform","x-accel-buffering":"no","x-ai-bridge-backend":id,"x-stream-mode":"buffered"});
      res.write(": waiting\n\n");
      heartbeat=setInterval(()=>{if(!res.destroyed&&!res.writableEnded&&res.writableLength<65536)res.write(": waiting\n\n");},15000);heartbeat.unref?.();
    }
    try{return await queue.add(async jobSignal=>{
      store.assertKeyActive(principal.key_id);context.stage="generation";logger.info("request.started",{request_id:requestId,account_id:account||null,account_name:context.account_name,stage:id,model:input.model});
      const {response,release}=await backend.open("/v1/chat/completions",{signal:jobSignal,method:"POST",json:payload});
      let completed=false;const usage=new UsageInspector(input.stream===true);
      try{
        // Only protocol headers pass through. Never expose backend cookies or credentials.
        if(input.stream&&!response.ok)throw new AppError(response.status,label+" 拒绝生成请求","backend_request_failed");
        if(!res.headersSent)res.writeHead(response.status,{"content-type":input.stream?"text/event-stream; charset=utf-8":"application/json; charset=utf-8","x-accel-buffering":"no","x-ai-bridge-backend":id,...(response.headers.get("x-stream-mode")?{"x-stream-mode":response.headers.get("x-stream-mode")}:{})});
        for await(const bytes of response.body){if(jobSignal.aborted)throw new AppError(499,"请求已取消","cancelled");usage.push(bytes);if(!res.write(bytes))await once(res,"drain",{signal:jobSignal});}
        usage.finish();completed=response.ok&&!usage.error;res.end();
      }finally{
        await response.body?.cancel().catch(()=>{});release();
        store.endKeyRequest(principal.key_id,completed,completed?usage.total:null);store.endBackendRequest(id,completed,completed?usage.total:null);context.outcome=true;
        const actualAccount=account||usage.accountId||null;
        const actualIdentity=!identity&&actualAccount?await backend.accountIdentity?.(actualAccount):identity;
        context.account_usage_recorded=true;if(actualAccount)await backend.recordUsage?.(actualAccount,completed,completed?usage.total:null);
        await store.event({id:requestId,api_key_id:principal.key_id,api_key_name:principal.key_name,account_id:actualAccount,account_name:actualIdentity?.name||label+"（内置后端）",backend:id,model:input.model,status:completed?response.status:response.ok?502:response.status,stage:completed?"completed":"generation",total_tokens:completed?usage.total:null,duration_ms:Date.now()-started});context.recorded=true;
        logger[completed?"info":"warn"](completed?"request.completed":"request.failed",{request_id:requestId,account_id:actualAccount,account_name:actualIdentity?.name||null,stage:id,status:completed?200:response.ok?502:response.status,duration_ms:Date.now()-started});
      }
    },signal,{id:requestId,sharedKey:account||null,resource:account?null:"backend:"+id,cancelable:true,metadata:{account_id:account||null,resource_name:id==="aist"?"AI Studio 浏览器":"Robin 当前请求",kind:"generation",source:"api",account_name:context.account_name||label,model:input.model,api_key_name:principal.key_name,summary:label+" 模型调用",content:JSON.stringify(payload.messages)}});}catch(error){if(account&&!context.account_usage_recorded){context.account_usage_recorded=true;await backend.recordUsage?.(account,false);}throw error;}finally{clearInterval(heartbeat);}
  }
  register("POST","/"+id+"/v1/chat/completions","api",async ctx=>chat(ctx,await body(ctx.req)));
  return chat;
}
async function limitedText(response,limit){let size=0;const parts=[];for await(const bytes of response.body){size+=bytes.length;if(size>limit)throw new AppError(502,"后端目录过大");parts.push(bytes);}return Buffer.concat(parts).toString("utf8");}
