import {AppError} from '../common.mjs';
import {StudioChat,toStudioRequest} from './aist-protocol.mjs';
// ASVS V8.3 / V16.5: selected account only, exactly one generation, credentials and response text never logged.
export async function verifyGoogleAccount({accounts,backends},id,backend,signal,progress=()=>{}){
 if(!['aist','robin'].includes(backend))throw new AppError(400,'校验后端无效');
 signal=AbortSignal.any([signal,AbortSignal.timeout(120000)].filter(Boolean));
 let account=await accounts.get(id);const started=Date.now();let generationStarted=false;
 try{
  progress('models');let models;
  if(backend==='aist'){if(!account.cookie_revision)throw new AppError(409,'请先同步 AIST Cookie','backend_auth_required');account=await backends.get('aist').engine.prepareAccount(account,signal,{refresh:true});models=account.models||[];}
  else{if(!['authenticated','verified'].includes(account.grants?.robin))throw new AppError(409,'请先完成 Robin 授权','backend_auth_required');const robin=backends.get('robin');robin.cache.delete(id);models=await robin.modes(account,signal);}
  const texts=models.filter(m=>!/image|tts|audio|video|embedding|live/i.test(m.id)&&(backend!=='aist'||m.capabilities?.includes(1)));
  const model=texts.find(m=>/flash/i.test(m.id)&&/(?:^|[-_.])(?:low|lite)(?:$|[-_.])/i.test(m.id))||texts.find(m=>/flash/i.test(m.id))||texts[0];if(!model)throw new AppError(503,'目录没有可用于最小测试的文本模型','no_test_model');
  progress('generation');generationStarted=true;const input={account_id:id,model:model.id,messages:[{role:'user',content:'Reply with OK only.'}],max_tokens:16};let result;
  if(backend==='aist'){const chat=new StudioChat(model.id,[]),request=toStudioRequest(input);for await(const event of backends.get('aist').engine.generate(account,request,signal))chat.accept(event);result=chat.finish();}
  else{const opened=await backends.get('robin').execute('/v1/chat/completions',{json:input,signal,verificationAccount:account});try{result=await opened.response.json();}finally{await opened.release?.();}}
  if(!result.choices?.[0]?.message?.content?.trim())throw new AppError(502,'模型测试未返回有效正文','verification_failed');
  const current=await accounts.get(id);current.grants={...current.grants,[backend]:'verified'};current.state='ready';current.checked_at=new Date().toISOString();current.verification={...current.verification,[backend]:{state:'verified',model:model.id,checked_at:current.checked_at,duration_ms:Date.now()-started}};await accounts.put(current);
  await accounts.recordUsage?.(id,backend,true,result.usage?.total_tokens);
  return{verified:true,backend,model:model.id,models:models.length};
 }catch(error){
  if(generationStarted)await accounts.recordUsage?.(id,backend,false);
  const current=await accounts.get(id);const failure={state:'failed',checked_at:new Date().toISOString(),code:error.code||'verification_failed',message:error instanceof AppError?error.message:'模型测试失败，请检查服务日志',duration_ms:Date.now()-started};current.verification={...current.verification,[backend]:failure};await accounts.put(current);throw error;
 }
}
