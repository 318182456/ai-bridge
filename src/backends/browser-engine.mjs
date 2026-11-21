import {googleCookies,studioURL} from "./browser-cookie-import.mjs";
import {importRobin} from "./robin-cookie-import.mjs";
import {authorizeRobin} from "./robin-authorization.mjs";
import {ManualBrowser} from "./manual-browser.mjs";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {setTimeout as sleep} from "node:timers/promises";
import {GoogleBrowserPool} from "./browser.mjs";
import {GoogleAccounts} from "./google-store.mjs";
import {binding,encodeRequest,decodeCatalog,decodeResponse,parse} from "./studio-wire.mjs";
import {studioFailure} from "./studio-failure.mjs";
import {AppError} from "../common.mjs";
const cancelled=()=>new AppError(499,"请求已取消","cancelled");
export class BrowserEngine {
 constructor({root,browser,accounts,logger,authorize,vault,manualFactory,bindRobin,credentialProvider}={}){this.credentialProvider=credentialProvider;this.preparingAccounts=new Map();this.appliedCookies=new WeakMap();this.identityMenus=new WeakSet();this.root=root;this.bindRobin=bindRobin;this.manualFactory=manualFactory===false?null:manualFactory||(!browser&&process.platform==="linux"?(options=>new ManualBrowser(options)):null);this.browser=browser||new GoogleBrowserPool({dataDir:root,logger,authVault:vault});this.accounts=accounts||new GoogleAccounts(root);this.jobs=new Map();this.cursor=0;this.authorize=authorize;this.vault=vault;}
 async prepareAccount(account,signal){
  if(!account.cookie_revision)return account;
  if(this.preparingAccounts.has(account.id)){await this.preparingAccounts.get(account.id);return this.accounts.get(account.id);}
  const work=(async()=>{const cookie=await this.credentialProvider?.(account.id);if(!cookie||cookie.revision!==account.cookie_revision)throw new AppError(401,"同步 Cookie 不可用，请重新同步","google_cookies_missing");const lease=await this.browser.acquire(account.id,signal);const applied=this.appliedCookies.get(lease.context)===cookie.revision;lease.release();if(applied&&account.models?.length)return;
   for await(const _ of this.login(randomUUID(),{account_id:account.id,expected_email:account.email,cookies:cookie.cookies,authuser:cookie.authuser,cookie_revision:cookie.revision,verify_generation:false},signal)){}
  })();this.preparingAccounts.set(account.id,work);try{await work;return await this.accounts.get(account.id);}finally{this.preparingAccounts.delete(account.id);}
 }
 async selectAccount(input){const accounts=(await this.accounts.list()).filter(a=>a.enabled&&["verified","authenticated","synced"].includes(a.grants?.aist)&&(!input.account_id||input.account_id===a.id)&&((a.models||[]).some(m=>m.id===input.model)||!!a.cookie_revision&&!a.models?.length));if(!accounts.length)throw new AppError(503,"没有支持此模型的已验证 AI Studio 账号","no_eligible_account");return accounts[input.account_id?0:this.cursor++%accounts.length].id;}
 async *run(op,input={},signal){
  if(signal?.aborted)throw cancelled();const id=randomUUID();
  if(op==="accounts"){yield{result:{accounts:(await this.accounts.list()).map(a=>({id:a.id,label:a.email,enabled:a.enabled,state:a.state,benefit_tier:a.tier||"未提供",models:a.models||[],grants:a.grants||{},agy_account_id:a.agy_account_id||null,usage:a.usage||{},checked_at:a.checked_at||null}))}};return;}
  if(op==="set_enabled"){const a=await this.accounts.get(input.id);if(input.enabled&&a.state!=="ready"&&!Object.values(a.grants||{}).some(v=>["synced","authenticated"].includes(v)))throw new AppError(409,"请先完成实际生成验证");a.enabled=!!input.enabled;await this.accounts.save();yield{result:{updated:true}};return;}
  if(op==="models"){const candidates=(await this.accounts.list()).filter(a=>a.enabled&&a.cookie_revision);for(const a of candidates)await this.prepareAccount(a,signal);const rows=(await this.accounts.list()).filter(a=>a.enabled&&["verified","authenticated","synced"].includes(a.grants?.aist)),all=new Map();for(const a of rows)for(const m of a.models||[])all.set(m.id,m);yield{result:{models:[...all.values()]}};return;}
  if(op==="login"){yield* this.login(id,input,signal);return;}
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
 async *manualLogin(id,profile,url,signal,phase="manual"){
  await this.browser.runtime?.prepare();await this.vault?.restore("google",profile);const desktop=this.manualFactory({executable:await this.browser.runtime?.executable(),profile:join(this.root,"google/profiles",profile),url}),job={id,manual:desktop,phase};this.jobs.set(id,job);
  try{yield{browser_meta:{type:"status",status:"starting"},native_job:id};await desktop.start(signal);yield{browser_meta:{type:"status",status:phase},native_job:id};const until=Date.now()+10*60000;let lastFrame=null;
   while(!desktop.confirmed){if(job.inputError)throw job.inputError;if(signal?.aborted)throw cancelled();if(Date.now()>until)throw new AppError(408,"完整浏览器登录超过十分钟","login_timeout");const image=await desktop.capture();if(image!==lastFrame){lastFrame=image;yield{browser_meta:{type:"frame",context:id,width:image.width,height:image.height,min_width:640,min_height:480,max_width:1600,max_height:1200,desktop:true},native_job:id};yield{browser_binary:image.bytes.toString("base64"),native_job:id};}await sleep(Date.now()-(desktop.lastInputAt||0)<1500?100:500,undefined,{signal});}
   return{skipped:!!desktop.skipped};
  }catch(error){if(signal?.aborted)throw cancelled();throw error;}finally{await desktop.close();this.jobs.delete(id);}
 }
 async *login(id,input,signal){
  if(input.account_id&&!/^g_[a-f0-9]{24}$/.test(input.account_id))throw new AppError(400,"Google 账号标识无效");
  if(input.target==="robin"&&input.oauth_token){yield* importRobin(this,id,input,signal);return;}
  if(input.target==="robin"){if(!input.account_id)throw new AppError(400,"请先选择已有 Google 账号","account_required");const result=yield* authorizeRobin(this,id,input.account_id,signal);yield{result:{account:{id:result.account.id,email:result.account.email,state:result.account.state}},native_job:id};return;}
  const profile=input.account_id||("g_"+randomUUID().replaceAll("-","").slice(0,24));yield{browser_meta:{type:"status",status:"preparing"},native_job:id};
  let previous;try{previous=await this.accounts.get(profile);}catch(error){if(error.status!==404)throw error;}const imported=!!input.cookies;const authuser=imported?input.authuser:(previous?.authuser||0);if(!Number.isInteger(authuser)||authuser<0||authuser>99)throw new AppError(400,"Google 账号序号无效");let verified=false,prepared=false;if(input.verify_generation!==false)await this.browser.checkpoint?.(profile);this.vault?.unmark?.("google",profile);
  if(this.manualFactory&&!imported)try{yield* this.manualLogin(id,profile,studioURL(previous),signal);}catch(error){if(previous&&this.vault){await this.vault.restore("google",profile,{force:true});if(Object.values(previous.grants||{}).includes("verified"))this.vault.mark("google",profile);}throw error;}
  const lease=await this.browser.acquire(profile,signal),context=lease.context,page=await context.newPage();const job={page,context,id};this.jobs.set(id,job);let models=[],phase="cookie_import";const detach=this.captureCatalog(page,value=>{models=value;});const abort=()=>page.close().catch(()=>{});signal?.addEventListener("abort",abort,{once:true});
  try{
   if(imported){const cookies=googleCookies(input.cookies);input.cookies=null;await context.clearCookies();await context.addCookies(cookies);}
   yield{browser_meta:{type:"status",status:"starting"},native_job:id};
   if(!imported){yield{browser_meta:{type:"frame",context:id,...(page.viewportSize?.()||{width:1280,height:800})},native_job:id};yield{browser_binary:(await page.screenshot({type:"jpeg",quality:65,timeout:10000})).toString("base64"),native_job:id};}phase="navigation";
   try{await page.goto(studioURL({authuser}),{waitUntil:"commit",timeout:45000});}catch(error){
    // ASVS V16.5: expose an actionable class, never raw navigation URLs or credentials.
    if(signal?.aborted)throw cancelled();
    const network=String(error.message||"").match(/net::ERR_[A-Z_]+/)?.[0]||"";
    if(error.name==="TimeoutError")throw new AppError(504,"连接 Google 登录页超时，请检查 NAS 代理能否访问 accounts.google.com 和 aistudio.google.com","google_page_timeout");
    if(/PROXY|TUNNEL/.test(network))throw new AppError(502,"Google 登录代理连接失败，请检查代理地址和认证配置","google_proxy_failed");
    if(/CERT|SSL/.test(network))throw new AppError(502,"Google 登录连接的 TLS 证书校验失败","google_tls_failed");
    throw new AppError(502,"Google 登录页连接失败，请检查 NAS 出口网络","google_page_failed");
   }yield{browser_meta:{type:"status",status:this.manualFactory?"verifying":"waiting"},native_job:id};const until=Date.now()+(imported?90000:10*60000);phase="identity";
   while(Date.now()<until){if(signal?.aborted)throw cancelled();
    const url=new URL(page.url());if(this.manualFactory&&url.hostname==="accounts.google.com")throw new AppError(401,"尚未保留 Google 登录，请在完整浏览器中进入 AI Studio 后再点击继续验证","manual_login_incomplete");if(url.hostname==="aistudio.google.com"&&url.pathname.includes("available-regions"))throw new AppError(403,"Google 不支持当前出口地区或账号","region_or_account_unsupported");
    const email=url.hostname==="aistudio.google.com"?await this.email(page):"";
    if(email&&models.length&&await page.locator("ms-prompt-box textarea").isVisible().catch(()=>false)){
      const old=previous;const expected=old?.email||input.expected_email;if(expected&&expected.toLowerCase()!==email.toLowerCase())throw new AppError(409,"请使用该账号原有 Google 身份登录，其他身份请添加新账号","account_identity_mismatch");const account=old?{...old,models,grants:{...old.grants}}:{id:profile,email,enabled:false,state:"authenticated",models,grants:{agy:"not_authorized",robin:"not_authorized",aist:"authenticated"},checked_at:null};account.authuser=authuser;if(!imported)delete account.cookie_revision;if(!old)await this.accounts.put(account);
      yield{browser_meta:{type:"status",status:"saving"},native_job:id};
      const model=models.find(m=>m.capabilities.includes(1)&&/flash/i.test(m.id))||models.find(m=>m.capabilities.includes(1));if(!model)throw new AppError(503,"账号未返回可验证的文本模型","no_test_model");
      if(input.verify_generation===false){account.grants.aist=old?.grants?.aist==="verified"?"verified":"authenticated";account.state=Object.values(account.grants).includes("verified")?"ready":"authenticated";await this.accounts.put(account);this.appliedCookies.set(context,input.cookie_revision);prepared=true;yield{result:{account:{id:profile,email,state:account.state}},native_job:id};return;}
      phase="generation";let text="";for await(const event of this.generate(account,{auth_verification:true,model:model.id,contents:[{role:"user",parts:[{text:"Reply with OK only."}]}],config:{max_output_tokens:8},system:[],tools:{}},signal))if(event.kind==="text")text+=event.text;
      if(!text.trim())throw new AppError(502,"Google 登录成功，但生成验证未返回正文","verification_failed");
      verified=true;this.vault?.mark("google",profile);account.enabled=old&&Object.values(old.grants||{}).includes("verified")?old.enabled:true;account.state="ready";account.grants.aist="verified";account.checked_at=new Date().toISOString();await this.accounts.put(account);
      if(!imported&&!this.manualFactory&&this.authorize)for await(const value of this.authorize({account,context,page,signal,id,owner:input.owner,setPage:p=>{job.page=p;}}))yield value;
      if(!imported&&this.manualFactory&&this.bindRobin&&account.grants.robin!=="verified"){
       await page.close().catch(()=>{});lease.release();await this.browser.checkpoint?.(profile);
       try{const result=yield* authorizeRobin(this,id,profile,signal,{allowSkip:true});Object.assign(account,result.account);}
       catch(error){if(signal?.aborted)throw cancelled();yield{browser_meta:{type:"status",status:"partial",message:error instanceof AppError?error.message:"Robin 授权未完成；AI Studio 已保留"},native_job:id};}
      }
      yield{result:{account:{id:profile,email,state:account.state}},native_job:id};return;
    }
    if(!imported){yield{browser_meta:{type:"frame",context:id,...(page.viewportSize?.()||{width:1280,height:800})},native_job:id};const bytes=await page.screenshot({type:"jpeg",quality:65,timeout:10000});yield{browser_binary:bytes.toString("base64"),native_job:id};}await sleep(imported?500:180,undefined,{signal});
   }throw imported?new AppError(401,"无法确认导入的 Google 身份或模型目录，请在本机进入 AI Studio 并选择所填账号后重新同步","import_identity_unverified"):new AppError(408,"Google 登录超过十分钟","login_timeout");
  }catch(e){if(signal?.aborted)throw cancelled();if(e instanceof AppError)throw e;if(imported){const errors={cookie_import:["Google 浏览器未能接收同步 Cookie，请重新安装最新脚本并同步","google_cookie_import_failed"],identity:["同步后 Google 页面未就绪或未能确认身份，请检查会话与 NAS 网络","google_identity_page_failed"],generation:["Google 生成校验未完成，已保留原有授权","google_verification_failed"]};const [message,code]=errors[phase]||["同步后 Google 页面加载失败，请检查 NAS 网络","google_import_page_failed"];throw new AppError(503,message,code);}throw new AppError(503,"Google 浏览器登录未完成，请重试","browser_login_failed");}
  finally{detach();this.jobs.delete(id);signal?.removeEventListener("abort",abort);await page.close().catch(()=>{});lease.release();if(!prepared)await this.browser.checkpoint?.(profile);if(!verified&&!prepared&&previous&&this.vault){await this.vault.restore("google",profile,{force:true});if(Object.values(previous.grants||{}).includes("verified"))this.vault.mark("google",profile);}}
 }
 async *generate(account,request,signal){
  if(!request.auth_verification)account=await this.prepareAccount(account,signal);
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
   const events=decodeResponse(body);if(!request.auth_verification&&events.some(e=>e.kind==="text"||e.kind==="function_call"||e.kind==="media")){this.vault?.mark("google",account.id);if(account.grants.aist!=="verified"){account.grants.aist="verified";account.state="ready";account.checked_at=new Date().toISOString();await this.accounts.put(account);}}for(const event of events)yield event;
  }catch(e){if(signal?.aborted)throw cancelled();if(e instanceof AppError)throw e;throw new AppError(502,"AI Studio 页面请求未完成","studio_browser_failed");}
  finally{signal?.removeEventListener("abort",abort);await page.close().catch(()=>{});lease.release();}
 }
 input(id,value){const j=this.jobs.get(id);if(!j||value.context!==id)return;if(j.manual){if(value.type==="skip"&&j.phase==="manual_robin"){j.manual.skipped=true;value={...value,type:"confirm"};}j.manual.input(value).catch(error=>{j.inputError=error;});return;}const page=j.page;const task=async()=>{if(value.type==="viewport"&&Number.isInteger(value.width)&&value.width>=320&&value.width<=1920&&Number.isInteger(value.height)&&value.height>=240&&value.height<=1200)await page.setViewportSize({width:value.width,height:value.height});else if(value.type==="text"&&typeof value.text==="string"&&value.text.length<=16384)await page.keyboard.insertText(value.text);else if(value.type==="key"&&["down","up"].includes(value.action)&&typeof value.key==="string"&&value.key.length<=30)await page.keyboard[value.action](value.key);else if(value.type==="pointer"&&Number.isFinite(value.x)&&Number.isFinite(value.y)){await page.mouse.move(Math.max(0,Math.min((page.viewportSize?.()?.width||1280)-1,value.x)),Math.max(0,Math.min((page.viewportSize?.()?.height||800)-1,value.y)));if(["down","up"].includes(value.action))await page.mouse[value.action]({button:"left"});}else if(value.type==="wheel"&&Number.isFinite(value.dx)&&Number.isFinite(value.dy))await page.mouse.wheel(Math.max(-2000,Math.min(2000,value.dx)),Math.max(-2000,Math.min(2000,value.dy)));};j.inputs=(j.inputs||Promise.resolve()).then(task).catch(()=>{});}
 async close(){for(const j of this.jobs.values())await(j.manual?j.manual.close():j.page.close()).catch(()=>{});this.jobs.clear();await this.accounts.pending;await this.browser.close();}
}
