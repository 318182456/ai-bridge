import {connectTLS,proxySetting} from "../runtime/tls-tunnel.mjs";
import {mkdir,readFile,writeFile,rename} from "node:fs/promises";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import https from "node:https";
import {AppError} from "../common.mjs";
// Credentials stay on the server; public account records contain grant states only.
export class GoogleGrants {
 constructor(root,{post,storage}={}){this.storage=storage;this.dir=join(root,"google","grants");this.post=post||authForm;this.pending=new Map();}
 path(id){if(!/^g_[a-f0-9]{24}$/.test(id))throw new AppError(400,"账号标识无效");return join(this.dir,id+".json");}
 async read(id){this.path(id);if(this.storage)return await this.storage.document("google-grant/"+id)||{};try{return JSON.parse(await readFile(this.path(id),"utf8"));}catch(e){if(e.code==="ENOENT")return{};throw e;}}
 async save(id,value){this.path(id);if(this.storage)return this.storage.putDocument("google-grant/"+id,value);await mkdir(this.dir,{recursive:true,mode:0o700});const path=this.path(id);await writeFile(path+".tmp",JSON.stringify(value),{mode:0o600});await rename(path+".tmp",path);}
 async bindRobin(account,oauthToken,signal){
  if(typeof oauthToken!=="string"||!oauthToken||oauthToken.length>16384)throw new AppError(400,"Google 未返回有效的 Robin 授权","robin_authorization_missing");
  const old=await this.read(account.id),androidId=old.robin?.android_id||randomBytes(8).toString("hex");
  const values=await this.post({accountType:"HOSTED_OR_GOOGLE",Email:account.email,has_permission:"1",source:"android",androidId,service:"ac2dm",add_account:"1",ACCESS_TOKEN:"1",Token:oauthToken,client_sig:"38918a453d07199354f8b19af05ec6562ced5788"},{signal});
  if(!values.Token)throw new AppError(401,"Google 未授予 Robin 访问权限","robin_authorization_failed");
  // Bind the returned Google subject to the selected account; never silently relabel another identity.
  if(typeof values.Email!=="string"||values.Email.toLowerCase()!==account.email.toLowerCase())throw new AppError(409,"Google 授权身份与所选账号不一致，请选择该账号重新授权","account_identity_mismatch");
  old.robin={email:account.email,android_id:androidId,master_token:values.Token};await this.save(account.id,old);return this.robinToken(account.id,signal);
 }
 async robinToken(id,signal){
  if(this.pending.has(id))return this.pending.get(id);
  const work=(async()=>{const grants=await this.read(id),r=grants.robin;if(!r?.master_token)throw new AppError(401,"Robin 尚未授权","backend_auth_required");if(r.access_token&&r.expires_at>Date.now()+60000)return r.access_token;
   const data=await this.post({accountType:"HOSTED_OR_GOOGLE",Email:r.email,has_permission:"1",source:"android",androidId:r.android_id,EncryptedPasswd:r.master_token,service:"oauth2:https://www.googleapis.com/auth/assistant",app:"com.google.android.googlequicksearchbox",client_sig:"38918a453d07199354f8b19af05ec6562ced5788"},{signal});
   if(!data.Auth)throw new AppError(401,"Robin 授权需要重新确认","backend_auth_required");r.access_token=data.Auth;const lifetime=Number(data.ExpiresIn);r.expires_at=Date.now()+(Number.isFinite(lifetime)&&lifetime>0?Math.min(lifetime,86400):3600)*1000;await this.save(id,grants);return r.access_token;
  })().finally(()=>this.pending.delete(id));this.pending.set(id,work);return work;
 }
}
function authForm(values,{signal}={}){
 const body=new URLSearchParams(values).toString();const agent=proxySetting()?new https.Agent({keepAlive:false}):false;if(agent)agent.createConnection=(_options,done)=>{connectTLS("android.clients.google.com",443,{signal}).then(socket=>done(null,socket),done);};return new Promise((resolve,reject)=>{
  const req=https.request({hostname:"android.clients.google.com",path:"/auth",method:"POST",agent,headers:{"content-type":"application/x-www-form-urlencoded","content-length":Buffer.byteLength(body),"user-agent":"GoogleAuth/1.4"},signal,timeout:20000},response=>{
   let size=0;const chunks=[];response.on("data",b=>{size+=b.length;if(size>65536)response.destroy();else chunks.push(b);});response.once("error",()=>reject(new AppError(502,"Google 授权响应中断","google_auth_failed")));response.once("end",()=>{if(response.statusCode!==200)return reject(new AppError(response.statusCode===429?429:response.statusCode>=500?503:401,response.statusCode>=500||response.statusCode===429?"Google 授权服务暂不可用，请稍后重试":"Google 未接受此次授权",response.statusCode>=500||response.statusCode===429?"google_auth_unavailable":"google_auth_failed"));const fields=Object.create(null);for(const line of Buffer.concat(chunks).toString("utf8").split(/\r?\n/)){const i=line.indexOf("=");if(i>0)fields[line.slice(0,i)]=line.slice(i+1);}resolve(fields);});
  });req.once("timeout",()=>req.destroy());req.once("error",()=>reject(new AppError(signal?.aborted?499:502,signal?.aborted?"授权已取消":"Google 授权连接失败",signal?.aborted?"cancelled":"google_auth_failed")));req.once("close",()=>agent&&agent.destroy());req.end(body);
 });
}
