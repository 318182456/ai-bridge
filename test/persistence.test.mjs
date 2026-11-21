import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {AuthVault} from '../src/storage/auth-vault.mjs';
import {Postgres} from '../src/storage/postgres.mjs';
import {Store} from '../src/store.mjs';
import {accountDirectory} from '../public/js/components/account-directory.mjs';

const mockStorage=()=>{const rows=new Map();return{rows,profile:async(k,id)=>rows.get(k+id)||null,putProfile:async(k,id,archive,metadata)=>rows.set(k+id,{archive,metadata,checksum:createHash('sha256').update(archive).digest('hex')})};};
test('credential snapshots restore a missing keyring and retain last valid backup when sync fails',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-bridge-vault-test-')),storage=mockStorage(),vault=new AuthVault(storage,root),id='a_'+'1'.repeat(16),home=vault.path('agy',id),key=join(home,'.local/share/keyrings/login.keyring');
 try{
  await mkdir(join(home,'.local/share/keyrings'),{recursive:true});await writeFile(key,'synthetic-encrypted-keyring');await writeFile(join(home,'settings.json'),'synthetic-private-config');vault.mark('agy',id);assert.equal(await vault.capture('agy',id,{strict:true}),true);
  await rm(key);assert.equal(await vault.restore('agy',id),true);assert.equal(await readFile(key,'utf8'),'synthetic-encrypted-keyring');
  const before=storage.rows.get('agy'+id).checksum;storage.putProfile=async()=>{throw Error('synthetic unavailable database');};vault.mark('agy',id);await writeFile(key,'synthetic-new-keyring');assert.equal(await vault.capture('agy',id),false);assert.equal(storage.rows.get('agy'+id).checksum,before);assert.equal(vault.status().unsynced_profiles,1);assert.equal(await readFile(key,'utf8'),'synthetic-new-keyring');
  await assert.rejects(vault.restore('agy','../escape'),{status:400});
 }finally{await vault.close();await rm(root,{recursive:true,force:true});}
});
test('account directory merges explicit links once but never merges matching display names',()=>{
 const native=[{id:'a_1',name:'same',enabled:true,models:[],requests:2,successes:2,failures:0,total_tokens:8,token_reports:2},{id:'a_2',name:'same',enabled:true,models:[]}];
 const google=[{id:'g_1',label:'same',agy_account_id:'a_1',enabled:true,models:[],usage:{aist:{requests:3,successes:2,failures:1,total_tokens:10,reports:2}}},{id:'g_2',label:'same',enabled:false,models:[]}];
 const rows=accountDirectory(native,google);assert.equal(rows.length,3);assert.equal(rows.filter(a=>a.native?.id==='a_1').length,1);assert.equal(rows[0].requests,5);assert.equal(rows[0].total_tokens,18);assert.equal(rows.at(-1).id,'a_2');
});

test('PostgreSQL persists normalized state and snapshots across restart, guards singleton ownership and rollback',{skip:!process.env.PG_TEST_URL},async()=>{
 const url=process.env.PG_TEST_URL,root=await mkdtemp(join(tmpdir(),'ai-bridge-pg-test-'));let db=await new Postgres(url).open();
 try{
  const store=await new Store(root,db).init();const a=await store.create({name:'synthetic-pg-account'});await store.createKeys([{name:'synthetic-key',value:'synthetic-private-api-key-123456789'}]);
  await store.event({id:'event-one',status:400,code:'synthetic_error'});await db.putDocument('google-grant/g_test',{synthetic_refresh:'synthetic-value'});
  await assert.rejects(new Postgres(url).open(),{code:'storage_already_open'});const failed={...structuredClone(store.state),accounts:[...store.state.accounts,{name:'invalid-no-id'}]};await assert.rejects(db.saveState(failed),{code:'storage_unavailable'});
  await db.close();db=await new Postgres(url).open();const reopened=await new Store(root,db).init();assert.equal(reopened.state.accounts.length,1);assert.equal(reopened.state.accounts[0].id,a.id);assert.equal(reopened.state.keys.length,1);assert.equal(reopened.state.events.length,1);assert.equal((await db.document('google-grant/g_test')).synthetic_refresh,'synthetic-value');
  const backup=Buffer.from('synthetic-encrypted-archive');await db.putProfile('agy',a.id,backup,{critical:[]});assert.deepEqual((await db.profile('agy',a.id)).archive,backup);
  reopened.state.events=[];await reopened.save();assert.equal((await db.query('SELECT count(*)::int AS count FROM ai_bridge.request_events')).rows[0].count,0);
 }finally{await db.close();await rm(root,{recursive:true,force:true});}
});
