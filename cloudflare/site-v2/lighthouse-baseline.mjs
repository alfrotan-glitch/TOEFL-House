import lighthouse from "/tmp/toefl-lighthouse/node_modules/lighthouse/core/index.js";
import chromeLauncher from "/tmp/toefl-lighthouse/node_modules/chrome-launcher/dist/chrome-launcher.js";
import {mkdir,writeFile} from "node:fs/promises";
const targets=[
 ["home","https://the-toefl-house.pages.dev/"],
 ["dari","https://the-toefl-house.pages.dev/fa/"],
 ["admissions","https://the-toefl-house.pages.dev/fa/admissions/"]
];
const outputs=[];
await mkdir("lighthouse-results",{recursive:true});
for(const [label,url] of targets){
 const chrome=await chromeLauncher.launch({chromePath:"/usr/bin/google-chrome",chromeFlags:["--headless","--no-sandbox","--disable-dev-shm-usage","--disable-gpu"]});
 try{
  const r=await lighthouse(url,{port:chrome.port,output:"json",logLevel:"error",onlyCategories:["performance","accessibility","best-practices","seo"],formFactor:"mobile",screenEmulation:{mobile:true,width:390,height:844,deviceScaleFactor:1,disabled:false},throttlingMethod:"simulate"});
  const a=r.lhr.audits,cat=r.lhr.categories;
  const score={label,url,score:Object.fromEntries(Object.entries(cat).map(([key,v])=>[key,Math.round((v.score||0)*100)])),metrics:{
    fcp:a["first-contentful-paint"]?.numericValue,lcp:a["largest-contentful-paint"]?.numericValue,cls:a["cumulative-layout-shift"]?.numericValue,tbt:a["total-blocking-time"]?.numericValue,tti:a["interactive"]?.numericValue,serverResponse:a["server-response-time"]?.numericValue
  },issues:Object.values(a).filter(x=>x.score!==null&&x.score<0.8&&x.details?.type==="opportunity").map(x=>({id:x.id,title:x.title,score:x.score})).slice(0,8)};
  outputs.push(score);
  await writeFile("lighthouse-results/"+label+".json",JSON.stringify(r.lhr));
  console.log(JSON.stringify(score,null,2));
 }finally{await chrome.kill();}
}
console.log("OVERALL="+JSON.stringify(outputs));
