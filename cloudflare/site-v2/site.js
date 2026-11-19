/* TOEFL House V2: tiny progressive enhancement; no cookies and no PII. */
(function(){
"use strict";
// Preserve anonymous campaign attribution across same-tab course navigation,
// including previews where production analytics are intentionally disabled.
try{
 var utm=new URLSearchParams(location.search);
 var utmSource=utm.get("utm_source")||utm.get("s");
 var utmCampaign=utm.get("utm_campaign")||utm.get("c");
 function safeUtm(x,max){return typeof x==="string"&&x.length<=max&&/^[a-z0-9][a-z0-9_-]*$/.test(x)?x:"";}
 var safeSource=safeUtm(utmSource,32);
 var safeCampaign=safeUtm(utmCampaign,48);
 if(safeSource||safeCampaign){
  sessionStorage.setItem("th_campaign",JSON.stringify({source:safeSource||"website",campaign:safeCampaign||"site_cta"}));
 }
}catch(_){}
var known="";
if(location.hash){try{known=decodeURIComponent(location.hash.slice(1));}catch(_){known="";}}
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
   fa:"سلام. می‌خواهم در مورد صنف‌های تافل هوس معلومات بگیرم و تعیین سطح رایگان انجام بدهم.\nبرنامه: ",
   ps:"سلام. د خانه موفقیت د کورسونو معلومات او د وړیا سویې معلومولو غوښتنه لرم.\nپروګرام: "
  };
  var labels={
   en:["\nLearning format: ","\nPreferred time: ","\nPlease share class times and fees. Thank you."],
   fa:["\nشیوهٔ آموزش: ","\nوقت مورد نظر: ","\nلطفاً تقسیم اوقات و فیس را شریک سازید. تشکر."],
   ps:["\nد زده‌کړې بڼه: ","\nوخت: ","\nمهرباني وکړئ د ټولګي وختونه او فیس راسره شریک کړئ. مننه."]
  };
  var l=labels[current]||labels.en;
  var message=(template[current]||template.en)+values[0]+l[0]+values[1]+l[1]+values[2]+l[2];
  // Carry only approved, anonymous campaign labels into the student's own WhatsApp
  // draft. This lets reception reconcile real conversations without a shadow CRM.
  function cleanRef(v,max){
   return typeof v==="string" && v.length<=max && /^[a-z0-9][a-z0-9_-]*$/.test(v)?v:"";
  }
  var query=new URLSearchParams(location.search);
  var refSource=cleanRef(query.get("utm_source")||query.get("s"),32);
  var refCampaign=cleanRef(query.get("utm_campaign")||query.get("c"),48);
  try{
   if(!refSource&&!refCampaign){
    var remembered=JSON.parse(sessionStorage.getItem("th_campaign")||"null");
    refSource=cleanRef(remembered?.source,32);
    refCampaign=cleanRef(remembered?.campaign,48);
   }
  }catch(_){}
  var refParts=[];
  if(refSource&&refSource!=="website")refParts.push(refSource);
  if(refCampaign&&!["organic_site","site_cta"].includes(refCampaign))refParts.push(refCampaign);
  if(refParts.length){
   var refLabel=current==="fa"?"\nکُد کمپاین: ":current==="ps"?"\nد کمپاین کوډ: ":"\nCampaign reference: ";
   message+=refLabel+refParts.join(" / ");
  }
  var number=enquiry.getAttribute("data-number")||"93794357509";
  // A real anchor click is recorded by the site's existing anonymous WhatsApp
  // click tracker before navigation. No personal form fields are sent to analytics.
  var link=document.createElement("a");
  link.href="https://wa.me/"+number+"?text="+encodeURIComponent(message);
  link.setAttribute("aria-hidden","true");
  link.style.display="none";
  document.body.appendChild(link);
  link.click();
  link.remove();
 });
}

})();
