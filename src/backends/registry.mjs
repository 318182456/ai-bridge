import {AppError} from "../common.mjs";
const catalog=Object.freeze([
  {id:"agy",name:"Antigravity CLI",authentication:"native-oauth"},
  {id:"robin",name:"Robin",authentication:"provider-grant"},
  {id:"aist",name:"AI Studio",authentication:"browser-session"},
]);
export class Backends {
  constructor(){this.adapters=new Map();}
  register(id,adapter){if(!catalog.some(b=>b.id===id)||this.adapters.has(id))throw Error("Unknown or duplicate backend");this.adapters.set(id,adapter);return adapter;}
  get(id){const adapter=this.adapters.get(id);if(!adapter)throw new AppError(503,"此后端尚未接入或未配置","backend_not_ready");return adapter;}
  list(){return catalog.map(b=>({...b,...(this.adapters.get(b.id)?.status?.()||{state:"not_configured"}),id:b.id}));}
  async close(){await Promise.allSettled([...this.adapters.values()].map(a=>a.close?.()));}
}
export function registerBackends({register,send,backends}){
  register("GET","/api/backends","read",async({res})=>send(res,{items:backends.list()}));
}
