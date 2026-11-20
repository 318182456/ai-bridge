import {cp,mkdir,mkdtemp,readFile,writeFile,chmod,rm,access} from "node:fs/promises";
import {join,resolve,dirname} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {createReadStream} from "node:fs";
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const out=resolve(process.env.RELEASE_DIR||join(tmpdir(),"ai-bridge-release"));
if(process.platform!=="linux"||!["x64","arm64"].includes(process.arch))throw Error("Native releases must be assembled on matching Linux runners");
const cli=process.env.NATIVE_AGY_BIN;if(!cli)throw Error("NATIVE_AGY_BIN must point to the pinned, checksum-verified official CLI");await access(cli);
const workspace=await mkdtemp(join(tmpdir(),"ai-bridge-package-")),stage=join(workspace,"ai-bridge");
const run=(cmd,args)=>new Promise((resolve,reject)=>{const p=spawn(cmd,args,{shell:false,stdio:"inherit"});p.once("error",reject);p.once("close",code=>code===0?resolve():reject(Error("Packaging command failed")));});
try{
 await mkdir(stage);for(const dir of ["src","public","scripts","deploy","node_modules"])await cp(join(root,dir),join(stage,dir),{recursive:true,verbatimSymlinks:true,filter:path=>!path.includes(".local-browsers")&&!path.includes(".cache")});
 for(const file of ["package.json","package-lock.json","README.md","DESIGN.md"])await cp(join(root,file),join(stage,file));
 // Preserve an existing application license verbatim; never assign one in packaging.
 try{await cp(join(root,"LICENSE"),join(stage,"LICENSE"));}catch(e){if(e.code!=="ENOENT")throw e;}
 await mkdir(join(stage,"bin"));await cp(process.execPath,join(stage,"bin/node"));await cp(cli,join(stage,"bin/agy"));await chmod(join(stage,"bin/node"),0o755);await chmod(join(stage,"bin/agy"),0o755);await chmod(join(stage,"scripts/login-pty.sh"),0o755);
 await mkdir(join(stage,"third-party"));const nodeLicense=join(dirname(process.execPath),"../LICENSE");await cp(nodeLicense,join(stage,"third-party/NODE-LICENSE.txt"));
 await writeFile(join(stage,"third-party/NOTICE.txt"),"Node.js and npm dependencies retain their existing licenses (included with each dependency). The official agy CLI and Chromium retain their respective vendor terms. Packaging does not relicense any component.\n");
 const version=JSON.parse(await readFile(join(root,"package.json"),"utf8")).version,platform="linux-"+(process.arch==="x64"?"amd64":"arm64");
 await writeFile(join(stage,"release.json"),JSON.stringify({format:1,version,platform,experimental:true,backends:{agy:{implemented:true},robin:{implemented:true},aist:{implemented:true}},verification:{node_tests:true,browser_smoke:process.env.BROWSER_SMOKE_VERIFIED==="true",google_integration:false}},null,2));
 await run(join(stage,"bin/node"),[join(stage,"scripts/check-release.mjs")]);await mkdir(out,{recursive:true});const asset="ai-bridge-"+platform+".tar.gz",path=join(out,asset);await run("tar",["-czf",path,"-C",workspace,"ai-bridge"]);
 const hash=createHash("sha256");for await(const part of createReadStream(path))hash.update(part);await writeFile(join(out,asset+".sha256"),hash.digest("hex")+"  "+asset+"\n");console.log("Assembled "+asset);
}finally{await rm(workspace,{recursive:true,force:true});}
