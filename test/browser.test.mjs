import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {GoogleBrowser} from "../src/backends/browser.mjs";
import {GoogleAccounts} from "../src/backends/google-store.mjs";
import {GoogleGrants} from "../src/backends/google-grants.mjs";
import {encodeRequest,binding,decodeCatalog,decodeResponse,parse,struct,unstruct,schema} from "../src/backends/studio-wire.mjs";
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test("browser launch is shared, account profiles are isolated and idle reclaims the single context",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ai-bridge-browser-test-"));let launches=0,closes=0;
 const browser=new GoogleBrowser({dataDir:dir,idleMs:30,launch:async(_path,options)=>{launches++;assert.equal(options.env.ADMIN_PASSWORD,undefined);assert.equal(options.chromiumSandbox,true);const ctx=new EventEmitter();ctx.close=async()=>{closes++;ctx.emit("close");};return ctx;}});
 try{const a=await browser.acquire("g_"+"1".repeat(24)),b=await browser.acquire("g_"+"1".repeat(24));assert.equal(launches,1);await assert.rejects(browser.acquire("g_"+"2".repeat(24)),{code:"browser_busy"});a.release();await pause(50);assert.equal(closes,0);b.release();await pause(80);assert.equal(closes,1);assert.equal(browser.status().browser_running,false);}finally{await browser.close();await rm(dir,{recursive:true,force:true});}
});
test("Google grants persist privately and refresh once; metadata contains no credential values",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ai-bridge-grants-test-")),id="g_"+"3".repeat(24);let calls=0;
 const account={id,email:"synthetic@example.invalid",enabled:false,state:"authenticated",grants:{}};const registry=new GoogleAccounts(dir);await registry.put(account);
 const grants=new GoogleGrants(dir,{post:async values=>{calls++;if(values.Token)return{Token:"synthetic-private-refresh-value"};return{Auth:"synthetic-private-access-value",ExpiresIn:"3600"};}});
 try{await grants.bindRobin(account,"synthetic-one-shot-code");const [a,b]=await Promise.all([grants.robinToken(id),grants.robinToken(id)]);assert.equal(a,b);assert.equal(calls,2);const reloaded=new GoogleGrants(dir,{post:async()=>{throw Error("must use cached token");}});assert.equal(await reloaded.robinToken(id),a);const metadata=JSON.stringify(await registry.list());assert.ok(!metadata.includes("synthetic-private"));assert.ok(!metadata.includes("synthetic-one-shot"));await assert.rejects(grants.read("../escape"),{status:400});}finally{await rm(dir,{recursive:true,force:true});}
});
test("AI Studio independent codec preserves binding, signatures, sparse arrays and exact reported usage",()=>{
 const value={array:[true,null,3],nested:{text:"x"}};assert.deepEqual(unstruct(struct(value)),value);assert.deepEqual(parse('[1,,"a,b",[,,],null]'),[1,null,"a,b",[null,null,null],null]);
 const req={model:"gemini-test",contents:[{role:"user",parts:[{text:"hello"}]},{role:"assistant",parts:[{function_call:{name:"f",id:"call",arguments:{a:1},thought_signature:"synthetic-signature"}}]}],config:{temperature:0.2,max_output_tokens:128},system:["sys"],tools:{functions:[{name:"f",parameters:{type:"object",properties:{a:true}}}]}};
 const wire=encodeRequest(req,"!synthetic-proof",{capabilities:[]});assert.equal(wire[0],"models/gemini-test");assert.equal(wire[4],"!synthetic-proof");assert.equal(wire[1][1][0][0][14],"synthetic-signature");assert.equal(binding(req),"hello ");assert.equal(wire[3][3],128);
 const row=[];row[0]="models/gemini-test";row[3]="Model";row[64]=[1,10];const catalog=decodeCatalog(JSON.stringify([[row]]));assert.equal(catalog[0].id,"gemini-test");
 const textFrame=[[[[[[null,"answer"]],"model"]]]],finishFrame=[[[null,1]],null,[10,4,14]];const events=decodeResponse(JSON.stringify([[textFrame,finishFrame]]));assert.equal(events.find(e=>e.kind==="text").text,"answer");assert.equal(events.find(e=>e.kind==="usage").usage.total_tokens,14);
});

test("Studio schema adapts local refs, nullable unions and empty enum members without fetching or weakening tool validation",()=>{
 const source={type:"object",properties:{sort:{$ref:"#/$defs/Sort"},value:{type:["string","null"]}},$defs:{Sort:{type:"string",enum:["","asc"]}}};
 const wire=schema(source);const sort=wire[6].find(([name])=>name==="sort")[1];assert.ok(sort[17]);assert.equal(wire[6].find(([name])=>name==="value")[1][3],true);assert.throws(()=>schema({$ref:"https://external.invalid/schema"}),{code:"invalid_studio_request"});
});
