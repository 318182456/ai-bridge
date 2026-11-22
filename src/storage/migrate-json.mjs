import {createHash} from 'node:crypto';
import {readFile,readdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import {AuthVault} from './auth-vault.mjs';
import {Store} from '../store.mjs';
export async function migrateJson(storage,root){const vault=new AuthVault(storage,root);let count=0;try{
 if(await storage.document("migration-complete"))throw Error("Migration already completed; refusing to overwrite database state");

 const raw=await readFile(join(root,"state.json"),"utf8").catch(async error=>{if(error.code!=="ENOENT")throw error;return JSON.stringify((await new Store(root).init()).state);}),sourceHash=createHash("sha256").update(raw).digest("hex"),staging=await storage.document("migration-staging");
 if(await storage.document("state")&&staging?.source_hash!==sourceHash)throw Error("Database already has unrelated state; refusing to overwrite");
 if(staging&&staging.source_hash!==sourceHash)throw Error("Migration source changed; refusing to overwrite");
 await storage.putDocument("migration-staging",{source_hash:sourceHash});
 const state=JSON.parse(raw);
 if(!Array.isArray(state.accounts)||!Array.isArray(state.keys)||!Array.isArray(state.events))throw Error("Invalid source metadata");
 for(const a of state.accounts){if(!/^a_[a-f0-9]{16}$/.test(a.id))throw Error("Invalid native account id");try{await access(vault.path("agy",a.id));await vault.capture("agy",a.id,{force:true,strict:true});count++;}catch(e){if(e.code!=="ENOENT")throw e;}}
 let google={accounts:[]};try{google=JSON.parse(await readFile(join(root,"google/accounts.json"),"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;}
 for(const a of google.accounts){if(!/^g_[a-f0-9]{24}$/.test(a.id))throw Error("Invalid Google account id");try{await access(vault.path("google",a.id));await vault.capture("google",a.id,{force:true,strict:true});count++;}catch(e){if(e.code!=="ENOENT")throw e;}}
 for(const name of await readdir(join(root,"google/grants")).catch(e=>{if(e.code==="ENOENT")return[];throw e;})){if(!/^g_[a-f0-9]{24}\.json$/.test(name))continue;await storage.putDocument("google-grant/"+name.slice(0,-5),JSON.parse(await readFile(join(root,"google/grants",name),"utf8")));}
 await storage.putDocument("google-accounts",google);await storage.saveState(state);await storage.putDocument("migration-complete",{version:1,completed_at:new Date().toISOString()});
 console.log(JSON.stringify({migration_complete:true,accounts:state.accounts.length,keys:state.keys.length,events:state.events.length,google_accounts:google.accounts.length,auth_profiles:count}));

}finally{await vault.close();}}
