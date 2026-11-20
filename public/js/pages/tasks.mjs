import {el,number as count,note,copy,fillOptions} from "../core.mjs";
export async function mount(ctx){
  const $=ctx.$;let state=ctx.state,jobId=null,busy=false,disposed=false,pollTimer=null,clock=null,loading=false,session=null,ending=false,started=0;
  const duration=ms=>{const n=Math.max(0,Math.floor(ms/1000));return String(Math.floor(n/60)).padStart(2,"0")+":"+String(n%60).padStart(2,"0");};
  function models(){const selected=$("taskModel").value,pool=state.accounts.filter(a=>a.enabled&&(!$("taskAccount").value||a.id===$("taskAccount").value)),entries=new Map();for(const a of pool)for(const m of a.models)entries.set(m.id,m.name||m.id);$("taskModel").replaceChildren(new Option("沿用默认模型",""));for(const [id,name]of entries)$("taskModel").add(new Option(name===id?id:name+" · "+id,id));if(entries.has(selected))$("taskModel").value=selected;}
  function renderSession(){$("taskSessionBar").hidden=!session;$("taskSessionInfo").textContent=session?(session.unavailable?"会话已结束，请开始新对话":"连续对话 · 已完成 "+session.turns+" 轮"):"";$("taskAccount").disabled=$("taskModel").disabled=busy||!!session;}
  function controls(){
    $("sendTask").disabled=busy||ending;$("sendTaskLabel").textContent=busy?"后台处理中":"发送任务";$("taskInputs").disabled=busy;$("taskSessionMode").disabled=busy||ending;$("endTaskSession").disabled=busy||ending;$("cancelTask").hidden=!busy;$("cancelTask").disabled=false;renderSession();
  }
  function stage(kind,label,title,detail){$("taskOutput").dataset.state=kind;$("taskStatus").textContent=label;$("taskStateTitle").textContent=title;$("taskStateDetail").textContent=detail;$("taskEmpty").hidden=kind==="success";$("taskResult").hidden=kind!=="success";$("copyAnswer").disabled=kind!=="success";$("taskWaitingTime").hidden=kind!=="pending";$("taskResult").setAttribute("aria-busy",String(kind==="pending"));}
  function request(id){$("taskRequestId").textContent=id||"";$("taskRequest").hidden=!id;}
  function tick(){if(!busy)return;const t=duration(Date.now()-started);$("taskElapsed").textContent="已等待 "+t;$("taskWaitingTime").textContent=t;}
  async function poll(){
    clearTimeout(pollTimer);if(disposed||!jobId||loading)return;loading=true;const id=jobId;
    try{const value=await ctx.api("/api/tasks/"+id);if(disposed||id!==jobId)return;apply(value);}
    catch(error){if(!disposed){note("taskFeedback",error.message,true);if(error.status===404||error.status===401){busy=false;controls();clearInterval(clock);sessionStorage.removeItem("agy.lastTask");stage("error","任务不可恢复","任务结果不可用",error.message);}}}
    finally{loading=false;if(!disposed&&busy)pollTimer=setTimeout(poll,1500);}
  }
  function apply(value){
    request(value.id);started=Date.parse(value.created_at)||Date.now();
    if(value.state==="completed"){
      busy=false;clearInterval(clock);const result=value.result;session=result.session||null;$("taskSessionMode").checked=!!session;$("answer").textContent=result.response;$("taskMeta").replaceChildren();
      for(const [label,text]of [["执行账号",result.account.name],["模型",result.model||value.input.model||"默认模型"],["总耗时（含排队）",duration(Date.parse(value.finished_at||new Date().toISOString())-started)],["Token 用量",result.usage?.total_tokens==null?"未报告":count(result.usage.total_tokens)]]){const item=el("div");item.append(el("dt",label),el("dd",String(text)));$("taskMeta").append(item);}
      if(session){$("taskAccount").value=session.account_id;models();$("taskModel").value=session.model||"";}
      stage("success","已完成","","");note("taskFeedback","任务完成。离页期间的结果已保留，可复制或查看请求记录。");
    }else if(["failed","cancelled"].includes(value.state)){
      busy=false;clearInterval(clock);if(session)session.unavailable=true;const cancelled=value.state==="cancelled";stage(cancelled?"cancelled":"error",cancelled?"已取消":"执行失败",cancelled?"本次任务已取消":"任务未能完成",value.error?.message||"任务未完成");note("taskFeedback",value.error?.message||"任务未完成",!cancelled);
    }else{
      busy=true;const queued=value.state==="waiting"||value.state==="pending",cancel=value.state==="cancelling";
      stage("pending",cancel?"取消中":queued?"排队中":"执行中",cancel?"正在终止并回收资源":queued?"等待执行":"正在调用模型",(value.queue?.reason||"正在提交到执行队列")+(value.queue?.position?" · 等待顺序 "+value.queue.position:""));tick();
    }
    controls();if(value.state==="cancelling")$("cancelTask").disabled=true;
  }
  async function attach(id,restore=false){
    const value=await ctx.api("/api/tasks/"+id);if(disposed)return;jobId=id;sessionStorage.setItem("agy.lastTask",id);
    if(restore){$("prompt").value=value.input.prompt;$("taskAccount").value=value.input.account_id||"";models();$("taskModel").value=value.input.model||"";$("taskSessionMode").checked=!!value.input.session_id;}
    apply(value);if(busy){clearInterval(clock);clock=setInterval(tick,1000);pollTimer=setTimeout(poll,1200);}
  }
  $("taskAccount").onchange=models;
  $("taskForm").onsubmit=async event=>{
    event.preventDefault();if(busy||ending)return;busy=true;controls();$("answer").textContent="";$("taskMeta").replaceChildren();request(null);started=Date.now();$("taskElapsed").hidden=false;stage("pending","提交中","正在提交任务","任务提交后会在后台继续执行，可以切换到执行队列进行管理。");
    try{
      const data={prompt:$("prompt").value,model:$("taskModel").value,account_id:$("taskAccount").value||undefined,session_id:$("taskSessionMode").checked?session?.id||"new":undefined,background:true};
      const accepted=await ctx.api("/api/tasks",{method:"POST",data});sessionStorage.setItem("agy.lastTask",accepted.id);if(!disposed)await attach(accepted.id);
    }catch(error){if(!disposed){busy=false;controls();stage("error","提交失败","任务未提交",error.message);note("taskFeedback",error.message,true);}}
  };
  $("cancelTask").onclick=async()=>{if(!jobId)return;$("cancelTask").disabled=true;try{await ctx.api("/api/tasks/"+jobId,{method:"DELETE"});await poll();}catch(error){note("taskFeedback",error.message,true);$("cancelTask").disabled=false;}};
  async function endSession(){if(busy||ending)return;ending=true;controls();try{if(session)await ctx.api("/api/sessions/"+session.id,{method:"DELETE"});session=null;sessionStorage.removeItem("agy.lastTask");jobId=null;note("taskFeedback","已结束上一段对话，下次使用新上下文。");}catch(error){if(error.status===404)session=null;else note("taskFeedback",error.message,true);}finally{ending=false;controls();}}
  $("endTaskSession").onclick=endSession;$("taskSessionMode").onchange=()=>{if(!$("taskSessionMode").checked)void endSession();};$("copyAnswer").onclick=()=>copy($("answer").textContent,$("copyAnswer"));
  fillOptions($("taskAccount"),state.accounts.filter(a=>a.enabled),"自动轮询");models();
  try{let id=ctx.params.get("task")||sessionStorage.getItem("agy.lastTask");if(!id){const values=await ctx.api("/api/tasks");id=values.items.find(x=>["pending","running","waiting"].includes(x.state))?.id;}if(id)await attach(id,true);}catch(error){sessionStorage.removeItem("agy.lastTask");note("taskFeedback",error.message,true);}
  return{render(){state=ctx.state;if(!busy&&!session){fillOptions($("taskAccount"),state.accounts.filter(a=>a.enabled),"自动轮询");models();}renderSession();},cleanup(){disposed=true;clearTimeout(pollTimer);clearInterval(clock);$("answer").textContent="";}};
}
