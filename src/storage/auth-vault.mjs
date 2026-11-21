import {create,extract,list} from "tar";
import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";
import {mkdir,access,mkdtemp,rename,rm} from "node:fs/promises";
import {join,dirname,resolve} from "node:path";
import {randomUUID,createHash} from "node:crypto";
import {AppError} from "../common.mjs";
const exists=path=>access(path).then(()=>true,()=>false);
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
const safe=path=>!path.startsWith("/")&&!/^[A-Za-z]:/.test(path)&&!path.includes("\\")&&!path.split("/").includes("..");
export class AuthVault {
 constructor(storage,dataDir,logger){Object.assign(this,{storage,root:resolve(dataDir),logger});this.chains=new Map();this.validated=new Set();this.failures=new Set();}
 path(kind,id){if(kind==="agy"&&/^a_[a-f0-9]{16}$/.test(id))return join(this.root,"accounts",id,"home");if(kind==="google"&&/^g_[a-f0-9]{24}$/.test(id))return join(this.root,"google","profiles",id);throw new AppError(400,"授权资料标识无效");}
 serial(key,action){const work=(this.chains.get(key)||Promise.resolve()).catch(()=>{}).then(action);this.chains.set(key,work);return work.finally(()=>{if(this.chains.get(key)===work)this.chains.delete(key);});}
 mark(kind,id){this.path(kind,id);this.validated.add(kind+":"+id);}
 unmark(kind,id){this.path(kind,id);return this.validated.delete(kind+":"+id);}
 status(){return{mode:"postgresql",pending_profiles:this.chains.size,unsynced_profiles:this.failures.size};}
 async validate(archive){
  if(!Buffer.isBuffer(archive)||archive.length>64*1024*1024)throw new AppError(503,"授权快照过大或格式无效","auth_snapshot_invalid");
  let entries=0,total=0;const paths=[];
  const parser=list({strict:true,onReadEntry:entry=>{
   if(++entries>20000||!safe(entry.path)||!["File","Directory"].includes(entry.type)||entry.size>64*1024*1024||(total+=entry.size)>256*1024*1024){parser.destroy(new AppError(503,"授权快照包含不安全或过大的条目","auth_snapshot_invalid"));entry.resume();return;}
   paths.push(entry.path);entry.resume();
  }});await pipeline(Readable.from([archive]),parser);return paths;
 }
 async restore(kind,id,{force=false}={}){const path=this.path(kind,id);return this.serial(kind+":"+id,async()=>{
  const record=await this.storage.profile(kind,id);if(!record)return false;
  if(!force&&await exists(path)&&await Promise.all((record.metadata.critical||[]).map(p=>safe(p)&&exists(join(path,p)))).then(a=>a.every(Boolean)))return false;
  if(digest(record.archive)!==record.checksum)throw new AppError(503,"授权快照校验失败，已保留本地资料","auth_snapshot_invalid");
  await this.validate(record.archive);await mkdir(dirname(path),{recursive:true,mode:0o700});const stage=await mkdtemp(join(dirname(path),".restore-"));let old=null,installed=false;
  try{
   await pipeline(Readable.from([record.archive]),extract({cwd:stage,preservePaths:false,strict:true,filter:(p,e)=>safe(p)&&["File","Directory"].includes(e.type)}));
   if(await exists(path)){old=path+".previous-"+randomUUID();await rename(path,old);}
   try{await rename(stage,path);installed=true;}catch(error){if(old)await rename(old,path);throw error;}
   this.failures.delete(kind+":"+id);return true;
  }finally{await rm(stage,{recursive:true,force:true});if(installed&&old)await rm(old,{recursive:true,force:true});}
 });}
 capture(kind,id,{force=false,strict=false}={}){const path=this.path(kind,id),key=kind+":"+id;if(!force&&!this.validated.has(key))return Promise.resolve(false);return this.serial(key,async()=>{
  if(!await exists(path))return false;const critical=[];
  // ASVS V1.2/V15: no links, runtime sockets or browser caches enter a credential snapshot.
  const stream=create({cwd:path,gzip:true,portable:true,noMtime:true,filter:(p,stat)=>{
   const clean=p.replace(/^\.\//,"");if(!safe(clean)||stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())return false;
   if(kind==="agy"&&/^\.gemini\/antigravity-cli\/(?:bin|log|conversations|brain|implicit|cache|builtin|tmp)(?:\/|$)/.test(clean))return false;
   if(clean.split("/").some(part=>[".cache","Cache","Code Cache","GPUCache","Crashpad"].includes(part))||/Singleton(?:Lock|Cookie|Socket)$/.test(clean))return false;
   if(stat.isFile()&&/(?:keyring|unlock|settings\.json$|Cookies$|Local State$|Preferences$)/i.test(clean))critical.push(clean);return true;
  }},["."]);
  const parts=[];let size=0;for await(const bytes of stream){size+=bytes.length;if(size>64*1024*1024){stream.destroy();throw new AppError(503,"授权快照超过限制","auth_snapshot_too_large");}parts.push(bytes);}
  const archive=Buffer.concat(parts);await this.validate(archive);const prior=await this.storage.profile(kind,id);
  for(const p of prior?.metadata.critical||[])if(!await exists(join(path,p)))throw new AppError(503,"授权资料不完整，未覆盖数据库中有效快照","auth_snapshot_incomplete");
  await this.storage.putProfile(kind,id,archive,{critical:[...new Set(critical)],format:1});this.validated.delete(key);this.failures.delete(key);return true;
 }).catch(error=>{this.failures.add(key);this.logger?.warn("auth.snapshot_failed",{code:error.code||"auth_snapshot_failed",stage:kind});if(strict)throw error;return false;});}
 async close(){await Promise.allSettled([...this.chains.values()]);}
}
