import {randomUUID} from "node:crypto";
import {AppError} from "../common.mjs";
const bad=message=>new AppError(400,message,"invalid_chat_request");
function textParts(content){
 if(content==null)return[];if(typeof content==="string")return[{text:content}];if(!Array.isArray(content))throw bad("消息内容必须为文本或内容数组");
 return content.map(part=>{
  if(["text","input_text"].includes(part?.type)&&typeof part.text==="string")return{text:part.text};
  if(part?.type==="image_url"){const url=typeof part.image_url==="string"?part.image_url:part.image_url?.url,m=/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url||"");if(!m)throw bad("Robin 图片请使用 base64 data URL");return{inlineData:{mimeType:m[1],data:m[2]}};}
  throw bad("不支持此消息内容类型");
 });
}
export function toGemini(input){
 if(!Array.isArray(input.messages)||!input.messages.length)throw bad("messages 不能为空");const contents=[],system=[],calls=new Map();
 for(const message of input.messages){
  if(!message||typeof message!=="object")throw bad("消息格式无效");
  if(["system","developer"].includes(message.role)){system.push(...textParts(message.content));continue;}
  if(message.role==="tool"){
   const name=calls.get(message.tool_call_id);if(!name)throw bad("工具结果缺少对应的工具调用");
   let result;try{result=JSON.parse(message.content);}catch{result={content:message.content};}
   contents.push({role:"user",parts:[{functionResponse:{name,response:{result}}}]});continue;
  }
  if(!["user","assistant"].includes(message.role))throw bad("不支持此消息角色");
  const parts=textParts(message.content);
  for(const call of message.tool_calls||[]){if(message.role!=="assistant"||typeof call?.function?.name!=="string"||typeof call.id!=="string")throw bad("工具调用格式无效");let args;try{args=JSON.parse(call.function.arguments);}catch{throw bad("工具参数必须为有效 JSON");}calls.set(call.id,call.function.name);parts.push({functionCall:{name:call.function.name,args}});}
  if(parts.length)contents.push({role:message.role==="assistant"?"model":"user",parts});
 }
 if(!contents.length)throw bad("至少需要一条用户或助手消息");
 const result={contents};if(system.length)result.systemInstruction={parts:system};
 if(input.tools?.length){result.tools=[{functionDeclarations:input.tools.map(tool=>{if(tool?.type!=="function"||typeof tool.function?.name!=="string")throw bad("仅支持 function 工具");return{name:tool.function.name,...(tool.function.description?{description:tool.function.description}:{}),parameters:tool.function.parameters??{type:"object",properties:{}}};})}];}
 const effort=input.reasoning_effort;if(effort!=null){if(!["low","medium","high"].includes(effort))throw bad("Robin reasoning_effort 支持 low、medium、high");result.generationConfig={thinkingConfig:{thinkingLevel:effort}};}
 if(input.tool_choice==="none")delete result.tools;else if(input.tool_choice!=null&&input.tool_choice!=="auto")throw bad("Robin 暂不支持强制工具选择");
 return result;
}
function assistant(parts){const message={role:"assistant",content:""},calls=[];let thinking="";
 for(const part of parts||[]){if(typeof part.text==="string"){if(part.thought)thinking+=part.text;else message.content+=part.text;}if(part.functionCall)calls.push({id:"call_"+randomUUID().replaceAll("-",""),type:"function",function:{name:part.functionCall.name,arguments:JSON.stringify(part.functionCall.args??{})}});}
 if(calls.length)message.tool_calls=calls;if(thinking)message.reasoning_content=thinking;return message;
}
export function fromGemini(value,model){
 if(value.error)throw new AppError(value.error.code||502,"Robin 生成失败","backend_generation_failed");
 const c=value.candidates?.[0];if(!c)throw new AppError(502,"Robin 没有返回候选内容","backend_response_invalid");
 const message=assistant(c.content?.parts);if(!message.content&&!message.tool_calls?.length)throw new AppError(502,"Robin 返回空响应","backend_response_empty");
 return{id:"chatcmpl-"+randomUUID(),object:"chat.completion",created:Math.floor(Date.now()/1000),model,choices:[{index:0,message,finish_reason:message.tool_calls?.length?"tool_calls":c.finishReason==="MAX_TOKENS"?"length":"stop"}],ai_bridge:{backend:"robin",completion_confirmed:!!c.finishReason,usage_source:"not_reported",ignored_parameters:[]}};
}
export function geminiStream(body,model){
 const id="chatcmpl-"+randomUUID(),created=Math.floor(Date.now()/1000),encoder=new TextEncoder();
 const chunk=(delta,finish_reason=null,bridge)=>"data: "+JSON.stringify({id,object:"chat.completion.chunk",created,model,choices:[{index:0,delta,finish_reason}],...(bridge?{ai_bridge:bridge}:{})})+"\n\n";
 const generate=async function*(){
  const reader=body.getReader(),decoder=new TextDecoder();let buffer="",seen=false,finished=false,tools=false,index=0;
  try{
   yield encoder.encode(chunk({role:"assistant",content:""}));
   for(;;){const {done,value}=await reader.read();buffer+=done?decoder.decode():decoder.decode(value,{stream:true});if(buffer.length>2*1024*1024)throw new AppError(502,"Robin 流帧过大");
    let split;while((split=buffer.indexOf("\n"))>=0||done&&buffer){const line=split>=0?buffer.slice(0,split):buffer;buffer=split>=0?buffer.slice(split+1):"";if(!line.startsWith("data:"))continue;const text=line.slice(5).trim();if(!text||text==="[DONE]")continue;let data;try{data=JSON.parse(text);}catch{throw new AppError(502,"Robin 流格式无效");}if(data.error)throw new AppError(502,"Robin 上游流失败","backend_stream_failed");const candidate=data.candidates?.[0];if(!candidate)continue;
     const a=assistant(candidate.content?.parts),delta={};if(a.content){delta.content=a.content;seen=true;}if(a.reasoning_content)delta.reasoning_content=a.reasoning_content;if(a.tool_calls){delta.tool_calls=a.tool_calls.map(call=>({index:index++,...call}));tools=true;seen=true;}if(Object.keys(delta).length)yield encoder.encode(chunk(delta));
     if(candidate.finishReason){finished=true;yield encoder.encode(chunk({},tools?"tool_calls":candidate.finishReason==="MAX_TOKENS"?"length":"stop",{backend:"robin",completion_confirmed:true,usage_source:"not_reported"}));}
    }if(done)break;
   }
   if(!seen)throw new AppError(502,"Robin 返回空响应","backend_response_empty");
   if(!finished)yield encoder.encode(chunk({},tools?"tool_calls":"stop",{backend:"robin",completion_confirmed:false,usage_source:"not_reported"}));
   yield encoder.encode("data: [DONE]\n\n");
  }catch(error){yield encoder.encode("data: "+JSON.stringify({error:{message:error instanceof AppError?error.message:"Robin 流中断",code:error.code||"backend_stream_failed"}})+"\n\ndata: [DONE]\n\n");}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 };
 const iterator=generate();return new ReadableStream({async pull(controller){try{const result=await iterator.next();if(result.done)controller.close();else controller.enqueue(result.value);}catch(e){controller.error(e);}},async cancel(){await body.cancel().catch(()=>{});await iterator.return?.();}});
}
