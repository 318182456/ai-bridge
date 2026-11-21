import {readFile} from "node:fs/promises";
import {join} from "node:path";
export const pages={
  overview:{title:"概览",description:"运行状态、请求趋势与账号消耗。"},
  accounts:{title:"账号与额度",description:"统一管理账号、后端授权、消耗和额度。"},
  models:{title:"模型目录",description:"查看账号实际返回的模型与当前可用性。"},
  tasks:{title:"任务",description:"提交调试任务，查看执行队列和结果。"},
  records:{title:"请求记录",description:"按账号、模型、API 密钥与状态定位请求。"},
  keys:{title:"API 密钥",description:"为不同项目创建独立密钥，管理名称、到期与消耗。"},
  access:{title:"接口接入",description:"连接客户端，查看支持范围与调用示例。"},
  settings:{title:"设置",description:"日志保留、额度缓存和运行配置。"},
};
const icons={
  overview:"M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  backends:"M4 4h16v5H4zM4 15h16v5H4zM8 9v6M16 9v6",
  accounts:"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  models:"m12 3 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5",
  tasks:"m5 5 7 7-7 7M13 19h7",
  queue:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  records:"M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-3M8 3h8v4H8zM8 12h8M8 16h6",
  keys:"M14 7a5 5 0 1 0-8.5 3.5L2 14v4h4v-3h3l2.5-2.5A5 5 0 0 0 14 7zM10 7h.01",
  access:"M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l2-2",
  settings:"M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3z",
};
function nav(active){
  return Object.entries(pages).map(([id,p])=>'<a class="nav-link'+(id===active?' active':'')+'" href="/panel/'+id+'"'+(id===active?' aria-current="page"':'')+'><svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+icons[id]+'"/></svg><span>'+p.title+'</span></a>').join("");
}
export function registerPages({register,publicDir}){
  register("GET","/","public",async({res})=>{res.writeHead(303,{location:"/panel/overview"});res.end();});
  register("GET","/panel","public",async({res})=>{res.writeHead(303,{location:"/panel/overview"});res.end();});
  for(const [old,target]of [["backends","/panel/accounts"],["queue","/panel/tasks?view=queue"]])register("GET","/panel/"+old,"public",async({res})=>{res.writeHead(303,{location:target});res.end();});
  for(const [id,page] of Object.entries(pages)){
    register("GET","/panel/"+id,"public",async({res})=>{
      const [shell,content]=await Promise.all([readFile(join(publicDir,"shell.html"),"utf8"),readFile(join(publicDir,"pages",id+".html"),"utf8")]);
      const html=shell.replaceAll("{{page}}",id).replaceAll("{{title}}",page.title).replaceAll("{{description}}",page.description).replace("{{nav}}",nav(id)).replace("{{content}}",content);
      res.writeHead(200,{"content-type":"text/html; charset=utf-8"});res.end(html);
    });
  }
  const assets=[["/style.css","style.css","text/css"],["/icon.svg","icon.svg","image/svg+xml"],["/icon-180.png","icon-180.png","image/png"],
    ["/js/core.mjs","js/core.mjs","text/javascript"],["/js/shell.mjs","js/shell.mjs","text/javascript"],
    ...Object.keys(pages).map(id=>["/js/pages/"+id+".mjs","js/pages/"+id+".mjs","text/javascript"])];
  for(const name of ["model-catalog","browser-sync","account-directory","task-console","queue"])assets.push(["/js/components/"+name+".mjs","js/components/"+name+".mjs","text/javascript"]);
  for(const [path,file,type] of assets)register("GET",path,"public",async({res})=>{res.writeHead(200,{"content-type":type});res.end(await readFile(join(publicDir,file)));});
}
