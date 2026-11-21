import {AppError} from '../common.mjs';
export const backendEnabled=(account,id)=>['verified','authenticated',...(id==='aist'?['synced']:[])].includes(account.grants?.[id])&&(account.backend_enabled?.[id]??!!account.enabled);
export function setBackendEnabled(account,id,enabled){
 if(!['aist','robin'].includes(id)||typeof enabled!=='boolean')throw new AppError(400,'后端启用设置无效');
 if(enabled&&!['verified','authenticated',...(id==='aist'?['synced']:[])].includes(account.grants?.[id]))throw new AppError(409,'请先同步或授权 '+(id==='aist'?'AIST':'Robin'),'backend_auth_required');
 account.backend_enabled={aist:backendEnabled(account,'aist'),robin:backendEnabled(account,'robin'),[id]:enabled};account.enabled=Object.values(account.backend_enabled).some(Boolean);if(!enabled&&account.verification?.[id]?.state==='failed'){account.verification={...account.verification};delete account.verification[id];}return account;
}
