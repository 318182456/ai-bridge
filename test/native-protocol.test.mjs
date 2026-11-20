import test from "node:test";
import assert from "node:assert/strict";
import {gzipSync} from "node:zlib";
import {message,fields,GrpcDecoder,grpc,decodeModes,decodeAnswer,queryFrames} from "../src/backends/robin-wire.mjs";
import {toStudioRequest,StudioChat} from "../src/backends/aist-protocol.mjs";
test("Robin codec handles fragmented compressed envelopes, dynamic allowlists and terminal markers",()=>{
 const status=message([[17,message([[1,"mode-one"],[19,"3.8 Flash"]])],[17,message([[1,"mode-two"],[19,"4 Argon"]])],[18,message([[1,"mode-two"]])]]);
 assert.deepEqual(decodeModes(status),[{mode:"mode-two",id:"gemini-4-argon",name:"4 Argon"}]);
 const compressed=gzipSync(status),header=Buffer.alloc(5);header[0]=1;header.writeUInt32BE(compressed.length,1);const framed=Buffer.concat([header,compressed]),decoder=new GrpcDecoder();let decoded=[];for(const byte of framed)decoded.push(...decoder.feed(Buffer.from([byte])));decoder.finish();assert.equal(decoded.length,1);assert.deepEqual(decoded[0],status);
 assert.throws(()=>fields(Buffer.from([0xff])),{code:"backend_protocol_error"});const partial=new GrpcDecoder();partial.feed(Buffer.from([0,0]));assert.throws(()=>partial.finish(),{code:"backend_protocol_error"});
 const data=message([[1003,message([[1,message([[1,message([[1,"shard"],[2,message([[1,"正文"]])],[19,2]])],[2,message([[1,"conversation"]])],[25,"mode-two"]])]])]]);
 const result=decodeAnswer(data);assert.equal(result.shards[0].text,"正文");assert.equal(result.conversation,"conversation");assert.equal(result.effectiveMode,"mode-two");assert.equal(decodeAnswer(message([[1003,message([[2,Buffer.alloc(0)]])]])).done,true);assert.equal(queryFrames("text","mode-two",2).length,3);
});
test("AI Studio native mapping preserves signatures, arbitrary tool JSON and real config",()=>{
 const input={model:"gemini-test",temperature:0.4,max_tokens:128,tools:[{type:"function",function:{name:"state",parameters:{type:"object",properties:{value:true}}}}],messages:[{role:"system",content:"system"},{role:"user",content:"hi"},{role:"assistant",content:null,tool_calls:[{id:"call-1",type:"function",function:{name:"state",arguments:'{"value":[true,null]}'},extra_content:{google:{thought_signature:"synthetic-signature"}}}]},{role:"tool",tool_call_id:"call-1",content:'[true,null]'}]};
 const result=toStudioRequest(input);assert.equal(result.config.temperature,0.4);assert.equal(result.config.max_output_tokens,128);assert.equal(result.contents[1].parts[0].function_call.thought_signature,"synthetic-signature");assert.deepEqual(result.contents[2].parts[0].function_result.content,[true,null]);assert.equal(result.tools.functions[0].parameters.properties.value,true);
 assert.throws(()=>toStudioRequest({...input,messages:[{role:"tool",tool_call_id:"missing",content:"x"}]}),{code:"invalid_chat_request"});
 const chat=new StudioChat("gemini-test",input.tools);chat.accept({kind:"text",text:"text"});chat.accept({kind:"function_call",function_call:{id:"call-1",name:"state",arguments:{value:true},thought_signature:"synthetic-signature"}});chat.accept({kind:"usage",usage:{input_tokens:10,output_tokens:4,total_tokens:14}});chat.accept({kind:"finish",finish_reason:"STOP"});const response=chat.finish();assert.equal(response.usage.total_tokens,14);assert.equal(response.choices[0].message.tool_calls[0].extra_content.google.thought_signature,"synthetic-signature");assert.equal(response.ai_bridge.completion_confirmed,true);
});
