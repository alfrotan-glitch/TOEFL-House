import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
const source=readFileSync(new URL("../site.js",import.meta.url),"utf8");
function scenario(search){
 const handlers={},drafts=[];
 const option=(value,textContent)=>({value,textContent,disabled:false,getAttribute(){return ""}});
 function select(values,initial){
  const options=values.map(x=>option(...x));
  return {options,value:initial,get selectedOptions(){return options.filter(x=>x.value===this.value)}};
 }
 const program=select([["","Choose"],["general-english","General English"],["online-individual-zoom","Private online"]],"");
 const format=select([["campus","In person"],["online","Google Meet"]],"campus");
 const time=select([["flexible","Flexible"],["morning","Morning"]],"flexible");
 const link={href:"/fa/admissions/",getAttribute(){return this.href},setAttribute(key,value){if(key==="href")this.href=value}};
 const form={querySelector(s){return {"#v2-program":program,"#v2-format":format,"#v2-when":time}[s]||null},addEventListener(type,fn){(handlers[type]??=[]).push(fn)},getAttribute(n){return n==="data-locale"?"en":n==="data-number"?"93794357509":null},checkValidity(){return true}};
 const location={search,hash:"",pathname:"/admissions/",href:"https://toeflhouse.pages.dev/admissions/"+search,origin:"https://toeflhouse.pages.dev"};
 const document={getElementById(id){return id==="v2-enquiry-form"?form:null},querySelector(){return null},querySelectorAll(){return [link]},createElement(){return {style:{},setAttribute(){},click(){drafts.push(new URL(this.href))},remove(){}}},body:{appendChild(){}}};
 runInNewContext(source,{document,location,URLSearchParams,URL,sessionStorage:{getItem(){return null},setItem(){}},console});
 return {program,format,time,link,drafts,change(){for(const fn of handlers.change)fn({})},submit(){for(const fn of handlers.submit)fn({preventDefault(){}})}};
}
test("online-only program corrects conflicting direct link and language state",()=>{
 const x=scenario("?program=online-individual-zoom&format=campus&when=morning");
 assert.equal(x.format.value,"online");
 assert.equal(x.format.options[0].disabled,true);
 assert.match(x.link.href,/program=online-individual-zoom&format=online&when=morning/);
 x.format.value="campus";x.submit();
 assert.match(x.drafts[0].searchParams.get("text"),/Learning format: Google Meet/);
});
test("switching out of private online restores earlier format without restricting other programs",()=>{
 const x=scenario("?program=general-english&format=campus");
 x.program.value="online-individual-zoom";x.change();
 assert.equal(x.format.value,"online");
 assert.equal(x.format.options[0].disabled,true);
 x.program.value="general-english";x.change();
 assert.equal(x.format.value,"campus");
 assert.equal(x.format.options[0].disabled,false);
 x.format.value="online";x.change();
 x.program.value="online-individual-zoom";x.change();
 x.program.value="general-english";x.change();
 assert.equal(x.format.value,"online");
});
