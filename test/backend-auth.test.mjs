import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {mkdtemp,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {createApplication} from "../src/server.mjs";
import {AIStudio} from "../src/backends/aist.mjs";
import {Runner} from "../src/runner.mjs";
import {Logger} from "../src/runtime/logger.mjs";
const password="synthetic-admin-password-123456789",key="synthetic-api-key-123456789";
test("retired NAS Google login routes, frame socket and component are absent; local sync and agy login remain protected",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ai-bridge-no-remote-login-"));let generation=0;
 const engine={async *run(op){if(op==="accounts")yield{result:{accounts:[]}};else{generation++;assert.fail('unexpected browser operation');}},close:async()=>{}};
 const app=await createApplication({dataDir:dir,password,key,aistudio:new AIStudio({engine}),runner:new Runner({dataDir:dir,command:process.execPath,prefix:[resolve("test/fixtures/fake-cli.mjs")]}),logger:new Logger({sink:()=>{}})});
 await new Promise(r=>app.server.listen(0,"127.0.0.1",r));const base="http://127.0.0.1:"+app.server.address().port;
 try{
  const login=await fetch(base+"/auth/login",{method:"POST",headers:{origin:base,"content-type":"application/json"},body:JSON.stringify({password})}),cookie=login.headers.get("set-cookie").split(";")[0],csrf=(await login.json()).csrf;
  const call=(path,method="GET",data)=>fetch(base+path,{method,headers:{cookie,origin:base,"x-csrf-token":csrf,...(data!==undefined?{"content-type":"application/json"}:{})},body:data!==undefined?JSON.stringify(data):undefined});
  for(const method of ["GET","POST","DELETE"])assert.equal((await call("/api/backends/aist/login",method,method==="GET"?undefined:{})).status,404);
  assert.equal((await call("/js/components/google-login.mjs")).status,404);
  const upgradeStatus=await new Promise((resolve,reject)=>{const request=http.request(base+"/api/backends/aist/login-view/00000000-0000-0000-0000-000000000000",{headers:{cookie,origin:base,connection:"Upgrade",upgrade:"websocket","sec-websocket-version":"13","sec-websocket-key":"c3ludGhldGljLWtleS0xMg=="}},response=>{response.resume();resolve(response.statusCode);});request.on("upgrade",(_response,socket)=>{socket.destroy();reject(Error("retired socket accepted"));});request.on("error",reject);request.setTimeout(3000,()=>request.destroy(Error("upgrade did not finish")));request.end();});assert.equal(upgradeStatus,404);
  assert.equal((await fetch(base+"/api/browser-sync")).status,401);assert.equal((await fetch(base+"/api/browser-sync",{method:"POST",headers:{cookie,origin:base,"content-type":"application/json"},body:JSON.stringify({target:"aist",email:"synthetic@example.invalid"})})).status,403);
  assert.ok(app.catalog.some(r=>r.path==="/api/browser-sync"&&r.method==="POST"&&r.access==="mutation"));assert.ok(app.catalog.some(r=>r.path.includes("login")&&r.path.includes("accounts")&&r.method==="POST"));assert.ok(!app.catalog.some(r=>r.path.includes("/backends/aist/login")||r.method==="UPGRADE"));assert.equal(generation,0);assert.equal(typeof app.backends.get("aist").loginSocket,"undefined");
 }finally{await app.browserSync.close();app.tasks.close();await app.backends.close();app.loginManager.close();await app.runner.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await app.store.pending;await rm(dir,{recursive:true,force:true});}
});
