import {rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {AppError} from '../common.mjs';
import {backendEnabled,setBackendEnabled} from '../backends/account-state.mjs';
// ASVS 8.3.1/8.3.2: protected mutation registrar and account writer lease own revocation.
// Only fixed, validated account profile paths may be removed; never accept a client path.
async function forgetProfile(vault,dataDir,kind,id){
 if(vault)return vault.forget(kind,id);
 const root=resolve(dataDir),path=resolve(kind==='agy'?join(root,'accounts',id,'home'):join(root,'google','profiles',id));
 if(!path.startsWith(root+sep)||!(kind==='agy'?/^a_[a-f0-9]{16}$/:/^g_[a-f0-9]{24}$/).test(id))throw new AppError(400,'授权资料标识无效');
 await rm(path,{recursive:true,force:true});
}
export function registerBackendAuthorization({register,send,accounts,grants,backends,queue,sync,store,sessions,runner,loginManager,authVault,dataDir}){
 register('DELETE',/^\/api\/backends\/(aist|robin)\/accounts\/(g_[a-f0-9]{24})\/authorization$/,'mutation',async({res,match,signal})=>{
  const [,backend,id]=match;await accounts.get(id);sync.closeAccount(id,backend);
  await queue.add(async()=>{
   const a=await accounts.get(id);setBackendEnabled(a,backend,false);await accounts.save();
   const robin=backends.get('robin');await grants.pending.get(id)?.catch(()=>{});
   const credentials=await grants.read(id);delete credentials[backend];await grants.save(id,credentials);
   if(backend==='aist'){await backends.get('aist').engine.browser.checkpoint(id,{requireIdle:true});await forgetProfile(authVault,dataDir,'google',id);a.models=[];a.cookie_revision=null;a.authuser=null;}
   else{robin.cache.delete(id);a.robin_models=[];}
   a.grants={...a.grants,[backend]:'not_authorized'};a.verification={...a.verification};delete a.verification[backend];a.catalog_updated_at={...a.catalog_updated_at};delete a.catalog_updated_at[backend];
   a.enabled=backendEnabled(a,'aist')||backendEnabled(a,'robin');a.state=Object.values(a.grants).includes('verified')?'ready':Object.values(a.grants).some(g=>['synced','authenticated'].includes(g))?'authenticated':'not_logged_in';
   await accounts.save();
  },signal,{key:id,lane:'login',metadata:{kind:'account',summary:'删除 '+backend+' 授权'}});send(res,{removed:true,backend,history_preserved:true});
 });
 register('DELETE',/^\/api\/accounts\/(a_[a-f0-9]{16})\/authorization$/,'mutation',async({res,match,signal})=>{
  const id=match[1];store.get(id);
  if(loginManager.current?.id===id&&['starting','running','submitted','checking'].includes(loginManager.current.state))throw new AppError(409,'请先结束该账号的登录，再删除授权');
  await queue.add(async()=>{
   if(loginManager.current?.id===id&&["starting","running","submitted","checking"].includes(loginManager.current.state))throw new AppError(409,"请先结束该账号的登录，再删除授权");
   const a=store.get(id);a.enabled=false;await store.save();await sessions.closeWhere(s=>s.account===id);
   const ring=runner.keyrings?.entries.get(id);if(ring?.refs)throw new AppError(409,'账号密钥环仍在使用，请稍后重试');await ring?.closing;
   await forgetProfile(authVault,dataDir,'agy',id);
   Object.assign(a,{status:'not_logged_in',models:[],checked_at:null,auth_checked_at:null,last_error:null,last_verification_error:null,quota:null,quota_error:null});await store.save();
   if(loginManager.current?.id===id)loginManager.current=null;
  },signal,{key:id,lane:'login',metadata:{kind:'account',summary:'删除 agy 授权'}});send(res,{removed:true,backend:'agy',history_preserved:true});
 });
}
