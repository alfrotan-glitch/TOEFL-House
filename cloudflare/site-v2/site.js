/* TOEFL House V2: tiny progressive enhancement; no cookies and no PII. */
(function(){
"use strict";
// Anonymous same-tab attribution, including previews.
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
// Migrate known retired anchors only.
var known="";
if(location.hash){try{known=decodeURIComponent(location.hash.slice(1));}catch(_){known="";}}
var isHome=["/","/fa/","/ps/"].includes(location.pathname);
if(isHome&&known&&!document.getElementById(known)){
var lang=location.pathname;
if(known==="start"||known==="advisor"){
location.replace(lang+"admissions/");
return;
}
if(known==="th-pathways"){
location.replace(lang+"#programs");
return;
}
}
var menu=document.querySelector(".mobile-menu");
if(menu){
menu.querySelectorAll('nav a').forEach(function(a){a.addEventListener("click",function(){menu.open=false;});});
document.addEventListener("keydown",function(event){
if(event.key==="Escape"&&menu.open){
var focusWasInside=menu.contains(document.activeElement);
menu.open=false;
if(focusWasInside){
var toggle=menu.querySelector("summary");
if(toggle)toggle.focus();
}
}
});
document.addEventListener("click",function(event){if(menu.open&&!menu.contains(event.target))menu.open=false;});
}
var enquiry=document.getElementById("v2-enquiry-form");
if(enquiry){
var selectedProgram=new URLSearchParams(location.search).get("program");
var courseChoice=enquiry.querySelector("#v2-program");
var timeChoice=enquiry.querySelector("#v2-when");
var formatChoice=enquiry.querySelector("#v2-format");
// Locale URLs carry public choices only; never PII.
function allowed(select,value){
return !!select && typeof value==="string" &&
value.length<=64 && /^[a-z0-9-]+$/.test(value) &&
Array.prototype.some.call(select.options,function(option){return option.value===value;});
}
var admissionQuery=new URLSearchParams(location.search);
if(allowed(courseChoice,selectedProgram))courseChoice.value=selectedProgram;
if(allowed(formatChoice,admissionQuery.get("format")))formatChoice.value=admissionQuery.get("format");
if(allowed(timeChoice,admissionQuery.get("when")))timeChoice.value=admissionQuery.get("when");
// Stable legacy ID; online only.
var lastFlexibleFormat=formatChoice?.value;
var wasOnlineOnly=false;
function syncOnlineFormat(){
if(!courseChoice||!formatChoice)return;
var campus=Array.prototype.find.call(formatChoice.options,function(option){return option.value==="campus";});
if(!campus||!allowed(formatChoice,"online"))return;
var onlineOnly=courseChoice.value==="online-individual-zoom";
if(onlineOnly){
if(!wasOnlineOnly)lastFlexibleFormat=formatChoice.value;
campus.disabled=true;
formatChoice.value="online";
}else{
campus.disabled=false;
if(wasOnlineOnly&&allowed(formatChoice,lastFlexibleFormat))formatChoice.value=lastFlexibleFormat;
lastFlexibleFormat=formatChoice.value;
}
wasOnlineOnly=onlineOnly;
}
function syncLanguageLinks(){
syncOnlineFormat();
document.querySelectorAll(".language-links a[hreflang], .mobile-language a[hreflang]").forEach(function(link){
var dest=new URL(link.getAttribute("href"),location.href);
if(dest.origin!==location.origin||!/\/admissions\/$/.test(dest.pathname))return;
var params=new URLSearchParams();
if(allowed(courseChoice,courseChoice.value))params.set("program",courseChoice.value);
if(allowed(formatChoice,formatChoice.value))params.set("format",formatChoice.value);
if(allowed(timeChoice,timeChoice.value))params.set("when",timeChoice.value);
link.setAttribute("href",dest.pathname+(params.size?"?"+params.toString():""));
});
}
enquiry.addEventListener("change",syncLanguageLinks);
syncLanguageLinks();
// Public option facts only; no requests or tracking.
var coursePreview=enquiry.querySelector("#v2-program-preview");
function updateCoursePreview(){
if(!coursePreview)return;
var choice=courseChoice&&courseChoice.selectedOptions&&courseChoice.selectedOptions[0];
var summary=choice?choice.getAttribute("data-summary")||"":"";
coursePreview.textContent=summary;
coursePreview.hidden=!summary;
}
enquiry.addEventListener("change",updateCoursePreview);
updateCoursePreview();
enquiry.addEventListener("submit",function(event){
event.preventDefault();
syncOnlineFormat();
if(!enquiry.checkValidity()){enquiry.reportValidity();return;}
var chosen=enquiry.querySelector("#v2-program");
var format=enquiry.querySelector("#v2-format");
var when=enquiry.querySelector("#v2-when");
var values=[chosen?.selectedOptions[0]?.textContent||"",format?.selectedOptions[0]?.textContent||"",when?.selectedOptions[0]?.textContent||""];
var current=enquiry.getAttribute("data-locale")||"en";
var template={
en:"Hello. I would like information about courses at The TOEFL House and a free placement assessment.\nProgram: ",
fa:"سلام. می‌خواهم در مورد صنف‌های تافل هوس معلومات بگیرم و تعیین سطح رایگان انجام بدهم.\nبرنامه: ",
ps:"سلام. د تافل هوس د انګلیسي پروګرامونو په اړه معلومات او د سویې د وړیا ارزونې غوښتنه لرم.\nپروګرام: "
};
var labels={
en:["\nLearning format: ","\nPreferred time: ","\nPlease share class times and fees. Thank you."],
fa:["\nشیوهٔ آموزش: ","\nوقت مورد نظر: ","\nلطفاً تقسیم اوقات و فیس را شریک سازید. تشکر."],
ps:["\nد زده‌کړې بڼه: ","\nوخت: ","\nمهرباني وکړئ د ټولګي وختونه او فیس راسره شریک کړئ. مننه."]
};
var l=labels[current]||labels.en;
var message=(template[current]||template.en)+values[0]+l[0]+values[1]+l[1]+values[2]+l[2];
// Only approved anonymous labels in WhatsApp drafts.
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
var configuredNumber=enquiry.getAttribute("data-number")||"";
var number=/^[1-9][0-9]{7,14}$/.test(configuredNumber)?configuredNumber:"93794357509";
// Existing anonymous click tracker; no PII.
var link=document.createElement("a");
link.href="https://wa.me/"+number+"?text="+encodeURIComponent(message);
link.setAttribute("aria-hidden","true");
link.style.display="none";
document.body.appendChild(link);
link.click();
link.remove();
});
}

/* Mini-practice: answers stay in this page only. */
var practice=document.querySelector("[data-ge-practice]");
if(practice){
const find=(el,key)=>el.querySelector("[data-ge-"+key+"]");
const questions=[...practice.querySelectorAll("[data-ge-question]")],d=practice.dataset,outcomes=new Map(),resets=[];
const update=()=>{find(practice,"progress").textContent=d.progressLabel+": "+outcomes.size+"/"+questions.length+" · "+d.scoreLabel+": "+[...outcomes.values()].filter(Boolean).length+"/"+questions.length;};
questions.forEach(q=>{
const check=find(q,"check"),feedback=find(q,"feedback"),answer=find(q,"answer"),inputs=q.querySelectorAll("input");
find(q,"controls").hidden=false;find(q,"fallback").hidden=true;answer.hidden=true;
q.addEventListener("change",()=>{if(!outcomes.has(q))check.disabled=!q.querySelector("input:checked");});
check.addEventListener("click",()=>{
const selected=q.querySelector("input:checked");
if(!selected||outcomes.has(q))return;
const correct=selected.value===q.dataset.correct;
outcomes.set(q,correct);feedback.textContent=correct?d.correctLabel:d.incorrectLabel;
answer.hidden=false;answer.open=true;check.disabled=true;inputs.forEach(i=>i.disabled=true);update();
});
resets.push(()=>{inputs.forEach(i=>{i.checked=i.disabled=false;});check.disabled=true;feedback.textContent="";answer.open=false;answer.hidden=true;});
});
find(practice,"result").hidden=false;update();
find(practice,"reset").addEventListener("click",()=>{outcomes.clear();resets.forEach(reset=>reset());update();questions[0].querySelector("input").focus();});
}

/* Accessible, click-to-play semester poster; native video controls remain as fallback. */
var semesterVideo=document.querySelector(".semester-video");
var semesterCover=document.querySelector(".semester-video-cover");
if(semesterVideo&&semesterCover){
semesterCover.hidden=false;
semesterCover.addEventListener("click",function(){
var restoreFocus=document.activeElement===semesterCover;
semesterCover.hidden=true;
if(restoreFocus)semesterVideo.focus();
try{
var playback=semesterVideo.play();
if(playback&&typeof playback.catch==="function")playback.catch(function(){semesterVideo.controls=true;});
}catch(_){semesterVideo.controls=true;}
});
}

})();
