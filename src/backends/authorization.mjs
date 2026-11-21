import {setTimeout as sleep} from "node:timers/promises";
import {AppError} from "../common.mjs";
function callback(url){let parsed;try{parsed=new URL(url);}catch{return null;}const redirect=parsed.searchParams.get("redirect_uri");if(parsed.protocol!=="https:"||parsed.hostname!=="accounts.google.com"||!redirect)throw new AppError(400,"官方 CLI 授权地址不符合预期","invalid_oauth_url");const target=new URL(redirect);if(target.protocol!=="https:"||!(target.hostname==="google.com"||target.hostname.endsWith(".google.com")))throw new AppError(400,"CLI 授权回调不在 Google 官方站点","invalid_oauth_redirect");return target;}
async function frame(page,id){return[{browser_meta:{type:"frame",context:id,...(page.viewportSize?.()||{width:1280,height:800})},native_job:id},{browser_binary:(await page.screenshot({type:"jpeg",quality:65,timeout:10000})).toString("base64"),native_job:id}];}
export class GoogleAuthorization {
 constructor({accounts,grants,store,loginManager,robin}){Object.assign(this,{accounts,grants,store,loginManager,robin});}
 async *authorize({account,context,page,signal,id,owner,setPage}){
  if(!owner)throw new AppError(401,"共享授权缺少发起会话");
  if(account.grants?.agy!=="verified"){
   let profile=account.agy_account_id?this.store.get(account.agy_account_id):null;
   if(!profile){profile=await this.store.create({name:account.email});account.agy_account_id=profile.id;await this.accounts.put(account);}
   const release=await this.loginManager.queue.acquireWrite(profile.id,signal);let submitted=false,expected=null;
   try{
    this.loginManager.start(owner,profile.id,{withinLogin:true,signal});
    const until=Date.now()+10*60000;
    while(Date.now()<until){if(signal.aborted)throw new AppError(499,"授权已取消","cancelled");const state=this.loginManager.view(owner,profile.id);
     if(state.state==="verified"){await this.store.patch(profile.id,{enabled:true});account.grants.agy="verified";await this.accounts.put(account);break;}
     if(["failed","expired","stopped"].includes(state.state))throw new AppError(401,"agy 官方登录或生成校验未通过","agy_authorization_failed");
     if(state.url&&!expected){expected=callback(state.url);await page.goto(state.url,{waitUntil:"domcontentloaded",timeout:60000});setPage(page);}
     if(expected&&!submitted){const current=new URL(page.url());if(current.origin===expected.origin&&current.pathname===expected.pathname){let code=current.searchParams.get("code");if(!code)code=await page.locator('code,input[readonly],textarea[readonly]').evaluateAll(nodes=>nodes.map(n=>n.value||n.textContent||"").find(v=>/^[A-Za-z0-9_./~+\-=]{4,2048}$/.test(v.trim()))?.trim()||"");if(code){this.loginManager.input(owner,profile.id,{code});submitted=true;}}}
     yield{browser_meta:{type:"status",status:submitted?"saving":"waiting"},native_job:id};for(const value of await frame(page,id))yield value;await sleep(250,undefined,{signal});
    }
    if(account.grants.agy!=="verified")throw new AppError(408,"agy 授权超时");
   }catch(error){account.grants.agy="needs_attention";await this.accounts.put(account);try{this.loginManager.stop(owner,profile.id);}catch{}if(signal.aborted)throw error;}finally{const current=this.loginManager.current;try{if(current?.owner===owner&&current.id===profile.id)await current.work;}finally{release();}}
  }
  if(account.grants?.robin!=="verified"){
   try{
    await context.clearCookies({name:"oauth_token"});
    const url=new URL("https://accounts.google.com/EmbeddedSetup");url.search=new URLSearchParams({source:"android",xoauth_display_name:"Android Device",lang:"zh",cc:"cn",langCountry:"zh_CN",hl:"zh-CN",tmpl:"new_account"}).toString();
    await page.goto(url.href,{waitUntil:"domcontentloaded",timeout:60000});setPage(page);const until=Date.now()+5*60000;let token="";
    while(Date.now()<until){if(signal.aborted)throw new AppError(499,"授权已取消","cancelled");token=(await context.cookies("https://accounts.google.com")).find(c=>c.name==="oauth_token")?.value||"";if(token)break;for(const value of await frame(page,id))yield value;await sleep(250,undefined,{signal});}
    if(!token)throw new AppError(401,"Google 未返回 Robin 授权结果","robin_authorization_missing");
    await this.grants.bindRobin(account,token,signal);token="";await context.clearCookies({name:"oauth_token"});await this.robin.verify(account,signal);account.grants.robin="verified";await this.accounts.put(account);
   }catch(error){account.grants.robin="needs_attention";await this.accounts.put(account);if(signal.aborted)throw error;}
  }
 }
}
