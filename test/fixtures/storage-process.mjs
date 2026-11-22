import {createApplication} from '../../src/server.mjs';
import {manageProcess} from '../../src/runtime/lifecycle.mjs';
const app=await createApplication();manageProcess(app);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const pid=(await app.storage.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
process.send({process:process.pid,port:app.server.address().port,pid,accounts:app.store.list().length});
