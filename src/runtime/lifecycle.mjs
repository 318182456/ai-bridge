// Bounded cleanup on service stop; database recovery stays inside the live connection pool.
export function manageProcess(app,{runtime=process,timeoutMs=10000,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 let stopping=null,exitCode=0,exited=false;
 const exit=()=>{if(exited)return;exited=true;runtime.exit(exitCode);};
 const stop=(code=0)=>{
  exitCode=Math.max(exitCode,code);if(stopping)return stopping;
  const deadline=setTimer(exit,timeoutMs);deadline.unref?.();
  stopping=Promise.resolve().then(async()=>{
   // Stop accepting work before shutting down providers or touching snapshots.
   app.server.close();app.server.closeIdleConnections?.();app.tasks.close();app.loginManager.close();
   await Promise.allSettled([app.browserSync.close(),app.catalogRefresh.close(),app.store.pending,app.backends.close(),app.runner.close()]);
   await app.authVault?.close();await app.storage?.close();
  }).catch(()=>{exitCode=1;}).finally(()=>{clearTimer(deadline);exit();});return stopping;
 };
 runtime.once('SIGTERM',()=>void stop(0));runtime.once('SIGINT',()=>void stop(0));
 return{stop};
}
