/* TOEFL House V2: tiny progressive enhancement; no cookies and no PII. */
(function(){
"use strict";
var known=location.hash?decodeURIComponent(location.hash.slice(1)):"";
var legacy=/(?:^|\/)(?:fa|ps)?\/?tools\/?$/.test(location.pathname);
if(known&&!legacy&&!document.getElementById(known)){
  var current=location.pathname;
  var lang=current.indexOf("/fa/")===0?"/fa/":current.indexOf("/ps/")===0?"/ps/":"/";
  location.replace(lang+"tools/"+location.hash);
  return;
}
var menu=document.querySelector(".mobile-menu");
if(menu){
  menu.querySelectorAll('nav a').forEach(function(a){a.addEventListener("click",function(){menu.open=false;});});
  document.addEventListener("keydown",function(event){if(event.key==="Escape")menu.open=false;});
  document.addEventListener("click",function(event){if(menu.open&&!menu.contains(event.target))menu.open=false;});
}
})();
