import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserEngine} from '../src/backends/browser-engine.mjs';

test('manual login never acquires an automated context before confirmation and closes the native browser first',async()=>{
 const order=[];const manual={confirmed:false,async start(){order.push('manual-start');},async capture(){return{bytes:Buffer.from('fixture'),width:640,height:480};},async input(v){if(v.type==='confirm')this.confirmed=true;},async close(){order.push('manual-close');}};
 const engine=new BrowserEngine({root:'fixture',accounts:{get:async()=>null},browser:{checkpoint:async()=>{},runtime:{prepare:async()=>{},executable:async()=>'/fixture/chrome'},acquire:async()=>{order.push('automation-acquire');throw Object.assign(Error('fixture-stop'),{code:'fixture-stop'});}},manualFactory:()=>manual});
 const iterator=engine.login('owner',{},new AbortController().signal);let frame;
 for(let i=0;i<8;i++){const v=await iterator.next();if(v.value?.browser_binary){frame=true;break;}}
 assert.ok(frame);assert.deepEqual(order,['manual-start']);engine.input('owner',{context:'foreign',type:'confirm'});assert.equal(manual.confirmed,false);engine.input('owner',{context:'owner',type:'confirm'});await manual.pending;await Promise.resolve();assert.equal(manual.confirmed,true);
 await assert.rejects(iterator.next(),{code:'fixture-stop'});assert.deepEqual(order,['manual-start','manual-close','automation-acquire']);assert.equal(engine.jobs.size,0);
});

test('cancelling manual login closes the desktop without acquiring an automated context',async()=>{
 let closed=0,acquired=0;const controller=new AbortController();const manual={confirmed:false,start:async()=>{},capture:async()=>({bytes:Buffer.from('fixture'),width:640,height:480}),close:async()=>{closed++;}};
 const engine=new BrowserEngine({root:'fixture',accounts:{get:async()=>null},browser:{checkpoint:async()=>{},runtime:{prepare:async()=>{},executable:async()=>'/fixture/chrome'},acquire:async()=>{acquired++;}},manualFactory:()=>manual});
 const iterator=engine.login('owner',{},controller.signal);for(let i=0;i<8;i++){const v=await iterator.next();if(v.value?.browser_binary)break;}controller.abort();await assert.rejects(iterator.next(),{code:'cancelled'});assert.equal(closed,1);assert.equal(acquired,0);assert.equal(engine.jobs.size,0);
});

