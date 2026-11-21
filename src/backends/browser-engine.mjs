import {backendEnabled,setBackendEnabled} from './account-state.mjs';
import {googleCookies,studioURL} from "./browser-cookie-import.mjs";
import {setTimeout as sleep} from "node:timers/promises";
import {GoogleBrowserPool} from "./browser.mjs";
import {GoogleAccounts} from "./google-store.mjs";
import {binding,encodeRequest,decodeCatalog,decodeResponse,parse} from "./studio-wire.mjs";
import {studioFailure} from "./studio-failure.mjs";
import {AppError} from "../common.mjs";
const cancelled=()=>new AppError(499,"请求已取消","cancelled");
export class BrowserEngine {
 constructor({root,browser,accounts,logger,vault,credentialProvider}={}){this.credentialProvider=credentialProvider;this.preparingAccounts=new Map();this.appliedCookies=new WeakMap();this.identityMenus=new WeakSet();this.browser=browser||new GoogleBrowserPool({dataDir:root,logger,authVault:vault});this.accounts=accounts||new GoogleAccounts(root);this.cursor=0;this.vault=vault;}
 async prepareAccount(account,signal){
  if(!account.cookie_revision)return account;
  if(this.preparingAccounts.has(account.id)){await this.preparingAccounts.get(account.id);return this.accounts.get(account.id);}
  const work=(async()=>{const cookie=await this.credentialProvider?.(account.id);if(!cookie||cookie.revision!==account.cookie_revision)throw new AppError(401,"同步 Cookie 不可用，请重新同步","google_cookies_missing");const lease=await this.browser.acquire(account.id,signal);const applied=this.appliedCookies.get(lease.context)===cookie.revision;lease.release();if(applied&&account.models?.length)return;
   await this.prepareCookies(account,cookie,signal);
  })();this.preparingAccounts.set(account.id,work);try{await work;return await this.accounts.get(account.id);}finally{this.preparingAccounts.delete(account.id);}
 }
 async selectAccount(input){const accounts=(await this.accounts.list()).filter(a=>backendEnabled(a,"aist")&&["verified","authenticated","synced"].includes(a.grants?.aist)&&(!input.account_id||input.account_id===a.id)&&((a.models||[]).some(m=>m.id===input.model)||!!a.cookie_revision&&!a.models?.length));if(!accounts.length)throw new AppError(503,"没有支持此模型的已验证 AI Studio 账号","no_eligible_account");return accounts[input.account_id?0:this.cursor++%accounts.length].id;}
 async *run(op,input={},signal){
  if(signal?.aborted)throw cancelled();
  if(op==="accounts"){yield{result:{accounts:(await this.accounts.list()).map(a=>({id:a.id,label:a.email,enabled:backendEnabled(a,"aist")||backendEnabled(a,"robin"),state:a.state,benefit_tier:a.tier||"未提供",models:a.models||[],grants:a.grants||{},backend_enabled:{aist:backendEnabled(a,"aist"),robin:backendEnabled(a,"robin")},agy_account_id:a.agy_account_id||null,usage:a.usage||{},checked_at:a.checked_at||null}))}};return;}
  if(op==="set_enabled"){const a=await this.accounts.get(input.id);if(input.enabled&&a.state!=="ready"&&!Object.values(a.grants||{}).some(v=>["synced","authenticated"].includes(v)))throw new AppError(409,"请先完成实际生成验证");if(input.backend)setBackendEnabled(a,input.backend,input.enabled);else{a.enabled=!!input.enabled;a.backend_enabled={aist:a.enabled,robin:a.enabled};}await this.accounts.save();yield{result:{updated:true}};return;}
  if(op==="models"){const candidates=(await this.accounts.list()).filter(a=>backendEnabled(a,"aist")&&a.cookie_revision);for(const a of candidates)await this.prepareAccount(a,signal);const rows=(await this.accounts.list()).filter(a=>backendEnabled(a,"aist")&&["verified","authenticated","synced"].includes(a.grants?.aist)),all=new Map();for(const a of rows)for(const m of a.models||[])all.set(m.id,m);yield{result:{models:[...all.values()]}};return;}
  if(op==="generate"){const a=await this.accounts.get(await this.selectAccount(input));for await(const event of this.generate(a,input,signal))yield{event:{...event,account_id:a.id}};return;}
  throw new AppError(400,"浏览器操作无效");
 }
 async email(page){
  // Provider-owned account switcher identifies the active account; never infer identity from arbitrary page text.
  const read=()=>page.locator('ms-account-switcher .account-switcher-text,a[aria-label*="Google"][aria-label*="@"],button[aria-label*="Google"][aria-label*="@"],a[aria-label*="Google"][data-email]').evaluateAll(nodes=>{const found=new Set();for(const n of nodes){const value=n.getAttribute("data-email")||n.getAttribute("aria-label")||n.textContent||"";const m=value.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/);if(m)found.add(m[0].toLowerCase());}return found.size===1?[...found][0]:"";}).catch(()=>"");
  let email=await read();if(email)return email;
  const button=page.getByRole('button',{name:/Google.*(?:Account|账号|帐号|账户)|(?:Account|账号|帐号|账户).*Google/i}).first();
  if(!this.identityMenus.has(page)&&await button.isVisible().catch(()=>false)){try{await button.click({timeout:3000});this.identityMenus.add(page);}catch{}email=await read();}return email;
 }
 captureCatalog(page,receive){const handler=async response=>{try{const u=new URL(response.url());if(u.protocol!=="https:"||!["alkalimakersuite-pa.clients6.google.com","alkalimakersuite-pa.googleapis.com"].includes(u.hostname)||!u.pathname.endsWith("/ListModels")||!response.ok())return;const text=await response.text();if(text.length>8*1024*1024)return;receive(decodeCatalog(text));}catch{}};page.on("response",handler);return()=>page.off("response",handler);}
 // Apply already-synchronized credentials only. No interactive login, frames or generation probe.
 async prepareCookies(account,credential,signal){
  const profile=account.id,authuser=credential.authuser??0;
  if(!/^g_[a-f0-9]{24}$/.test(profile)||!Number.isInteger(authuser)||authuser<0||authuser>99)throw new AppError(400,"Google 账号标识或序号无效");
  const cookies=googleCookies(credential.cookies);const previous=structuredClone(account);
  this.vault?.unmark?.("google",profile);
  const lease=await this.browser.acquire(profile,signal);let page,detach=()=>{},prepared=false;
  const abort=()=>page?.close().catch(()=>{});signal?.addEventListener("abort",abort,{once:true});
  try{
   page=await lease.context.newPage();let models=[];detach=this.captureCatalog(page,value=>{models=value;});
   // Read-only preparation must never accidentally submit a model request (ASVS V8.3).
   await page.route("**/*",route=>/\/(?:GenerateContent|GenerateText|ProcessQuery)(?:[?]|$)/.test(new URL(route.request().url()).pathname)?route.abort("blockedbyclient"):route.continue());
   await lease.context.clearCookies();await lease.context.addCookies(cookies);
   await page.goto(studioURL({authuser}),{waitUntil:"commit",timeout:45000});
   const until=Date.now()+90000;
   while(Date.now()<until){
    if(signal?.aborted)throw cancelled();const url=new URL(page.url());
    if(url.hostname==="accounts.google.com")throw new AppError(401,"同步的 Google 会话已失效，请在本机重新登录并同步","google_cookies_expired");
    if(url.hostname==="aistudio.google.com"&&url.pathname.includes("available-regions"))throw new AppError(403,"Google 不支持当前出口地区或账号","region_or_account_unsupported");
    const email=url.hostname==="aistudio.google.com"?await this.email(page):"";
    if(email&&email.toLowerCase()!==account.email.toLowerCase())throw new AppError(409,"同步会话与所选 Google 身份不匹配，请重新同步","account_identity_mismatch");
    if(email&&models.length&&await page.locator("ms-prompt-box textarea").isVisible().catch(()=>false)){
     const current=await this.accounts.get(profile);
     if(current.cookie_revision!==credential.revision)throw new AppError(409,"Cookie 已更新，请重新执行本次请求","google_cookies_changed");
     const grants={...current.grants,aist:current.grants?.aist==="verified"?"verified":"authenticated"};
     await this.accounts.put({...current,models,authuser,grants,state:Object.values(grants).includes("verified")?"ready":"authenticated"});
     this.appliedCookies.set(lease.context,credential.revision);prepared=true;return;
    }
    await sleep(500,undefined,{signal});
   }
   throw new AppError(401,"无法确认同步的 Google 身份或模型目录，请在本机进入 AI Studio 后重新同步","import_identity_unverified");
  }catch(error){
   if(signal?.aborted)throw cancelled();if(error instanceof AppError)throw error;
   throw new AppError(503,"同步后 Google 页面加载失败，请检查会话与服务出口网络","google_import_page_failed");
  }finally{
   detach();signal?.removeEventListener("abort",abort);await page?.close().catch(()=>{});lease.release();
   if(!prepared){this.appliedCookies.delete(lease.context);await this.browser.checkpoint?.(profile);if(this.vault){await this.vault.restore("google",profile,{force:true});if(Object.values(previous.grants||{}).includes("verified"))this.vault.mark("google",profile);}}
  }
 }
 async *generate(account,request,signal){
  account=await this.prepareAccount(account,signal);
  const model=(account.models||[]).find(m=>m.id===request.model);if(!model)throw new AppError(404,"账号模型目录中没有此模型","model_not_found");
  const lease=await this.browser.acquire(account.id,signal),page=await lease.context.newPage();const abort=()=>page.close().catch(()=>{});signal?.addEventListener("abort",abort,{once:true});let replaced=false;
  try{
   const own=encodeRequest(request,"",model);const prompt=binding(request);if(!prompt.trim())throw new AppError(400,"当前 aist 请求缺少可提交的内容");
   await page.route("**/*GenerateContent*",async route=>{
    const url=new URL(route.request().url());if(!["alkalimakersuite-pa.clients6.google.com","alkalimakersuite-pa.googleapis.com"].includes(url.hostname)||replaced)return route.continue();
    try{const original=parse(route.request().postData()||"");if(typeof original[4]!=="string"||!original[4].startsWith("!"))return route.abort("failed");own[4]=original[4];replaced=true;await route.continue({postData:JSON.stringify(own)});}catch{await route.abort("failed").catch(()=>{});}
   });
   await page.goto(studioURL(account,request.model),{waitUntil:"domcontentloaded",timeout:60000});
   const field=page.locator("ms-prompt-box textarea");await field.waitFor({state:"visible",timeout:30000});await field.fill(prompt,{timeout:15000});
   const responsePromise=page.waitForResponse(r=>r.request().method()==="POST"&&["alkalimakersuite-pa.clients6.google.com","alkalimakersuite-pa.googleapis.com"].includes(new URL(r.url()).hostname)&&new URL(r.url()).pathname.endsWith("/GenerateContent"),{timeout:180000});responsePromise.catch(()=>{});
   await page.locator("ms-run-button button").click({timeout:30000});const response=await responsePromise;
   if(!replaced)throw new AppError(502,"未能绑定本次 aist 请求","studio_request_not_bound");if(!response.ok())throw await studioFailure(response);const body=await response.text();if(body.length>16*1024*1024)throw new AppError(502,"AI Studio 响应超过限制");
   const events=decodeResponse(body);if(events.some(e=>e.kind==="text"||e.kind==="function_call"||e.kind==="media")){this.vault?.mark("google",account.id);if(account.grants.aist!=="verified"){account.grants.aist="verified";account.state="ready";account.checked_at=new Date().toISOString();await this.accounts.put(account);}}for(const event of events)yield event;
  }catch(e){if(signal?.aborted)throw cancelled();if(e instanceof AppError)throw e;throw new AppError(502,"AI Studio 页面请求未完成","studio_browser_failed");}
  finally{signal?.removeEventListener("abort",abort);await page.close().catch(()=>{});lease.release();}
 }
 async close(){await this.accounts.pending;await this.browser.close();}
}
