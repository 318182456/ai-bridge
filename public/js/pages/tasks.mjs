import {mount as mountConsole} from "../components/task-console.mjs";
import {mount as mountQueue} from "../components/queue.mjs";
export async function mount(ctx){
 let view=ctx.params.get("view")==="queue"?"queue":"compose";
 const consoleView=await mountConsole(ctx),queueView=mountQueue(ctx,{isActive:()=>view==="queue"});
 const tabs=[ctx.$("taskTabCompose"),ctx.$("taskTabQueue")];
 async function choose(next,updateUrl=true){
  view=next;ctx.$("taskComposeView").hidden=view!=="compose";ctx.$("taskQueueView").hidden=view!=="queue";
  tabs.forEach((tab,i)=>{const selected=(i===0?"compose":"queue")===view;tab.setAttribute("aria-selected",String(selected));tab.tabIndex=selected?0:-1;});
  if(updateUrl){const url=new URL(location.href);if(view==="queue")url.searchParams.set("view","queue");else url.searchParams.delete("view");history.replaceState(null,"",url);}
  if(view==="queue")await queueView.render();
 }
 tabs.forEach((tab,index)=>{tab.onclick=()=>choose(index===0?"compose":"queue");tab.onkeydown=event=>{if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;event.preventDefault();const next=event.key==="Home"?0:event.key==="End"?1:1-index;tabs[next].focus();void choose(next===0?"compose":"queue");};});
 await choose(view,false);
 return{async render(){consoleView.render();if(view==="queue")await queueView.render();},cleanup(){consoleView.cleanup();queueView.cleanup();}};
}
