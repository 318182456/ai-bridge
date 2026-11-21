import {createServer} from "node:http";
import {connectTunnel} from "../runtime/tls-tunnel.mjs";
export const googleHost=host=>["google.com","googleapis.com","googleusercontent.com","gstatic.com","ggpht.com","youtube.com","recaptcha.net"].some(root=>host===root||host.endsWith("."+root));
// ASVS V2.2: loopback-only, first-party HTTPS CONNECT only; no general-purpose relay.
export async function manualProxy({connect=connectTunnel}={}){
 const sockets=new Set(),controllers=new Set();const server=createServer({maxHeaderSize:8192},(_req,res)=>{res.writeHead(403);res.end();});
 server.on("connection",socket=>{sockets.add(socket);socket.on("error",()=>{});socket.once("close",()=>sockets.delete(socket));});
 server.on("connect",async(req,client,head)=>{const controller=new AbortController();controllers.add(controller);client.once("close",()=>controller.abort());let upstream;
  try{const target=new URL("https://"+req.url);if(target.username||target.password||target.pathname!=="/"||target.search||target.hash||target.port&&target.port!=="443"||!googleHost(target.hostname)||controllers.size>32)throw Error();
   upstream=await connect(target.hostname,443,{signal:controller.signal});if(client.destroyed)throw Error();upstream.on("error",()=>client.destroy());client.on("error",()=>upstream.destroy());client.once("close",()=>upstream.destroy());upstream.once("close",()=>client.destroy());client.write("HTTP/1.1 200 Connection Established\r\n\r\n");if(head.length)upstream.write(head);client.pipe(upstream).pipe(client);
  }catch{upstream?.destroy();if(!client.destroyed)client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");}finally{if(!upstream)controllers.delete(controller);else upstream.once("close",()=>controllers.delete(controller));}
 });
 await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});return{server:"http://127.0.0.1:"+server.address().port,close:async()=>{for(const c of controllers)c.abort();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
