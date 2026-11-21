import {connectTLS} from "../runtime/tls-tunnel.mjs";
import http2 from "node:http2";
import {setTimeout as sleep} from "node:timers/promises";
import {GrpcDecoder,grpc} from "./robin-wire.mjs";
import {AppError} from "../common.mjs";
export class RobinRPC {
 constructor({origin="https://robinfrontend-pa.googleapis.com",timeout=180000,connect=http2.connect,connectTLS:tlsConnector=connectTLS}={}){Object.assign(this,{origin,timeout,connect,tlsConnector});this.session=null;this.users=0;this.idle=null;}
 async sessionFor(signal){
  if(signal?.aborted)throw new AppError(499,"请求已取消","cancelled");
  const wait=promise=>signal?new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener("abort",abort);reject(new AppError(499,"请求已取消","cancelled"));};signal.addEventListener("abort",abort,{once:true});promise.then(value=>{signal.removeEventListener("abort",abort);resolve(value);},error=>{signal.removeEventListener("abort",abort);reject(error);});if(signal.aborted)abort();}):promise;
  if(this.session&&!this.session.closed&&!this.session.destroyed)return this.session;
  if(this.connecting)return wait(this.connecting);
  const controller=new AbortController();this.connectionController=controller;
  this.connecting=(async()=>{
   const url=new URL(this.origin),socket=await this.tlsConnector(url.hostname,Number(url.port)||443,{alpn:["h2"],signal:controller.signal});
   if(controller.signal.aborted){socket.destroy();throw new AppError(499,"请求已取消","cancelled");}
   const s=this.connect(this.origin,{createConnection:()=>socket,settings:{enablePush:false}});
   s.on("error",()=>{if(this.session===s)this.session=null;});s.on("goaway",()=>{if(this.session===s)this.session=null;s.close();});this.session=s;return s;
  })().finally(()=>{if(this.connectionController===controller)this.connectionController=null;this.connecting=null;});return wait(this.connecting);
 }

 async *call(method,frames,{token,signal,bidi=false}={}){
  if(!["GetUserStatus","ProcessQuery","DeleteConversation"].includes(method)||typeof token!=="string"||/[\r\n]/.test(token))throw new AppError(400,"Robin RPC 参数无效");
  if(signal?.aborted)throw new AppError(499,"请求已取消","cancelled");clearTimeout(this.idle);this.users++;
  const controller=new AbortController(),cancel=()=>controller.abort();signal?.addEventListener("abort",cancel,{once:true});const timer=setTimeout(cancel,this.timeout);timer.unref?.();
  let stream,writer,status="0",httpStatus=0;
  try{
   stream=(await this.sessionFor(controller.signal)).request({":method":"POST",":path":"/assistant.mobile.robin.RobinService/"+method,"content-type":"application/grpc","te":"trailers","grpc-accept-encoding":"gzip",authorization:"Bearer "+token,"user-agent":"grpc-java/1.60.0"});
   const abort=()=>stream.close(http2.constants.NGHTTP2_CANCEL);controller.signal.addEventListener("abort",abort,{once:true});if(controller.signal.aborted)abort();
   stream.on("response",h=>{httpStatus=Number(h[":status"]);if(h["grpc-status"]!=null)status=String(h["grpc-status"]);});stream.on("trailers",h=>{if(h["grpc-status"]!=null)status=String(h["grpc-status"]);});
   writer=(async()=>{for(const frame of frames){if(controller.signal.aborted)break;stream.write(grpc(frame.data));if(frame.delay)await sleep(frame.delay,undefined,{signal:controller.signal});}if(!bidi&&!controller.signal.aborted)stream.end();})();writer.catch(()=>{});
   const decoder=new GrpcDecoder();for await(const bytes of stream){if(controller.signal.aborted)break;for(const payload of decoder.feed(bytes))yield payload;}
   if(controller.signal.aborted)throw new AppError(signal?.aborted?499:504,signal?.aborted?"请求已取消":"Robin 请求超时",signal?.aborted?"cancelled":"backend_timeout");
   decoder.finish();if(httpStatus!==200||status!=="0")throw new AppError(status==="16"?401:status==="7"?403:status==="8"?429:502,"Robin 上游拒绝请求（gRPC "+status+"）","backend_rpc_failed");
  }catch(error){if(controller.signal.aborted)throw new AppError(signal?.aborted?499:504,signal?.aborted?"请求已取消":"Robin 请求超时",signal?.aborted?"cancelled":"backend_timeout");if(error instanceof AppError)throw error;throw new AppError(signal?.aborted?499:502,signal?.aborted?"请求已取消":"Robin 连接失败",signal?.aborted?"cancelled":"backend_connection_failed");}
  finally{clearTimeout(timer);signal?.removeEventListener("abort",cancel);controller.abort();stream?.close();await writer?.catch(()=>{});this.users--;if(!this.users){this.idle=setTimeout(()=>this.close(),120000);this.idle.unref?.();}}
 }
 close(){clearTimeout(this.idle);this.connectionController?.abort();this.session?.destroy();this.session=null;}
}
