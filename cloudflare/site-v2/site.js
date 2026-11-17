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
var enquiry=document.getElementById("v2-enquiry-form");
if(enquiry){
 var selectedProgram=new URLSearchParams(location.search).get("program");
 var courseChoice=enquiry.querySelector("#v2-program");
 if(selectedProgram && courseChoice && [...courseChoice.options].some(function(x){return x.value===selectedProgram;}))courseChoice.value=selectedProgram;
 enquiry.addEventListener("submit",function(event){
  event.preventDefault();
  if(!enquiry.checkValidity()){enquiry.reportValidity();return;}
  var chosen=enquiry.querySelector("#v2-program");
  var format=enquiry.querySelector("#v2-format");
  var when=enquiry.querySelector("#v2-when");
  var values=[chosen?.selectedOptions[0]?.textContent||"",format?.selectedOptions[0]?.textContent||"",when?.selectedOptions[0]?.textContent||""];
  var current=enquiry.getAttribute("data-locale")||"en";
  var template={
   en:"Hello. I would like information about courses at The TOEFL House and a free placement assessment.\nProgram: ",
   fa:"سلام. می‌خواهم در مورد صنف‌های خانه موفقیت معلومات بگیرم و تعیین سطح رایگان انجام بدهم.\nبرنامه: ",
   ps:"سلام. د خانه موفقیت د کورسونو معلومات او د وړیا سویې معلومولو غوښتنه لرم.\nپروګرام: "
  };
  var labels={
   en:["\nLearning format: ","\nPreferred time: ","\nPlease share class times and fees. Thank you."],
   fa:["\nشیوهٔ آموزش: ","\nوقت مورد نظر: ","\nلطفاً تقسیم اوقات و فیس را شریک سازید. تشکر."],
   ps:["\nد زده‌کړې بڼه: ","\nوخت: ","\nمهرباني وکړئ د ټولګي وختونه او فیس راسره شریک کړئ. مننه."]
  };
  var l=labels[current]||labels.en;
  var message=(template[current]||template.en)+values[0]+l[0]+values[1]+l[1]+values[2]+l[2];
  var number=enquiry.getAttribute("data-number")||"93794357509";
  location.assign("https://wa.me/"+number+"?text="+encodeURIComponent(message));
 });
}

})();
