import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {browserSyncScript} from '../src/admin/browser-sync-script.mjs';

async function panel(target='aist',url='https://aistudio.google.com/u/2/prompts/new_chat',values=new Map()){
 const nodes=[],navigation=[];let shadow;
 class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.attrs={};this.events={};this.style={};this.hidden=false;this.value='';this.isConnected=false;nodes.push(this);}
  append(...items){this.children.push(...items);for(const n of items)n.isConnected=true;}
  attachShadow(){shadow=new Element('shadow');return shadow;}
  setAttribute(k,v){this.attrs[k]=v;}
  addEventListener(k,v){this.events[k]=v;}
  focus(){this.focused=true;}
 }
 const job={id:'11111111-1111-1111-1111-111111111111',token:'synthetic-pair',origin:'https://bridge.invalid',target,label:'<img src=x onerror=alert(1)>',expires:Date.now()+600000};values.set('ai-bridge-local-login',JSON.stringify(job));
 const document={createElement:t=>new Element(t),documentElement:new Element('html')};
 const location=new URL(url);location.assign=u=>navigation.push(u);
 const context={URL,Date,Map,Promise,Number,String,JSON,document,location,window:{},setTimeout,clearTimeout,addEventListener(){},MutationObserver:class{observe(){}},GM_getValue:(k,f)=>values.has(k)?values.get(k):f,GM_setValue:(k,v)=>values.set(k,v),GM_deleteValue:k=>values.delete(k),GM_registerMenuCommand(){}};
 vm.runInNewContext(await browserSyncScript('https://bridge.invalid'),context);
 return {nodes,values,job,navigation,box:nodes.find(n=>n.id==='ai-bridge-sync-panel'),launcher:nodes.find(n=>n.id==='launcher'),index:nodes.find(n=>n.id==='google-account-index'),switcher:nodes.find(n=>n.textContent==='切换账号'),close:nodes.find(n=>n.textContent==='收起'),status:nodes.find(n=>n.tagName==='p'&&!n.textContent)};
}
test('sync panel starts compact, can reopen, remembers only presentation and restores keyboard focus',async()=>{
 const t=await panel();assert.equal(t.box.hidden,true);assert.equal(t.launcher.attrs['aria-expanded'],'false');t.launcher.onclick();assert.equal(t.box.hidden,false);assert.equal(t.close.focused,true);assert.equal(t.values.get('ai-bridge-sync-expanded'),true);t.box.events.keydown({key:'Escape'});assert.equal(t.box.hidden,true);assert.equal(t.launcher.focused,true);t.launcher.onclick();const next=await panel('aist',undefined,t.values);assert.equal(next.box.hidden,false);assert.ok(t.nodes.some(n=>n.textContent==='同步目标：'+t.job.label));assert.ok(!t.nodes.some(n=>'innerHTML' in n));assert.deepEqual([...t.values.keys()].sort(),['ai-bridge-local-login','ai-bridge-sync-expanded']);
});
test('AIST switching routes to selected Google account without changing the paired destination',async()=>{
 const t=await panel();assert.equal(t.index.value,'2');t.index.value='3';t.switcher.onclick();assert.equal(t.navigation[0],'https://aistudio.google.com/u/3/prompts/new_chat?temporary=true');assert.equal(JSON.parse(t.values.get('ai-bridge-local-login')).id,t.job.id);t.index.value='https://evil.invalid';t.switcher.onclick();assert.equal(t.navigation.length,1);assert.ok(t.status.textContent.includes('0–99'));t.index.value='-1';t.switcher.onclick();assert.equal(t.navigation.length,1);
});
test('Robin account chooser preserves official authorization continuation and hides the AIST index',async()=>{
 const url='https://accounts.google.com/v3/signin/identifier?flowName=EmbeddedSetup';const t=await panel('robin',url);assert.equal(t.index.hidden,true);t.switcher.onclick();const next=new URL(t.navigation[0]);assert.equal(next.origin,'https://accounts.google.com');assert.equal(next.pathname,'/AccountChooser');assert.equal(next.searchParams.get('continue'),url);
 const wrong=await panel('robin');wrong.switcher.onclick();assert.equal(wrong.navigation.length,0);
});
