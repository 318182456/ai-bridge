import test from 'node:test';import assert from 'node:assert/strict';
import {studioFailure} from '../src/backends/studio-failure.mjs';
test('AI Studio failures expose HTTP/status and safe reasons instead of secrets or raw response bodies',async()=>{
 for(const [status,body,expected]of [
 [403,{error:{status:'PERMISSION_DENIED',message:'User location is not supported for the API use. synthetic-private-token'}},/出口地区/],
 [400,{error:{status:'INVALID_ARGUMENT',message:'Invalid JSON payload. Unknown name "imageSize": synthetic-private-token'}},/imageSize/],
 [429,{error:{status:'RESOURCE_EXHAUSTED',message:'private request'}},/额度/],
 [403,'<html>captcha synthetic-private-token</html>',/额外验证/],
 [503,'synthetic-private-token',/暂时不可用/]]){
  const e=await studioFailure(new Response(typeof body==='string'?body:JSON.stringify(body),{status}));assert.equal(e.status,status);assert.match(e.message,new RegExp('HTTP '+status));assert.match(e.message,expected);assert.ok(!e.message.includes('synthetic-private-token'));assert.ok(!e.message.includes('private request'));assert.ok(!e.message.includes('<html>'));
 }
});
test('oversized and broken upstream errors remain bounded and generic',async()=>{
 let cancelled=false;const response=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));},cancel(){cancelled=true;}}),{status:403});const e=await studioFailure(response);assert.equal(cancelled,true);assert.match(e.message,/HTTP 403/);assert.match(e.message,/没有返回可识别/);
});

test('Playwright responses retain real status and Google reason without reflecting private data',async()=>{const response={status:()=>403,headerValue:async()=>null,body:async()=>Buffer.from(JSON.stringify({error:{status:'PERMISSION_DENIED',message:'User location is not supported for the API use.'}}))};const e=await studioFailure(response);assert.equal(e.status,403);assert.match(e.message,/PERMISSION_DENIED/);assert.match(e.message,/出口地区/);let read=false;const large={status:()=>400,headerValue:async()=>'65537',body:async()=>{read=true;}};await studioFailure(large);assert.equal(read,false);});
