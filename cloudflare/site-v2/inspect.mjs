const response=await fetch("https://the-toefl-house.pages.dev/api/content",{signal:AbortSignal.timeout(25000)});
if(!response.ok)throw Error("CMS API HTTP "+response.status);
const c=await response.json();
const desc=o=>o&&typeof o==="object"?Object.keys(o):typeof o;
console.log(JSON.stringify({keys:desc(c),content:desc(c.content),data:desc(c.data),locales:desc(c.locales),pashto:desc(c.pashto),ps:desc(c.ps),homepage:desc(c.homepage),published:desc(c.published),eng:c.content?.locales?.en&&Object.keys(c.content.locales.en),fa:c.content?.locales?.fa&&Object.keys(c.content.locales.fa),status:c.cmsStatus,preview:JSON.stringify(c).slice(0,450)},null,2));
