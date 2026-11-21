import {note,fmtDate} from '../core.mjs';
export function mountBrowserSync(ctx,{onChange=async()=>{},onOpen=()=>{}}={}){
 const $=ctx.$;let disposed=false,timer=null,loading=false,starting=false,lastTerminal=null;
 const panel=$('browserSyncPanel');
 function show(){panel.hidden=false;}
 function pair(job){return new Promise((resolve,reject)=>{const done=e=>{if(e.source===window&&e.origin===location.origin&&e.data?.type==='AI_BRIDGE_LOCAL_LOGIN_READY'&&e.data.id===job.id){clearTimeout(timeout);removeEventListener('message',done);resolve();}};const timeout=setTimeout(()=>{removeEventListener('message',done);reject(Error('同步脚本没有响应，请安装或更新脚本并刷新管理页。'));},3000);addEventListener('message',done);window.postMessage({type:'AI_BRIDGE_LOCAL_LOGIN',job},location.origin);});}
 async function read(){
  if(loading||disposed)return false;loading=true;
  try{const job=await ctx.api('/api/browser-sync');if(disposed)return false;show();onOpen(job.account_id);const running=['waiting_browser','queued','running'].includes(job.state);$('browserSyncStatus').textContent=({waiting_browser:'已打开本机 Google 页面。完成登录后，在脚本面板点击“登录完成，安全同步”。',queued:'凭据已收到，等待账号空闲后校验。',running:job.target==='robin'?'正在单独校验 Robin（一次真实调用）…':'正在校验 Google 身份与 AIST 生成权限（一次真实调用）…',done:'认证与实际调用已验证通过。',failed:job.error||'校验未通过；同步 Cookie 不代表生成权限可用。',cancelled:'本机登录已取消。',expired:'配对已过期，请重新点击本机登录。'})[job.state]||'等待同步';
   $('browserSyncTitle').textContent='本机浏览器登录 · '+(job.target==='robin'?'Robin':'AIST');$('browserSyncExpiry').textContent='配对有效期至 '+fmtDate(job.expires_at)+'（北京时间）';$('browserSyncOpen').href=job.google_url;$('browserSyncOpen').hidden=job.state!=='waiting_browser';$('browserSyncCancel').hidden=!running;
   if(!running){clearInterval(timer);if(lastTerminal!==job.id){lastTerminal=job.id;await onChange();onOpen(job.account_id);}}return running;
  }catch(error){if(error.status!==404)note('browserSyncStatus',error.message,true);return false;}finally{loading=false;}
 }
 async function begin(account,target,email){
  if(starting)return;
  show();onOpen(account||null);if(document.documentElement.dataset.aiBridgeSyncReady!=='1'){note('browserSyncStatus','请先安装下面的同步脚本并刷新管理页；手机需支持 Cookie API 的脚本管理器。',true);return;}
  starting=true;let created=false;
  const tab=window.open('about:blank','_blank');if(tab)tab.opener=null;
  try{const job=await ctx.api('/api/browser-sync',{method:'POST',data:{target,...(account?{account_id:account}:{email})}});created=true;await pair(job);if(tab)tab.location.href=job.google_url;else note('browserSyncStatus','浏览器阻止了新标签页，请点击“打开本机 Google 页面”。',true);clearInterval(timer);await read();timer=setInterval(read,1500);}
  catch(error){tab?.close();if(created)await ctx.api('/api/browser-sync',{method:'DELETE',data:{}}).catch(()=>{});note('browserSyncStatus',error.message,true);}finally{starting=false;}
 }
 $('browserSyncCancel').onclick=async()=>{try{await ctx.api('/api/browser-sync',{method:'DELETE',data:{}});await read();}catch(e){note('browserSyncStatus',e.message,true);}};
 for(const [id,target]of [['beginLocalAist','aist'],['beginLocalRobin','robin']])$(id).onclick=()=>begin(null,target,$('localGoogleEmail').value.trim());
 return{begin,async resume(){if(await read())timer=setInterval(read,1500);},cleanup(){disposed=true;clearInterval(timer);}};
}
