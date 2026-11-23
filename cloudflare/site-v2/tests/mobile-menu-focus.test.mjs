import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const source=readFileSync(new URL("../site.js",import.meta.url),"utf8");

function bootMenu(){
 const handlers={};
 const toggle={focused:false,focus(){this.focused=true;}};
 const link={};
 const menu={
  open:true,
  contains(element){return element===link||element===toggle;},
  querySelector(selector){return selector==="summary"?toggle:null;},
  querySelectorAll(){return [];}
 };
 const document={
  activeElement:link,
  querySelector(selector){return selector===".mobile-menu"?menu:null;},
  getElementById(){return null;},
  addEventListener(name,callback){handlers[name]=callback;}
 };
 const location={search:"",hash:"",pathname:"/",href:"https://toeflhouse.pages.dev/"};
 runInNewContext(source,{document,location,URLSearchParams,sessionStorage:{getItem(){return null;},setItem(){}},URL,console});
 return {handlers,menu,toggle,link,document};
}

test("Escape closes mobile menu and returns keyboard focus to toggle",()=>{
 const {handlers,menu,toggle}=bootMenu();
 handlers.keydown({key:"Escape"});
 assert.equal(menu.open,false);
 assert.equal(toggle.focused,true);
});

test("Escape does not steal focus when menu is already closed",()=>{
 const {handlers,menu,toggle}=bootMenu();
 menu.open=false;
 handlers.keydown({key:"Escape"});
 assert.equal(toggle.focused,false);
});

test("Escape closes menu without stealing focus from outside",()=>{
 const {handlers,menu,toggle,document}=bootMenu();
 document.activeElement={};
 handlers.keydown({key:"Escape"});
 assert.equal(menu.open,false);
 assert.equal(toggle.focused,false);
});

test("other keys leave menu and focus unchanged",()=>{
 const {handlers,menu,toggle}=bootMenu();
 handlers.keydown({key:"Enter"});
 assert.equal(menu.open,true);
 assert.equal(toggle.focused,false);
});
