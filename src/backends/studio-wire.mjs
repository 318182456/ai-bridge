import {AppError} from "../common.mjs";
const fail=message=>new AppError(400,message,"invalid_studio_request");
export function tuple(values){const result=[];for(const [index,value]of Object.entries(values))if(value!==undefined&&value!==null)result[Number(index)]=value;return Array.from(result,v=>v??null);}
export function struct(value){if(!value||typeof value!=="object"||Array.isArray(value))value={result:value};return[Object.entries(value).map(([key,v])=>[key,typed(v)])];}
function typed(v){if(v===null)return[0];if(typeof v==="number")return[null,v];if(typeof v==="string")return[null,null,v];if(typeof v==="boolean")return[null,null,null,v];if(Array.isArray(v))return[null,null,null,null,null,[v.map(typed)]];return[null,null,null,null,struct(v)];}
function untyped(v){if(!Array.isArray(v))throw new AppError(502,"AI Studio 返回无效 JSON 值");if(v[5])return(v[5][0]||[]).map(untyped);if(v[4])return unstruct(v[4]);if(v[3]!=null)return v[3];if(v[2]!=null)return v[2];if(v[1]!=null)return v[1];return null;}
export function unstruct(v){return Object.fromEntries((v?.[0]||[]).map(([key,value])=>[key,untyped(value)]));}
export function schema(value,depth=0,root=value,refs=new Set()){if(depth>32)throw fail("Schema 过深");if(value===true)return[];if(value===false)throw fail("上游不支持恒假 Schema");if(!value||typeof value!=="object")throw fail("Schema 无效");
 if(value.$ref){if(typeof value.$ref!=="string"||!value.$ref.startsWith("#/")||refs.has(value.$ref))throw fail("Schema 引用不支持或存在递归");let target=root;for(const token of value.$ref.slice(2).split("/").map(s=>s.replace(/~1/g,"/").replace(/~0/g,"~"))){if(!target||!Object.hasOwn(target,token))throw fail("Schema 引用不存在");target=target[token];}const next=new Set(refs);next.add(value.$ref);const {$ref,...siblings}=value;return schema({...target,...siblings},depth+1,root,next);}
 if(Array.isArray(value.enum)&&value.enum.some(v=>v==="")){const other=value.enum.filter(v=>v!=="");const {enum:unused,...rest}=value;return schema({...rest,anyOf:[...(other.length?[{...rest,enum:other}]:[]),{type:"string",pattern:"^$"}]},depth+1,root,refs);}
 const types={string:1,number:2,integer:3,boolean:4,array:5,object:6};const out={};if(value.type){if(Array.isArray(value.type)){const types=value.type.filter(t=>t!=="null");if(!types.length)throw fail("仅 null 类型需要改用 nullable Schema");if(types.length===1)return schema({...value,type:types[0],nullable:value.type.includes("null")||value.nullable},depth+1,root,refs);return tuple({3:value.type.includes("null")||null,17:types.map(t=>schema({...value,type:t},depth+1,root,refs))});}if(!types[value.type])throw fail("Schema 类型无效");out[0]=types[value.type];}
 for(const [key,index]of Object.entries({format:1,description:2,nullable:3,enum:4,required:7,title:8,minimum:9,maximum:10,minLength:11,maxLength:12,pattern:13,maxItems:19,minItems:20,propertyOrdering:22}))if(value[key]!=null)out[index]=value[key];
 if(value.items!=null)out[5]=schema(value.items,depth+1,root,refs);if(value.properties)out[6]=Object.entries(value.properties).map(([k,v])=>[k,schema(v,depth+1,root,refs)]);
 for(const [name,index]of [["oneOf",16],["anyOf",17],["allOf",18]])if(value[name])out[index]=value[name].map(v=>schema(v,depth+1,root,refs));
 return tuple(out);
}
function encodePart(part){const v={};if(part.text!=null)v[1]=part.text;if(part.inline_data)v[2]=[part.inline_data.mime,part.inline_data.data];if(part.function_call){const f=part.function_call;v[10]=[f.name,struct(f.arguments),f.id||null];if(f.thought_signature)v[14]=f.thought_signature;}if(part.function_result){const f=part.function_result;v[11]=[f.name,struct(f.content),f.id||null];}if(part.thought)v[12]=true;if(part.thought_signature)v[14]=part.thought_signature;return tuple(v);}
export function binding(request){return request.contents.flatMap(c=>c.parts.map(p=>p.text||p.inline_data?.data||"")).join(" ");}
export function encodeRequest(request,proof,model){const config=request.config||{},cfg={13:1};for(const [k,index]of [["stop_sequences",1],["max_output_tokens",3],["temperature",4],["top_p",5],["top_k",6],["response_mime_type",7],["seed",18]])if(config[k]!=null)cfg[index]=config[k];if(config.response_json_schema)cfg[8]=schema(config.response_json_schema);
 if(config.reasoning_effort){const level={minimal:4,low:1,medium:2,high:3,xhigh:3,max:3}[config.reasoning_effort];if(model?.capabilities?.includes(52)&&level)cfg[16]=[1,null,null,level];else if(model?.capabilities?.includes(35))cfg[16]=[1,config.reasoning_effort==="none"?0:{minimal:0,low:1024,medium:8192,high:24576,xhigh:24576,max:24576}[config.reasoning_effort]];}
 const tools=request.tools?.functions?.length?[[null,request.tools.functions.map(f=>[f.name,f.description||"",schema(f.parameters)])]]:null;
 return tuple({0:"models/"+request.model,1:request.contents.map(c=>[c.parts.map(encodePart),c.role==="assistant"?"model":"user"]),3:tuple(cfg),4:proof,5:request.system?.length?[request.system.map(s=>[null,s]),"user"]:null,6:tools,10:1,13:[[null,null,"Asia/Shanghai"]]});
}
export function decodeCatalog(text){const root=parse(text);if(!Array.isArray(root?.[0]))throw new AppError(502,"模型目录格式无效","studio_protocol_error");return root[0].map(r=>{if(!Array.isArray(r)||typeof r[0]!=="string")throw new AppError(502,"模型目录字段无效");return{id:r[0].replace(/^models\//,""),name:typeof r[3]==="string"?r[3]:r[0],description:r[4]||"",capabilities:Array.isArray(r[64])?r[64]:[],input_limit:r[5]??null,output_limit:r[6]??null};});}
export function parse(text){
 const cleaned=text.replace(/^\)\]\}'\s*/,"");let out="",quoted=false,escaped=false,previous="";const stack=[];
 for(const ch of cleaned){if(quoted){out+=ch;if(escaped)escaped=false;else if(ch==="\\")escaped=true;else if(ch==='"')quoted=false;continue;}
  if(ch==='"'){quoted=true;out+=ch;previous='"';continue;}
  if(ch===","&&stack.at(-1)==="["&&["[",","].includes(previous))out+="null";
  if(ch==="]"&&stack.at(-1)==="["&&previous===",")out+="null";
  if(ch==="["||ch==="{"){stack.push(ch);if(stack.length>128)throw new AppError(502,"AI Studio 响应嵌套过深");}else if(ch==="]"||ch==="}")stack.pop();out+=ch;if(!/\s/.test(ch))previous=ch;
 }try{return JSON.parse(out);}catch{throw new AppError(502,"AI Studio 协议响应不是完整 JSON","studio_protocol_error");}
}
export function decodeResponse(text){const root=parse(text);if(root[1]?.[0])throw new AppError(502,"AI Studio 上游返回错误","studio_upstream_error");const events=[];let generation;
 for(const frame of root[0]||[]){if(!Array.isArray(frame))throw new AppError(502,"生成帧格式无效");if(frame[4]?.[0]){if(generation&&generation!==frame[4][0])continue;generation=frame[4][0];}const c=frame[0]?.[0];if(!c)continue;
  for(const part of c[0]?.[0]||[]){if(part[1]!=null)events.push({kind:part[12]?"reasoning":"text",text:part[1],thought_signature:part[14]||""});if(part[2]&&!part[12])events.push({kind:"media",inline_data:{mime:part[2][0],data:part[2][1]}});if(part[10])events.push({kind:"function_call",function_call:{name:part[10][0],arguments:unstruct(part[10][1]),id:part[10][2]||"",thought_signature:part[14]||""}});}
  const u=frame[2];if(Number.isSafeInteger(u?.[0])&&Number.isSafeInteger(u?.[2]))events.push({kind:"usage",usage:{input_tokens:u[0],output_tokens:u[1]??0,total_tokens:u[2]}});
  if(c[1]!=null)events.push({kind:"finish",finish_reason:c[1]===2?"MAX_TOKENS":c[1]===1?"STOP":"OTHER"});
 }return events;
}
