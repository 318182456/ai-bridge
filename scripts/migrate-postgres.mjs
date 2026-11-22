import {resolve} from 'node:path';
import {Postgres} from '../src/storage/postgres.mjs';
import {migrateJson} from '../src/storage/migrate-json.mjs';
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is required');
const storage=await new Postgres(process.env.DATABASE_URL).open();
try{await migrateJson(storage,resolve(process.env.DATA_DIR||'data'));}finally{await storage.close();}
