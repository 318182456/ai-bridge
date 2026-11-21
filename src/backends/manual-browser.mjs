import {spawn} from "node:child_process";
import {mkdtemp,mkdir,rm,open,access} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {randomBytes} from "node:crypto";
import {setTimeout as sleep} from "node:timers/promises";
import {manualProxy,googleHost} from "./manual-proxy.mjs";
import {proxySetting} from "../runtime/tls-tunnel.mjs";
import {xwdPng} from "./xwd.mjs";
import {AppError} from "../common.mjs";
const failure=(code="manual_browser_failed")=>new AppError(503,"完整浏览器无法运行，请检查 Xvfb、xauth、xwd、xdotool、xclip 与 Chromium 依赖",code);
const keys={Enter:"Return",Backspace:"BackSpace",Delete:"Delete",Tab:"Tab",Escape:"Escape",ArrowLeft:"Left",ArrowRight:"Right",ArrowUp:"Up",ArrowDown:"Down",Home:"Home",End:"End",PageUp:"Prior",PageDown:"Next",Insert:"Insert"};
const modifiers={Control:"ctrl",Alt:"alt",Meta:"super",Shift:"shift"};
export class ManualBrowser{
 constructor({executable,profile,url="https://aistudio.google.com/prompts/new_chat",allowLocalTest=false}={}){Object.assign(this,{executable,profile:resolve(profile),url,allowLocalTest});this.size={width:1100,height:850};this.held=new Set();this.pending=Promise.resolve();this.confirmed=false;this.closed=false;}
 env(){const names=["PATH","SystemRoot","WINDIR","LANG","SSL_CERT_FILE"];return{...Object.fromEntries(names.filter(k=>process.env[k]).map(k=>[k,process.env[k]])),HOME:this.home,LANG:"C.UTF-8",DISPLAY:this.display,XAUTHORITY:this.authority};}
 // ASVS V1.2.5: fixed programs and argument arrays; text only on stdin, never a shell/argv.
 command(command,args,{input,max=16384,timeout=5000}={}){return new Promise((resolve,reject)=>{const child=spawn(command,args,{env:this.env(),stdio:["pipe","pipe","ignore"],shell:false,windowsHide:true}),parts=[];let size=0,exceeded=false;const timer=setTimeout(()=>child.kill("SIGKILL"),timeout);child.stdin.on("error",()=>{});child.once("error",()=>{clearTimeout(timer);reject(failure());});child.stdout.on("data",b=>{size+=b.length;if(size>max){exceeded=true;child.kill("SIGKILL");}else parts.push(b);});child.once("close",code=>{clearTimeout(timer);if(code===0&&!exceeded)resolve(Buffer.concat(parts));else reject(failure("manual_"+command+"_"+(exceeded?"output_limit":code===null?"timeout":"exit")));});child.stdin.end(input);});}
 child(command,args){const child=spawn(command,args,{env:this.env(),stdio:"ignore",shell:false,windowsHide:true});child.on("error",()=>{child.failed=true;});child.once("exit",()=>{child.stopped=true;});return child;}
 async start(signal){
  if(process.platform!=="linux")throw new AppError(503,"完整浏览器登录需要 Linux；请在 NAS、Docker 或 Linux 安装版中使用","manual_browser_platform");
  const url=new URL(this.url);if(!(url.protocol==="https:"&&googleHost(url.hostname))&&!(this.allowLocalTest&&url.protocol==="http:"&&url.hostname==="127.0.0.1"))throw new AppError(400,"完整浏览器只能打开官方 Google 登录地址");
  this.signal=signal;this.abort=()=>{this.cancelled=true;this.chrome?.kill("SIGTERM");};signal?.addEventListener("abort",this.abort,{once:true});if(signal?.aborted)throw new AppError(499,"登录已取消","cancelled");
  this.temp=await mkdtemp(join(tmpdir(),"ai-bridge-desktop-"));this.home=join(this.profile,".desktop-home");await mkdir(this.home,{recursive:true,mode:0o700});this.authority=join(this.temp,"Xauthority");
  // Private Xauthority, local Unix display only; no X11 TCP listener (ASVS V12/V14).
  for(let n=90;n<150;n++){try{await access("/tmp/.X11-unix/X"+n);continue;}catch(e){if(e.code!=="ENOENT")throw e;}try{const path=join(tmpdir(),"ai-bridge-display-"+n+".lock");this.lock=await open(path,"wx",0o600);this.lockPath=path;this.display=":"+n;break;}catch(e){if(e.code!=="EEXIST")throw e;}}
  if(!this.display)throw failure();await this.command("xauth",["-f",this.authority,"source","-"],{input:"add "+this.display+" . "+randomBytes(16).toString("hex")+"\n"});
  this.xvfb=this.child("Xvfb",[this.display,"-screen","0","1600x1000x24","-nolisten","tcp","-auth",this.authority,"-noreset"]);
  let ready=false;for(let i=0;i<40;i++){this.assertActive();try{await this.command("xdotool",["getdisplaygeometry"],{max:1024,timeout:1000});ready=true;break;}catch{await sleep(100);}}if(!ready)throw failure();
  if(proxySetting())this.proxy=await manualProxy();
  // No automation, debugging or headless switches. Show the actual browser chrome/address bar.
  this.args=["--user-data-dir="+this.profile,"--no-first-run","--no-default-browser-check","--disable-dev-shm-usage","--password-store=basic","--lang=zh-CN","--window-position=0,0","--window-size=1100,850",...(this.proxy?["--proxy-server="+this.proxy.server,"--disable-http2"]:[]),this.url];
  this.chrome=this.child(this.executable,this.args);
  for(let i=0;i<60;i++){this.assertActive();try{const ids=(await this.command("xdotool",["search","--onlyvisible","--pid",String(this.chrome.pid)],{timeout:1000})).toString().trim().split(/\s+/);if(ids[0]&&/^\d+$/.test(ids[0])){this.window=ids[0];break;}}catch{}await sleep(100);}
  if(!this.window)throw failure();await this.resize(this.size);await this.command("xdotool",["windowfocus",this.window]);return this;
 }
 assertActive(){if(this.cancelled||this.signal?.aborted)throw new AppError(499,"登录已取消","cancelled");if(this.closed||this.chrome?.stopped||this.chrome?.failed||this.xvfb?.stopped||this.xvfb?.failed)throw new AppError(503,"完整浏览器已关闭，请重新开始登录","manual_browser_closed");}
 async resize({width,height}){this.size={width:Math.max(640,Math.min(1600,Math.floor(width))),height:Math.max(480,Math.min(1000,Math.floor(height)))};if(this.window){await this.command("xdotool",["windowsize",this.window,String(this.size.width),String(this.size.height)]);await this.command("xdotool",["windowmove",this.window,"0","0"]);}}
 async capture(){this.assertActive();const dump=await this.command("xwd",["-root","-silent","-display",this.display],{max:16*1024*1024,timeout:5000});return xwdPng(dump,this.size);}
 async paste(text){
  await this.stop(this.clipboard);const child=this.clipboard=spawn("xclip",["-quiet","-selection","clipboard","-in"],{env:this.env(),stdio:["pipe","ignore","ignore"],shell:false,windowsHide:true});child.on("error",()=>{child.failed=true;});child.once("exit",()=>{child.stopped=true;});child.stdin.on("error",()=>{});child.stdin.end(text);
  let ready=false;for(let i=0;i<20;i++){if(child.failed||child.stopped)throw failure("manual_input_failed");try{if((await this.command("xclip",["-selection","clipboard","-out"],{max:65536,timeout:1000})).toString()===text){ready=true;break;}}catch{}await sleep(50);}if(!ready)throw failure("manual_clipboard_timeout");
  // Keep the selection owner alive until the next paste/close; Chromium may consume it asynchronously.
  await this.command("xdotool",["key","--clearmodifiers","ctrl+v"]);await sleep(100);
 }

 input(value){const action=async()=>{this.assertActive();if(value.type==="confirm"){this.confirmed=true;return;}if(value.type==="viewport"&&Number.isInteger(value.width)&&Number.isInteger(value.height)&&value.width>=320&&value.width<=1920&&value.height>=240&&value.height<=1200)return this.resize(value);
   if(value.type==="text"&&typeof value.text==="string"&&value.text.length<=16384)return this.paste(value.text);
   if(value.type==="key"&&typeof value.key==="string"&&value.key.length<=30&&["down","up"].includes(value.action)){
    if(modifiers[value.key]){if(value.action==="down")this.held.add(modifiers[value.key]);else this.held.delete(modifiers[value.key]);return;}if(value.action!=="down")return;
    if([...value.key].length===1&&!this.held.has("ctrl")&&!this.held.has("alt")&&!this.held.has("super"))return this.paste(value.key);
    const key=keys[value.key]||(/^[a-zA-Z0-9]$/.test(value.key)?value.key:/^F(?:[1-9]|1[0-2])$/.test(value.key)?value.key:null);if(key)return this.command("xdotool",["key","--clearmodifiers",[...this.held,key].join("+")]);return;
   }
   if(value.type==="pointer"&&Number.isFinite(value.x)&&Number.isFinite(value.y)){await this.command("xdotool",["mousemove",String(Math.round(Math.max(0,Math.min(this.size.width-1,value.x)))),String(Math.round(Math.max(0,Math.min(this.size.height-1,value.y))))]);if(["down","up"].includes(value.action))await this.command("xdotool",[value.action==="down"?"mousedown":"mouseup","1"]);}
   if(value.type==="wheel"&&Number.isFinite(value.dx)&&Number.isFinite(value.dy)){
    const x=Number.isFinite(value.x)?value.x:this.size.width/2,y=Number.isFinite(value.y)?value.y:this.size.height/2;await this.command("xdotool",["mousemove",String(Math.round(Math.max(0,Math.min(this.size.width-1,x)))),String(Math.round(Math.max(0,Math.min(this.size.height-1,y))))]);
    for(const [delta,positive,negative]of [[value.dy,5,4],[value.dx,7,6]])if(delta)await this.command("xdotool",["click","--repeat",String(Math.min(10,Math.max(1,Math.round(Math.abs(delta)/70)))),"--delay","10",String(delta>0?positive:negative)]);
   }
  };this.pending=this.pending.catch(()=>{}).then(action);return this.pending;
 }
 async stop(child){if(!child||child.stopped||child.exitCode!==null||child.signalCode)return;await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill("SIGKILL");resolve();},4000);child.once("exit",()=>{clearTimeout(timer);resolve();});child.kill("SIGTERM");});}
 async close(){if(this.closing)return this.closing;this.closing=(async()=>{await this.pending.catch(()=>{});this.closed=true;this.signal?.removeEventListener("abort",this.abort);await this.stop(this.chrome);await this.stop(this.clipboard);await this.proxy?.close();await this.stop(this.xvfb);await this.lock?.close();if(this.lockPath)await rm(this.lockPath,{force:true});if(this.temp)await rm(this.temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});})();return this.closing;}
}
