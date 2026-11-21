import {AppError,object} from '../common.mjs';
export function registerGoogleAccounts({register,send,body,accounts,store,queue,sync,browser}){
 // ASVS 2.2.2: session/Origin/CSRF policy comes from the mutation registrar; all associations are explicit administrator choices.
 register('PATCH',/^\/api\/backends\/aist\/accounts\/(g_[a-f0-9]{24})\/name$/,'mutation',async({req,res,match,signal})=>{
  const input=object(await body(req));if(Object.keys(input).some(k=>k!=='name')||typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>100)throw new AppError(400,'请输入不超过 100 字符的账号名称');
  await queue.add(async()=>{const a=await accounts.get(match[1]);a.name=input.name.trim();await accounts.save();},signal,{key:match[1],lane:'login',metadata:{kind:'account',summary:'修改 Google 账号显示名称'}});send(res,{updated:true});
 });
 register('POST',/^\/api\/backends\/aist\/accounts\/(g_[a-f0-9]{24})\/agy$/,'mutation',async({req,res,match,signal})=>{
  const input=object(await body(req));if(Object.keys(input).some(k=>!['create','native_account_id'].includes(k))||!!input.create===!!input.native_account_id||input.create!=null&&input.create!==true||input.native_account_id!=null&&!/^a_[a-f0-9]{16}$/.test(input.native_account_id))throw new AppError(400,'请选择现有 agy 账号或新建账号');
  const result=await queue.add(async()=>{const a=await accounts.get(match[1]);if(a.agy_account_id){try{return{account_id:store.get(a.agy_account_id).id};}catch(e){if(e.status!==404)throw e;}}
   if(input.native_account_id&&(await accounts.list()).some(g=>g.id!==a.id&&g.agy_account_id===input.native_account_id))throw new AppError(409,'该 agy 账号已关联其他 Google 记录');
   let created=false;const native=input.native_account_id?store.get(input.native_account_id):(created=true,await store.create({name:a.email.slice(0,100)}));
   const before={...a};try{await accounts.put({...a,agy_account_id:native.id});}catch(e){if(before.agy_account_id===undefined)delete a.agy_account_id;else a.agy_account_id=before.agy_account_id;if(created)await store.remove(native.id);throw e;}return{account_id:native.id};
  },signal,{key:match[1],metadata:{kind:'account',summary:'关联官方 agy 登录账号'}});send(res,result);
 });
 register('DELETE',/^\/api\/backends\/aist\/accounts\/(g_[a-f0-9]{24})$/,'mutation',async({res,match,signal})=>{
  await queue.add(async()=>{await accounts.get(match[1]);sync.closeAccount(match[1]);await browser.checkpoint?.(match[1]);await accounts.remove(match[1]);},signal,{key:match[1],metadata:{kind:'account',summary:'移除 Google 账号记录'}});send(res,{removed:true,profile_preserved:true,agy_preserved:true});
 });
}
