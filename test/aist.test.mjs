import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {AIStudio} from "../src/backends/aist.mjs";
import {UsageInspector} from "../src/backends/routes.mjs";
import {createApplication} from "../src/server.mjs";
import {Runner} from "../src/runner.mjs";
import {Logger} from "../src/runtime/logger.mjs";
const password="synthetic-password-123456789",key="synthetic-api-key-123456789";
test("AI Studio uses the common API key and queue, forwards tools/parameters and accounts real streaming usage once",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ai-bridge-aist-test-"));let leases=0,seen;const logs=[];
 const backend={status:()=>({state:"ready"}),close:async()=>{},open:async(path,options={})=>{
   leases++;seen={path,...options};const release=()=>{leases--;};
   if(path==="/v1/models")return{response:Response.json({data:[{id:"test-build"}]}),release};
   const payload=options.json;
   if(payload.model==="FAIL")throw Error("synthetic startup failure");
   const data=payload.stream?'data: {"choices":[{"delta":{"content":"测试"}}]}\n\ndata: {"choices":[],"usage":{"total_tokens":23}}\n\ndata: [DONE]\n\n':JSON.stringify({choices:[{message:{content:"ok"}}],usage:{total_tokens:17}});
   return{response:new Response(data,{headers:{"set-cookie":"private_cookie=secret"}}),release};
 }};
 const app=await createApplication({dataDir:dir,password,key,aistudio:backend,logger:new Logger({sink:s=>logs.push(s)}),runner:new Runner({dataDir:dir,command:process.execPath,prefix:[resolve("test/fixtures/fake-cli.mjs")]})});
 await new Promise(r=>app.server.listen(0,"127.0.0.1",r));const origin="http://127.0.0.1:"+app.server.address().port;
 const call=(path,data,auth=key)=>fetch(origin+path,{method:data?"POST":"GET",headers:{authorization:"Bearer "+auth,...(data?{"content-type":"application/json"}:{})},body:data?JSON.stringify(data):undefined});
 try{
   assert.equal((await call("/api/backends")).status,401);assert.equal((await call("/aist/v1/models",null,"wrong")).status,401);
   assert.equal((await(await call("/aist/v1/models")).json()).data[0].id,"test-build");assert.equal(leases,0);
   const response=await call("/v1/chat/completions",{backend:"aist",model:"test-build",stream:true,temperature:0.2,tools:[{type:"function",function:{name:"example"}}],messages:[{role:"user",content:"synthetic-private-prompt"}]});
   assert.equal(response.status,200);assert.equal(response.headers.get("set-cookie"),null);assert.ok((await response.text()).includes("测试"));assert.equal(leases,0);assert.equal(seen.json.temperature,0.2);assert.equal(seen.json.tools[0].function.name,"example");assert.equal(seen.json.backend,undefined);
   let usage=app.store.state.master_usage;assert.equal(usage.requests,1);assert.equal(usage.successes,1);assert.equal(usage.total_tokens,23);
   const second=await call("/aist/v1/chat/completions",{model:"test-build",messages:[{role:"user",content:"second"}]});await second.text();usage=app.store.state.master_usage;assert.equal(usage.requests,2);assert.equal(usage.total_tokens,40);for(let i=0;i<50&&app.queue.running;i++)await new Promise(r=>setTimeout(r,10));assert.equal(app.queue.running,0);
   const invalid=await call("/aist/v1/chat/completions",{model:"x",messages:[]});assert.equal(invalid.status,400);await invalid.text();assert.equal(usage.requests,3);assert.equal(usage.failures,1);
   assert.ok(!logs.join(" ").includes("synthetic-private-prompt"));assert.ok(!logs.join(" ").includes(key));
 }finally{app.tasks.close();await app.backends.close();app.loginManager.close();await app.runner.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await app.store.pending;await rm(dir,{recursive:true,force:true});}
});
test("stream usage inspector handles UTF-8 boundaries, CRLF, no final newline and bounded oversized lines",()=>{
 const inspector=new UsageInspector(true),bytes=Buffer.from('data: {"choices":[{"delta":{"content":"中文"}}]}\r\n\r\ndata: {"usage":{"total_tokens":29}}');for(const byte of bytes)inspector.push(new Uint8Array([byte]));inspector.finish();assert.equal(inspector.total,29);
 const huge=new UsageInspector(true);huge.push(Buffer.from("data: "+"x".repeat(2*1024*1024)+"\ndata: {\"usage\":{\"total_tokens\":31}}\n"));huge.finish();assert.equal(huge.total,31);assert.ok(huge.text.length<1024*1024);
});

test("AI Studio uses the project browser engine without an upstream executable",async()=>{
 let calls=0;const engine={async *run(op){calls++;if(op==="models")yield{result:{models:[{id:"gemini-test"}]}};},close:async()=>{}};
 const b=new AIStudio({engine});try{const result=await b.open("/v1/models");assert.equal((await result.response.json()).data[0].id,"gemini-test");assert.equal(calls,1);assert.equal(b.status().resident_processes,0);await assert.rejects(b.open("https://external.invalid"),{status:400});}finally{await b.close();}
});

test("AI Studio SSE flushes a waiting comment while the generation is still queued",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ai-bridge-queued-stream-"));let unblock,called=false;
 const backend={status:()=>({state:"ready"}),close:async()=>{},open:async()=>{called=true;return{response:new Response('data: {"choices":[],"usage":{"total_tokens":2}}\n\ndata: [DONE]\n\n'),release(){}};}};
 const app=await createApplication({dataDir:dir,password,key,aistudio:backend,logger:new Logger({sink:()=>{}}),runner:new Runner({dataDir:dir,command:process.execPath,prefix:[resolve("test/fixtures/fake-cli.mjs")]})});
 await new Promise(r=>app.server.listen(0,"127.0.0.1",r));const origin="http://127.0.0.1:"+app.server.address().port;
 const occupied=app.queue.add(()=>new Promise(resolve=>{unblock=resolve;}));
 try{
  const response=await fetch(origin+"/aist/v1/chat/completions",{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify({model:"synthetic-model",stream:true,messages:[{role:"user",content:"synthetic"}]}),signal:AbortSignal.timeout(5000)});
  const reader=response.body.getReader(),first=await reader.read();assert.match(new TextDecoder().decode(first.value),/^: waiting/);assert.equal(called,false);assert.equal(response.headers.get("x-stream-mode"),"buffered");
  unblock();await occupied;let final="";for(;;){const next=await reader.read();if(next.done)break;final+=new TextDecoder().decode(next.value);}assert.match(final,/\[DONE\]/);assert.equal(called,true);assert.equal(app.store.state.backend_usage.aist.successes,1);
 }finally{unblock?.();await occupied;app.tasks.close();await app.backends.close();app.loginManager.close();await app.runner.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await app.store.pending;await rm(dir,{recursive:true,force:true});}
});
