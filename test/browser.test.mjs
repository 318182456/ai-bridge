import {spawn} from "node:child_process";
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


test("cold browser preparation invokes the installed Playwright CLI without relying on an unexported subpath",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ai-bridge-browser-installer-"));let started=false;
 const browser=new GoogleBrowser({dataDir:dir,spawnProcess:(command,args,options)=>{started=true;assert.match(args[0],/[\\/]playwright-core[\\/]cli\.js$/);assert.deepEqual(args.slice(1),["install","chromium","--no-shell"]);assert.equal(options.env.ADMIN_PASSWORD,undefined);return spawn(command,[args[0],"--version"],options);}});
 try{await browser.prepare();assert.equal(started,true);assert.equal(browser.installChild,null);assert.equal(browser.status().state,"idle");}finally{await browser.close();await rm(dir,{recursive:true,force:true});}
});

test("browser pool shares a profile across requests and keeps login/other profiles within its hard bound",async()=>{
 const {GoogleBrowserPool}=await import('../src/backends/browser.mjs');const root=await mkdtemp(join(tmpdir(),'ai-bridge-pool-'));let active=0,peak=0;
 const pool=new GoogleBrowserPool({dataDir:root,limit:2,launch:async()=>{active++;peak=Math.max(peak,active);const c=new EventEmitter();c.close=async()=>{await pause(10);active--;c.emit('close');};return c;}});
 try{
  const one=await pool.acquire('g_'+'1'.repeat(24)),same=await pool.acquire('g_'+'1'.repeat(24)),two=await pool.acquire('g_'+'2'.repeat(24));assert.equal(pool.status().contexts,2);assert.equal(peak,2);
  let third=false;const waiting=pool.acquire('g_'+'3'.repeat(24)).then(lease=>{third=true;return lease;});await pause(10);assert.equal(third,false);one.release();assert.equal(third,false);same.release();const three=await waiting;assert.equal(peak,2);two.release();three.release();
 }finally{await pool.close();await rm(root,{recursive:true,force:true});}assert.equal(active,0);
});


test("failed Google reauthorization preserves the last verified account metadata",async()=>{
 const {BrowserEngine}=await import('../src/backends/browser-engine.mjs');const {AppError}=await import('../src/common.mjs');
 const root=await mkdtemp(join(tmpdir(),'ai-bridge-relogin-')),accounts=new GoogleAccounts(root),id='g_'+'4'.repeat(24);
 const old={id,email:'synthetic@example.invalid',enabled:true,state:'ready',checked_at:'2026-01-01T00:00:00.000Z',models:[{id:'old-model'}],grants:{aist:'verified',agy:'verified',robin:'verified'}};
 await accounts.put(structuredClone(old));let releases=0,closes=0;
 const page={screenshot:async()=>Buffer.from('synthetic-frame'),goto:async()=>{},url:()=> 'https://aistudio.google.com/prompts/new_chat',locator:()=>({isVisible:async()=>true}),close:async()=>{closes++;}};
 const engine=new BrowserEngine({accounts,browser:{checkpoint:async()=>{},acquire:async()=>({context:{newPage:async()=>page},release:()=>releases++})}});
 engine.email=async()=>old.email;engine.captureCatalog=(_page,receive)=>{receive([{id:'new-flash',capabilities:[1]}]);return()=>{};};
 engine.generate=async function*(){throw new AppError(503,'Synthetic network failure','network_error');};
 try{await assert.rejects(async()=>{for await(const _ of engine.login('synthetic-job',{account_id:id},new AbortController().signal)){};},{code:'network_error'});assert.deepEqual(await accounts.get(id),old);assert.equal(releases,1);assert.equal(closes,1);}
 finally{await rm(root,{recursive:true,force:true});}
});


test("Google login emits a real frame before navigation and returns a safe network error",async()=>{
 const {BrowserEngine}=await import('../src/backends/browser-engine.mjs');const root=await mkdtemp(join(tmpdir(),'ai-bridge-first-frame-')),accounts=new GoogleAccounts(root);let navigated=false,released=false;
 const page={screenshot:async()=>Buffer.from('synthetic-frame'),goto:async(_url,opts)=>{assert.equal(opts.waitUntil,'commit');navigated=true;const error=new Error('synthetic-private-navigation-url');error.name='TimeoutError';throw error;},close:async()=>{}};
 const engine=new BrowserEngine({accounts,browser:{acquire:async()=>({context:{newPage:async()=>page},release:()=>{released=true;}})}});engine.captureCatalog=()=>()=>{};const iterator=engine.login('test',{},new AbortController().signal);
 try{await iterator.next();await iterator.next();await iterator.next();const image=await iterator.next();assert.equal(navigated,false);assert.equal(Buffer.from(image.value.browser_binary,'base64').toString(),'synthetic-frame');await assert.rejects(iterator.next(),e=>e.code==='google_page_timeout'&&!e.message.includes('synthetic-private'));assert.equal(released,true);}
 finally{await iterator.return();await rm(root,{recursive:true,force:true});}
});


test("login viewport follows the owner window within bounded dimensions and pointer coordinates",async()=>{
 const {BrowserEngine}=await import('../src/backends/browser-engine.mjs');let size={width:1280,height:800};const moves=[],sizes=[];
 const page={viewportSize:()=>size,setViewportSize:async next=>{size=next;sizes.push(next);},mouse:{move:async(x,y)=>moves.push([x,y])}};
 const engine=new BrowserEngine({accounts:{},browser:{}}),job={page};engine.jobs.set('owned',job);
 engine.input('owned',{type:'viewport',context:'foreign',width:390,height:640});engine.input('owned',{type:'viewport',context:'owned',width:99999,height:640});
 engine.input('owned',{type:'viewport',context:'owned',width:390,height:640});engine.input('owned',{type:'pointer',context:'owned',action:'move',x:9999,y:9999});await job.inputs;
 assert.deepEqual(sizes,[{width:390,height:640}]);assert.deepEqual(moves,[[389,639]]);
});
