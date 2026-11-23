import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const source=readFileSync(new URL("../site.js",import.meta.url),"utf8");

function submitWithNumber(configuredNumber){
 const events={};
 const links=[];
 const option={textContent:"TOEFL Preparation",value:"toefl-preparation",getAttribute(){return "";}};
 const select={value:"toefl-preparation",options:[option],selectedOptions:[option]};
 const form={
  querySelector(selector){return selector==="#v2-program"||selector==="#v2-when"||selector==="#v2-format"?select:null;},
  addEventListener(type,callback){events[type]=callback;},
  getAttribute(name){return name==="data-number"?configuredNumber:name==="data-locale"?"en":null;},
  checkValidity(){return true;}
 };
 const document={
  getElementById(id){return id==="v2-enquiry-form"?form:null;},
  querySelector(){return null;},
  querySelectorAll(){return [];},
  createElement(){return {style:{},setAttribute(){},click(){links.push(this.href);},remove(){}};},
  body:{appendChild(){}}
 };
 const location={search:"",hash:"",pathname:"/admissions/",href:"https://toeflhouse.pages.dev/admissions/",origin:"https://toeflhouse.pages.dev"};
 runInNewContext(source,{document,location,URLSearchParams,URL,sessionStorage:{getItem(){return null;},setItem(){}},console});
 assert.equal(typeof events.submit,"function");
 events.submit({preventDefault(){}});
 assert.equal(links.length,1);
 return new URL(links[0]);
}

test("admissions accepts valid international WhatsApp destination",()=>{
 const url=submitWithNumber("93794357509");
 assert.equal(url.hostname,"wa.me");
 assert.equal(url.pathname,"/93794357509");
 assert.match(url.searchParams.get("text"),/TOEFL Preparation/);
});

test("admissions refuses injected WhatsApp query parameters in number",()=>{
 const url=submitWithNumber("93794357509?text=attacker");
 assert.equal(url.hostname,"wa.me");
 assert.equal(url.pathname,"/93794357509");
 assert.doesNotMatch(url.searchParams.get("text"),/attacker/);
});

test("admissions refuses invalid numbers and uses documented destination",()=>{
 for(const invalid of ["+93794357509","0000000000","12","abc","93794357509/evil"]){
  const url=submitWithNumber(invalid);
  assert.equal(url.pathname,"/93794357509");
 }
});
