import {randomUUID} from 'node:crypto';
import {AppError} from '../common.mjs';
import {googleCookies} from './browser-cookie-import.mjs';
// ASVS 2.2.2 / 16.5.3: private credential persistence is distinct from verified product access.
export async function syncBrowserCredential({accounts,grants},input,signal){
 let old;try{old=structuredClone(await accounts.get(input.account_id));}catch(e){if(e.status!==404)throw e;}
 const account=old?structuredClone(old):{id:input.account_id,email:input.expected_email,enabled:true,state:'authenticated',models:[],grants:{aist:'not_authorized',robin:'not_authorized',agy:'not_authorized'}};
 if(account.email.toLowerCase()!==input.expected_email.toLowerCase())throw new AppError(409,'所选 Google 身份不一致','account_identity_mismatch');
 account.grants={...account.grants};
 const before=await grants.read(account.id);let saved=false;
 try{
  if(signal?.aborted)throw new AppError(499,'同步已取消','cancelled');
  if(input.target==='aist'){const cookies=googleCookies(input.cookies),revision=randomUUID();await grants.save(account.id,{...before,aist:{cookies,authuser:input.authuser,revision}});account.cookie_revision=revision;account.authuser=input.authuser;account.grants.aist='synced';}
  else{await grants.bindRobin(account,input.oauth_token,signal);account.grants.robin='authenticated';}
  saved=true;if(signal?.aborted)throw new AppError(499,'同步已取消','cancelled');
  if(!old||!Object.values(old.grants||{}).includes('verified'))account.enabled=true;
  account.synced_at=new Date().toISOString();account.state=Object.values(account.grants).includes('verified')?'ready':'authenticated';await accounts.put(account);
 }catch(error){await grants.save(account.id,before);if(old&&saved)await accounts.put(old);throw error;}
 finally{input.cookies=null;input.oauth_token='';}
 return{synced:true,verified:false};
}
