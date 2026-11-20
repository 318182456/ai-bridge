import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {GoogleBrowser} from "../src/backends/browser.mjs";
import {chromium} from "playwright-core";
const root=await mkdtemp(join(tmpdir(),"ai-bridge-browser-smoke-")),before=process.env.BROWSER_EXECUTABLE;
process.env.BROWSER_EXECUTABLE=before||chromium.executablePath();
const browser=new GoogleBrowser({dataDir:root,idleMs:20});
try{const lease=await browser.acquire("g_"+"0".repeat(24));try{const page=await lease.context.newPage();await page.goto("data:text/html,<form><input aria-label='value'><button>save</button></form>");await page.getByLabel("value").fill("synthetic");if(await page.getByLabel("value").inputValue()!=="synthetic")throw Error("Browser editing failed");await page.close();}finally{lease.release();}await browser.stop();console.log(JSON.stringify({browser_started:true,editing:true,browser_stopped:!browser.status().browser_running,node_rss:process.memoryUsage().rss}));}
finally{await browser.close();if(before===undefined)delete process.env.BROWSER_EXECUTABLE;else process.env.BROWSER_EXECUTABLE=before;await rm(root,{recursive:true,force:true});}
