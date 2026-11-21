import {backendEnabled} from './account-state.mjs';
import {AppError} from '../common.mjs';
// ASVS V8.3 / V16.5: read cached data independently; refresh has a bounded lifetime and sanitized errors.
export class CatalogRefresh {
 constructor({accounts,backends,queue,logger,timeoutMs=120000,retryMs=300000,ttlMs=3600000}){Object.assign(this,{accounts,backends,queue,logger,timeoutMs,retryMs,ttlMs});this.work=null;this.controller=null;this.lastAttempt=0;this.lastState={state:'idle',errors:[]};this.closed=false;}
 status(){return {...this.lastState,errors:[...this.lastState.errors]};}
 async start({force=false}={}){
  if(this.closed||this.work)return this.status();
  const accounts=await this.accounts.list();if(this.closed||this.work)return this.status();
  const now=Date.now();if(!force&&now-this.lastAttempt<this.retryMs)return this.status();
  const targets=[];
  for(const a of accounts)for(const backend of ['aist','robin']){
   const allowed=backendEnabled(a,backend)&&(backend==='aist'?!!a.cookie_revision:['authenticated','verified'].includes(a.grants?.robin));
   const rows=backend==='aist'?a.models:a.robin_models,updated=Date.parse(a.catalog_updated_at?.[backend]||'');
   if(allowed&&(force||!rows?.length||!Number.isFinite(updated)||now-updated>this.ttlMs))targets.push({id:a.id,backend});
  }
  if(!targets.length)return this.status();
  this.lastAttempt=now;this.controller=new AbortController();const controller=this.controller;
  this.lastState={state:'running',started_at:new Date(now).toISOString(),finished_at:null,errors:[]};
  const timer=setTimeout(()=>controller.abort(),this.timeoutMs);timer.unref?.();
  this.work=(async()=>{
   let success=0;
   for(const target of targets){if(controller.signal.aborted)break;
    try{await this.queue.add(async signal=>{
     const account=await this.accounts.get(target.id);if(!backendEnabled(account,target.backend))return;
     if(target.backend==='aist')await this.backends.get('aist').engine.prepareAccount(account,signal,{refresh:true});
     else{const robin=this.backends.get('robin');robin.cache.delete(account.id);await robin.modes(account,signal);}
    },controller.signal,{key:target.id,cancelable:true,metadata:{kind:'models',account_id:target.id,summary:'后台刷新模型目录（无生成）'}});success++;}
    catch(error){const failure={backend:target.backend,account_id:target.id,code:error.code||'backend_models_failed',message:error instanceof AppError?error.message:'模型目录刷新失败，已保留缓存'};this.lastState.errors.push(failure);this.logger?.warn('backend.catalog_failed',{stage:target.backend,status:error.status||503,code:failure.code});}
   }
   if(controller.signal.aborted&&!this.lastState.errors.some(e=>e.code==='cancelled'))this.lastState.errors.push({code:'catalog_refresh_timeout',message:'模型目录刷新超时或已停止，已保留缓存'});
   this.lastState.state=this.lastState.errors.length?(success?'partial':'failed'):'completed';
  })().catch(()=>{this.lastState.state='failed';this.lastState.errors.push({code:'backend_models_failed',message:'模型目录刷新失败，已保留缓存'});}).finally(()=>{clearTimeout(timer);this.lastState.finished_at=new Date().toISOString();this.work=null;this.controller=null;});
  return this.status();
 }
 async close(){this.closed=true;this.controller?.abort();await this.work;}
}
