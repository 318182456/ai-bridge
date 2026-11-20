import {el,action,emptyRows,note,socketProtocols} from "../core.mjs";
export function mount(ctx){
 const $=ctx.$;let disposed=false,poll=null,socket=null,view=null,frame=null,sequence=0,loading=false;
 const states={stopped:"未启动",starting:"启动中",ready:"运行中",managed:"按任务管理",failed:"异常冷却中",stopping:"回收中",not_configured:"尚未配置"};
 function closeSocket(){sequence++;socket?.close();socket=null;view=null;frame=null;$("googleBrowser").hidden=true;const canvas=$("googleCanvas");canvas.getContext("2d").clearRect(0,0,canvas.width,canvas.height);$("googleKeyboard").value="";}
 function send(message){if(socket?.readyState===WebSocket.OPEN&&frame)socket.send(JSON.stringify({...message,context:frame.context}));}
 function connect(id){
   if(view===id&&socket&&socket.readyState<=1)return;closeSocket();view=id;
   const url=new URL("/api/backends/aist/login-view/"+id,location.origin);url.protocol=location.protocol==="https:"?"wss:":"ws:";
   socket=new WebSocket(url,socketProtocols());socket.binaryType="blob";let meta;
   socket.onmessage=async event=>{
     if(disposed)return;
     if(typeof event.data==="string"){try{const value=JSON.parse(event.data);if(value.type==="status")$("aistLoginStatus").textContent=({preparing:"准备浏览器，首次使用可能需要下载…",starting:"准备登录浏览器…",waiting:"请在下方 Google 页面完成登录",saving:"登录已识别，正在验证并保存账号"})[value.status]||"正在登录";else if(value.type==="dialog")note("aistFeedback","Google 页面需要处理浏览器确认，请检查登录画面",true);else meta=value;}catch{}return;}
     if(!meta||!Number.isFinite(meta.width)||meta.width>4096||meta.height>4096)return;
     const current=++sequence,bitmap=await createImageBitmap(event.data);if(disposed||current!==sequence){bitmap.close();return;}
     const canvas=$("googleCanvas");canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext("2d").drawImage(bitmap,0,0);bitmap.close();frame=meta;$("googleBrowser").hidden=false;
   };
   socket.onclose=()=>{if(!disposed&&view===id)$("aistLoginStatus").textContent="登录窗口已断开，后台授权状态仍在查询";};
   socket.onerror=()=>{};
 }
 const point=e=>{const rect=$("googleCanvas").getBoundingClientRect();return{x:Math.max(0,Math.min(frame.width-1,(e.clientX-rect.left)/rect.width*frame.width)),y:Math.max(0,Math.min(frame.height-1,(e.clientY-rect.top)/rect.height*frame.height))};};
 const canvas=$("googleCanvas"),keyboard=$("googleKeyboard");
 canvas.onpointerdown=e=>{if(!frame)return;e.preventDefault();keyboard.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);send({type:"pointer",action:"down",button:0,...point(e)});};
 canvas.onpointerup=e=>{if(frame)send({type:"pointer",action:"up",button:0,...point(e)});};
 canvas.onpointermove=e=>{if(frame&&e.buttons)send({type:"pointer",action:"move",...point(e)});};
 canvas.onwheel=e=>{if(!frame)return;e.preventDefault();send({type:"wheel",dx:e.deltaX,dy:e.deltaY,...point(e)});};
 for(const target of [canvas,keyboard]){
   target.onkeydown=e=>{if(e.isComposing||["Process","Unidentified","Dead"].includes(e.key))return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="v")return;e.preventDefault();send({type:"key",action:"down",key:e.key});};
   target.onkeyup=e=>{if(!e.isComposing){e.preventDefault();send({type:"key",action:"up",key:e.key});}};
   target.onpaste=e=>{e.preventDefault();const text=e.clipboardData?.getData("text/plain");if(text){send({type:"key",action:"up",key:"Control"});send({type:"key",action:"up",key:"Meta"});send({type:"text",text});}};
 }
 keyboard.oncompositionend=e=>{if(e.data)send({type:"text",text:e.data});keyboard.value="";};
 keyboard.oninput=e=>{if(e.isComposing)return;if(e.inputType==="insertText"&&e.data)send({type:"text",text:e.data});keyboard.value="";};
 async function loginState(){
   if(loading||disposed)return;loading=true;
   try{const data=await ctx.api("/api/backends/aist/login");if(disposed)return;
     $("aistLoginPanel").hidden=false;
     const running=["waiting","running"].includes(data.state);$("beginGoogleLogin").disabled=running;$("cancelGoogleLogin").hidden=!running;
     if(data.state==="waiting")$("aistLoginStatus").textContent="等待正在执行的请求结束，随后启动登录";
     if(data.view)connect(data.view);
     if(!running){closeSocket();clearInterval(poll);$("aistLoginStatus").textContent=data.state==="done"?"授权流程已结束，请查看各后端独立验证状态":data.error||"登录已取消";if(data.state==="done")await loadAccounts();}return running;
   }catch(error){if(error.status!==404)note("aistFeedback",error.message,true);return false;}finally{loading=false;}
 }
 async function begin(account){try{await ctx.api("/api/backends/aist/login",{method:"POST",data:account?{account_id:account}:{}});const active=await loginState();clearInterval(poll);if(active)poll=setInterval(loginState,1500);}catch(e){note("aistFeedback",e.message,true);}}
 async function loadAccounts(){
   $("loadAistAccounts").disabled=true;
   try{const data=await ctx.api("/api/backends/aist/accounts");if(disposed)return;const rows=$("aistAccountRows");rows.replaceChildren();
     for(const account of data.accounts||[]){const row=el("tr"),ops=el("td"),bar=el("div","","row-actions");bar.append(action("重新登录",()=>begin(account.id)),action(account.enabled?"停用":"启用",async()=>{await ctx.api("/api/backends/aist/accounts/"+encodeURIComponent(account.id),{method:"PATCH",data:{enabled:!account.enabled}});await loadAccounts();}));ops.append(bar);const state=el("td",account.message||account.state||"未提供");for(const [provider,value]of Object.entries(account.grants||{}))state.append(el("small",provider+" · "+({verified:"已验证",authenticated:"已登录，待验证",not_authorized:"未授权",needs_attention:"需处理"}[value]||value)));row.append(el("td",account.label||account.id),state,el("td",account.benefit_tier||"未提供"),el("td",String(account.models?.length||0)),ops);rows.append(row);}
     if(!data.accounts?.length)emptyRows(rows,"尚无账号，请点击 Google 登录",5);note("aistFeedback","已加载共享 Google 账号");
   }catch(e){note("aistFeedback",e.message,true);}finally{if(!disposed)$("loadAistAccounts").disabled=false;}
 }
 $("loadAistAccounts").onclick=loadAccounts;$("beginGoogleLogin").onclick=()=>begin(null);$("cancelGoogleLogin").onclick=async()=>{try{await ctx.api("/api/backends/aist/login",{method:"DELETE",data:{}});await loginState();}catch(e){note("aistFeedback",e.message,true);}};
 return{async render(){const data=await ctx.api("/api/backends");if(disposed)return;const rows=$("backendRows");rows.replaceChildren();for(const backend of data.items){const row=el("tr"),ops=el("td");if(backend.id==="agy"){const link=el("a","管理 agy 账号","button secondary small");link.href="/panel/accounts";ops.append(link);}else ops.textContent="共享账号与独立授权状态见下方";row.append(el("td",backend.name),el("td",states[backend.state]||backend.state),el("td",String(backend.active_requests||0)),ops);rows.append(row);}const available=data.items.some(b=>b.id==="aist"&&b.state!=="not_configured");$("beginGoogleLogin").disabled=!available;$("loadAistAccounts").disabled=!available;const active=await loginState();if(!disposed){clearInterval(poll);if(active)poll=setInterval(loginState,1500);}},cleanup(){disposed=true;clearInterval(poll);closeSocket();}};
}
