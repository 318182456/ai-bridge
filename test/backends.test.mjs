import test from "node:test";
import assert from "node:assert/strict";
import {Backends} from "../src/backends/registry.mjs";
test("provider registry marks absent implementations explicitly and rejects duplicates",()=>{
 const b=new Backends();assert.deepEqual(b.list().map(x=>x.id),["agy","robin","aist"]);assert.equal(b.list()[1].state,"not_configured");assert.throws(()=>b.get("robin"),{code:"backend_not_ready"});b.register("agy",{status:()=>({state:"managed"})});assert.throws(()=>b.register("agy",{}));assert.throws(()=>b.register("other",{}));
});
