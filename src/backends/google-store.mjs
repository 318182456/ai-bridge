import {mkdir,readFile,writeFile,rename} from "node:fs/promises";
import {join} from "node:path";
import {AppError} from "../common.mjs";
export class GoogleAccounts {
 constructor(root,storage=null){this.storage=storage;this.dir=join(root,"google");this.path=join(this.dir,"accounts.json");this.loaded=null;this.state={accounts:[]};this.pending=Promise.resolve();}
 async load(){if(!this.loaded)this.loaded=(async()=>{await mkdir(this.dir,{recursive:true,mode:0o700});try{this.state=this.storage?(await this.storage.document("google-accounts")||{accounts:[]}):JSON.parse(await readFile(this.path,"utf8"));if(!Array.isArray(this.state.accounts))throw Error("Invalid Google account registry");}catch(e){if(e.code!=="ENOENT")throw e;}return this.state;})();return this.loaded;}
 async list(){await this.load();return this.state.accounts.map(a=>({...a,models:[...(a.models||[])]}));}
 async get(id){await this.load();const a=this.state.accounts.find(a=>a.id===id);if(!a)throw new AppError(404,"Google 账号不存在");return a;}
 async put(account){await this.load();if(!/^g_[a-f0-9]{24}$/.test(account.id))throw new AppError(400,"账号标识无效");const old=this.state.accounts.find(a=>a.id===account.id);if(old)Object.assign(old,account);else{if(this.state.accounts.length>=100)throw new AppError(409,"最多100个 Google 账号");this.state.accounts.push(account);}await this.save();return account;}
 async recordUsage(id,backend,success,tokens){const a=await this.get(id);a.usage||={};const u=a.usage[backend]||={requests:0,successes:0,failures:0,total_tokens:0,reports:0};u.requests++;u[success?"successes":"failures"]++;if(Number.isFinite(tokens)){u.total_tokens+=tokens;u.reports++;}await this.save();}
 save(){const data=JSON.stringify(this.state);if(this.storage){this.pending=this.pending.catch(()=>{}).then(()=>this.storage.putDocument("google-accounts",JSON.parse(data)));return this.pending;}this.pending=this.pending.catch(()=>{}).then(async()=>{await writeFile(this.path+".tmp",data,{mode:0o600});await rename(this.path+".tmp",this.path);});return this.pending;}
}
