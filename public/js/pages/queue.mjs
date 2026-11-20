import {el,number,fmtDate,action,emptyRows,note} from "../core.mjs";
export function mount(ctx){
  const $=ctx.$;let data=null,disposed=false,timer=null,confirmId=null,loading=false;
  const types={generation:"模型请求",login:"Google 登录",verification:"实际调用校验",quota:"额度查询"};
  const names={waiting:"等待中",running:"执行中",cancelling:"取消中"};
  const seconds=ms=>Math.floor(ms/1000)+" 秒";
  function clearDetail(){$("queueContent").textContent="";$("queueDetailMeta").replaceChildren();confirmId=null;$("queueConfirmCancel").hidden=true;$("queueConfirmText").hidden=true;}
  async function detail(item,cancel=false){
    clearDetail();const d=await ctx.api("/api/queue/"+item.id);if(disposed)return;
    for(const [label,value]of [["请求 ID",d.id],["类型",types[d.kind]||"后台操作"],["账号",d.account_name||d.account_id||"—"],["模型",d.model||"—"],["状态",names[d.state]||d.state],["创建时间",fmtDate(d.created_at)]])$("queueDetailMeta").append(el("dt",label),el("dd",value));
    $("queueContent").textContent=d.content||d.summary||"此任务没有请求正文";
    if(cancel){confirmId=d.id;$("queueConfirmCancel").hidden=false;$("queueConfirmText").hidden=false;$("queueConfirmText").textContent="确认取消该任务？正在执行的上游请求可能已经消耗额度。";}
    $("queueDetail").showModal();
  }
  function render(){
    if(!data)return;
    $("queueSummary").replaceChildren(el("span","执行 "+data.running+" / "+data.concurrency),el("span","排队 "+data.waiting+" / "+data.limit),el("span",data.exclusive?"登录 / 校验独占中":"同账号串行 · 不同账号按并发设置执行"));
    const query=$("queueSearch").value.toLowerCase(),state=$("queueState").value;
    const list=data.items.filter(x=>(!state||x.state===state)&&(!query||[x.id,x.summary,x.account_name,x.model,x.api_key_name].join(" ").toLowerCase().includes(query)));
    const rows=$("queueRows");rows.replaceChildren();
    for(const item of list){
      const row=el("tr"),text=el("td",types[item.kind]||"后台操作");text.append(el("small",item.summary||"无正文"),el("code",item.id));
      const account=el("td",item.account_name||"系统任务");account.append(el("small",item.model||"—"),el("small",item.api_key_name||"管理台"));
      const status=el("td",names[item.state]||item.state,item.state==="running"?"status-ready":"");status.append(el("small",item.reason),el("small",item.position?"等待顺序 "+item.position:""));
      const time=el("td",item.state==="waiting"?"已等 "+seconds(item.waiting_ms):"执行 "+seconds(item.execution_ms));time.append(el("small",fmtDate(item.created_at)));
      const ops=el("td"),bar=el("div","","row-actions");bar.append(action("内容",()=>detail(item)));
      if(item.state==="waiting")bar.append(action("置顶",async()=>{await ctx.api("/api/queue/"+item.id+"/promote",{method:"POST",data:{}});await refresh();}));
      if(item.can_cancel)bar.append(action(item.state==="waiting"?"取消排队":"终止",()=>detail(item,true),{danger:true}));
      if(item.kind==="generation"&&item.source==="panel"){const link=el("a","查看结果","button secondary small");link.href="/panel/tasks?task="+item.id;bar.append(link);}
      ops.append(bar);row.append(text,account,status,time,ops);rows.append(row);
    }
    if(!list.length)emptyRows(rows,query||state?"没有匹配的任务":"当前没有执行或等待的任务",5);
  }
  async function refresh(){if(loading)return;loading=true;try{const value=await ctx.api("/api/queue");if(!disposed){data=value;render();}}catch(error){if(!disposed)note("queueFeedback",error.message,true);}finally{loading=false;}}
  $("queueCloseDetail").onclick=()=>$("queueDetail").close();$("queueDetail").addEventListener("close",clearDetail);
  $("queueConfirmCancel").onclick=async()=>{const button=$("queueConfirmCancel");button.disabled=true;try{await ctx.api("/api/queue/"+confirmId,{method:"DELETE"});$("queueDetail").close();await refresh();note("queueFeedback","已请求取消，资源回收后任务会从队列移除。");}catch(error){note("queueFeedback",error.message,true);}finally{button.disabled=false;}};
  $("queueSearch").oninput=render;$("queueState").onchange=render;$("queueRefresh").onclick=refresh;
  timer=setInterval(()=>{if(!document.hidden)void refresh();},2000);
  return {render:refresh,cleanup(){disposed=true;clearInterval(timer);if($("queueDetail").open)$("queueDetail").close();clearDetail();data=null;}};
}
