import {WebSocketServer} from "ws";
import {equalSecret} from "../common.mjs";
export class Upgrades {
 constructor({server,auth}){Object.assign(this,{server,auth});this.routes=[];this.connections=new Map();this.ws=new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false,handleProtocols:protocols=>protocols.has("ai-bridge")?"ai-bridge":false});server.on("upgrade",(req,socket,head)=>{this.accept(req,socket,head).catch(()=>{if(!socket.destroyed)socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");});});}
 register(path,connect){this.routes.push({path,connect,method:"UPGRADE",access:"upgrade"});}
 async accept(req,socket,head){
  socket.on("error",()=>{});if(req.method!=="GET")throw Error("Unsupported upgrade");const url=new URL(req.url,"http://internal"),route=this.routes.find(r=>r.path.test(url.pathname));if(!route||url.search)throw Error("Unknown upgrade");
  this.auth.sameOrigin(req);const principal=this.auth.session(req),protocols=req.headers["sec-websocket-protocol"]?.split(",").map(s=>s.trim())||[],csrf=protocols.find(s=>s.startsWith("csrf."))?.slice(5);
  if(!protocols.includes("ai-bridge")||!equalSecret(csrf,principal.csrf)||this.connections.size>=8)throw Error("Invalid upgrade");
  const connection={owner:principal.token,socket,ws:null};this.connections.set(socket,connection);let resource;
  try{resource=await route.connect({req,principal,match:url.pathname.match(route.path)});this.auth.session(req);if(socket.destroyed)throw Error("Client closed");
   await new Promise((resolve,reject)=>{this.ws.handleUpgrade(req,socket,head,ws=>{connection.ws=ws;ws.on("error",()=>{});const timer=setInterval(()=>{try{this.auth.session(req);}catch{ws.close(4001,"Session expired");ws.terminate();}},15000);timer.unref();ws.once("close",()=>{clearInterval(timer);resolve();});try{resource.attach(ws);}catch(e){ws.terminate();reject(e);}});});
  }finally{resource?.release();this.connections.delete(socket);}
 }
 closeOwner(owner){for(const c of this.connections.values())if(c.owner===owner){c.ws?.close(4001,"Signed out");c.ws?.terminate();c.socket.destroy();}}
 close(){for(const c of this.connections.values()){c.ws?.terminate();c.socket.destroy();}this.ws.close();}
 catalog(){return this.routes.map(({method,path,access})=>({method,path:String(path),access}));}
}
