(()=>{
 'use strict';
 const W=typeof unsafeWindow!=='undefined'?unsafeWindow:window;
 const BRIDGE=__BRIDGE_ORIGIN__,KEY='ai-bridge-local-login';let busy=false;
 const get=()=>{try{const value=JSON.parse(GM_getValue(KEY,'null'));if(!value||value.origin!==BRIDGE||!Number.isFinite(value.expires)||value.expires<Date.now()){GM_deleteValue(KEY);return null;}return value;}catch{return null;}};
 if(location.origin===BRIDGE){
  document.documentElement.dataset.aiBridgeSyncReady='1';
  addEventListener('message',event=>{if((event.source!==W&&event.source!==window)||event.origin!==BRIDGE||event.data?.type!=='AI_BRIDGE_LOCAL_LOGIN')return;const v=event.data.job;
   if(!v||v.origin!==BRIDGE||!['aist','robin'].includes(v.target)||!/^[-a-f0-9]{36}$/.test(v.id)||!/^[A-Za-z0-9_-]{43}$/.test(v.token)||!Number.isFinite(Date.parse(v.expires_at))||Date.parse(v.expires_at)<Date.now()||Date.parse(v.expires_at)>Date.now()+910000)return;
   GM_setValue(KEY,JSON.stringify({id:v.id,token:v.token,target:v.target,label:String(v.account_label||'').slice(0,254),origin:BRIDGE,expires:Date.parse(v.expires_at)}));W.postMessage({type:'AI_BRIDGE_LOCAL_LOGIN_READY',id:v.id},BRIDGE);
  });return;
 }
 if(!['aistudio.google.com','accounts.google.com','alkalimakersuite-pa.clients6.google.com'].includes(location.hostname))return;
 function list(details){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('cookie_api')),5000);const done=(rows,error)=>{clearTimeout(timer);error?reject(Error('cookie_api')):resolve(Array.isArray(rows)?rows:[]);};try{if(typeof GM_cookie!=='undefined'&&typeof GM_cookie.list==='function')GM_cookie.list(details,done);else if(typeof GM!=='undefined'&&typeof GM.cookie?.list==='function')Promise.resolve(GM.cookie.list(details)).then(v=>done(v),()=>done([],true));else done([],true);}catch{done([],true);}});}
 const domainAllowed=d=>{d=String(d||'').replace(/^\./,'').toLowerCase();return d==='google.com'||d.endsWith('.google.com');};
 function upload(job,payload){return new Promise((resolve,reject)=>{const xhr=typeof GM_xmlhttpRequest==='function'?GM_xmlhttpRequest:typeof GM!=='undefined'?GM.xmlHttpRequest:null;if(!xhr)return reject(Error('request_api'));xhr({method:'POST',url:BRIDGE+'/api/browser-sync/'+job.id+'/deliver',headers:{'content-type':'application/json',authorization:'Bearer '+job.token},data:JSON.stringify(payload),timeout:30000,anonymous:false,onload:r=>{if(r.status===202){try{if(JSON.parse(r.responseText).accepted)return resolve();}catch{}}reject(Error(r.status===401||r.status===403?'pair_expired':'server_rejected'));},onerror:()=>reject(Error('network')),ontimeout:()=>reject(Error('network'))});});}
 const host=document.createElement('div');host.style.cssText='position:fixed;right:12px;bottom:12px;z-index:2147483646;max-width:calc(100vw - 24px)';const shadow=host.attachShadow({mode:'closed'});
 const style=document.createElement('style');style.textContent=':host{all:initial}section{box-sizing:border-box;width:320px;max-width:calc(100vw - 24px);padding:14px;background:#fff;color:#16221c;border:1px solid #cddbd2;border-radius:10px;box-shadow:0 4px 24px #0002;font:13px/1.5 system-ui,sans-serif}p{margin:6px 0;overflow-wrap:anywhere}button{font:inherit;border-radius:6px;padding:7px 10px;border:1px solid #abc6b7;background:#147454;color:#fff;cursor:pointer}button:disabled{opacity:.55}small{color:#52675a}';
 const box=document.createElement('section'),title=document.createElement('strong'),dest=document.createElement('p'),label=document.createElement('p'),status=document.createElement('p'),button=document.createElement('button'),help=document.createElement('small');box.append(title,dest,label,status,button,help);shadow.append(style,box);button.textContent='登录完成，安全同步';help.textContent='只发往你的 AI Bridge。建议使用 Tampermonkey Beta，允许 Cookie API 读取 HttpOnly；同步后仍需由后端校验。';
 async function sync(){if(busy)return;const job=get();if(!job){status.textContent='配对已失效，请回管理页重新点击本机登录。';return;}if(job.target==='aist'&&location.hostname!=='aistudio.google.com'){status.textContent='请先进入 AI Studio 页面，再同步。';return;}if(job.target==='robin'&&location.hostname!=='accounts.google.com'){status.textContent='请在 Google EmbeddedSetup 登录授权页面同步。';return;}
  busy=true;button.disabled=true;status.textContent='正在读取并同步，请稍候…';let payload;
  try{
   if(job.target==='robin'){
    const queries=await Promise.allSettled([list({url:location.origin+location.pathname,name:'oauth_token'}),list({domain:'accounts.google.com',name:'oauth_token'}),list({domain:'.google.com',name:'oauth_token'})]);const rows=queries.flatMap(r=>r.status==='fulfilled'?r.value:[]);const c=rows.find(c=>c.name==='oauth_token'&&c.value&&domainAllowed(c.domain));if(!c)throw Error('missing_oauth');let token=c.value;try{token=decodeURIComponent(token);}catch{}payload={oauth_token:token};
   }else{
    const queries=await Promise.allSettled([list({url:'https://aistudio.google.com/'}),list({url:'https://alkalimakersuite-pa.clients6.google.com/'}),list({domain:'.google.com'}),list({domain:'accounts.google.com'})]);if(queries.every(r=>r.status==='rejected'))throw Error('cookie_api');const cookies=new Map();for(const r of queries)if(r.status==='fulfilled')for(const c of r.value)if(domainAllowed(c.domain)&&c.name!=='oauth_token')cookies.set(c.domain+'\n'+c.path+'\n'+c.name,{name:c.name,value:c.value,domain:c.domain,path:c.path||'/',secure:!!c.secure,httpOnly:!!c.httpOnly,sameSite:c.sameSite,expires:c.expirationDate??c.expires});
    const rows=[...cookies.values()];if(!rows.some(c=>['SID','__Secure-1PSID','__Secure-3PSID'].includes(c.name)&&c.value)||!rows.some(c=>['SAPISID','__Secure-1PAPISID','__Secure-3PAPISID'].includes(c.name)&&c.value))throw Error('incomplete_cookies');const index=location.pathname.match(/\/u\/(\d+)\//)?.[1]||new URL(location.href).searchParams.get('authuser')||'0';payload={cookies:rows,authuser:/^\d{1,2}$/.test(index)?Number(index):0};
   }
   if(get()?.id!==job.id)throw Error('pair_expired');await upload(job,payload);GM_deleteValue(KEY);status.textContent='已安全提交。请返回管理页查看账号身份与模型校验结果。';button.hidden=true;
  }catch(error){status.textContent=({cookie_api:'当前脚本管理器不能读取 Cookie，请使用支持 HttpOnly 的 Tampermonkey Beta 并检查 Cookie API 权限。',missing_oauth:'尚未取得 oauth_token；请完成 Google 授权并同意后再同步。',incomplete_cookies:'缺少完整会话 Cookie，请启用 Cookie API 的 HttpOnly 访问权限。',pair_expired:'管理会话或配对已失效，请回管理页重新点击本机登录。',network:'同步连接失败，请先在管理页完成 SSO 登录，并确认可以访问服务。',server_rejected:'服务器未接受同步，请回管理页检查状态或重新配对。',request_api:'脚本管理器不支持跨站同步请求。'})[error.message]||'同步未完成，请返回管理页重新配对。';}
  finally{payload=null;busy=false;button.disabled=false;}
 }
 button.onclick=sync;GM_registerMenuCommand('同步到 AI Bridge',sync);
 function render(){const job=get();if(!job)return;title.textContent='AI Bridge · '+(job.target==='aist'?'AIST':'Robin')+' 本机登录';dest.textContent='同步至：'+BRIDGE;label.textContent='所选账号：'+job.label;if(!host.isConnected)document.documentElement.append(host);}
 render();new MutationObserver(()=>{if(!host.isConnected)render();}).observe(document.documentElement,{childList:true});
})();
