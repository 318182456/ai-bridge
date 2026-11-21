import {mountCatalog} from "../components/model-catalog.mjs";
import {el,copy,note} from "../core.mjs";
export function mount(ctx){const $=ctx.$;let models=[];
function render(){
 const available=models.filter(m=>m.sources.some(s=>s.available)),sources=new Set(available.flatMap(m=>m.sources.filter(s=>s.available).map(s=>s.backend))),target=$("endpointRows");target.replaceChildren();
 note("accessStatus",available.length?"当前 "+available.length+" 个可用模型 · 来源："+[...sources].join(" / "):"当前缓存中没有可用模型；接口地址已列出，请检查授权和启用状态");
 for(const [label,path,backend]of [["统一入口 · Base URL","/v1",null],["AI Studio · 固定来源","/aist/v1","aist"],["Robin · 固定来源","/robin/v1","robin"]]){const url=location.origin+path,ready=backend?sources.has(backend):available.length>0;
  const row=el("div","","endpoint-row"),body=el("div");body.append(el("small",label),el("code",url));
  const button=el("button","复制","secondary small");button.type="button";button.disabled=!ready;button.onclick=()=>copy(url,button);row.append(body,button);row.classList.toggle("inactive",!ready);target.append(row);
 }
 const first=available[0]?.id||"MODEL_ID";
 const value="curl '"+location.origin+"/v1/chat/completions' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '"+JSON.stringify({model:first,messages:[{role:"user",content:"你好"}]})+"'";
 $("curlExample").textContent=value;$("copyCurl").onclick=()=>copy(value,$("copyCurl"));
}
render();return mountCatalog(ctx,{onData:value=>{models=value;render();}});}
