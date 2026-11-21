// Merge only an explicit provider link; similar names/emails never prove account identity.
export function accountDirectory(nativeAccounts,sharedAccounts){
 const linked=new Set(),rows=[];
 for(const g of sharedAccounts){
  const native=nativeAccounts.find(a=>a.id===g.agy_account_id)||null;
  if(native)linked.add(native.id);
  const usage=Object.values(g.usage||{}),sum=key=>usage.reduce((n,u)=>n+(Number.isFinite(u[key])?u[key]:0),0);
  const models=new Set([...(native?.models||[]),...(g.models||[])].map(m=>typeof m==='string'?m:m.id));
  rows.push({...native,id:native?.id||g.id,name:native?.name||g.label,identity:g.label||g.id,native,google:g,
   enabled:native?native.enabled:g.enabled,any_enabled:!!(native?.enabled||g.enabled),status:native?.status||(g.state==='ready'?'ready':Object.values(g.grants||{}).some(x=>['synced','authenticated'].includes(x))?'credentials_synced':'not_logged_in'),checked_at:native?.checked_at||g.checked_at,
   requests:(native?.requests||0)+sum('requests'),successes:(native?.successes||0)+sum('successes'),failures:(native?.failures||0)+sum('failures'),total_tokens:(native?.total_tokens||0)+sum('total_tokens'),token_reports:(native?.token_reports||0)+sum('reports'),model_count:models.size});
 }
 for(const a of nativeAccounts)if(!linked.has(a.id))rows.push({...a,identity:a.name,native:a,google:null,any_enabled:a.enabled,model_count:a.models?.length||0});
 return rows;
}
