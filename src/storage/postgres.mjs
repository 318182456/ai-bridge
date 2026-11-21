import pg from "pg";
import {createHash} from "node:crypto";
import {AppError} from "../common.mjs";
const unavailable=()=>new AppError(503,"PostgreSQL 暂不可用，已保留现有授权资料","storage_unavailable");
const ddl=`CREATE SCHEMA IF NOT EXISTS ai_bridge;
CREATE TABLE IF NOT EXISTS ai_bridge.documents(name text PRIMARY KEY,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ai_bridge.accounts(id text PRIMARY KEY,value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS ai_bridge.api_keys(id text PRIMARY KEY,value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS ai_bridge.request_events(id text PRIMARY KEY,occurred_at timestamptz NOT NULL,sequence bigserial,value jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS request_events_time ON ai_bridge.request_events(occurred_at DESC,sequence DESC);
CREATE TABLE IF NOT EXISTS ai_bridge.auth_profiles(kind text NOT NULL,id text NOT NULL,checksum text NOT NULL,archive bytea NOT NULL,metadata jsonb NOT NULL,revision bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(kind,id));`;
// JSONB can reorder object keys; fingerprints must survive a database round trip.
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash=value=>createHash("sha256").update(Buffer.isBuffer(value)||typeof value==="string"?value:JSON.stringify(canonical(value))).digest("hex");
export class Postgres {
 constructor(url,{pool}={}){this.pool=pool||new pg.Pool({connectionString:url,max:4,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,statement_timeout:15000});this.pool.on?.("error",()=>{});this.pending=Promise.resolve();this.saved=null;this.closed=false;}
 async open({writer=true}={}){try{this.lease=await this.pool.connect();this.lease.on("error",()=>{this.failed=true;});if(writer){const r=await this.lease.query("SELECT pg_try_advisory_lock(193382,1) AS locked");if(!r.rows[0].locked)throw new AppError(409,"该数据库已有运行中的 AI Bridge，请先停止旧实例","storage_already_open");}await this.lease.query(ddl);return this;}catch(e){await this.close();if(e instanceof AppError)throw e;throw unavailable();}}
 assertReady(){if(this.failed||this.closed)throw unavailable();}
 async query(sql,values){this.assertReady();try{return await this.pool.query(sql,values);}catch{throw unavailable();}}
 async document(name){return(await this.query("SELECT value FROM ai_bridge.documents WHERE name=$1",[name])).rows[0]?.value??null;}
 async putDocument(name,value){await this.query("INSERT INTO ai_bridge.documents(name,value) VALUES($1,$2::jsonb) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[name,JSON.stringify(value)]);}
 async loadState(){
  const value=await this.document("state");if(!value)return null;
  const [accounts,keys,events]=await Promise.all([this.query("SELECT value FROM ai_bridge.accounts ORDER BY id"),this.query("SELECT value FROM ai_bridge.api_keys ORDER BY id"),this.query("SELECT value FROM ai_bridge.request_events ORDER BY occurred_at DESC,sequence DESC")]);
  const state={...value,accounts:accounts.rows.map(r=>r.value),keys:keys.rows.map(r=>r.value),events:events.rows.map(r=>r.value)};this.saved=this.fingerprints(state);return state;
 }
 fingerprints(state){const {accounts,keys,events,...config}=state;return{config:hash(config),accounts:new Map(accounts.map(a=>[a.id,hash(a)])),api_keys:new Map(keys.map(k=>[k.id,hash(k)])),request_events:new Map(events.map(e=>[hash(e),hash(e)]))};}
 saveState(state){const snapshot=structuredClone(state);const work=this.pending.catch(()=>{}).then(()=>this.saveSnapshot(snapshot));this.pending=work;return work;}
 async saveSnapshot(state){
  this.assertReady();  const next=this.fingerprints(state),previous=this.saved||{accounts:new Map(),api_keys:new Map(),request_events:new Map()};const client=await this.pool.connect().catch(()=>{throw unavailable();});
  try{
   await client.query("BEGIN");const {accounts,keys,events,...config}=state;
   if(next.config!==previous.config)await client.query("INSERT INTO ai_bridge.documents(name,value) VALUES('state',$1::jsonb) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[JSON.stringify(config)]);
   // Fixed table names only; all values are parameters (ASVS V1.2.4).
   for(const [table,rows]of [["accounts",accounts],["api_keys",keys],["request_events",[...events].reverse()]]){
    const old=previous[table];
    for(const row of rows){const id=table==="request_events"?hash(row):row.id;if(next[table].get(id)===old.get(id))continue;
     if(table==="request_events")await client.query("INSERT INTO ai_bridge.request_events(id,occurred_at,value) VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO NOTHING",[id,row.at,JSON.stringify(row)]);
     else await client.query("INSERT INTO ai_bridge."+table+"(id,value) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value",[id,JSON.stringify(row)]);
    }
    const removed=[...old.keys()].filter(id=>!next[table].has(id));if(removed.length)await client.query("DELETE FROM ai_bridge."+table+" WHERE id=ANY($1::text[])",[removed]);
   }
   await client.query("COMMIT");this.saved=next;
  }catch(e){await client.query("ROLLBACK").catch(()=>{});throw unavailable();}finally{client.release();}
 }
 async profile(kind,id){return(await this.query("SELECT archive,checksum,metadata,revision FROM ai_bridge.auth_profiles WHERE kind=$1 AND id=$2",[kind,id])).rows[0]||null;}
 async putProfile(kind,id,archive,metadata){const checksum=hash(archive);await this.query("INSERT INTO ai_bridge.auth_profiles(kind,id,checksum,archive,metadata) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(kind,id) DO UPDATE SET checksum=EXCLUDED.checksum,archive=EXCLUDED.archive,metadata=EXCLUDED.metadata,revision=ai_bridge.auth_profiles.revision+1,updated_at=now() WHERE ai_bridge.auth_profiles.checksum<>EXCLUDED.checksum",[kind,id,checksum,archive,JSON.stringify(metadata)]);return checksum;}
 async deleteProfile(kind,id){await this.query("DELETE FROM ai_bridge.auth_profiles WHERE kind=$1 AND id=$2",[kind,id]);}
 async close(){if(this.closed)return;await this.pending.catch(()=>{});this.closed=true;if(this.lease){await this.lease.query("SELECT pg_advisory_unlock(193382,1)").catch(()=>{});this.lease.release();this.lease=null;}await this.pool.end().catch(()=>{});}
}
