import {mountCatalog} from "../components/model-catalog.mjs";
import {el,fmtDate,copy,emptyRows} from "../core.mjs";
export function mount(ctx){const $=ctx.$;let data=[];
function render(){const query=$("modelSearch").value.trim().toLowerCase(),availableOnly=$("modelAvailability").value==="available";
 const list=data.filter(m=>(!availableOnly||m.sources.some(s=>s.available))&&(!query||[m.id,m.name,...m.sources.map(s=>s.backend)].join(" ").toLowerCase().includes(query)));$("modelCount").textContent=list.length+" / "+data.length+" 个模型";const rows=$("modelRows");rows.replaceChildren();
 for(const m of list){const row=el("tr"),identity=el("td"),sources=el("td"),ops=el("td");identity.append(el("code",m.id));if(m.name!==m.id)identity.append(el("small",m.name));for(const id of [...new Set(m.sources.map(s=>s.backend))]){const all=m.sources.filter(s=>s.backend===id),ready=all.filter(s=>s.available);sources.append(el("small",id+" · "+ready.length+" / "+all.length+" 个账号",ready.length?"status-ready":"muted"));}const button=el("button","复制 ID","secondary small");button.onclick=()=>copy(m.id,button);ops.append(button);row.append(identity,sources,el("td",fmtDate(m.checked_at)),ops);rows.append(row);}if(!list.length)emptyRows(rows,"没有匹配的已发现模型",4);
}
$("modelSearch").oninput=render;$("modelAvailability").onchange=render;render();return mountCatalog(ctx,{onData:value=>{data=value;render();}});
}
