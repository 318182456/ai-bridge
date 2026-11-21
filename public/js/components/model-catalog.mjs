import {note,fmtDate} from '../core.mjs';
export function mountCatalog(ctx,{onData,statusId='catalogStatus',refreshId='refreshModels'}){
 const button=ctx.$(refreshId);let disposed=false,timer=null,loading=false;
 function status(value){
  const refresh=value.refresh||{},errors=refresh.errors||[];button.disabled=refresh.state==='running';
  const source=value.cache?.storage==='postgresql'?'PostgreSQL 缓存':'已保存的目录';
  const message=refresh.state==='running'?'后台刷新中，当前显示'+source+'；不执行模型生成。':errors.length?'刷新未完成，保留'+source+'：'+errors.map(e=>e.message).join('；'):refresh.finished_at?'显示'+source+'；最近刷新 '+fmtDate(refresh.finished_at):'显示'+source+'；目录按需后台刷新，不执行模型生成。';
  note(statusId,message,!!errors.length);
  if(refresh.state==='running')timer=setTimeout(load,1500);
 }
 async function load(){
  if(disposed||loading)return;loading=true;clearTimeout(timer);
  try{const value=await ctx.api('/api/models/catalog');if(disposed)return;onData(value.models||[]);status(value);}
  catch(error){if(!disposed){button.disabled=false;note(statusId,'目录读取失败，已保留当前内容：'+error.message,true);}}
  finally{loading=false;}
 }
 button.onclick=async()=>{button.disabled=true;clearTimeout(timer);try{await ctx.api('/api/models/catalog/refresh',{method:'POST',data:{}});if(!disposed)await load();}catch(error){if(!disposed){button.disabled=false;note(statusId,'无法刷新目录，已保留当前内容：'+error.message,true);}}};
 return{render:load,cleanup(){disposed=true;clearTimeout(timer);}};
}
