import {AppError} from '../common.mjs';
const cancelled=()=>new AppError(499,'授权已取消','cancelled');
// Google-owned EmbeddedSetup stays in the human-controlled browser; no application callback or password form.
export async function* authorizeRobin(engine,id,profile,signal,{allowSkip=false}={}){
 if(!engine.manualFactory||!engine.bindRobin)throw new AppError(503,'Robin 独立授权需要 Linux 完整浏览器','robin_login_unavailable');
 const previous=structuredClone(await engine.accounts.get(profile)),account=structuredClone(previous);account.grants={...account.grants};let completed=false,grantCleaned=false,rollbackGrant;
 await engine.browser.checkpoint?.(profile);engine.vault?.unmark?.("google",profile);
 try{
 const clear=await engine.browser.acquire(profile,signal);try{await clear.context.clearCookies({name:'oauth_token'});}finally{clear.release();await engine.browser.checkpoint?.(profile);}
 const url=new URL('https://accounts.google.com/EmbeddedSetup');url.search=new URLSearchParams({source:'android',xoauth_display_name:'Android Device',lang:'zh',hl:'zh-CN'}).toString();
  const choice=yield* engine.manualLogin(id,profile,url.href,signal,'manual_robin');
  if(choice.skipped){if(allowSkip)return{account:previous,skipped:true};throw cancelled();}
  yield{browser_meta:{type:'status',status:'verifying_robin'},native_job:id};
  const lease=await engine.browser.acquire(profile,signal);
  try{
   const token=(await lease.context.cookies('https://accounts.google.com')).find(c=>c.name==='oauth_token')?.value;
   if(!token)throw new AppError(401,'Google 未返回 Robin 授权结果，请完成官方授权后重试','robin_authorization_missing');
   rollbackGrant=await engine.bindRobin(account,token,signal);
   if(signal?.aborted)throw cancelled();
   await lease.context.clearCookies({name:'oauth_token'});grantCleaned=true;
   const hadVerified=Object.values(previous.grants||{}).includes('verified');
   account.grants.robin='verified';account.state='ready';account.enabled=hadVerified?previous.enabled:true;account.checked_at=new Date().toISOString();
   await engine.accounts.put(account);engine.vault?.mark('google',profile);completed=true;return{account,skipped:false};
  }finally{if(!grantCleaned)await lease.context.clearCookies({name:'oauth_token'}).then(()=>{grantCleaned=true;},()=>{});lease.release();await engine.browser.checkpoint?.(profile);}
 }catch(error){
  // Preserve established grants and explicit disablement when reauthorization fails (ASVS V16.5.3).
  if(!completed){if(typeof rollbackGrant==='function')await rollbackGrant();const saved=structuredClone(previous);if(!signal?.aborted&&error.code!=='cancelled'&&saved.grants?.robin!=='verified')saved.grants={...saved.grants,robin:'needs_attention'};await engine.accounts.put(saved);}
  if(signal?.aborted)throw cancelled();throw error;
 }finally{
  if(!completed&&!grantCleaned){let cleanup;try{cleanup=await engine.browser.acquire(profile,AbortSignal.timeout(10000));await cleanup.context.clearCookies({name:'oauth_token'});}catch{engine.logger?.warn('backend.login_cleanup_failed',{stage:'robin',code:'cookie_cleanup_failed'});}finally{cleanup?.release();await engine.browser.checkpoint?.(profile);}}
  if(!completed&&engine.vault&&Object.values(previous.grants||{}).includes('verified')){await engine.vault.restore('google',profile,{force:true});engine.vault.mark('google',profile);}}
}
