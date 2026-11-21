import {AppError} from '../common.mjs';
// Remote Robin authorization exchanges a one-use Google token; it never imports it as an AI Studio login.
export async function* importRobin(engine,id,input,signal){
 if(typeof input.oauth_token!=='string'||!input.oauth_token||input.oauth_token.length>16384||/[\r\n\0]/.test(input.oauth_token))throw new AppError(400,'Robin 授权结果无效','invalid_robin_token');
 let old;try{old=structuredClone(await engine.accounts.get(input.account_id));}catch(error){if(error.status!==404)throw error;}
 if(!old&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.expected_email||''))throw new AppError(400,'请先选择 Google 账号','account_required');
 const account=old?structuredClone(old):{id:input.account_id,email:input.expected_email,enabled:false,state:'authenticated',models:[],grants:{aist:'not_authorized',robin:'not_authorized',agy:'not_authorized'}};account.grants={...account.grants};let undo,committed=false;
 try{yield{browser_meta:{type:'status',status:'verifying_robin'},native_job:id};undo=await engine.bindRobin(account,input.oauth_token,signal);if(signal?.aborted)throw new AppError(499,'授权已取消','cancelled');account.grants.robin='verified';account.state='ready';account.enabled=old&&Object.values(old.grants||{}).includes('verified')?old.enabled:true;account.checked_at=new Date().toISOString();await engine.accounts.put(account);committed=true;yield{result:{account:{id:account.id,email:account.email,state:account.state}},native_job:id};}
 catch(error){if(!committed){if(typeof undo==='function')await undo();if(old)await engine.accounts.put(old);}throw error;}
 finally{input.oauth_token='';}
}
