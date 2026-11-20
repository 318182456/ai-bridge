import {spawn} from "node:child_process";
import {AppError} from "../common.mjs";
const cancelled=()=>new AppError(499,"请求已取消","cancelled");
const unavailable=()=>new AppError(503,"后端暂不可用，请稍后重试","backend_unavailable");

// ASVS 1.2.5: only deployment-owned executables/argument arrays; never shell input.
export class ManagedProcess {
  constructor({id,command,args=[],cwd,env={},ready=async()=>true,idleMs=120000,startMs=60000,stopMs=5000,cooldownMs=10000,logger,spawnProcess=spawn}) {
    if(!/^[a-z][a-z0-9-]{0,31}$/.test(id)||typeof command!=="string"||!command||!Array.isArray(args)||args.some(a=>typeof a!=="string"))throw Error("Invalid backend process configuration");
    for(const n of [idleMs,startMs,stopMs,cooldownMs])if(!Number.isFinite(n)||n<0)throw Error("Invalid backend lifecycle duration");
    Object.assign(this,{id,command,args:[...args],cwd,env:{...env},ready,idleMs,startMs,stopMs,cooldownMs,logger,spawnProcess});
    this.state="stopped";this.users=0;this.child=null;this.starting=null;this.stopping=null;this.timer=null;this.retryAt=0;this.closed=false;
  }
  status(){return{id:this.id,state:this.state,active_requests:this.users,pid:this.child?.pid??null,retry_at:this.retryAt>Date.now()?new Date(this.retryAt).toISOString():null};}
  async acquire(signal){
    if(signal?.aborted)throw cancelled();if(this.closed)throw unavailable();
    clearTimeout(this.timer);this.users++;
    try{
      const start=this.ensure();
      if(signal){
        await new Promise((resolve,reject)=>{const abort=()=>{cleanup();reject(cancelled());};const cleanup=()=>signal.removeEventListener("abort",abort);signal.addEventListener("abort",abort,{once:true});start.then(()=>{cleanup();resolve();},e=>{cleanup();reject(e);});if(signal.aborted)abort();});
      }else await start;
      if(signal?.aborted)throw cancelled();if(this.closed||this.state!=="ready")throw unavailable();
    }catch(e){this.release();throw e;}
    let released=false;return()=>{if(!released){released=true;this.release();}};
  }
  release(){
    this.users=Math.max(0,this.users-1);
    if(!this.users&&!this.closed){clearTimeout(this.timer);this.timer=setTimeout(()=>{if(!this.users)this.stop().catch(()=>{});},this.idleMs);this.timer.unref?.();}
  }
  async ensure(){
    if(this.closed)throw unavailable();
    if(this.stopping)await this.stopping;
    if(this.state==="ready")return;
    if(this.starting)return this.starting;
    if(Date.now()<this.retryAt)throw unavailable();
    this.starting=this.start().finally(()=>{this.starting=null;});return this.starting;
  }
  async start(){
    if(this.closed)throw unavailable();
    this.state="starting";
    const controller=new AbortController();this.startController=controller;
    let child;
    try{
      child=this.spawnProcess(this.command,this.args,{cwd:this.cwd,env:this.env,shell:false,detached:process.platform!=="win32",stdio:"ignore",windowsHide:true});
      this.child=child;
      // Backend output may contain Google cookies/authorization URLs; do not forward it.
      child.once("error",()=>{controller.abort();});
      const ended=new Promise(resolve=>child.once("close",()=>{
        if(this.child===child){this.child=null;if(this.state!=="stopping"){this.state="failed";this.retryAt=Date.now()+this.cooldownMs;this.logger?.warn("backend.exited",{stage:this.id,code:"backend_exited"});}}
        controller.abort();resolve();
      }));
      this.ended=ended;
      const deadline=Date.now()+this.startMs;
      while(!controller.signal.aborted&&Date.now()<deadline){
        const probe=AbortSignal.any([controller.signal,AbortSignal.timeout(Math.max(1,Math.min(1000,deadline-Date.now())))]);
        try{if(await this.ready(probe)){if(this.child!==child||controller.signal.aborted)throw unavailable();this.state="ready";this.retryAt=0;this.logger?.info("backend.ready",{stage:this.id});return;}}catch{}
        await new Promise(r=>{const t=setTimeout(done,50);function done(){clearTimeout(t);controller.signal.removeEventListener("abort",done);r();}controller.signal.addEventListener("abort",done,{once:true});if(controller.signal.aborted)done();});
      }
      throw unavailable();
    }catch{
      await this.stop();this.state="failed";this.retryAt=Date.now()+this.cooldownMs;throw unavailable();
    }
  }
  stop(){
    if(this.stopping)return this.stopping;
    this.stopping=this.terminate().finally(()=>{this.stopping=null;});return this.stopping;
  }
  async terminate(){
    clearTimeout(this.timer);this.startController?.abort();
    const child=this.child;if(!child){this.state="stopped";return;}
    this.state="stopping";
    const kill=signal=>{try{if(process.platform!=="win32"&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch(e){if(e.code!=="ESRCH")throw e;}};
    try{kill("SIGTERM");}catch{}
    let timer;await Promise.race([this.ended,new Promise(r=>{timer=setTimeout(r,this.stopMs);})]);clearTimeout(timer);
    if(this.child===child){try{kill("SIGKILL");}catch{}await this.ended;}
    this.state="stopped";this.logger?.info("backend.stopped",{stage:this.id});
  }
  async close(){this.closed=true;clearTimeout(this.timer);this.startController?.abort();await this.starting?.catch(()=>{});await this.stop();}
}
