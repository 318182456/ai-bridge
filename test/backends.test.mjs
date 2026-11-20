import test from "node:test";
import assert from "node:assert/strict";
import {ManagedProcess} from "../src/backends/process.mjs";
import {Backends} from "../src/backends/registry.mjs";
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function backend(options={}){return new ManagedProcess({id:"test",command:process.execPath,args:["-e","setInterval(()=>{},1000)"],env:{},idleMs:60,startMs:1000,stopMs:100,cooldownMs:100,...options});}
test("backend shared startup, active lease retention and actual idle process reclamation",async()=>{
 let probes=0;const b=backend({ready:async()=>{probes++;await pause(30);return true;}});
 try{const [releaseA,releaseB]=await Promise.all([b.acquire(),b.acquire()]);assert.equal(probes,1);const pid=b.status().pid;assert.ok(pid);assert.equal(b.status().active_requests,2);
 releaseA();releaseA();await pause(90);assert.equal(b.status().pid,pid);assert.equal(b.status().active_requests,1);
 releaseB();await pause(180);assert.equal(b.status().pid,null);assert.equal(b.status().state,"stopped");
 }finally{await b.close();}
});
test("cancelled startup waiter does not cancel other callers; close reaps process",async()=>{
 const b=backend({ready:async()=>{await pause(120);return true;}}),c=new AbortController();
 try{const first=b.acquire(c.signal),second=b.acquire();c.abort();await assert.rejects(first,{code:"cancelled"});assert.equal(b.users,1);
 const release=await second;assert.equal(b.state,"ready");release();await b.close();assert.equal(b.child,null);await assert.rejects(b.acquire(),{code:"backend_unavailable"});
 }finally{await b.close();}
});
test("backend spawn failure is classified without exposing command or environment and has cooldown",async()=>{
 const b=backend({command:"missing-synthetic-backend-xyz",ready:async()=>false});
 try{await assert.rejects(b.acquire(),{code:"backend_unavailable"});assert.equal(b.child,null);assert.equal(b.users,0);assert.ok(b.retryAt>Date.now());await assert.rejects(b.acquire(),{code:"backend_unavailable"});}finally{await b.close();}
});
test("provider registry marks absent implementations explicitly and rejects duplicates",()=>{
 const b=new Backends();assert.deepEqual(b.list().map(x=>x.id),["agy","robin","aist"]);assert.equal(b.list()[1].state,"not_configured");assert.throws(()=>b.get("robin"),{code:"backend_not_ready"});b.register("agy",{status:()=>({state:"managed"})});assert.throws(()=>b.register("agy",{}));assert.throws(()=>b.register("other",{}));
});
