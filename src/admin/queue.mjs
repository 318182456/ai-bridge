import {AppError} from "../common.mjs";
export function registerQueue({register,send,queue}){
  // ASVS V8/V14: request content is admin-session-only, in memory, never in generic runtime/status responses or logs.
  register("GET","/api/queue","read",async({res})=>send(res,{...queue.status,items:queue.list()}));
  const path=/^\/api\/queue\/([a-f0-9-]{36})$/;
  register("GET",path,"read",async({res,match})=>send(res,queue.get(match[1])));
  register("DELETE",path,"mutation",async({res,match})=>send(res,await queue.cancel(match[1])));
  register("POST",/^\/api\/queue\/([a-f0-9-]{36})\/promote$/,"mutation",async({res,match})=>send(res,queue.promote(match[1])));
}
