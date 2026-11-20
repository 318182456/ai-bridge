import test from "node:test";
import assert from "node:assert/strict";
import {modelCatalog,publicModels} from "../src/backends/catalog.mjs";
test("same model ID merges actual providers while disabled accounts remain diagnostic-only",async()=>{
 const store={list:()=>[{id:"a_1",name:"cli",enabled:true,status:"ready",models:[{id:"gemini-test",name:"Gemini"}],checked_at:"2026-11-20T00:00:00Z"}]};
 const backends={adapters:new Map([["aist",{catalogEntries:async()=>[{model:{id:"gemini-test"},account:{id:"g_1",name:"Google"},available:true,checked_at:"2026-11-20T01:00:00Z"},{model:{id:"disabled-model"},account:{id:"g_2",name:"disabled"},available:false}]}]])};
 const models=await modelCatalog(store,backends);assert.equal(models.length,2);const visible=publicModels(models);assert.equal(visible.data.length,1);assert.deepEqual(visible.data[0].backends,["agy","aist"]);assert.equal(models.find(m=>m.id==="gemini-test").sources.length,2);
});
