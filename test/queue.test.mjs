import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {SerialQueue} from "../src/queue.mjs";
import {Tasks} from "../src/tasks.mjs";
import {AppError} from "../src/common.mjs";
const tick=()=>new Promise(r=>setTimeout(r,10));
test("queue exposes reasons and content, reorders waiting jobs and keeps cancelling capacity until cleanup",async()=>{
 const q=new SerialQueue(10,1);let release,aborted=false;const ran=[];
 const first=q.add(async signal=>{await new Promise(resolve=>{release=resolve;signal.addEventListener("abort",()=>{aborted=true;},{once:true});});},undefined,{key:"one",cancelable:true,metadata:{summary:"summary",content:"private body"}});
 const second=q.add(async()=>{ran.push("second");},undefined,{key:"one"}).catch(e=>e);
 const third=q.add(async()=>{ran.push("third");},undefined,{key:"two"});
 await tick();let rows=q.list();assert.equal(rows[1].reason,"等待该账号当前任务完成");assert.equal(rows[2].reason,"等待全局并发位置");
 assert.equal("content" in rows[0],false);assert.equal(q.get(rows[0].id).content,"private body");
 q.promote(rows[2].id);assert.equal(q.list()[1].id,rows[2].id);
 await q.cancel(rows[1].id);assert.equal((await second).code,"cancelled");
 await q.cancel(rows[0].id);assert.equal(aborted,true);assert.equal(q.status.running,1);assert.equal(q.list()[0].state,"cancelling");
 assert.deepEqual(ran,[]);release();await first;await third;assert.deepEqual(ran,["third"]);assert.equal(q.list().length,0);
});
test("background tasks survive independent reads, bind results to their owner and cancel without running queued work",async()=>{
 const queue=new SerialQueue(),tasks=new Tasks({queue}),id=randomUUID();let release;
 const blocker=queue.add(()=>new Promise(r=>{release=r;}));await tick();let ran=false;
 tasks.start(id,"owner",{prompt:"private input"},signal=>queue.add(async()=>{ran=true;return{response:"done"};},signal,{id,cancelable:true,metadata:{summary:"private"}}));
 await tick();assert.equal(tasks.view(id,"owner").state,"waiting");assert.throws(()=>tasks.view(id,"foreign"),/不属于/);
 assert.throws(()=>tasks.cancel(id,"foreign"),/不属于/);tasks.cancel(id,"owner");await tick();assert.equal(tasks.view(id,"owner").state,"cancelled");assert.equal(ran,false);
 release();await blocker;
 const good=randomUUID();tasks.start(good,"owner",{prompt:"valid"},async()=>({response:"actual result",account:{id:"one"}}));await tick();
 assert.equal(tasks.view(good,"owner").result.response,"actual result");
 tasks.entry(good,"owner").finished=Date.now()-tasks.ttl-1;assert.throws(()=>tasks.view(good,"owner"),/过期/);tasks.close();
});

test("background result capacity evicts an older completed result only when admitting another task",async()=>{
 const queue={get(){throw Error("not in queue");}},tasks=new Tasks({queue});
 try{for(let i=0;i<128;i++){tasks.start(String(i),"owner",{prompt:"synthetic"},async()=>({content:String(i)}));await new Promise(r=>setImmediate(r));}
 assert.equal(tasks.entries.size,128);assert.equal(tasks.view("127","owner").result.content,"127");
 tasks.start("next","owner",{prompt:"synthetic"},async()=>({content:"next"}));await new Promise(r=>setImmediate(r));
 assert.equal(tasks.entries.size,128);assert.throws(()=>tasks.view("0","owner"),{code:"task_not_found"});assert.equal(tasks.view("next","owner").result.content,"next");
 }finally{tasks.close();}
});

test("shared backend resources wait visibly without blocking another backend or claiming an account",async()=>{
 const queue=new SerialQueue(8,2);let releaseA,startedB=false;
 const a=queue.add(()=>new Promise(resolve=>{releaseA=resolve;}),undefined,{id:"a",resource:"browser",metadata:{resource_name:"AI Studio 浏览器"}});
 const b=queue.add(async()=>{startedB=true;},undefined,{id:"b",resource:"browser",metadata:{resource_name:"AI Studio 浏览器"}});
 const other=queue.add(async()=>42,undefined,{id:"other",resource:"robin"});
 assert.equal(await other,42);assert.equal(startedB,false);assert.equal(queue.get("b").reason,"等待AI Studio 浏览器");assert.equal(queue.get("b").account_id,null);
 releaseA();await a;await b;assert.equal(startedB,true);assert.equal(queue.activeResources.size,0);assert.equal(queue.running,0);
});

test("same-account independent requests share reads while login uses its own slot and waits only for that account",async()=>{
 const queue=new SerialQueue(10,2);let a,b,loginStarted=false,otherStarted=false;
 const first=queue.add(()=>new Promise(r=>{a=r;}),undefined,{id:"model-a",sharedKey:"account"});
 const second=queue.add(()=>new Promise(r=>{b=r;}),undefined,{id:"model-b",sharedKey:"account"});
 await new Promise(r=>setImmediate(r));assert.equal(queue.modelRunning,2);
 const login=queue.add(async()=>{loginStarted=true;},undefined,{id:"login",key:"account",lane:"login"});
 const other=queue.add(async()=>{otherStarted=true;},undefined,{id:"other-login",key:"other",lane:"model"});
 assert.match(queue.get("login").reason,/账号/);a();await first;await new Promise(r=>setImmediate(r));assert.equal(loginStarted,false);assert.equal(otherStarted,true);b();await second;await login;await other;assert.equal(loginStarted,true);assert.equal(queue.running,0);
});
test("login on another account runs with a full model budget; delegated credential write drains readers and can be cancelled",async()=>{
 const queue=new SerialQueue(10,1);let releaseModel,releaseLogin;
 const model=queue.add(()=>new Promise(r=>releaseModel=r),undefined,{id:"model",sharedKey:"a"});
 const login=queue.add(()=>new Promise(r=>releaseLogin=r),undefined,{id:"login",key:"b",lane:"login"});
 await new Promise(r=>setImmediate(r));assert.equal(queue.modelRunning,1);assert.equal(queue.loginRunning,1);
 const c=new AbortController(),cancelled=queue.acquireWrite("a",c.signal);c.abort();await assert.rejects(cancelled,{code:"cancelled"});
 const writer=queue.acquireWrite("a");let nextRan=false;const next=queue.add(async()=>{nextRan=true;},undefined,{id:"next",sharedKey:"a"});releaseModel();await model;const releaseWrite=await writer;await new Promise(r=>setImmediate(r));assert.equal(nextRan,false);releaseWrite();await next;releaseLogin();await login;assert.equal(queue.writeOwners.size,0);
});
