import net from "node:net";
import tls from "node:tls";
import {AppError} from "../common.mjs";
export const proxySetting=()=>process.env.HTTPS_PROXY||process.env.HTTP_PROXY||process.env.ALL_PROXY||null;
const failed=()=>new AppError(502,"上游代理或 TLS 连接失败","upstream_connection_failed");
async function ready(socket,event,signal){return new Promise((resolve,reject)=>{let timer;const done=(error)=>{clearTimeout(timer);socket.off(event,success);socket.off("error",errorHandler);signal?.removeEventListener("abort",abort);if(error){socket.destroy();reject(error);}else resolve(socket);};const success=()=>done();const errorHandler=()=>done(failed());const abort=()=>done(new AppError(499,"请求已取消","cancelled"));socket.once(event,success);socket.once("error",errorHandler);signal?.addEventListener("abort",abort,{once:true});timer=setTimeout(()=>done(failed()),15000);if(signal?.aborted)abort();});}
export async function connectTLS(host,port=443,{signal,alpn,proxy=proxySetting()}={}){
 if(!/^[a-zA-Z0-9.-]+$/.test(host)||!Number.isInteger(port)||port<1||port>65535)throw failed();
 let socket;
 if(proxy){let url;try{url=new URL(proxy);}catch{throw failed();}if(!["http:","https:"].includes(url.protocol))throw new AppError(503,"当前原生上游连接需要 HTTP/HTTPS CONNECT 代理","unsupported_proxy");
  socket=url.protocol==="https:"?tls.connect({host:url.hostname,port:Number(url.port)||443,servername:url.hostname,rejectUnauthorized:true}):net.connect({host:url.hostname,port:Number(url.port)||80});
  await ready(socket,url.protocol==="https:"?"secureConnect":"connect",signal);
  await new Promise((resolve,reject)=>{let bytes=Buffer.alloc(0);const timer=setTimeout(()=>finish(failed()),15000);const abort=()=>finish(new AppError(499,"请求已取消","cancelled"));const error=()=>finish(failed());
   const finish=e=>{clearTimeout(timer);socket.off("data",data);socket.off("error",error);signal?.removeEventListener("abort",abort);if(e){socket.destroy();reject(e);}else resolve();};
   const data=chunk=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.length>16384)return finish(failed());const end=bytes.indexOf("\r\n\r\n");if(end<0)return;if(!/^HTTP\/1\.[01] 200(?: |\r)/.test(bytes.toString("latin1",0,end)))return finish(failed());const tail=bytes.subarray(end+4);socket.pause();if(tail.length)socket.unshift(tail);finish();};
   socket.on("data",data);socket.once("error",error);signal?.addEventListener("abort",abort,{once:true});
   const credentials=url.username?"Proxy-Authorization: Basic "+Buffer.from(decodeURIComponent(url.username)+":"+decodeURIComponent(url.password)).toString("base64")+"\r\n":"";
   socket.write("CONNECT "+host+":"+port+" HTTP/1.1\r\nHost: "+host+":"+port+"\r\n"+credentials+"\r\n");if(signal?.aborted)abort();
  });
 }
 const secure=tls.connect({...(socket?{socket}:{host,port}),servername:host,rejectUnauthorized:true,...(alpn?{ALPNProtocols:alpn}:{})});secure.on("error",()=>{});return ready(secure,"secureConnect",signal);
}
