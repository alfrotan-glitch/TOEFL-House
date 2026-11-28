import {readFile,mkdir,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
import {createHash} from "node:crypto";
import {buildStyles} from "./build-styles.mjs";
import {loadContent} from "./content-compiler.mjs";
import {loadBrand} from "./brand-asset.mjs";
import {composeEdge} from "./compose-edge.mjs";
const here=dirname(fileURLToPath(import.meta.url));
let main=await readFile(join(here,"../pages-edge/worker.mjs"),"utf8");
const landing=await readFile(join(here,"landing.mjs"),"utf8");
const detail=await readFile(join(here,"detail.mjs"),"utf8");
const components=await readFile(join(here,"course-components.mjs"),"utf8");
const router=await readFile(join(here,"router.mjs"),"utf8");
const generalEnglish=await readFile(join(here,"general-english.mjs"),"utf8");
const guides=await readFile(join(here,"guides.mjs"),"utf8");
const publicContent=await readFile(join(here,"public-content.mjs"),"utf8");
// Translation files remain readable and are validated and compacted at build time.
const programContent=await loadContent();
const academicEnglish=await readFile(join(here,"academic-english.mjs"),"utf8");
const specialPrograms=await readFile(join(here,"special-programs.mjs"),"utf8");
// Compile the three source layers to the existing single, versioned CSS endpoint.
const {css}=await buildStyles();
const js=await readFile(join(here,"site.js"),"utf8");
const assetRevision=createHash("sha256").update(css).update(js).digest("hex").slice(0,12);
const modules=[await loadBrand(),landing,generalEnglish,programContent,components,academicEnglish,specialPrograms,detail,guides,publicContent,router,
 "const V2_REV="+JSON.stringify(assetRevision)+";",
 "const V2_CSS="+JSON.stringify(css)+";",
 "const V2_JS="+JSON.stringify(js)+";"].join("\n");
main=composeEdge(main,modules);
if(!main.includes("function v2GeneralEnglish")||!main.includes("function v2AcademicEnglishPage")||!main.includes("function v2SpecialProgramPage")||!main.includes("async function v2Home")||!main.includes("function v2NotFound")||!main.includes("async function v2Route")||!main.includes("function v2Guides")||!main.includes("function v2PublicContent")||!main.includes("function v2PublicSitemap")||!main.includes("async function v2ServeLegacyTools")||!main.includes("env.LEGACY_CMS.fetch")||!main.includes("Never proxy to the retired Pages origin"))throw Error("Build missing new routes");
await mkdir(join(here,"dist"),{recursive:true});
await writeFile(join(here,"dist/_worker.js"),main);
console.log(JSON.stringify({output:"dist/_worker.js",bytes:Buffer.byteLength(main),assetRevision,cssBytes:Buffer.byteLength(css),clientBytes:Buffer.byteLength(js),retiredOriginProxy:false}));
