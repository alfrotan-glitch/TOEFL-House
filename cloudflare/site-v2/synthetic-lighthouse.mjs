// Local-only Lighthouse experiment: synthetic CMS, no real Pages bindings/assets.
// npm install --prefix /tmp/toefl-lh --no-save lighthouse@12.8.2
// TOEFL_LH_ROOT=/tmp/toefl-lh CHROME_PATH=/path/to/chrome node cloudflare/site-v2/synthetic-lighthouse.mjs /guides/ /fa/guides/
// Never treat these scores as a deployment, production or field-CWV measurement.
import http from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(process.env.TOEFL_LH_ROOT||'/tmp/toefl-lh');
const {default:lighthouse}=await import(pathToFileURL(join(root,'node_modules/lighthouse/core/index.js')));
const chromeLauncher=await import(pathToFileURL(join(root,'node_modules/chrome-launcher/dist/index.js')));
const {default:worker}=await import(pathToFileURL(join(here,'dist/_worker.js')));
const font=Buffer.from(await readFile(join(here,'vendor-font/Vazirmatn-33.003.woff2.base64'),'utf8'),'base64');
const paths=process.argv.slice(2);
if(!paths.length||paths.some(p=>!/^\/(?:[a-z0-9-]+\/)*$/.test(p)))throw Error('Pass one or more local sitemap paths, such as /fa/guides/');
const ids=['general-english','academic-english','toefl-preparation','special-speaking','professional-writing','teacher-training','online-individual-zoom'];
const programs=ids.map(id=>({id,title:id,summary:'Example program',duration:'2 months'}));
const enfa={locales:{en:{programs},fa:{programs}},media:{},timetable:{}},ps={programs};
const env={CMS_DB:{prepare(sql){return {async first(){return {body:JSON.stringify(sql.includes('pashto_content')?ps:enfa),revision:1};}}}}};
const server=http.createServer(async(req,res)=>{
 try{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/__th/v2/font/vazirmatn-33.003.woff2'){
   res.writeHead(200,{'content-type':'font/woff2'});return res.end(req.method==='HEAD'?undefined:font);
  }
  const response=await worker.fetch(new Request(url,{method:req.method,headers:req.headers}),env);
  res.writeHead(response.status,Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end('fixture error');}
});
await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
let chrome;
try{
 chrome=await chromeLauncher.launch({chromePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',chromeFlags:['--headless','--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost']});
 const out=process.env.TOEFL_LIGHTHOUSE_OUT||'.sandbox/lighthouse';await mkdir(out,{recursive:true});
 for(const path of paths){
  const {lhr}=await lighthouse('http://localhost:'+server.address().port+path,{port:chrome.port,logLevel:'error',onlyCategories:['performance','accessibility','best-practices','seo']});
  const report={path,scores:Object.fromEntries(Object.entries(lhr.categories).map(([key,value])=>[key,Math.round(value.score*100)])),metrics:Object.fromEntries(['largest-contentful-paint','cumulative-layout-shift','total-blocking-time','interactive'].map(key=>[key,lhr.audits[key]?.numericValue])),seoFailures:lhr.categories.seo.auditRefs.filter(ref=>ref.weight>0&&lhr.audits[ref.id].score!==null&&lhr.audits[ref.id].score<1).map(ref=>ref.id),limitations:['Local synthetic CMS; real Pages bindings and campus/external imagery unavailable','Preview is noindex','Not a production score or field INP']};
  await writeFile(join(out,encodeURIComponent(path)+'.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
 }
}finally{if(chrome)await chrome.kill();await new Promise(resolve=>server.close(resolve));}
