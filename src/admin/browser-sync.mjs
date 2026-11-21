import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {AppError,object} from '../common.mjs';
import {sessionOwner} from '../sessions.mjs';
import {googleCookies} from '../backends/browser-cookie-import.mjs';
const hash=s=>createHash('sha256').update(String(s)).digest();
const missing=()=>new AppError(404,'没有本机登录任务','browser_sync_missing');
export class BrowserSync{
 constructor({auth,accounts,queue,process,logger,ttl=900000}){Object.assign(this,{auth,accounts,queue,process,logger,ttl});this.jobs=new Map();}
 active(job){const row=this.auth.sessions.get(job.sessionToken),now=Date.now();return!!row&&row.created>now-43200000&&row.seen>now-1800000;}
 prune(){for(const job of this.jobs.values())if(job.state==='waiting_browser'&&job.expiresAt<Date.now()){job.state='expired';job.secret=null;}}
 view(job){return{id:job.id,target:job.target,account_id:job.account,account_label:job.label,state:job.state,expires_at:new Date(job.expiresAt).toISOString(),google_url:job.googleURL,step:job.step||null,error:job.error||null};}
 get(owner){this.prune();const job=[...this.jobs.values()].findLast(j=>j.owner===owner);if(!job)throw missing();return this.view(job);}
 async create(principal,input,origin){
  this.prune();const owner=sessionOwner(principal);object(input);if(Object.keys(input).some(k=>!['target','account_id','email'].includes(k))||!['aist','robin'].includes(input.target))throw new AppError(400,'登录目标无效');
  const targetOrigin=new URL(origin);if(targetOrigin.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(targetOrigin.hostname))throw new AppError(400,'本机凭据同步需要通过 HTTPS 管理地址使用');
  let account,email;if(input.account_id){if(!/^g_[a-f0-9]{24}$/.test(input.account_id))throw new AppError(400,'Google 账号无效');const a=await this.accounts.get(input.account_id);account=a.id;email=a.email;}else{email=String(input.email||'').trim().toLowerCase();if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new AppError(400,'新增账号请填写 Google 邮箱');account='g_'+randomBytes(12).toString('hex');}
  for(const j of this.jobs.values())if(j.owner===owner){if(['queued','running'].includes(j.state))throw new AppError(409,'本机同步正在保存，请先完成或取消');j.controller.abort();this.jobs.delete(j.id);}
  if(this.jobs.size>=100)for(const [id,j]of this.jobs)if(!['waiting_browser','queued','running'].includes(j.state))this.jobs.delete(id);
  if(this.jobs.size>=100)throw new AppError(429,'本机登录任务过多，请稍后重试');
  const token=randomBytes(32).toString('base64url'),job={id:randomUUID(),owner,sessionToken:principal.token,target:input.target,account,label:email,secret:hash(token),expiresAt:Date.now()+this.ttl,state:'waiting_browser',controller:new AbortController(),googleURL:input.target==='robin'?'https://accounts.google.com/EmbeddedSetup?source=android&xoauth_display_name=Android+Device&lang=zh&hl=zh-CN':'https://aistudio.google.com/prompts/new_chat?temporary=true'};this.jobs.set(job.id,job);return{...this.view(job),token,origin:targetOrigin.origin};
 }
 authorize(id,authorization){this.prune();const job=this.jobs.get(id);if(!job||job.state!=='waiting_browser'||!job.secret||!this.active(job)||!/^Bearer [A-Za-z0-9_-]{43}$/.test(String(authorization||''))||!timingSafeEqual(job.secret,hash(String(authorization||'').replace(/^Bearer /,''))))throw new AppError(401,'本机登录配对无效或已过期','browser_sync_unauthorized');return job;}
 deliver(job,input){
  object(input);let payload;if(job.target==='aist'){if(Object.keys(input).some(k=>!['cookies','authuser'].includes(k))||!Number.isInteger(input.authuser)||input.authuser<0||input.authuser>99)throw new AppError(400,'Google 账号序号无效');payload={cookies:googleCookies(input.cookies),authuser:input.authuser};}else{if(Object.keys(input).some(k=>k!=='oauth_token')||typeof input.oauth_token!=='string'||!input.oauth_token||input.oauth_token.length>16384||/[\r\n\0]/.test(input.oauth_token))throw new AppError(400,'Robin 授权结果无效');payload={oauth_token:input.oauth_token};}
  if(job.state!=='waiting_browser'||!job.secret)throw new AppError(409,'同步授权已使用');job.secret=null;job.state='queued';
  // ASVS V2.2 / V16.5: session-bound, expiring, single-use capability; do not persist or log credentials.
  // Only this short-lived capability authorizes cross-origin upload; cookies, keys and pairing secrets never enter task metadata.
  job.work=this.queue.add(async signal=>{if(!this.active(job)||Date.now()>job.expiresAt)throw new AppError(401,'管理会话或同步授权已失效');job.state='running';await this.process({target:job.target,account_id:job.account,expected_email:job.label,owner:job.owner,...payload},signal,value=>{job.step=value;});job.state='done';},job.controller.signal,{id:job.id,key:job.account,lane:'login',cancelable:true,metadata:{kind:'login',account_name:job.label,summary:'本机浏览器登录 · '+job.target}}).catch(error=>{job.state=error.code==='cancelled'?'cancelled':'failed';job.error=error instanceof AppError?error.message:'本机凭据同步保存失败';this.logger?.warn('browser_sync.failed',{stage:job.target,code:error.code||'browser_sync_failed',status:error.status||503});}).finally(()=>{payload.cookies=null;payload.oauth_token=null;});return{accepted:true};
 }
 cancel(owner){const job=[...this.jobs.values()].findLast(j=>j.owner===owner);if(!job)throw missing();job.secret=null;job.controller.abort();if(job.state==='waiting_browser')job.state='cancelled';return{cancelled:true};}
 closeAccount(account){for(const [id,j]of this.jobs)if(j.account===account){j.secret=null;j.controller.abort();this.jobs.delete(id);}}
 closeOwner(owner){for(const j of this.jobs.values())if(j.owner===owner){j.secret=null;j.controller.abort();if(j.state==='waiting_browser')j.state='cancelled';}}
 async close(){for(const j of this.jobs.values()){j.secret=null;j.controller.abort();}await Promise.allSettled([...this.jobs.values()].map(j=>j.work));}
}
export function registerBrowserSync({register,send,body,auth,sync,script}){
 register('POST','/api/browser-sync','mutation',async({req,res,principal})=>send(res,await sync.create(principal,await body(req),auth.sameOrigin(req).origin),202));
 register('GET','/api/browser-sync','read',async({res,principal})=>send(res,sync.get(sessionOwner(principal))));
 register('DELETE','/api/browser-sync','mutation',async({res,principal})=>send(res,sync.cancel(sessionOwner(principal))));
 register('POST',/^\/api\/browser-sync\/([a-f0-9-]{36})\/deliver$/,'public',async({req,res,match})=>{const job=sync.authorize(match[1],req.headers.authorization);const input=await body(req);sync.authorize(match[1],req.headers.authorization);send(res,sync.deliver(job,input),202);});
 register('GET','/userscripts/ai-bridge.user.js','public',async({req,res})=>{const url=new URL('https://'+req.headers.host);if(!/^[a-z0-9.[\]:-]+$/i.test(url.host))throw new AppError(400,'服务地址无效');if(['localhost','127.0.0.1','[::1]'].includes(url.hostname))url.protocol='http:';res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(await script(url.origin));});
}
