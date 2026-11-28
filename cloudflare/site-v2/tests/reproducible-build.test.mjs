import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, copyFile, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";

const site=dirname(dirname(fileURLToPath(import.meta.url)));

test("identical source builds byte-identical Workers across UTC dates",async()=>{
 const root=await mkdtemp(join(tmpdir(),"toefl-build-"));
 try{
  const copy=join(root,"site-v2"), edge=join(root,"pages-edge");
  await mkdir(copy); await mkdir(edge);
  for(const name of await readdir(site)){
   if(name.endsWith(".mjs") || name==="site.css" || name==="site.js")
    await copyFile(join(site,name),join(copy,name));
  }
  await copyFile(join(site,"../pages-edge/worker.mjs"),join(edge,"worker.mjs"));
  const clock=join(root,"clock.cjs");
  await writeFile(clock,`const RealDate=Date; global.Date=class extends RealDate { constructor(...args){ super(...(args.length?args:[process.env.TEST_BUILD_DATE])); } static now(){ return new RealDate(process.env.TEST_BUILD_DATE).getTime(); } };`);
  const build=date=>execFileSync(process.execPath,["--require",clock,join(copy,"build.mjs")],{env:{...process.env,TEST_BUILD_DATE:date},stdio:"pipe"});
  build("2026-11-28T23:59:59Z");
  const first=await readFile(join(copy,"dist/_worker.js"));
  build("2026-11-29T00:00:01Z");
  const second=await readFile(join(copy,"dist/_worker.js"));
  const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
  assert.equal(first.length,second.length,"release artifact size changed across dates");
  assert.equal(sha256(first),sha256(second),"wall-clock time must not alter the release artifact");
 }finally{await rm(root,{recursive:true,force:true});}
});
