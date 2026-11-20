import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {setTimeout as sleep} from "node:timers/promises";
import WebSocket from "ws";
import {createApplication} from "../src/server.mjs";
import {AIStudio} from "../src/backends/aist.mjs";
import {Runner} from "../src/runner.mjs";
import {Logger} from "../src/runtime/logger.mjs";
const password="synthetic-admin-password-123456789",key="synthetic-api-key-123456789";
test("Google login frames are owner-bound, Origin/CSRF protected and revoked on logout; cancellation releases queue",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ai-bridge-authorization-"));let stopped=false,inputs=0;
 const engine={async *run(op,input,signal){if(op==="login"){try{while(!signal.aborted){yield{native_job:"synthetic-job",browser_meta:{type:"frame",context:"synthetic-job",width:100,height:100}};await sleep(30,undefined,{signal});}}finally{stopped=true;}}else if(op==="accounts")yield{result:{accounts:[]}};},input(){inputs++;},close:async()=>{}};
 const app=await createApplication({dataDir:dir,password,key,aistudio:new AIStudio({engine}),runner:new Runner({dataDir:dir,command:process.execPath,prefix:[resolve("test/fixtures/fake-cli.mjs")]}),logger:new Logger({sink:()=>{}})});
 await new Promise(r=>app.server.listen(0,"127.0.0.1",r));const base="http://127.0.0.1:"+app.server.address().port;
 async function login(){const response=await fetch(base+"/auth/login",{method:"POST",headers:{origin:base,"content-type":"application/json"},body:JSON.stringify({password})});return{cookie:response.headers.get("set-cookie").split(";")[0],csrf:(await response.json()).csrf};}
 const call=(session,path,method="GET",data)=>fetch(base+path,{method,headers:{cookie:session.cookie,origin:base,"x-csrf-token":session.csrf,...(data!==undefined?{"content-type":"application/json"}:{})},body:data!==undefined?JSON.stringify(data):undefined});
 let ws;
 try{
  const owner=await login(),other=await login();assert.equal((await call(owner,"/api/backends/aist/login","POST",{})).status,202);
  let state;for(let i=0;i<50;i++){state=await(await call(owner,"/api/backends/aist/login")).json();if(state.view)break;await sleep(20);}assert.ok(state.view);assert.equal((await call(other,"/api/backends/aist/login")).status,404);
  const url=base.replace("http:","ws:")+"/api/backends/aist/login-view/"+state.view;
  const denied=options=>new Promise(resolve=>{const socket=new WebSocket(url,["ai-bridge","csrf."+(options.csrf||owner.csrf)],{headers:{cookie:options.cookie||owner.cookie,origin:options.origin||base}});socket.on("unexpected-response",(_req,res)=>{res.resume();socket.terminate();resolve(res.statusCode);});socket.on("error",()=>{});socket.on("open",()=>{socket.terminate();resolve(101);});});
  assert.equal(await denied({cookie:other.cookie,csrf:other.csrf}),403);assert.equal(await denied({origin:"https://foreign.invalid"}),403);assert.equal(await denied({csrf:"wrong"}),403);
  ws=new WebSocket(url,["ai-bridge","csrf."+owner.csrf],{headers:{cookie:owner.cookie,origin:base}});await new Promise((r,j)=>{ws.once("open",r);ws.once("error",j);});await new Promise(r=>ws.once("message",r));ws.send(JSON.stringify({type:"text",text:"synthetic",context:"synthetic-job"}));for(let i=0;i<30&&!inputs;i++)await sleep(10);assert.equal(inputs,1);
  const closed=new Promise(r=>ws.once("close",r));await call(owner,"/auth/logout","POST",{});await closed;for(let i=0;i<100&&app.queue.running;i++)await sleep(10);assert.equal(stopped,true);assert.equal(app.queue.running,0);assert.ok(app.catalog.some(r=>r.method==="UPGRADE"&&r.access==="upgrade"));
 }finally{ws?.terminate();app.backendAccounts.close();app.upgrades.close();await app.backends.close();app.loginManager.close();await app.runner.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await app.store.pending;await rm(dir,{recursive:true,force:true});}
});
