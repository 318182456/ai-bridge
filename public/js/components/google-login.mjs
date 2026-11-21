import {note,socketProtocols} from "../core.mjs";
export function mountGoogleLogin(ctx,{onChange=async()=>{},onOpen=()=>{}}={}){
 const $=ctx.$;let disposed=false,poll=null,socket=null,view=null,frame=null,sequence=0,loading=false;

 function closeSocket(){sequence++;socket?.close();socket=null;view=null;frame=null;$("googleBrowser").hidden=true;const canvas=$("googleCanvas");canvas.getContext("2d").clearRect(0,0,canvas.width,canvas.height);$("googleKeyboard").value="";}
 function send(message){if(socket?.readyState===WebSocket.OPEN&&frame)socket.send(JSON.stringify({...message,context:frame.context}));}
 function connect(id){
   if(view===id&&socket&&socket.readyState<=1)return;closeSocket();view=id;
   const url=new URL("/api/backends/aist/login-view/"+id,location.origin);url.protocol=location.protocol==="https:"?"wss:":"ws:";
   socket=new WebSocket(url,socketProtocols());socket.binaryType="blob";let meta;
   socket.onmessage=async event=>{
     if(disposed)return;
     if(typeof event.data==="string"){try{const value=JSON.parse(event.data);if(value.type==="status")$("aistLoginStatus").textContent=({preparing:"准备浏览器，首次使用可能需要下载…",starting:"正在连接 Google 登录页…",waiting:"请在下方 Google 页面完成登录",saving:"登录已识别，正在验证并保存账号"})[value.status]||"正在登录";else if(value.type==="dialog")note("aistFeedback","Google 页面需要处理浏览器确认，请检查登录画面",true);else meta=value;}catch{}return;}
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
     if(data.state==="waiting")$("aistLoginStatus").textContent="等待目标账号空闲或另一项登录结束";
     if(running)onOpen(data.account_id||null);if(data.view)connect(data.view);
     if(!running){closeSocket();clearInterval(poll);$("aistLoginStatus").textContent=data.state==="done"?"授权流程已结束，请查看各后端独立验证状态":data.error||"登录已取消";if(data.state==="done")await onChange();}return running;
   }catch(error){if(error.status!==404)note("aistFeedback",error.message,true);return false;}finally{loading=false;}
 }
 async function begin(account){try{await ctx.api("/api/backends/aist/login",{method:"POST",data:account?{account_id:account}:{}});const active=await loginState();clearInterval(poll);if(active)poll=setInterval(loginState,1500);}catch(e){note("aistFeedback",e.message,true);}}
 $("beginGoogleLogin").onclick=()=>begin(null);$("cancelGoogleLogin").onclick=async()=>{try{await ctx.api("/api/backends/aist/login",{method:"DELETE",data:{}});await loginState();}catch(e){note("aistFeedback",e.message,true);}};
 return{begin,async resume(){const running=await loginState();if(running){clearInterval(poll);poll=setInterval(loginState,1500);}},cleanup(){disposed=true;clearInterval(poll);closeSocket();}};
}
