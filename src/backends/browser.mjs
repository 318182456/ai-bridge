import {mkdir,readdir,access,readFile} from "node:fs/promises";
import {join,resolve,dirname} from "node:path";
import {createRequire} from "node:module";
import {spawn} from "node:child_process";
import {AppError} from "../common.mjs";
const require=createRequire(import.meta.url);
export class GoogleBrowser {
 constructor({dataDir,idleMs=120000,launch,logger,authVault=null,spawnProcess=spawn}={}){Object.assign(this,{spawnProcess,authVault,root:join(dataDir,"google"),idleMs,launch,logger});this.context=null;this.profile=null;this.users=0;this.starting=null;this.installing=null;this.timer=null;this.closed=false;this.phase="idle";}
 status(){return{state:this.phase,active_requests:this.users,browser_running:!!this.context};}
 async executable(){
  if(process.env.BROWSER_EXECUTABLE)return resolve(process.env.BROWSER_EXECUTABLE);
  const metadata=JSON.parse(await readFile(join(dirname(require.resolve("playwright-core/package.json")),"browsers.json"),"utf8"));const revision=metadata.browsers.find(b=>b.name==="chromium")?.revision;
  for(const dir of await readdir(join(this.root,"browser-cache")).catch(()=>[]))if(dir==="chromium-"+revision)for(const exe of ["chrome-linux64/chrome","chrome-linux/chrome","chrome-win64/chrome.exe","chrome-win/chrome.exe"]){const path=join(this.root,"browser-cache",dir,exe);try{await access(path);return path;}catch{}}
  return null;
 }
 async prepare(){
  if(this.launch||await this.executable())return;
  if(this.installing)return this.installing;
  this.phase="preparing";
  this.installing=(async()=>{await mkdir(join(this.root,"browser-cache"),{recursive:true,mode:0o700});await new Promise((resolve,reject)=>{
   const child=this.spawnProcess(process.execPath,[join(dirname(require.resolve("playwright-core/package.json")),"cli.js"),"install","chromium","--no-shell"],{env:{...safeEnvironment(),PLAYWRIGHT_BROWSERS_PATH:join(this.root,"browser-cache")},stdio:"ignore",windowsHide:true,shell:false});
   this.installChild=child;const timer=setTimeout(()=>child.kill(),10*60000);child.once("error",()=>{clearTimeout(timer);reject(new AppError(503,"浏览器下载无法启动","browser_prepare_failed"));});child.once("close",code=>{this.installChild=null;clearTimeout(timer);if(code===0)resolve();else reject(new AppError(503,"浏览器准备失败，请检查网络与磁盘空间","browser_prepare_failed"));});
  });})().finally(()=>{this.installing=null;this.phase=this.context?"ready":"idle";});return this.installing;
 }
 async acquire(profile,signal){
  if(!/^g_[a-f0-9]{24}$/.test(profile))throw new AppError(400,"Google 账号标识无效");if(signal?.aborted)throw new AppError(499,"请求已取消","cancelled");if(this.closed)throw new AppError(503,"浏览器管理器已关闭");clearTimeout(this.timer);
  if(this.starting){await this.starting;if(signal?.aborted)throw new AppError(499,"请求已取消","cancelled");}
  if(this.context&&this.profile!==profile){if(this.users)throw new AppError(429,"另一 Google 账号正在使用浏览器","browser_busy");await this.stop();}
  if(!this.context){this.starting=(async()=>{
   await this.prepare();if(this.closed||signal?.aborted)throw new AppError(499,"请求已取消","cancelled");this.phase="starting";
   const dir=join(this.root,"profiles",profile);await this.authVault?.restore("google",profile);await mkdir(dir,{recursive:true,mode:0o700});
   // Some authenticated CONNECT proxies stall Chromium HTTP/2; retain normal TLS validation.
   const factory=this.launch||((path,options)=>import("playwright-core").then(m=>m.chromium.launchPersistentContext(path,options)));
   try{this.context=await factory(dir,{env:safeEnvironment(),...browserProxy(),executablePath:await this.executable(),headless:true,...(proxySettingForBrowser()?{args:["--disable-http2"]}:{}),viewport:{width:1280,height:800},locale:"zh-CN",timezoneId:"Asia/Shanghai",acceptDownloads:false,chromiumSandbox:process.env.BROWSER_SANDBOX!=="false"});}catch{this.phase="failed";throw new AppError(503,"浏览器无法启动，请检查系统运行依赖与沙盒设置","browser_launch_failed");}
   this.profile=profile;this.phase="ready";this.timer=setTimeout(()=>{if(!this.users)this.stop().catch(()=>{});},this.idleMs);this.timer.unref?.();const context=this.context;context.on?.("close",()=>{if(this.context===context){this.context=null;this.profile=null;this.phase="idle";}});
  })().finally(()=>{this.starting=null;});await this.starting;}
  if(signal?.aborted)throw new AppError(499,"请求已取消","cancelled");this.users++;let released=false;
  return{context:this.context,release:()=>{if(released)return;released=true;this.users--;if(!this.users&&!this.closed){this.timer=setTimeout(()=>{if(!this.users)this.stop().catch(()=>{});},this.idleMs);this.timer.unref?.();}}};
 }
 async stop(){clearTimeout(this.timer);const context=this.context,profile=this.profile;this.context=null;this.profile=null;if(context){await context.close().catch(()=>{});if(profile)await this.authVault?.capture("google",profile);}this.phase="idle";}
 async close(){this.closed=true;this.installChild?.kill();await this.starting?.catch(()=>{});await this.stop();}
}

function safeEnvironment(){const keys=["PATH","SystemRoot","WINDIR","USERPROFILE","LOCALAPPDATA","HOMEDRIVE","HOMEPATH","HOME","TMP","TEMP","TMPDIR","SSL_CERT_FILE","HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY"];return Object.fromEntries(keys.filter(k=>process.env[k]).map(k=>[k,process.env[k]]));}
function proxySettingForBrowser(){return process.env.HTTPS_PROXY||process.env.HTTP_PROXY||process.env.ALL_PROXY;}
function browserProxy(){const value=proxySettingForBrowser();if(!value)return{};try{const url=new URL(value);if(!["http:","https:","socks5:"].includes(url.protocol))return{};const username=decodeURIComponent(url.username),password=decodeURIComponent(url.password);url.username="";url.password="";return{proxy:{server:url.origin==="null"?url.protocol+"//"+url.host:url.origin,...(username?{username,password}:{})}};}catch{return{};}}

// At most two Chromium profiles by default. Requests for one profile share a context,
// while each generation has its own page and request binding.
export class GoogleBrowserPool {
 constructor({dataDir,limit=Number(process.env.MAX_BROWSER_CONTEXTS||2),launch,logger,...options}={}){
  if(!Number.isInteger(limit)||limit<1||limit>4)throw Error("MAX_BROWSER_CONTEXTS must be 1–4");
  Object.assign(this,{dataDir,limit,launch,logger,options});this.entries=new Map();this.waiters=new Set();this.closed=false;
  this.runtime=new GoogleBrowser({dataDir,launch,logger,...options});
 }
 status(){const entries=[...this.entries.values()];return{state:entries.some(b=>b.context)?"ready":this.runtime.phase,active_requests:entries.reduce((n,b)=>n+b.users,0),browser_running:entries.some(b=>b.context),contexts:entries.filter(b=>b.context).length,context_limit:this.limit};}
 notify(){for(const done of [...this.waiters])done();}
 wait(signal){return new Promise((resolve,reject)=>{const done=()=>{cleanup();resolve();};const abort=()=>{cleanup();reject(new AppError(499,"请求已取消","cancelled"));};const cleanup=()=>{this.waiters.delete(done);signal?.removeEventListener("abort",abort);};this.waiters.add(done);signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();});}
 async acquire(profile,signal){
  if(!/^g_[a-f0-9]{24}$/.test(profile))throw new AppError(400,"Google 账号标识无效");
  if(signal?.aborted)throw new AppError(499,"请求已取消","cancelled");
  const preparing=this.runtime.prepare();if(signal)await new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener("abort",abort);reject(new AppError(499,"请求已取消","cancelled"));};signal.addEventListener("abort",abort,{once:true});preparing.then(()=>{signal.removeEventListener("abort",abort);resolve();},e=>{signal.removeEventListener("abort",abort);reject(e);});if(signal.aborted)abort();});else await preparing;
  for(;;){
   if(this.closed)throw new AppError(503,"浏览器管理器已关闭");if(signal?.aborted)throw new AppError(499,"请求已取消","cancelled");
   let browser=this.entries.get(profile);
   if(browser?.poolClosing){await this.wait(signal);continue;}
   if(!browser){
    if(this.entries.size>=this.limit){const idle=[...this.entries].find(([,b])=>!b.users&&!b.starting&&!b.poolClosing);if(!idle){await this.wait(signal);continue;}idle[1].poolClosing=true;await idle[1].close();this.entries.delete(idle[0]);this.notify();continue;}
    browser=new GoogleBrowser({dataDir:this.dataDir,launch:this.launch,logger:this.logger,...this.options});this.entries.set(profile,browser);
   }
   try{const lease=await browser.acquire(profile,signal);let released=false;return{context:lease.context,release:()=>{if(released)return;released=true;lease.release();this.notify();}};}
   catch(error){if(!browser.users&&!browser.starting&&this.entries.get(profile)===browser){this.entries.delete(profile);await browser.close();this.notify();}throw error;}
  }
 }
 async checkpoint(profile){const browser=this.entries.get(profile);if(browser&&!browser.users&&!browser.starting){browser.poolClosing=true;await browser.close();this.entries.delete(profile);this.notify();}}
 async close(){this.closed=true;this.notify();await Promise.allSettled([...this.entries.values()].map(b=>b.close()));this.entries.clear();await this.runtime.close();}
}
