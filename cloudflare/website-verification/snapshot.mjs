import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";

const manifest = JSON.parse(await readFile(new URL("./pages-static-manifest.json", import.meta.url), "utf8"));
const root = resolve("cloudflare-pages-public-snapshot");
const host = "https://the-toefl-house.pages.dev";
await mkdir(root, {recursive:true});
const report = {
  project:manifest.project,
  deployment_id:manifest.deployment_id,
  timestamp:new Date().toISOString(),
  note:"Public, compiled assets only; not original source or Pages Functions",
  files:[]
};
for (const [asset, hash] of Object.entries(manifest.files)) {
  if (!/^\/[a-zA-Z0-9/_\-.]+$/.test(asset) || asset.includes("..")) {
    throw new Error("Unsafe manifest asset path: "+asset);
  }
  const entry = {path:asset,deployment_hash:hash};
  try {
    const response = await fetch(host+asset, {signal:AbortSignal.timeout(20000)});
    entry.status = response.status;
    entry.final_url = response.url;
    if (response.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      entry.bytes = bytes.length;
      const filename = join(root,asset.slice(1));
      await mkdir(dirname(filename),{recursive:true});
      await writeFile(filename,bytes);
    } else {
      entry.error = "Asset not publicly readable";
    }
  } catch (error) {
    entry.error = String(error);
  }
  report.files.push(entry);
  console.log(entry.status || "ERROR",asset,entry.bytes || 0);
}
await writeFile(join(root,"BACKUP-REPORT.json"),JSON.stringify(report,null,2)+"\n");
const ok=report.files.filter(x=>x.status===200).length;
console.log("Snapshot",ok,"of",report.files.length,"static files; original Pages Functions not included.");
if(ok===0)process.exitCode=1;
