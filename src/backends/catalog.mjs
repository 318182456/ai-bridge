export async function modelCatalog(store,backends){
 const models=new Map();
 const add=(id,name,backend,account,available,checked)=>{if(!id)return;if(!models.has(id))models.set(id,{id,name:name||id,object:"model",owned_by:"ai-bridge",sources:[],checked_at:null});const m=models.get(id);m.sources.push({backend,account_id:account.id,account_name:account.name,available});if(checked&&(!m.checked_at||checked>m.checked_at))m.checked_at=checked;};
 for(const a of store.list())for(const m of a.models||[])add(m.id,m.name,"agy",a,a.enabled&&a.status==="ready",a.checked_at);
 for(const id of ["aist","robin"]){const adapter=backends.adapters.get(id);if(!adapter?.catalogEntries)continue;for(const entry of await adapter.catalogEntries())add(entry.model.id,entry.model.name,id,entry.account,entry.available,entry.checked_at);}
 return[...models.values()].sort((a,b)=>a.id.localeCompare(b.id));
}
export function publicModels(models){return{object:"list",data:models.filter(m=>m.sources.some(s=>s.available)).map(m=>({id:m.id,object:"model",owned_by:"ai-bridge",backends:[...new Set(m.sources.filter(s=>s.available).map(s=>s.backend))]}))};}
