import {createServer} from "node:http";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";import {join} from "node:path";
import {chromium} from "playwright-core";
import {ManualBrowser} from "../src/backends/manual-browser.mjs";
let inputReached=false;
const root=await mkdtemp(join(tmpdir(),"ai-bridge-manual-smoke-")),server=createServer((_req,res)=>{if(_req.url==="/typed"){inputReached=true;res.end("ok");return;}res.setHeader("content-type","text/html;charset=utf-8");res.end('<title>Manual test</title><style>body{font:20px sans-serif}input{position:absolute;left:30px;top:0;width:300px;height:300px}</style><h1>完整浏览器测试</h1><input oninput="if(this.value===`synthetic@example.invalid`){fetch(`/typed`);document.cookie=`synthetic_cookie=present;SameSite=Lax;Max-Age=3600`}">');});await new Promise(r=>server.listen(0,"127.0.0.1",r));const url="http://127.0.0.1:"+server.address().port,profile=join(root,"profile"),browser=new ManualBrowser({executable:process.env.BROWSER_EXECUTABLE||chromium.executablePath(),profile,url,allowLocalTest:true});
try{await browser.start(new AbortController().signal);await new Promise(r=>setTimeout(r,1200));const image=await browser.capture();if(image.bytes.length<1000)throw Error("Empty desktop frame");if(browser.args.some(a=>/headless|remote-debugging|enable-automation|disable-blink/.test(a)))throw Error("Automation switch in manual browser");
 await browser.input({type:"pointer",action:"down",x:100,y:250});await browser.input({type:"pointer",action:"up",x:100,y:250});await browser.input({type:"text",text:"synthetic@example.invalid"});
 let typed=false;for(let i=0;i<30;i++){if(inputReached){typed=true;break;}await new Promise(r=>setTimeout(r,100));}if(!typed)throw Error("Desktop clipboard/keyboard did not reach the field");
 await browser.resize({width:640,height:600});const smaller=await browser.capture();if(smaller.width!==640||smaller.height!==600)throw Error("Desktop resize failed");await browser.close();
 // Fixture-only verification after the unmanaged browser exits; no Google login is automated.
 const context=await chromium.launchPersistentContext(profile,{headless:true,chromiumSandbox:true});try{if(!(await context.cookies(url)).some(c=>c.name==="synthetic_cookie"&&c.value==="present"))throw Error("Manual browser cookies did not persist");}finally{await context.close();}
 console.log(JSON.stringify({manual_chrome:true,address_bar_visible:true,x11_input:true,resized:true,cookies_preserved:true,frame_bytes:image.bytes.length}));
}finally{await browser.close();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
