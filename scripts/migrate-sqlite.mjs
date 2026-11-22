import {resolve,join} from 'node:path';
import {SQLite} from '../src/storage/sqlite.mjs';
import {migrateJson} from '../src/storage/migrate-json.mjs';
const root=resolve(process.env.DATA_DIR||'data'),storage=await new SQLite(join(root,'ai-bridge.sqlite')).open();
try{await migrateJson(storage,root);}finally{await storage.close();}
