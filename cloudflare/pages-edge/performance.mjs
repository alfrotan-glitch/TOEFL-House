const hosts={
  current:"https://the-toefl-house.pages.dev",
  preview:"https://ea3b7ad7.the-toefl-house.pages.dev"
};
const paths=["/","/fa/","/api/content","/admissions/","/assets/index-Ch3KjNPK.js"];
const results=[];
function median(a){const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)];}
for(const p of paths){
  const samples={current:[],preview:[]};
  for(let i=0;i<8;i++){
    for(const kind of i%2?["preview","current"]:["current","preview"]){
      const started=performance.now();
      const r=await fetch(hosts[kind]+p,{signal:AbortSignal.timeout(15000)});
      await r.arrayBuffer();
      const ms=Math.round(performance.now()-started);
      if(!r.ok)throw new Error(kind+" "+p+" HTTP "+r.status);
      samples[kind].push(ms);
    }
  }
  const a=median(samples.current),b=median(samples.preview),difference=b-a;
  const result={path:p,currentMedianMs:a,previewMedianMs:b,deltaMs:difference,samples};
  results.push(result);
  console.log(JSON.stringify(result));
}
console.log(JSON.stringify({summary:results.map(({path,currentMedianMs,previewMedianMs,deltaMs})=>({path,currentMedianMs,previewMedianMs,deltaMs}))},null,2));
