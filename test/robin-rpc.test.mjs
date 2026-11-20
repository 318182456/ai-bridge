import test from 'node:test';
import assert from 'node:assert/strict';
import {RobinRPC} from '../src/backends/robin-rpc.mjs';

test('Robin cancellation interrupts pending TLS and never opens an HTTP/2 stream',async()=>{
 let opened=0,entered;
 const ready=new Promise(resolve=>entered=resolve);
 const rpc=new RobinRPC({connect:()=>{opened++;throw Error('must not connect');},connectTLS:(_host,_port,{signal})=>new Promise((_resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true});})});
 const controller=new AbortController();
 const work=(async()=>{for await(const _ of rpc.call('GetUserStatus',[],{token:'synthetic-token',signal:controller.signal})){} })();
 await ready;controller.abort();await assert.rejects(work,error=>error.code==='cancelled'||error.status===499);assert.equal(opened,0);assert.equal(rpc.users,0);rpc.close();
});

test('Robin shutdown disposes a TLS socket which completes after cancellation',async()=>{
 let finish,entered,destroyed=0,opened=0;
 const ready=new Promise(resolve=>entered=resolve);
 const rpc=new RobinRPC({connect:()=>{opened++;},connectTLS:()=>new Promise(resolve=>{finish=resolve;entered();})});
 const work=rpc.sessionFor();await ready;rpc.close();finish({destroy(){destroyed++;}});
 await assert.rejects(work);assert.equal(destroyed,1);assert.equal(opened,0);assert.equal(rpc.session,null);
});
