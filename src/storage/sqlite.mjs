import {mkdir,chmod} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {AppError} from '../common.mjs';
const fail=()=>new AppError(503,'SQLite 暂不可用，已保留现有数据','storage_unavailable');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(Buffer.isBuffer(v)?v:JSON.stringify(canonical(v))).digest('hex');
export class SQLite{
 constructor(path){this.path=resolve(path);this.mode='sqlite';this.pending=Promise.resolve();this.saved=null;this.closed=false;}
 async open(){
  await mkdir(dirname(this.path),{recursive:true,mode:0o700});
  try{const {DatabaseSync}=await import('node:sqlite');this.db=new DatabaseSync(this.path);await chmod(this.path,0o600);
   this.db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS documents(name TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS request_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,occurred_at TEXT NOT NULL,value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS request_events_time ON request_events(occurred_at DESC,sequence DESC);
    CREATE TABLE IF NOT EXISTS auth_profiles(kind TEXT NOT NULL,id TEXT NOT NULL,checksum TEXT NOT NULL,archive BLOB NOT NULL,metadata TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(kind,id));`);return this;
  }catch{this.db?.close();throw fail();}
 }
 assertReady(){if(this.closed||!this.db)throw fail();}
 async health(){this.assertReady();try{this.db.prepare('SELECT 1').get();}catch{throw fail();}}
 async document(name){this.assertReady();try{const row=this.db.prepare('SELECT value FROM documents WHERE name=?').get(name);return row?JSON.parse(row.value):null;}catch{throw fail();}}
 async putDocument(name,value){this.assertReady();try{this.db.prepare('INSERT INTO documents(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name,JSON.stringify(value));}catch{throw fail();}}
 async loadState(){
  const value=await this.document('state');if(!value)return null;
  try{const state={...value,accounts:this.db.prepare('SELECT value FROM accounts ORDER BY id').all().map(r=>JSON.parse(r.value)),keys:this.db.prepare('SELECT value FROM api_keys ORDER BY id').all().map(r=>JSON.parse(r.value)),events:this.db.prepare('SELECT value FROM request_events ORDER BY occurred_at DESC,sequence DESC').all().map(r=>JSON.parse(r.value))};this.saved=this.fingerprints(state);return state;}catch{throw fail();}
 }
 fingerprints(state){const {accounts,keys,events,...config}=state;return{config:hash(config),accounts:new Map(accounts.map(a=>[a.id,hash(a)])),api_keys:new Map(keys.map(k=>[k.id,hash(k)])),request_events:new Map(events.map(e=>[hash(e),hash(e)]))};}
 saveState(state){const snapshot=structuredClone(state);const work=this.pending.catch(()=>{}).then(()=>this.saveSnapshot(snapshot));this.pending=work;return work;}
 saveSnapshot(state){
  this.assertReady();const next=this.fingerprints(state),previous=this.saved||{accounts:new Map(),api_keys:new Map(),request_events:new Map()};
  try{this.db.exec('BEGIN IMMEDIATE');const {accounts,keys,events,...config}=state;
   if(next.config!==previous.config)this.db.prepare("INSERT INTO documents(name,value) VALUES('state',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(JSON.stringify(config));
   // ASVS 1.2.4: table names come only from this fixed list; every value is bound.
   for(const [table,rows]of [['accounts',accounts],['api_keys',keys],['request_events',[...events].reverse()]]){
    const old=previous[table];for(const row of rows){const id=table==='request_events'?hash(row):row.id;if(next[table].get(id)===old.get(id))continue;
     if(table==='request_events')this.db.prepare('INSERT INTO request_events(id,occurred_at,value) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').run(id,row.at,JSON.stringify(row));
     else this.db.prepare('INSERT INTO '+table+'(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id,JSON.stringify(row));
    }
    const remove=this.db.prepare('DELETE FROM '+table+' WHERE id=?');for(const id of old.keys())if(!next[table].has(id))remove.run(id);
   }
   this.db.exec('COMMIT');this.saved=next;
  }catch{try{this.db.exec('ROLLBACK');}catch{}throw fail();}
 }
 async profile(kind,id){this.assertReady();try{const row=this.db.prepare('SELECT archive,checksum,metadata,revision FROM auth_profiles WHERE kind=? AND id=?').get(kind,id);return row?{...row,archive:Buffer.from(row.archive),metadata:JSON.parse(row.metadata)}:null;}catch{throw fail();}}
 async putProfile(kind,id,archive,metadata){this.assertReady();const checksum=hash(archive);try{this.db.prepare('INSERT INTO auth_profiles(kind,id,checksum,archive,metadata) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET checksum=excluded.checksum,archive=excluded.archive,metadata=excluded.metadata,revision=auth_profiles.revision+1 WHERE auth_profiles.checksum<>excluded.checksum').run(kind,id,checksum,archive,JSON.stringify(metadata));return checksum;}catch{throw fail();}}
 async deleteProfile(kind,id){this.assertReady();try{this.db.prepare('DELETE FROM auth_profiles WHERE kind=? AND id=?').run(kind,id);}catch{throw fail();}}
 async close(){if(this.closed)return;await this.pending.catch(()=>{});this.closed=true;if(this.db){try{this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}catch{}this.db.close();this.db=null;}}
}
