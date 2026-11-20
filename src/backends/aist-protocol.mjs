import {compileToolSchema} from "../chat.mjs";
import {randomUUID} from "node:crypto";
import {AppError} from "../common.mjs";
const bad=message=>new AppError(400,message,"invalid_chat_request");
function parts(content){if(content==null)return[];if(typeof content==="string")return[{text:content}];if(!Array.isArray(content))throw bad("消息内容无效");return content.map(p=>{if(p?.type==="text"&&typeof p.text==="string")return{text:p.text};if(p?.type==="image_url"){const url=typeof p.image_url==="string"?p.image_url:p.image_url?.url;const m=/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url||"");if(m)return{inline_data:{mime:m[1],data:m[2]}};throw bad("图片请使用 base64 data URL");}throw bad("暂不支持此消息内容类型");});}
export function toStudioRequest(input){
 if(typeof input.model!=="string"||!input.model||input.model.length>160||!Array.isArray(input.messages)||!input.messages.length)throw bad("请提供模型和 messages");
 if(input.account_id!=null&&!/^g_[a-f0-9]{24}$/.test(input.account_id))throw bad("Google 账号标识无效");
 const request={...(input.account_id?{account_id:input.account_id}:{}),id:randomUUID(),model:input.model,system:[],contents:[],config:{},tools:{functions:[]}},names=new Map();
 for(const m of input.messages){if(!m||typeof m!=="object")throw bad("消息格式无效");
  if(["system","developer"].includes(m.role)){for(const p of parts(m.content)){if(!('text'in p))throw bad("系统消息仅支持文本");request.system.push(p.text);}continue;}
  if(m.role==="tool"){const name=names.get(m.tool_call_id);if(!name)throw bad("工具结果缺少对应调用");let value;try{value=JSON.parse(m.content);}catch{value=m.content;}request.contents.push({role:"tool",parts:[{function_result:{id:m.tool_call_id,name,content:value}}]});continue;}
  if(!["user","assistant"].includes(m.role))throw bad("消息角色无效");const content={role:m.role,parts:parts(m.content)};
  for(const call of m.tool_calls||[]){if(m.role!=="assistant"||call.type!=="function"||typeof call.id!=="string"||typeof call.function?.name!=="string")throw bad("工具调用无效");let args;try{args=JSON.parse(call.function.arguments);}catch{throw bad("工具 arguments 必须为 JSON");}names.set(call.id,call.function.name);content.parts.push({function_call:{id:call.id,name:call.function.name,arguments:args,thought_signature:call.extra_content?.google?.thought_signature||call.thought_signature||""}});}
  request.contents.push(content);
 }
 if(!request.contents.length)throw bad("messages 缺少对话内容");
 if(input.tools!=null){if(!Array.isArray(input.tools)||input.tools.length>128)throw bad("tools 格式无效");const names=new Set();request.tools.functions=input.tools.map(t=>{if(t?.type!=="function"||typeof t.function?.name!=="string"||!/^[a-zA-Z0-9_.:-]{1,128}$/.test(t.function.name))throw bad("工具名称无效");if(names.has(t.function.name))throw bad("工具名称重复");names.add(t.function.name);compileToolSchema(t.function.parameters??{type:"object",properties:{}});return{name:t.function.name,description:t.function.description||"",parameters:t.function.parameters??{type:"object",properties:{}}};});}
 const choice=input.tool_choice;if(choice!=null){if(["auto","none","required"].includes(choice))request.tools.tool_config={mode:{auto:"AUTO",none:"NONE",required:"ANY"}[choice]};else if(choice?.type==="function"&&request.tools.functions.some(f=>f.name===choice.function?.name))request.tools.tool_config={mode:"ANY",allowed_function_names:[choice.function.name]};else throw bad("tool_choice 无效");}
 for(const [source,dest]of [["temperature","temperature"],["top_p","top_p"],["seed","seed"],["max_tokens","max_output_tokens"],["max_completion_tokens","max_output_tokens"]])if(input[source]!=null){const value=input[source];if(typeof value!=="number"||!Number.isFinite(value)||source.includes("tokens")&&(!Number.isSafeInteger(value)||value<1))throw bad(source+" 无效");request.config[dest]=value;}
 if(input.stop!=null){if(typeof input.stop==="string")request.config.stop_sequences=[input.stop];else if(Array.isArray(input.stop)&&input.stop.length<=4&&input.stop.every(x=>typeof x==="string"))request.config.stop_sequences=input.stop;else throw bad("stop 无效");}
 if(input.reasoning_effort!=null){if(typeof input.reasoning_effort!=="string")throw bad("reasoning_effort 无效");request.config.reasoning_effort=input.reasoning_effort;}
 if(input.response_format?.type==="json_object")request.config.response_mime_type="application/json";
 else if(input.response_format?.type==="json_schema"){request.config.response_mime_type="application/json";request.config.response_json_schema=input.response_format.json_schema?.schema;if(!request.config.response_json_schema)throw bad("response_format 缺少 schema");}
 else if(input.response_format!=null&&input.response_format.type!=="text")throw bad("response_format 无效");
 return request;
}
export class StudioChat {
 constructor(model,tools=[]){this.checks=new Map(tools.map(t=>[t.function.name,compileToolSchema(t.function.parameters??{type:"object",properties:{}})]));this.model=model;this.id="chatcmpl-"+randomUUID();this.created=Math.floor(Date.now()/1000);this.text="";this.thinking="";this.calls=[];this.signature="";this.usage=null;this.reason=null;this.media=[];}
 chunk(delta){return{id:this.id,object:"chat.completion.chunk",created:this.created,model:this.model,choices:[{index:0,delta,finish_reason:null}],ai_bridge:{backend:"aist",account_id:this.accountId||null}};}
 accept(event){if(event.account_id)this.accountId=event.account_id;const delta={};
  if(event.kind==="error")throw new AppError(502,"AI Studio 上游生成失败","native_generation_failed");
  if(event.kind==="text"&&event.text){this.text+=event.text;delta.content=event.text;}
  if(event.kind==="reasoning"&&event.text){this.thinking+=event.text;delta.reasoning_content=event.text;}
  if(event.thought_signature){this.signature=event.thought_signature;delta.extra_content={google:{thought_signature:event.thought_signature}};}
  if(event.function_call){const c=event.function_call;if(!this.checks.has(c.name)||!this.checks.get(c.name)(c.arguments))throw new AppError(502,"上游工具调用不符合声明的参数 Schema","invalid_tool_output");const call={id:c.id||"call_"+randomUUID(),type:"function",function:{name:c.name,arguments:JSON.stringify(c.arguments??{})},...((c.thought_signature||event.thought_signature)?{extra_content:{google:{thought_signature:c.thought_signature||event.thought_signature}}}:{})};this.calls.push(call);delta.tool_calls=[{index:this.calls.length-1,...call}];}
  if(event.inline_data?.mime?.startsWith("image/")){const image={type:"image_url",image_url:{url:"data:"+event.inline_data.mime+";base64,"+event.inline_data.data}};this.media.push(image);delta.content=[image];}
  if(event.usage)this.usage={prompt_tokens:event.usage.input_tokens||0,completion_tokens:event.usage.output_tokens||0,total_tokens:event.usage.total_tokens??null};
  if(event.kind==="finish")this.reason=event.finish_reason||"STOP";
  return Object.keys(delta).length?[this.chunk(delta)]:[];
 }
 finish(){if(!this.text&&!this.calls.length&&!this.media.length)throw new AppError(502,"AI Studio 返回空响应","native_empty_response");const message={role:"assistant",content:this.media.length?[...(this.text?[{type:"text",text:this.text}]:[]),...this.media]:this.text};if(this.thinking)message.reasoning_content=this.thinking;if(this.calls.length)message.tool_calls=this.calls;if(this.signature)message.extra_content={google:{thought_signature:this.signature}};
  return{id:this.id,object:"chat.completion",created:this.created,model:this.model,choices:[{index:0,message,finish_reason:this.calls.length?"tool_calls":this.reason==="MAX_TOKENS"?"length":"stop"}],...(this.usage?{usage:this.usage}:{}),ai_bridge:{backend:"aist",account_id:this.accountId||null,completion_confirmed:!!this.reason,usage_source:this.usage?"upstream":"not_reported"}};
 }
 finalChunk(result){return{id:this.id,object:"chat.completion.chunk",created:this.created,model:this.model,choices:[{index:0,delta:{},finish_reason:result.choices[0].finish_reason}],...(result.usage?{usage:result.usage}:{}),ai_bridge:result.ai_bridge};}
}
