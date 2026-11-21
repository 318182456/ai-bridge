import {note,socketProtocols} from "../core.mjs";
export function mountGoogleLogin(ctx,{onChange=async()=>{},onOpen=()=>{}}={}){
 const $=ctx.$;let disposed=false,poll=null,socket=null,view=null,frame=null,sequence=0,loading=false,collapsed=false,zoom=1,lastViewportAt=0,touch=null,manualPhase=null;
 const dialog=$("googleLoginDialog"),browser=$("googleBrowser");
 const setStatus=value=>{$("aistLoginStatus").textContent=value;$("googleConnectPlaceholder").textContent=value;};
 function openDialog(){collapsed=false;if(!dialog.open)dialog.showModal();syncViewport();}
 function minimize(){collapsed=true;dialog.close();$("openGoogleLoginDialog").focus();}
 function applyZoom(){ $("googleCanvas").style.width=(100*zoom)+"%";$("googleZoomLabel").textContent=Math.round(zoom*100)+"%";}
 function syncViewport(){if(!frame||!dialog.open||browser.hidden)return;const width=Math.max(frame.min_width||320,Math.min(1920,Math.floor(browser.clientWidth))),height=Math.max(frame.min_height||240,Math.min(1200,Math.floor(browser.clientHeight)));if((frame.width!==width||frame.height!==height)&&Date.now()-lastViewportAt>600){lastViewportAt=Date.now();send({type:"viewport",width,height});}}
 const observer=new ResizeObserver(syncViewport);observer.observe(browser);
 $("openGoogleLoginDialog").onclick=openDialog;$("minimizeGoogleLogin").onclick=minimize;dialog.addEventListener("cancel",event=>{event.preventDefault();minimize();});
 $("googleZoomIn").onclick=()=>{zoom=Math.min(2,zoom+.25);applyZoom();};$("googleZoomFit").onclick=()=>{zoom=1;applyZoom();syncViewport();};

 function setPhase(value){const manual=["manual","manual_robin"].includes(value.status);$("confirmGoogleLogin").hidden=!manual;$("skipGoogleGrant").hidden=value.status!=="manual_robin";if(manualPhase!==value.status){$("confirmGoogleLogin").disabled=false;$("skipGoogleGrant").disabled=false;}manualPhase=value.status;setStatus(({manual:"请在完整浏览器中登录并进入 AI Studio，然后点击继续验证",manual_robin:"请完成 Robin 的 Google 授权，再继续验证；也可稍后处理",verifying:"已关闭手动浏览器，正在实际验证并保存账号",partial:value.message||"部分授权未完成，请查看账号状态"})[value.status]||({preparing:"准备完整浏览器，首次使用可能需要下载…",starting:"正在启动完整浏览器…",waiting:"请完成 Google 官方授权",saving:"正在验证并保存账号"})[value.status]||"正在登录");}
 $("confirmGoogleLogin").onclick=()=>{send({type:"confirm"});$("confirmGoogleLogin").disabled=true;};$("skipGoogleGrant").onclick=()=>{send({type:"skip"});$("skipGoogleGrant").disabled=true;};
 function closeSocket(){sequence++;socket?.close();socket=null;view=null;frame=null;touch=null;$("googleBrowser").hidden=true;$("googleConnectPlaceholder").hidden=false;const canvas=$("googleCanvas");canvas.getContext("2d").clearRect(0,0,canvas.width,canvas.height);$("googleKeyboard").value="";}
 function send(message){if(socket?.readyState===WebSocket.OPEN&&frame)socket.send(JSON.stringify({...message,context:frame.context}));}
 function connect(id){
   if(view===id&&socket&&socket.readyState<=1)return;closeSocket();view=id;
   const url=new URL("/api/backends/aist/login-view/"+id,location.origin);url.protocol=location.protocol==="https:"?"wss:":"ws:";
   socket=new WebSocket(url,socketProtocols());socket.binaryType="blob";let meta;
   socket.onmessage=async event=>{
     if(disposed)return;
     if(typeof event.data==="string"){try{const value=JSON.parse(event.data);if(value.type==="status")setPhase(value);else if(value.type==="dialog")note("aistFeedback","Google 页面需要处理浏览器确认，请检查登录画面",true);else meta=value;}catch{}return;}
     if(!meta||![meta.width,meta.height].every(n=>Number.isFinite(n)&&n>0&&n<=4096))return;
     const current=++sequence,bitmap=await createImageBitmap(event.data);if(disposed||current!==sequence){bitmap.close();return;}
     const canvas=$("googleCanvas");canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext("2d").drawImage(bitmap,0,0);bitmap.close();frame={...meta,width:canvas.width,height:canvas.height};$("googleBrowser").hidden=false;$("googleConnectPlaceholder").hidden=true;applyZoom();syncViewport();
   };
   socket.onclose=()=>{if(!disposed&&view===id)$("aistLoginStatus").textContent="登录窗口已断开，后台授权状态仍在查询";};
   socket.onerror=()=>{};
 }
 const point=e=>{const rect=$("googleCanvas").getBoundingClientRect();return{x:Math.max(0,Math.min(frame.width-1,(e.clientX-rect.left)/rect.width*frame.width)),y:Math.max(0,Math.min(frame.height-1,(e.clientY-rect.top)/rect.height*frame.height))};};
 const canvas=$("googleCanvas"),keyboard=$("googleKeyboard");
 canvas.onpointerdown=e=>{if(!frame)return;e.preventDefault();if(e.pointerType==="touch"){touch={id:e.pointerId,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false};canvas.setPointerCapture(e.pointerId);return;}keyboard.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);send({type:"pointer",action:"down",button:0,...point(e)});};
 canvas.onpointerup=e=>{if(!frame)return;if(touch?.id===e.pointerId){if(!touch.moved){keyboard.focus({preventScroll:true});send({type:"pointer",action:"down",button:0,...point(e)});send({type:"pointer",action:"up",button:0,...point(e)});}touch=null;return;}send({type:"pointer",action:"up",button:0,...point(e)});};canvas.onpointercancel=()=>{touch=null;};
 canvas.onpointermove=e=>{if(touch?.id===e.pointerId){const dx=touch.x-e.clientX,dy=touch.y-e.clientY;touch.moved||=Math.hypot(e.clientX-touch.startX,e.clientY-touch.startY)>8;if(touch.moved){if(zoom>1){browser.scrollLeft+=dx;browser.scrollTop+=dy;}else send({type:"wheel",dx,dy});}touch.x=e.clientX;touch.y=e.clientY;return;}if(frame&&e.buttons)send({type:"pointer",action:"move",...point(e)});};
 canvas.onwheel=e=>{if(!frame)return;e.preventDefault();send({type:"wheel",dx:e.deltaX,dy:e.deltaY,...point(e)});};
 for(const target of [canvas,keyboard]){
   target.onkeydown=e=>{if(e.key==="Escape")return;if(e.isComposing||["Process","Unidentified","Dead"].includes(e.key))return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="v")return;e.preventDefault();send({type:"key",action:"down",key:e.key});};
   target.onkeyup=e=>{if(e.key==="Escape")return;if(!e.isComposing){e.preventDefault();send({type:"key",action:"up",key:e.key});}};
   target.onpaste=e=>{e.preventDefault();const text=e.clipboardData?.getData("text/plain");if(text){send({type:"key",action:"up",key:"Control"});send({type:"key",action:"up",key:"Meta"});send({type:"text",text});}};
 }
 keyboard.oncompositionend=e=>{if(e.data)send({type:"text",text:e.data});keyboard.value="";};
 keyboard.oninput=e=>{if(e.isComposing)return;if(e.inputType==="insertText"&&e.data)send({type:"text",text:e.data});keyboard.value="";};
 async function loginState(){
   if(loading||disposed)return;loading=true;
   try{const data=await ctx.api("/api/backends/aist/login");if(disposed)return;
     $("aistLoginPanel").hidden=false;if(!collapsed&&!dialog.open)openDialog();
     const running=["waiting","running"].includes(data.state);$("beginGoogleLogin").disabled=running;$("cancelGoogleLogin").hidden=!running;
     if(data.state==="waiting")setStatus("等待目标账号空闲或另一项登录结束");
     if(running)onOpen(data.account_id||null);if(data.view)connect(data.view);
     if(!running){closeSocket();clearInterval(poll);setStatus(data.state==="done"?"授权流程已结束，请查看各后端独立验证状态":data.error||"登录已取消");$("confirmGoogleLogin").hidden=true;$("skipGoogleGrant").hidden=true;await onChange();}return running;
   }catch(error){if(error.status!==404)note("aistFeedback",error.message,true);return false;}finally{loading=false;}
 }
 async function begin(account){zoom=1;lastViewportAt=0;applyZoom();openDialog();setStatus("正在创建 Google 登录任务…");$("beginGoogleLogin").disabled=true;try{await ctx.api("/api/backends/aist/login",{method:"POST",data:account?{account_id:account}:{}});const active=await loginState();clearInterval(poll);if(active)poll=setInterval(loginState,1500);}catch(e){setStatus(e.message);$("beginGoogleLogin").disabled=false;note("aistFeedback",e.message,true);}}
 $("beginGoogleLogin").onclick=()=>begin(null);$("cancelGoogleLogin").onclick=async()=>{try{await ctx.api("/api/backends/aist/login",{method:"DELETE",data:{}});await loginState();}catch(e){note("aistFeedback",e.message,true);}};
 return{begin,async resume(){const running=await loginState();if(running){clearInterval(poll);poll=setInterval(loginState,1500);}},cleanup(){disposed=true;clearInterval(poll);observer.disconnect();closeSocket();if(dialog.open)dialog.close();}};
}
