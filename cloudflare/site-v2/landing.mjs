/* TOEFL House V2 — CMS-driven, accessible, server-rendered public homepage.
 * No enrollment, account, or finance data is fetched. CMS reads are read-only.
 * The original interactive portal remains reachable at /tools/ per language.
 */
const V2_ORIGIN="https://the-toefl-house.pages.dev";
const V2_IMG="/assets/aistudio/campus_dfe458a8.webp";
const V2_IMG_640="/assets/aistudio/campus-640_c222a08a.webp";
const V2_IMG_960="/assets/aistudio/campus-960_85648e8f.webp";
const V2_IMG_SET=V2_IMG_640+" 640w, "+V2_IMG_960+" 960w, "+V2_IMG+" 1280w";
const V2_IMG_SIZES="(max-width: 760px) calc(100vw - 36px), (max-width: 1020px) 380px, 490px";
const V2_LOGO="/assets/aistudio/logo_2b39e99e.png";
const V2_OG="/assets/aistudio/social-preview_cee43595.jpg";
const V2_COURSE_IDS=["general-english","academic-english","toefl-preparation","special-speaking","professional-writing","teacher-training"];
const V2_COPY={
 en:{
  lang:"en",dir:"ltr",name:"THE TOEFL HOUSE",localName:"خانه موفقیت",tag:"ENGLISH EDUCATION · KABUL",
  navPrograms:"Programs",navGuides:"Learning guides",navWhy:"Why TOEFL House",navOnline:"Online classes",navFaq:"FAQ",navContact:"Contact",navMenu:"Menu",
  navApply:"Free assessment",badge:"Admissions are open · Placement assessment is free",
  lead:"Your English journey",leadAccent:"starts here.",subtitle:"From your first English words to fluent conversations, academic English and TOEFL preparation. Find the right level with a free placement assessment.",
  heroCta:"Take a free placement assessment",heroSecondary:"Explore our programs",heroBottom:"In-person classes in Kabul · Private online lessons by arrangement",
  photoBadge:"Learning together",photoSub:"Dasht-e-Barchi · Kabul",micro:"THE TOEFL HOUSE • EST. 2013",
  trustTitle:"A place to grow",trustSub:"Our learning community in numbers",
  courseEyebrow:"FIND YOUR PATH",coursesTitle:"The right course for",coursesAccent:"your next step.",coursesLead:"Explore our six educational programs. Course availability, fees and class times are confirmed by admissions.",
  courseDetail:"View program",courseDuration:"Duration",onlineLabel:"Private online learning",onlineTitle:"One teacher. One learner. A schedule that fits.",onlineText:"Live Zoom classes may be arranged for learners outside Kabul, including Europe and Canada. Subject, time zone, schedule and fees are confirmed before enrollment.",onlineCta:"Ask about online classes",
  whyLabel:"A CLEAR WAY FORWARD",whyTitle:"Start with confidence.",whyLead:"A simple path from choosing your program to joining your class.",
  steps:[["01","Tell us your goal","Share what you want to improve—speaking, academic English, TOEFL or everyday communication."],["02","Find your level, free","Our team helps you select a suitable starting level through a free assessment."],["03","Join the right class","Confirm available shifts, teaching format and tuition with our admissions team."]],
  toolsLabel:"LEARNING SUPPORT",toolsTitle:"Your learning tools, one place.",toolsText:"Explore class times, curriculum, the TOEFL score planner and the placement advisor in our interactive student toolkit.",toolsCta:"Open learning tools",
  faqLabel:"GOOD TO KNOW",faqTitle:"Before you begin",faqLead:"Clear answers to common admissions questions.",faqMore:"More questions? Message our team",
  visitLabel:"VISIT US",visitTitle:"Learn with us in Kabul.",visitText:"Opposite Jalili Center, Maghaza Station, Dasht-e-Barchi, Kabul, Afghanistan.",hours:"Saturday–Thursday · Friday closed",phone:"Call admissions",wa:"WhatsApp admissions",map:"Find our campus",
  finalEyebrow:"YOUR NEXT CHAPTER",finalTitle:"Ready to take the first step?",finalText:"Start with a free placement assessment. Ask admissions about current classes and tuition.",finalCta:"Request your free assessment",
  footerLine:"Unlock the world with TOEFL.",footerRights:"All rights reserved.",footerNote:"Free placement assessment · Course fees are separate",footPrograms:"Programs",footJoin:"Admissions",footTools:"Student tools",
  statsFallback:[["6,000+","Graduates since 2013"],["500+","TOEFL test-takers guided"],["100+","University admissions worldwide"]],courseNames:["General English","Academic English","TOEFL Preparation","Special Speaking","Professional Writing","Teacher Training"],fallbackFaq:[["Is the placement assessment free?","Yes. Placement assessment is free; course tuition is separate."],["Can I enroll without an email?","Yes. You may contact admissions through WhatsApp or by phone."],["Are online classes available?","Private online classes can be arranged based on teacher availability and time zones."]]
 },
 fa:{
  lang:"fa-AF",dir:"rtl",name:"THE TOEFL HOUSE",localName:"تافل هوس",tag:"آموزش زبان انگلیسی · کابل",
  navPrograms:"برنامه‌ها",navGuides:"رهنماهای آموزشی",navWhy:"چرا تافل هوس؟",navOnline:"صنف‌های آنلاین",navFaq:"پرسش‌ها",navContact:"تماس",navMenu:"فهرست",
  navApply:"تعیین سطح رایگان",badge:"پذیرش جریان دارد · تعیین سطح رایگان",
  lead:"راه یادگیری انگلیسی شما",leadAccent:"از همین‌جا آغاز می‌شود.",subtitle:"از اولین کلمات انگلیسی تا مکالمهٔ روان، انگلیسی اکادمیک و آمادگی تافل. با تعیین سطح رایگان، صنف مناسب خود را پیدا کنید.",
  heroCta:"درخواست تعیین سطح رایگان",heroSecondary:"دیدن برنامه‌های آموزشی",heroBottom:"صنف‌های حضوری در کابل · آموزش آنلاین انفرادی با هماهنگی",
  photoBadge:"باهم یاد می‌گیریم",photoSub:"دشت برچی · کابل",micro:"تافل هوس • از سال ۲۰۱۳",
  trustTitle:"جایی برای پیشرفت",trustSub:"شاگردان و دستاوردهای تافل هوس",
  courseEyebrow:"مسیر آموزشی خود را انتخاب کنید",coursesTitle:"برنامهٔ مناسب برای",coursesAccent:"هدف شما.",coursesLead:"شش برنامهٔ آموزشی برای نیازهای متفاوت. فیس، ظرفیت و زمان صنف‌ها را از بخش پذیرش بپرسید.",
  courseDetail:"معلومات برنامه",courseDuration:"مدت دوره",onlineLabel:"آموزش آنلاین انفرادی",onlineTitle:"یک استاد، یک شاگرد؛ مطابق وقت شما.",onlineText:"صنف‌های زنده از طریق Zoom برای علاقه‌مندان خارج از کابل، از جمله اروپا و کانادا، با هماهنگی قابل برگزاری است. فیس، مضمون، منطقهٔ زمانی و اوقات صنف پیش از ثبت‌نام تأیید می‌شود.",onlineCta:"معلومات صنف‌های آنلاین",
  whyLabel:"شروع آسان و روشن",whyTitle:"با اطمینان آغاز کنید.",whyLead:"از انتخاب برنامه تا شامل‌شدن در صنف، سه گام ساده پیش روی شماست.",
  steps:[["۰۱","هدف‌تان را بگویید","مکالمه، انگلیسی اکادمیک، تافل یا انگلیسی روزمره؛ بگویید کدام مهارت را می‌خواهید بهتر سازید."],["۰۲","سطح خود را رایگان معلوم کنید","با راهنمایی تیم آموزشی، صنف و سطح مناسب خود را پیدا کنید."],["۰۳","در صنف مناسب شامل شوید","تقسیم اوقات، شیوهٔ تدریس و فیس را با پذیرش تأیید کنید."]],
  toolsLabel:"ابزارهای آموزشی",toolsTitle:"امکانات درسی، یک‌جا.",toolsText:"تقسیم اوقات صنف‌ها، نصاب درسی، ابزار تخمین نمرهٔ تافل و رهنمای تعیین سطح را در بخش تعاملی سایت ببینید.",toolsCta:"باز کردن ابزارهای آموزشی",
  faqLabel:"معلومات ضروری",faqTitle:"پیش از شروع، بدانید",faqLead:"پاسخ پرسش‌های رایج دربارهٔ ثبت‌نام و صنف‌ها.",faqMore:"پرسش دیگری دارید؟ در واتساپ پیام بدهید",
  visitLabel:"آدرس ما",visitTitle:"در کابل پذیرای شما هستیم.",visitText:"کابل، دشت برچی، ایستگاه مغازه، روبروی مرکز جلیلی، افغانستان.",hours:"شنبه تا پنج‌شنبه · جمعه رخصت",phone:"تماس با پذیرش",wa:"واتساپ پذیرش",map:"پیدا کردن آدرس کورس",
  finalEyebrow:"گام بعدی شما",finalTitle:"برای شروع آماده هستید؟",finalText:"با تعیین سطح رایگان آغاز کنید؛ معلومات صنف‌های موجود و فیس را از پذیرش دریافت کنید.",finalCta:"درخواست تعیین سطح رایگان",
  footerLine:"با تافل، دروازه‌های جهان را باز کنید.",footerRights:"تمام حقوق محفوظ است.",footerNote:"تعیین سطح رایگان · فیس دوره جداگانه است",footPrograms:"برنامه‌ها",footJoin:"پذیرش",footTools:"ابزارهای درسی",
  statsFallback:[["۶٬۰۰۰+","فارغ‌التحصیل از سال ۲۰۱۳"],["۵۰۰+","اشتراک‌کننده در تافل"],["۱۰۰+","پذیرش دانشگاهی در جهان"]],courseNames:["انگلیسی عمومی","انگلیسی اکادمیک","آمادگی تافل","مکالمهٔ ویژه","نگارش مسلکی","تربیهٔ استاد"],fallbackFaq:[["آیا تعیین سطح رایگان است؟","بلی، تعیین سطح رایگان است؛ فیس دوره‌های آموزشی جداگانه می‌باشد."],["آیا بدون ایمیل می‌توانم معلومات بگیرم؟","بلی. از طریق واتساپ یا تماس تلفونی با بخش پذیرش در ارتباط شوید."],["آیا صنف آنلاین دارید؟","صنف‌های آنلاین انفرادی مطابق ظرفیت استاد و منطقهٔ زمانی با هماهنگی برگزار می‌شود."]]
 },
 ps:{
  lang:"ps-AF",dir:"rtl",name:"THE TOEFL HOUSE",localName:"تافل هوس",tag:"د انګلیسي ژبې زده‌کړه · کابل",
  navPrograms:"پروګرامونه",navGuides:"د زده‌کړې لارښودونه",navWhy:"ولې تافل هوس؟",navOnline:"آنلاین ټولګي",navFaq:"پوښتنې",navContact:"اړیکه",navMenu:"لړلیک",
  navApply:"وړیا سویه معلومول",badge:"نوم‌لیکنه روانه ده · د سویې معلومول وړیا دي",
  lead:"د انګلیسي زده‌کړې سفر مو",leadAccent:"همدلته پیلېږي.",subtitle:"له لومړنیو کلمو څخه تر روانو خبرو، اکاډمیکې انګلیسي او TOEFL چمتووالي پورې. د وړیا سویې معلومولو له لارې خپل مناسب ټولګی وټاکئ.",
  heroCta:"د وړیا سویې معلومولو غوښتنه",heroSecondary:"زموږ پروګرامونه وګورئ",heroBottom:"په کابل کې حضوري ټولګي · د همغږۍ له مخې انفرادي آنلاین درسونه",
  photoBadge:"په ګډه زده‌کړه",photoSub:"دشت برچي · کابل",micro:"تافل هوس • له ۲۰۱۳ کال راهیسې",
  trustTitle:"د پرمختګ لپاره ځای",trustSub:"زموږ زده‌کوونکي او لاسته‌راوړنې",
  courseEyebrow:"خپله زده‌کړیزه لاره وټاکئ",coursesTitle:"ستاسو د هدف لپاره",coursesAccent:"مناسب پروګرام.",coursesLead:"شپږ زده‌کړیز پروګرامونه. د فیس، ځای او د ټولګیو د وختونو لپاره له ادارې سره اړیکه ونیسئ.",
  courseDetail:"د پروګرام معلومات",courseDuration:"د کورس موده",onlineLabel:"انفرادي آنلاین زده‌کړه",onlineTitle:"یو ښوونکی، یو زده‌کوونکی؛ ستاسو د وخت سره سم.",onlineText:"د Zoom له لارې انفرادي آنلاین ټولګي د کابل څخه بهر، د اروپا او کاناډا په ګډون، د همغږۍ له مخې برابریدلی شي. فیس، مضمون او وختونه تر نوم‌لیکنې مخکې تاییدېږي.",onlineCta:"د آنلاین ټولګیو معلومات",
  whyLabel:"روښانه پیل",whyTitle:"په ډاډه زړه پیل وکړئ.",whyLead:"د پروګرام له ټاکلو تر ټولګي پورې درې اسانه ګامونه.",
  steps:[["۰۱","خپل هدف ووایئ","خبرې کول، اکاډمیکه انګلیسي، TOEFL یا ورځنۍ انګلیسي؛ خپل هدف راسره شریک کړئ."],["۰۲","خپله سویه وړیا معلومه کړئ","زموږ ښوونیز ټیم له تاسو سره د مناسبې سویې په ټاکلو کې مرسته کوي."],["۰۳","مناسب ټولګي ته لاړ شئ","مهالوېش، د زده‌کړې بڼه او فیس له ادارې سره تایید کړئ."]],
  toolsLabel:"د زده‌کړې وسایل",toolsTitle:"ټولې زده‌کړیزې اسانتیاوې، په یوه ځای کې.",toolsText:"د ټولګیو مهالوېش، نصاب، د TOEFL نمرې پلان او د سویې معلومولو لارښود په تعاملي برخه کې وګورئ.",toolsCta:"زده‌کړیز وسایل پرانیزئ",
  faqLabel:"اړین معلومات",faqTitle:"تر پیل مخکې پوښتنې",faqLead:"د نوم‌لیکنې او ټولګیو په اړه لنډ ځوابونه.",faqMore:"نورې پوښتنې لرئ؟ موږ ته په واټساپ پیغام واستوئ",
  visitLabel:"زموږ پته",visitTitle:"په کابل کې ستاسو هرکلی کوو.",visitText:"کابل، دشت برچي، مغازه تمځای، د جلیلي مرکز مخامخ، افغانستان.",hours:"شنبه تر پنجشنبې · جمعه رخصتي",phone:"له ادارې سره اړیکه",wa:"د واټساپ اړیکه",map:"زموږ ځای ومومئ",
  finalEyebrow:"ستاسو راتلونکی ګام",finalTitle:"پیل ته چمتو یاست؟",finalText:"د سویې له وړیا معلومولو پیل وکړئ؛ د ټولګیو او فیس معلومات له ادارې واخلئ.",finalCta:"د وړیا سویې معلومولو غوښتنه",
  footerLine:"له TOEFL سره نړۍ ته ورسېږئ.",footerRights:"ټول حقونه خوندي دي.",footerNote:"د سویې معلومول وړیا دي · د کورس فیس جلا دی",footPrograms:"پروګرامونه",footJoin:"نوم‌لیکنه",footTools:"د زده‌کړې وسایل",
  statsFallback:[["۶٬۰۰۰+","له ۲۰۱۳ کال راهیسې فارغان"],["۵۰۰+","د TOEFL ازموینې لارښوونه ترلاسه کوونکي"],["۱۰۰+","په نړیوالو پوهنتونونو کې منل شوي"]],courseNames:["عمومي انګلیسي","اکاډمیکه انګلیسي","د TOEFL چمتووالی","ځانګړې خبرې","مسلکي لیکنه","د ښوونکو روزنه"],fallbackFaq:[["آیا د سویې معلومول وړیا دي؟","هو. د سویې معلومول وړیا دي، خو د کورس فیس جلا دی."],["له ایمیل پرته نوم‌لیکنه کېدای شي؟","هو. له ادارې سره په واټساپ یا ټیلیفون اړیکه ونیسئ."],["آنلاین ټولګي شته؟","انفرادي آنلاین ټولګي د ښوونکي د وخت او ظرفیت له مخې همغږي کېږي."]]
 }
};
function v2Esc(s){return String(s??"").replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[x]));}
function v2T(s,max=1000){return v2Esc(String(s??"").slice(0,max));}
function v2Short(s,max=140){const text=String(s??"").replace(/\s+/g," ").trim();return v2T(text.length>max?text.slice(0,max-1).replace(/\s+\S*$/,"")+"…":text,max+3);}
async function v2Cms(env){
 if(!env?.CMS_DB)throw Error("CMS_DB missing");
 const [main,ps]=await Promise.all([
   env.CMS_DB.prepare("SELECT body,revision FROM content WHERE id='main'").first(),
   env.CMS_DB.prepare("SELECT body,revision FROM pashto_content WHERE id='main'").first()
 ]);
 if(!main?.body||!ps?.body)throw Error("Published CMS not available");
 const parsed=JSON.parse(main.body),pashto=JSON.parse(ps.body);
 if(!parsed?.locales?.en?.programs||!parsed?.locales?.fa?.programs||!pashto?.programs)throw Error("Unexpected CMS schema");
 return {main:parsed,pashto,revision:main.revision,psRevision:ps.revision};
}
function v2Prefix(locale){return locale==="en"?"/":"/"+locale+"/";}
function v2Languages(locale,suffix=""){
 return [["en","EN","/"],["fa","دری","/fa/"],["ps","پښتو","/ps/"]].map(([id,title,path])=>'<a lang="'+(id==="fa"?"fa-AF":id==="ps"?"ps-AF":"en")+'" hreflang="'+(id==="en"?"en":id==="fa"?"fa-AF":"ps-AF")+'" href="'+path+suffix+'"'+(id===locale?' aria-current="page" class="is-active"':'')+'>'+title+'</a>').join("");
}
function v2Header(c,locale,suffix=""){
 const prefix=v2Prefix(locale);
 const l=v2Languages(locale,suffix);
 const anchorBase=suffix?v2Prefix(locale):"";
 const nav=[[anchorBase+"#programs",c.navPrograms],[prefix+"guides/",c.navGuides],[anchorBase+"#why-us",c.navWhy],[anchorBase+"#online",c.navOnline],[anchorBase+"#faq",c.navFaq],[anchorBase+"#contact",c.navContact]];
 const links=nav.map(([href,label])=>'<a href="'+href+'">'+v2T(label)+'</a>').join("");
 return '<a class="skip" href="#main">'+(locale==="en"?"Skip to content":locale==="fa"?"رفتن به محتوا":"منځپانګې ته لاړ شئ")+'</a>'
  +'<div class="topline"><div class="shell topline-inner"><span class="top-dots"></span><span>'+v2T(c.badge)+'</span><a class="toplink" href="https://wa.me/93794357509" rel="noopener noreferrer">'+v2T(c.wa)+' <span aria-hidden="true">↗</span></a></div></div>'
  +'<header class="site-header"><div class="shell header-inner"><a class="brand" href="'+prefix+'" aria-label="'+v2T(c.name)+'"><img src="'+V2_LOGO+'" width="48" height="48" alt="" decoding="async"><span><strong>THE TOEFL HOUSE</strong><small>'+v2T(c.localName)+'</small></span></a>'
  +'<nav class="main-nav" aria-label="'+v2T(c.navMenu)+'">'+links+'</nav>'
  +'<div class="header-actions"><div class="language-links" aria-label="Languages">'+l+'</div><a class="button button-primary desktop-apply" href="'+prefix+'admissions/">'+v2T(c.navApply)+' <span aria-hidden="true">↗</span></a></div>'
  +'<details class="mobile-menu"><summary aria-label="'+v2T(c.navMenu)+'"><span></span><span></span><span></span></summary><nav aria-label="'+v2T(c.navMenu)+'">'+links+'<div class="mobile-language">'+l+'</div><a class="mobile-apply" href="'+prefix+'admissions/">'+v2T(c.navApply)+'</a></nav></details></div></header>';
}
function v2Stats(c,content,locale){
 const stats=locale==="ps"?content.pashto.statistics:content.main.locales[locale].stats;
 const fallback=c.statsFallback;
 const values=locale==="ps" && Array.isArray(stats)?stats.slice(0,3).map(x=>[x.value,x.label]):
 (stats&&typeof stats==="object")?[
 [stats.graduates,stats.graduatesLabel],
 [stats.toeflTakers,stats.toeflLabel],
 [stats.universityAdmissions,stats.universityLabel]]:fallback;
 return '<section class="stats-wrap" aria-label="'+v2T(c.trustTitle)+'"><div class="shell">'
 +'<div class="stat-head"><h2>'+v2T(c.trustTitle)+'</h2><p>'+v2T(c.trustSub)+'</p></div>'
 +'<div class="stat-grid">'+values.map(([n,t],i)=>'<div class="stat-item"><strong dir="ltr">'+v2T(n||fallback[i][0])+'</strong><span>'+v2T(t||fallback[i][1])+'</span></div>').join("")+'</div></div></section>';
}
function v2Programs(c,content,locale){
 const prefix=v2Prefix(locale);
 const src=locale==="ps"?content.pashto.programs:content.main.locales[locale].programs;
 const cards=V2_COURSE_IDS.map((id,i)=>{
  const program=src.find(x=>x.id===id)||{};
  let duration=program.duration;
  const shortDurations={
    en:["Pre-Starter: 1 mo · Other levels: 2 mo","2 months per level","4 months","2 months","2 months","2 months"],
    fa:["Pre-Starter: ۱ ماه · سایر سطوح: ۲ ماه","۲ ماه برای هر سطح","۴ ماه","۲ ماه","۲ ماه","۲ ماه"],
    ps:["Pre-Starter: ۱ میاشت · نورې کچې: ۲ میاشتې","د هرې کچې لپاره ۲ میاشتې","څلور میاشتې","۲ میاشتې","۲ میاشتې","۲ میاشتې"]
  };
  duration=shortDurations[locale][i]||duration;
  let desc=program.summary||program.subtitle||"";
  return '<article class="course-card '+(id==="toefl-preparation"?"course-featured":"")+'"><div class="course-top"><span class="course-number">'+String(i+1).padStart(2,"0")+'</span><span class="course-mark" aria-hidden="true">↗</span></div><h3>'+v2T(program.title||c.courseNames[i])+'</h3><p class="course-copy">'+v2Short(desc,160)+'</p><div class="course-bottom"><span><small>'+v2T(c.courseDuration)+'</small><strong>'+v2Short(duration||"",85)+'</strong></span><a aria-label="'+v2T(c.courseDetail+' — '+(program.title||c.courseNames[i]))+'" href="'+prefix+'courses/'+id+'/">'+v2T(c.courseDetail)+' <span aria-hidden="true">↗</span></a></div></article>';
 }).join("");
 return '<section class="programs-section section" id="programs"><div class="shell"><div class="section-head"><div><p class="eyebrow">'+v2T(c.courseEyebrow)+'</p><h2>'+v2T(c.coursesTitle)+' <em>'+v2T(c.coursesAccent)+'</em></h2></div><p class="section-intro">'+v2T(c.coursesLead)+'</p></div><div class="courses-grid">'+cards+'</div></div></section>';
}
function v2Faq(c,content,locale){
 const raw=locale==="ps"?content.pashto.faq:content.main.locales[locale].faq;
 const items=(Array.isArray(raw)?raw:raw?.items)||[];
 const prioritized=[
  items.find(x=>/تعیین سطح|placement|سویې معلومولو/i.test(x.q||x.question||"")),
  items.find(x=>/ایمیل|email|ایمېل/i.test(x.q||x.question||"")),
  items.find(x=>/آنلاین|online|آنلاين/i.test(x.q||x.question||""))
 ].filter(Boolean);
 const list=prioritized.length===3?prioritized:items.slice(0,3);
 const entries=list.length?list.map(x=>[x.q||x.question,x.a||x.answer]):c.fallbackFaq;
 return '<section class="faq-section section" id="faq"><div class="shell faq-layout"><div class="faq-aside"><p class="eyebrow">'+v2T(c.faqLabel)+'</p><h2>'+v2T(c.faqTitle)+'</h2><p>'+v2T(c.faqLead)+'</p><a class="text-link" href="https://wa.me/93794357509" rel="noopener noreferrer">'+v2T(c.faqMore)+' <span aria-hidden="true">↗</span></a></div><div class="faq-list">'+entries.map(([q,a],i)=>'<details'+(i===0?' open':'')+'><summary>'+v2Short(q,160)+'<span class="faq-plus" aria-hidden="true"></span></summary><p>'+v2T(a,680)+'</p></details>').join("")+'</div></div></section>';
}
function v2Footer(c,locale,content){
 const prefix=v2Prefix(locale);
 const contact=locale==="ps"?content?.pashto?.contact:content?.main?.locales?.[locale]?.contact;
 const published=(value,fallback,max)=>typeof value==="string"&&value.trim()&&value.length<=max?value:fallback;
 const visitTitle=published(contact?.title,c.visitTitle,180);
 const visitAddress=published(contact?.address,c.visitText,350);
 const visitHours=published(contact?.operatingHours||contact?.hours,c.hours,250);
 const maps="https://www.google.com/maps/search/?api=1&query=The%20TOEFL%20House%20Dasht-e-Barchi%20Kabul";
 return '<footer class="footer" id="contact"><div class="shell"><div class="footer-main"><div class="footer-brand"><span class="eyebrow">'+v2T(c.visitLabel)+'</span><h2>'+v2T(visitTitle)+'</h2><p>'+v2T(visitAddress)+'</p><span class="footer-hours">'+v2T(visitHours)+'</span></div><div class="footer-links"><a href="'+prefix+'#programs">'+v2T(c.footPrograms)+'</a><a href="'+prefix+'guides/">'+v2T(c.navGuides)+'</a><a href="'+prefix+'admissions/">'+v2T(c.footJoin)+'</a><a href="'+prefix+'tools/">'+v2T(c.footTools)+'</a><a href="https://wa.me/93794357509" rel="noopener noreferrer">'+v2T(c.wa)+'</a><a href="tel:+93745651844">'+v2T(c.phone)+'</a><a href="'+maps+'" target="_blank" rel="noopener noreferrer">'+v2T(c.map)+' ↗</a></div></div><div class="footer-bottom"><span>© '+new Date().getUTCFullYear()+' THE TOEFL HOUSE · '+v2T(c.footerRights)+'</span><span>'+v2T(c.footerNote)+'</span></div></div></footer>';
}
function v2Page(locale,content){
 const c=V2_COPY[locale],prefix=v2Prefix(locale),title=locale==="en"?"The TOEFL House | English Classes & TOEFL Preparation in Kabul":locale==="fa"?"تافل هوس | کورس زبان انگلیسی و آمادگی تافل در کابل":"The TOEFL House | په کابل کې انګلیسي او TOEFL زده‌کړه";
 const desc=c.subtitle,canonical=V2_ORIGIN+prefix;
 const language="<link rel=\"alternate\" hreflang=\"en\" href=\""+V2_ORIGIN+"/\"><link rel=\"alternate\" hreflang=\"fa-AF\" href=\""+V2_ORIGIN+"/fa/\"><link rel=\"alternate\" hreflang=\"ps-AF\" href=\""+V2_ORIGIN+"/ps/\"><link rel=\"alternate\" hreflang=\"x-default\" href=\""+V2_ORIGIN+"/\">";
 const ld=JSON.stringify({"@context":"https://schema.org","@type":"EducationalOrganization","name":"The TOEFL House","alternateName":"خانه موفقیت","url":V2_ORIGIN+"/","description":c.subtitle,"address":{"@type":"PostalAddress","streetAddress":"Opposite Jalili Center, Maghaza Station, Dasht-e-Barchi","addressLocality":"Kabul","addressCountry":"AF"},"telephone":"+93745651844","availableLanguage":["en","fa-AF","ps-AF"]}).replace(/</g,"\\u003c");
 return '<!doctype html><html lang="'+c.lang+'" dir="'+c.dir+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+v2T(title)+'</title><meta name="description" content="'+v2T(desc,400)+'"><meta name="theme-color" content="#f7f6f2"><meta property="og:type" content="website"><meta property="og:title" content="'+v2T(title)+'"><meta property="og:description" content="'+v2T(desc)+'"><meta property="og:url" content="'+canonical+'"><meta property="og:image" content="'+V2_ORIGIN+V2_OG+'"><link rel="canonical" href="'+canonical+'">'+language+'<link rel="icon" href="/assets/aistudio/favicon_afa00a26.png"><link rel="preload" href="'+V2_IMG_640+'" as="image" imagesrcset="'+V2_IMG_SET+'" imagesizes="'+V2_IMG_SIZES+'" fetchpriority="high"><link rel="stylesheet" href="/__th/v2/site.css?v='+V2_REV+'"><script defer src="/__th/v2/site.js?v='+V2_REV+'"></script><script defer src="/__th/engagement-v1.js"></script><script type="application/ld+json">'+ld+'</script></head><body>'
 +v2Header(c,locale)
 +'<main id="main"><section class="hero"><div class="shell hero-grid"><div class="hero-copy"><span class="eyebrow eyebrow-hero"><span class="eyebrow-rule"></span>'+v2T(c.tag)+'</span><h1>'+v2T(c.lead)+' <span>'+v2T(c.leadAccent)+'</span></h1><p class="hero-lead">'+v2T(c.subtitle)+'</p><div class="hero-actions"><a class="button button-primary button-xl" href="'+prefix+'admissions/">'+v2T(c.heroCta)+' <span aria-hidden="true">↗</span></a><a class="button button-quiet button-xl" href="#programs">'+v2T(c.heroSecondary)+'</a></div><div class="hero-fine"><span aria-hidden="true">✦</span>'+v2T(c.heroBottom)+'</div></div><div class="hero-art"><div class="photo-frame"><img src="'+V2_IMG_640+'" srcset="'+V2_IMG_SET+'" sizes="'+V2_IMG_SIZES+'" width="680" height="820" alt="'+v2T(c.photoSub)+'" fetchpriority="high" decoding="async"><div class="photo-shade"></div><div class="photo-label"><strong>'+v2T(c.photoBadge)+'</strong><small>'+v2T(c.photoSub)+'</small></div></div><div class="photo-side"><span>'+v2T(c.micro)+'</span></div><div class="photo-accent" aria-hidden="true"></div></div></div></section>'
 +v2Stats(c,content,locale)
 +v2Programs(c,content,locale)
 +'<section class="online-section section" id="online"><div class="shell"><div class="online-panel"><div class="online-symbol" aria-hidden="true"><span>1:1</span><svg viewBox="0 0 70 70" fill="none" aria-hidden="true"><circle cx="35" cy="35" r="31" stroke="currentColor" stroke-width="1.5"/><path d="M15 35h40M35 15v40" stroke="currentColor" stroke-width="1.5"/></svg></div><div class="online-copy"><p class="eyebrow">'+v2T(c.onlineLabel)+'</p><h2>'+v2T(c.onlineTitle)+'</h2><p>'+v2T(c.onlineText)+'</p></div><a class="button button-light" href="'+prefix+'admissions/?program=online-individual-zoom">'+v2T(c.onlineCta)+' <span aria-hidden="true">↗</span></a></div></div></section>'
 +'<section class="journey-section section" id="why-us"><div class="shell"><div class="section-head"><div><p class="eyebrow">'+v2T(c.whyLabel)+'</p><h2>'+v2T(c.whyTitle)+'</h2></div><p class="section-intro">'+v2T(c.whyLead)+'</p></div><div class="journey-grid">'+c.steps.map(([n,h,p])=>'<article class="journey-step"><span class="step-no">'+v2T(n)+'</span><div class="step-line"></div><h3>'+v2T(h)+'</h3><p>'+v2T(p)+'</p></article>').join("")+'</div><div class="tools-strip"><div class="tools-glyph" aria-hidden="true">✳</div><div class="tools-content"><span class="eyebrow">'+v2T(c.toolsLabel)+'</span><h3>'+v2T(c.toolsTitle)+'</h3><p>'+v2T(c.toolsText)+'</p></div><a class="text-link" href="'+prefix+'tools/">'+v2T(c.toolsCta)+' <span aria-hidden="true">↗</span></a></div></div></section>'
 +v2Faq(c,content,locale)
 +'<section class="final-cta"><div class="shell final-inner"><div><p class="eyebrow">'+v2T(c.finalEyebrow)+'</p><h2>'+v2T(c.finalTitle)+'</h2><p>'+v2T(c.finalText)+'</p></div><a class="button button-white" href="'+prefix+'admissions/">'+v2T(c.finalCta)+' <span aria-hidden="true">↗</span></a></div></section>'
 +'</main>'+v2Footer(c,locale,content)+'</body></html>';
}
async function v2Home(request,env,locale){
 if(!["GET","HEAD"].includes(request.method))return new Response("Method not allowed",{status:405,headers:{"Allow":"GET, HEAD"}});
 try{
  const data=await v2Cms(env);
  const html=v2Page(locale,data),preview=new URL(request.url).hostname!=="the-toefl-house.pages.dev";
  const headers=new Headers({"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache, no-store, must-revalidate","X-Content-Type-Options":"nosniff","Referrer-Policy":"strict-origin-when-cross-origin","X-Frame-Options":"DENY","Permissions-Policy":"camera=(), microphone=(), geolocation=()","Content-Language":V2_COPY[locale].lang,"Content-Security-Policy":"default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self' https://toefl-house-conversions.alfrotan2.workers.dev https://static.cloudflareinsights.com https://cloudflareinsights.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://wa.me"});
  if(preview)headers.set("X-Robots-Tag","noindex, nofollow, noarchive");
  return new Response(request.method==="HEAD"?null:html,{status:200,headers});
 }catch(error){
  console.error("V2 CMS page render unavailable; retaining original",String(error));
  return null;
 }
}
