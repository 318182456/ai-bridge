// ASVS 15.4.3/16.5.3: release runtime resources; never revive stale state after the PG writer lease is lost.
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
 const storageFailure=()=>{app.logger.error('storage.restart_required',{code:'storage_lease_lost',stage:'storage',message:'数据库持锁连接已中断，正在安全退出；由服务管理器重启并重新读取数据库。'});void stop(1);};
 app.storage?.once('failure',storageFailure);
 runtime.once('SIGTERM',()=>void stop(0));runtime.once('SIGINT',()=>void stop(0));
 if(app.storage?.failed)storageFailure();
 return{stop};
}
