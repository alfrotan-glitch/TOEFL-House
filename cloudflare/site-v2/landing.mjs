/* TOEFL House V2 — CMS-driven, accessible, server-rendered public homepage.
 * No enrollment, account, or finance data is fetched. CMS reads are read-only.
 * The original interactive portal remains reachable at /tools/ per language.
 */
// This is the only public/canonical website host; legacy origin stays internal to the edge worker.
const V2_ORIGIN="https://toeflhouse.pages.dev";
const V2_IMG="/assets/aistudio/FB_IMG_1793645643808_dad823ce.jpg";
const V2_CAMPUS_ALT={en:"Exterior of The TOEFL House campus in Dasht-e-Barchi, Kabul",fa:"نمای ساختمان تافل هوس در دشت برچی، کابل",ps:"د کابل په دشت برچي کې د تافل هوس د ودانۍ بڼه"};
const V2_OG_LOCALE={en:"en_US",fa:"fa_AF",ps:"ps_AF"};

const V2_IMG_640="/assets/aistudio/FB_IMG_1793645643808_dad823ce.jpg";
const V2_IMG_960="/assets/aistudio/FB_IMG_1793645643808_dad823ce.jpg";
const V2_IMG_SET=V2_IMG_640+" 640w, "+V2_IMG_960+" 960w, "+V2_IMG+" 1280w";
const V2_IMG_SIZES="(max-width: 760px) calc(100vw - 36px), (max-width: 1020px) 380px, 490px";
const V2_LOGO="data:image/webp;base64,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";
const V2_OG="/assets/aistudio/FB_IMG_1793645643808_dad823ce.jpg";
const V2_COURSE_IDS=["general-english","academic-english","toefl-preparation","special-speaking","professional-writing","teacher-training"];
const V2_COPY={
 en:{
  lang:"en",dir:"ltr",name:"THE TOEFL HOUSE",localName:"تافل هوس",tag:"ENGLISH LANGUAGE EDUCATION · KABUL",
  navPrograms:"Programs",navGuides:"Learning guides",navWhy:"Why The TOEFL House",navOnline:"Online classes",navFaq:"FAQ",navContact:"Contact",navMenu:"Menu",
  navApply:"Free assessment",badge:"Admissions are open · Placement assessment is free",
  lead:"Learn English with purpose.",leadAccent:"Move forward with confidence.",subtitle:"Develop the English you need for everyday communication, university study and TOEFL preparation. Start at a suitable level with a free placement assessment.",
  heroCta:"Request a free placement assessment",heroSecondary:"Explore our programs",heroBottom:"In-person classes in Kabul · Private online lessons by arrangement",
  photoBadge:"Learning together",photoSub:"Dasht-e-Barchi · Kabul",micro:"THE TOEFL HOUSE • EST. 2013",
  trustTitle:"Learning that opens doors",trustSub:"The TOEFL House community at a glance",
  courseEyebrow:"EXPLORE OUR PROGRAMS",coursesTitle:"Find the program that",coursesAccent:"fits your goals.",coursesLead:"Six English language programs, from foundational learning to academic and professional communication. Confirm fees, class times and availability with admissions.",
  courseDetail:"View program",courseDuration:"Duration",onlineLabel:"Private online learning",onlineTitle:"Personalized English lessons, wherever you are.",onlineText:"Live, one-to-one Zoom lessons can be arranged for learners in Kabul or abroad, including Europe and Canada. The curriculum, teacher availability, time zone and fees are confirmed before registration.",onlineCta:"Ask about online classes",
  whyLabel:"A CLEAR WAY FORWARD",whyTitle:"A clear route to your next class.",whyLead:"Choose your goal, assess your current level and confirm the class that suits you.",
  steps:[["01","Tell us your goal","Share what you want to improve—speaking, academic English, TOEFL or everyday communication."],["02","Find your level, free","Our team helps you select a suitable starting level through a free assessment."],["03","Join the right class","Confirm available shifts, teaching format and tuition with our admissions team."]],
  toolsLabel:"ADMISSIONS SUPPORT",toolsTitle:"Need help choosing your next step?",toolsText:"Our admissions team can help you choose a suitable English program and arrange your free placement assessment.",toolsCta:"Request guidance",
  faqLabel:"GOOD TO KNOW",faqTitle:"Questions before you enroll?",faqLead:"Essential information about placement, tuition and available classes.",faqMore:"More questions? Message our team",
  visitLabel:"VISIT US",visitTitle:"Visit The TOEFL House in Kabul.",visitText:"Opposite Jalili Center, Maghaza Station, Dasht-e-Barchi, Kabul, Afghanistan.",hours:"Classes Saturday–Thursday · Friday closed · Confirm class times with admissions",phone:"Call admissions",wa:"WhatsApp admissions",map:"Find our campus",
  finalEyebrow:"YOUR NEXT CHAPTER",finalTitle:"Your next step begins with the right level.",finalText:"Request a free placement assessment and ask our admissions team about current programs, fees and class times.",finalCta:"Request your free assessment",
  footerRights:"All rights reserved.",footPrograms:"Programs",footTools:"Student tools",
  statsFallback:[["6,000+","Graduates since 2013"],["500+","TOEFL test-takers guided"],["100+","University admissions worldwide"]],courseNames:["General English","Academic English","TOEFL Preparation","Special Speaking","Professional Writing","Teacher Training"],fallbackFaq:[["Is the placement assessment free?","Yes. The placement assessment is free and helps identify a suitable starting level."],["Can I enroll without an email?","Yes. You may contact admissions through WhatsApp or by phone."],["Are online classes available?","Private online classes can be arranged based on teacher availability and time zones."]]
 },
 fa:{
  lang:"fa-AF",dir:"rtl",name:"THE TOEFL HOUSE",localName:"تافل هوس",tag:"آموزش تخصصی زبان انگلیسی · کابل",
  navPrograms:"برنامه‌ها",navGuides:"رهنماهای درسی",navWhy:"چرا تافل هوس؟",navOnline:"صنف‌های آنلاین",navFaq:"پرسش‌ها",navContact:"تماس",navMenu:"فهرست",
  navApply:"تعیین سطح رایگان",badge:"ثبت‌نام جریان دارد · تعیین سطح رایگان",
  lead:"انگلیسی را هدفمند بیاموزید.",leadAccent:"با اطمینان پیش بروید.",subtitle:"برای مکالمهٔ روزمره، تحصیل در دانشگاه و آمادگی امتحان TOEFL، مهارت‌های زبان انگلیسی خود را تقویت کنید. با تعیین سطح رایگان، از سطح مناسب آغاز نمایید.",
  heroCta:"درخواست تعیین سطح رایگان",heroSecondary:"دیدن برنامه‌های آموزشی",heroBottom:"صنف‌های حضوری در کابل · آموزش آنلاین انفرادی با هماهنگی قبلی",
  photoBadge:"یادگیری در کنار هم",photoSub:"دشت برچی · کابل",micro:"تافل هوس • از سال ۲۰۱۳",
  trustTitle:"آموزش برای فرصت‌های بیشتر",trustSub:"نگاهی به جامعهٔ آموزشی تافل هوس",
  courseEyebrow:"برنامه‌های آموزشی",coursesTitle:"برنامه‌ای متناسب با",coursesAccent:"هدف شما.",coursesLead:"شش برنامهٔ آموزشی، از انگلیسی عمومی تا مهارت‌های اکادمیک و مسلکی. برای دریافت معلومات دقیق دربارهٔ فیس، تقسیم اوقات و ظرفیت صنف‌ها با پذیرش تماس بگیرید.",
  courseDetail:"معرفی کامل برنامه",courseDuration:"مدت دوره",onlineLabel:"صنف‌های آنلاین انفرادی",onlineTitle:"آموزش خصوصی انگلیسی، مطابق هدف و وقت شما.",onlineText:"صنف‌های زنده و انفرادی از طریق Zoom برای علاقه‌مندان داخل و خارج از کابل، به‌شمول اروپا و کانادا، با هماهنگی قبلی برگزار می‌شوند. محتوای آموزشی، وقت صنف، دسترسی استاد و فیس پیش از ثبت‌نام تأیید می‌گردد.",onlineCta:"معلومات دربارهٔ صنف‌های آنلاین",
  whyLabel:"مسیر روشن ثبت‌نام",whyTitle:"با یک انتخاب آگاهانه آغاز کنید.",whyLead:"از تعیین هدف تا انتخاب صنف مناسب، سه گام مشخص پیش روی شماست.",
  steps:[["۰۱","هدف‌تان را بگویید","مکالمه، انگلیسی اکادمیک، تافل یا انگلیسی روزمره؛ بگویید کدام مهارت را می‌خواهید بهتر سازید."],["۰۲","سطح زبان خود را رایگان تعیین کنید","با رهنمایی تیم آموزشی، صنف و سطح مناسب خود را پیدا کنید."],["۰۳","در صنف مناسب شامل شوید","تقسیم اوقات، شیوهٔ تدریس و فیس را با پذیرش تأیید کنید."]],
  toolsLabel:"رهنمایی پذیرش",toolsTitle:"برای انتخاب گام بعدی راهنمایی بگیرید.",toolsText:"بخش پذیرش در انتخاب برنامهٔ مناسب انگلیسی و هماهنگی ارزیابی رایگان سطح شما کمک می‌کند.",toolsCta:"درخواست راهنمایی",
  faqLabel:"معلومات ضروری",faqTitle:"پرسش‌های مهم پیش از ثبت‌نام",faqLead:"معلومات روشن دربارهٔ تعیین سطح، فیس و شیوهٔ اشتراک در صنف‌ها.",faqMore:"پرسش دیگری دارید؟ در واتساپ پیام بدهید",
  visitLabel:"نشانی مرکز",visitTitle:"تافل هوس در کابل",visitText:"کابل، دشت برچی، ایستگاه مغازه، روبروی مرکز جلیلی، افغانستان.",hours:"صنف‌ها از شنبه تا پنج‌شنبه · جمعه رخصت · وقت دقیق صنف را از پذیرش بپرسید",phone:"تماس با پذیرش",wa:"واتساپ پذیرش",map:"مسیریابی تا مرکز",
  finalEyebrow:"گام بعدی شما",finalTitle:"برای پیشرفت، از سطح مناسب آغاز کنید.",finalText:"تعیین سطح رایگان انجام دهید و دربارهٔ صنف‌های موجود، فیس و تقسیم اوقات از پذیرش معلومات بگیرید.",finalCta:"درخواست تعیین سطح رایگان",
  footerRights:"تمام حقوق محفوظ است.",footPrograms:"برنامه‌ها",footTools:"ابزارهای درسی",
  statsFallback:[["۶٬۰۰۰+","فارغ‌التحصیل از سال ۲۰۱۳"],["۵۰۰+","اشتراک‌کننده در تافل"],["۱۰۰+","پذیرش در دانشگاه‌های جهان"]],courseNames:["انگلیسی عمومی","انگلیسی اکادمیک","آمادگی تافل","مکالمهٔ ویژه","نگارش مسلکی","تربیهٔ استاد"],fallbackFaq:[["آیا تعیین سطح رایگان است؟","بلی، تعیین سطح رایگان است و برای انتخاب سطح مناسب کمک می‌کند."],["آیا بدون ایمیل می‌توانم معلومات بگیرم؟","بلی. از طریق واتساپ یا تماس تلفونی با بخش پذیرش در ارتباط شوید."],["آیا صنف آنلاین دارید؟","صنف‌های آنلاین انفرادی مطابق ظرفیت استاد و منطقهٔ زمانی با هماهنگی برگزار می‌شود."]]
 },
 ps:{
  lang:"ps-AF",dir:"rtl",name:"THE TOEFL HOUSE",localName:"تافل هوس",tag:"د انګلیسي ژبې مسلکي زده‌کړه · کابل",
  navPrograms:"پروګرامونه",navGuides:"د زده‌کړې لارښود",navWhy:"ولې تافل هوس؟",navOnline:"آنلاین ټولګي",navFaq:"پوښتنې",navContact:"اړیکه",navMenu:"لړلیک",
  navApply:"د سویې وړیا ارزونه",badge:"نوم‌لیکنه روانه ده · د سویې ارزونه وړیا ده",
  lead:"انګلیسي په موخه زده کړئ.",leadAccent:"په ډاډه زړه پرمختګ وکړئ.",subtitle:"د ورځنیو خبرو، پوهنتوني زده‌کړو او د TOEFL ازموینې د چمتووالي لپاره خپل انګلیسي مهارتونه پیاوړي کړئ. د سویې له وړیا ارزونې وروسته له مناسبې کچې پیل وکړئ.",
  heroCta:"د سویې د وړیا ارزونې غوښتنه",heroSecondary:"زموږ پروګرامونه وګورئ",heroBottom:"په کابل کې حضوري ټولګي · د همغږۍ له مخې انفرادي آنلاین درسونه",
  photoBadge:"په ګډه زده کړه",photoSub:"دشت برچي · کابل",micro:"تافل هوس • له ۲۰۱۳ کال راهیسې",
  trustTitle:"د لا ډېرو فرصتونو لپاره زده‌کړه",trustSub:"د تافل هوس د زده‌کړې ټولنې پېژندنه",
  courseEyebrow:"زموږ ښوونیز پروګرامونه",coursesTitle:"د خپلې موخې لپاره",coursesAccent:"مناسب پروګرام وټاکئ.",coursesLead:"د انګلیسي شپږ پروګرامونه، له بنسټیزې زده‌کړې تر اکاډمیکو او مسلکي مهارتونو پورې. د فیس، مهالوېش او شته ځایونو په اړه له نوم‌لیکنې څانګې سره اړیکه ونیسئ.",
  courseDetail:"د پروګرام بشپړ معلومات",courseDuration:"د کورس موده",onlineLabel:"انفرادي آنلاین زده‌کړه",onlineTitle:"انفرادي آنلاین زده‌کړه؛ ستاسو د موخې او وخت له مخې.",onlineText:"د Zoom له لارې ژوندۍ انفرادي ټولګي په کابل او بهر کې، د اروپا او کاناډا په ګډون، د مخکینۍ همغږۍ له مخې برابرېږي. درسي مواد، د ښوونکي شتون، وخت او فیس تر نوم‌لیکنې مخکې تاییدېږي.",onlineCta:"د آنلاین ټولګیو معلومات",
  whyLabel:"روښانه پیل",whyTitle:"په روښانه پلان زده‌کړه پیل کړئ.",whyLead:"خپله موخه وټاکئ، سویه مو معلومه کړئ او مناسب ټولګی تایید کړئ.",
  steps:[["۰۱","خپل هدف ووایئ","خبرې کول، اکاډمیکه انګلیسي، TOEFL یا ورځنۍ انګلیسي؛ خپل هدف راسره شریک کړئ."],["۰۲","خپله سویه وړیا معلومه کړئ","زموږ ښوونیز ټیم له تاسو سره د مناسبې سویې په ټاکلو کې مرسته کوي."],["۰۳","مناسب ټولګي ته لاړ شئ","مهالوېش، د زده‌کړې بڼه او فیس له ادارې سره تایید کړئ."]],
  toolsLabel:"د نوم‌لیکنې لارښوونه",toolsTitle:"د خپل راتلونکي ګام په ټاکلو کې مرسته وغواړئ.",toolsText:"زموږ د نوم‌لیکنې ډله د مناسب انګلیسي پروګرام په ټاکلو او د سویې د وړیا ارزونې په تنظیم کې مرسته کوي.",toolsCta:"لارښوونه وغواړئ",
  faqLabel:"اړین معلومات",faqTitle:"له نوم‌لیکنې مخکې مهمې پوښتنې",faqLead:"د سویې ارزونې، فیس او د ټولګیو د ګډون په اړه روښانه ځوابونه.",faqMore:"نورې پوښتنې لرئ؟ موږ ته په واټساپ پیغام واستوئ",
  visitLabel:"زموږ پته",visitTitle:"په کابل کې تافل هوس ته راشئ.",visitText:"کابل، دشت برچي، مغازه تمځای، د جلیلي مرکز مخامخ، افغانستان.",hours:"ټولګي له شنبې تر پنجشنبې · جمعه رخصتي · د ټولګي دقیق وخت له ادارې وپوښتئ",phone:"له ادارې سره اړیکه",wa:"د واټساپ اړیکه",map:"زموږ ځای ومومئ",
  finalEyebrow:"ستاسو راتلونکی ګام",finalTitle:"خپل پرمختګ له مناسبې کچې پیل کړئ.",finalText:"د سویې وړیا ارزونه وغواړئ او د شته ټولګیو، فیس او مهالوېش په اړه له ادارې معلومات واخلئ.",finalCta:"د وړیا سویې معلومولو غوښتنه",
  footerRights:"ټول حقونه خوندي دي.",footPrograms:"پروګرامونه",footTools:"د زده‌کړې وسایل",
  statsFallback:[["۶٬۰۰۰+","له ۲۰۱۳ کال راهیسې فارغان"],["۵۰۰+","د TOEFL ازموینې لارښوونه ترلاسه کوونکي"],["۱۰۰+","په نړیوالو پوهنتونونو کې منل شوي"]],courseNames:["عمومي انګلیسي","اکاډمیکه انګلیسي","د TOEFL چمتووالی","ځانګړې خبرې","مسلکي لیکنه","د ښوونکو روزنه"],fallbackFaq:[["آیا د سویې معلومول وړیا دي؟","هو. د سویې ارزونه وړیا ده او د مناسبې کچې په ټاکلو کې مرسته کوي."],["له ایمیل پرته نوم‌لیکنه کېدای شي؟","هو. له ادارې سره په واټساپ یا ټیلیفون اړیکه ونیسئ."],["آنلاین ټولګي شته؟","انفرادي آنلاین ټولګي د ښوونکي د وخت او ظرفیت له مخې همغږي کېږي."]]
 }
};
const V2_SEMESTER_VIDEO="https://d2ol7oe51mr4n9.cloudfront.net/user_3LPLI9IxwqxpPOe3cVF5EVhg2wd/21a66634-3b32-49c7-9034-8680714ebf17.mp4";
const V2_SEMESTER={
 "en": {
  "heroTeaser": "New semester · Qaws 1405",
  "eyebrow": "ENROLLMENT · QAWS 1405",
  "title": "A new semester.",
  "accent": "A stronger start to your English journey.",
  "lead": "Build practical English for conversation, university study, professional writing or TOEFL preparation. Explore six programs, choose a suitable level and begin with a free placement assessment.",
  "chips": [
   "General English",
   "Academic English · EAP",
   "Special Speaking"
  ],
    "cta": "Request a free placement assessment",
  "secondary": "Explore all six programs",
  "videoLabel": "Watch our new semester announcement",
  "play": "Play the new semester video",
  "playText": "Watch the video",
  "videoCaption": "New semester announcement · 36-second video",
  "videoFallback": "Watch the semester video",
  "eapLabel": "ACADEMIC ENGLISH · EAP",
  "eapTeaser": "Four levels · Three instructors and three books per level",
  "eapDetail": "AFN 1,000 monthly · AFN 2,000 per two-month level",
  "eapLink": "Explore the EAP pathway"
 },
 "fa": {
  "heroTeaser": "ثبت‌نام سمستر قوس ۱۴۰۵",
  "eyebrow": "ثبت‌نام سمستر جدید · قوس ۱۴۰۵",
  "title": "سمستر جدید؛",
  "accent": "آغاز یک مسیر روشن برای یادگیری انگلیسی.",
  "lead": "برای مکالمهٔ روان‌تر، تحصیل در دانشگاه، نگارش مسلکی یا آمادگی TOEFL، برنامهٔ متناسب با هدف خود را انتخاب کنید. در تافل هوس شش برنامهٔ آموزشی ارائه می‌شود و تعیین سطح برای انتخاب سطح مناسب رایگان است.",
  "chips": [
   "General English",
   "Academic English · EAP",
   "Special Speaking"
  ],
    "cta": "درخواست تعیین سطح رایگان",
  "secondary": "دیدن تمام شش برنامه",
  "videoLabel": "ویدیوی معرفی سمستر جدید تافل هوس",
  "play": "پخش ویدیوی معرفی سمستر جدید",
  "playText": "ویدیو را تماشا کنید",
  "videoCaption": "معرفی سمستر جدید · ویدیوی ۳۶ ثانیه‌ای",
  "videoFallback": "تماشای ویدیوی سمستر",
  "eapLabel": "انگلیسی اکادمیک · EAP",
  "eapTeaser": "۴ سطح · ۳ استاد و ۳ کتاب درسی در هر سطح",
  "eapDetail": "فیس ماهانه ۱٬۰۰۰ افغانی · هر سطح دوماهه ۲٬۰۰۰ افغانی",
  "eapLink": "معرفی کامل برنامهٔ EAP"
 },
 "ps": {
  "heroTeaser": "د قوس ۱۴۰۵ نوي سمستر نوم‌لیکنه",
  "eyebrow": "د نوي سمستر نوم‌لیکنه · قوس ۱۴۰۵",
  "title": "نوی سمستر؛",
  "accent": "د انګلیسي زده‌کړې لپاره روښانه پیل.",
  "lead": "د روانو خبرو، پوهنتوني زده‌کړو، مسلکي لیکنې او د TOEFL ازموینې د چمتووالي لپاره د خپلې موخې مناسب پروګرام وټاکئ. تافل هوس شپږ ښوونیز پروګرامونه لري او د مناسبې کچې د ټاکلو لپاره د سویې ارزونه وړیا ده.",
  "chips": [
   "General English",
   "Academic English · EAP",
   "Special Speaking"
  ],
    "cta": "د سویې د وړیا ارزونې غوښتنه",
  "secondary": "ټول شپږ پروګرامونه وګورئ",
  "videoLabel": "د تافل هوس د نوي سمستر معرفي ویډیو",
  "play": "د نوي سمستر ویډیو پلې کړئ",
  "playText": "ویډیو وګورئ",
  "videoCaption": "د نوي سمستر پېژندنه · ۳۶ ثانیې ویډیو",
  "videoFallback": "د سمستر ویډیو وګورئ",
  "eapLabel": "اکاډمیکه انګلیسي · EAP",
  "eapTeaser": "۴ کچې · په هره کچه کې ۳ ښوونکي او ۳ کتابونه",
  "eapDetail": "میاشتنی فیس ۱٬۰۰۰ افغانۍ · د دوه میاشتنې کچې فیس ۲٬۰۰۰ افغانۍ",
  "eapLink": "د EAP بشپړ معلومات"
 }
};
function v2SemesterCampaign(locale){
 const p=v2Prefix(locale),c=V2_SEMESTER[locale];
 const signup=p+"admissions/?utm_source=website&amp;utm_campaign=qaws_1405_semester";
 return '<section class="semester-section" id="semester-qaws-1405" aria-labelledby="semester-heading"><div class="shell"><div class="semester-card"><div class="semester-copy"><p class="semester-eyebrow"><span class="semester-dot" aria-hidden="true"></span>'+v2T(c.eyebrow)+'</p><h2 id="semester-heading" class="semester-title">'+v2T(c.title)+' <span>'+v2T(c.accent)+'</span></h2><p class="semester-lead">'+v2T(c.lead)+'</p><ul class="semester-chips">'+c.chips.map(x=>'<li>'+v2T(x)+'</li>').join("")+'</ul><div class="semester-actions"><a class="button semester-primary" href="'+signup+'">'+v2T(c.cta)+' <span aria-hidden="true">↗</span></a><a class="button semester-secondary" href="#programs">'+v2T(c.secondary)+'</a></div></div><div class="semester-media"><div class="semester-video-frame"><video class="semester-video" controls playsinline preload="none" poster="'+V2_IMG_640+'" width="720" height="1280" aria-label="'+v2T(c.videoLabel)+'"><source src="'+V2_SEMESTER_VIDEO+'" type="video/mp4">'+v2T(c.videoFallback)+'</video><button class="semester-video-cover" type="button" hidden aria-label="'+v2T(c.play)+'"><img src="'+V2_IMG_640+'" width="640" height="820" loading="lazy" decoding="async" alt=""><span class="semester-cover-shade" aria-hidden="true"></span><span class="semester-play-circle" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M8 5.6c0-.8.9-1.3 1.6-.9L20 11.2c.6.4.6 1.2 0 1.6L9.6 19.3C8.9 19.7 8 19.2 8 18.4V5.6z"/></svg></span><span class="semester-play-caption" aria-hidden="true">'+v2T(c.playText)+'</span></button><span class="semester-filmmark" aria-hidden="true">THE TOEFL HOUSE · 00:36</span></div><p class="semester-video-caption">'+v2T(c.videoCaption)+'</p></div></div><a class="semester-eap-spotlight" href="'+p+'courses/academic-english/"><span class="semester-eap-mark">EAP</span><span class="semester-eap-copy"><small>'+v2T(c.eapLabel)+'</small><strong>'+v2T(c.eapTeaser)+'</strong><span>'+v2T(c.eapDetail)+'</span></span><span class="semester-eap-link">'+v2T(c.eapLink)+' <span aria-hidden="true">↗</span></span></a></div></section>';
}
function v2Esc(s){return String(s??"").replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[x]));}
function v2T(s,max=1000){const publicCopy=String(s??"").replace(/خانه موفقیت/g,"تافل هوس");return v2Esc(publicCopy.slice(0,max));}
// Present the Owner's selected university terminology only on Dari pages.
// This also normalizes legacy, editable CMS copy at render time without
// rewriting the database or altering Pashto's correct "پوهنتون".
function v2DariEditorial(html,locale){
 return locale!=="fa"?html:html.replace(/پوهنتونی/g,"دانشگاهی").replace(/پوهنتون/g,"دانشگاه").replace(/روبروی/g,"روبه‌روی");
}

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
function v2BreadcrumbLabel(locale){return locale==="fa"?"مسیر دسترسی به صفحه":locale==="ps"?"د پاڼې د لاسرسي لاره":"Breadcrumb";}
function v2Languages(locale,suffix=""){
 return [["en","EN","/"],["fa","دری","/fa/"],["ps","پښتو","/ps/"]].map(([id,title,path])=>'<a lang="'+(id==="fa"?"fa-AF":id==="ps"?"ps-AF":"en")+'" hreflang="'+(id==="en"?"en":id==="fa"?"fa-AF":"ps-AF")+'" href="'+path+suffix+'"'+(id===locale?' aria-current="page" class="is-active"':'')+'>'+title+'</a>').join("");
}
function v2Header(c,locale,suffix=""){
 const prefix=v2Prefix(locale);
 const l=v2Languages(locale,suffix);
 const anchorBase=suffix?v2Prefix(locale):"";
 const courseMatch=/^courses\/([a-z0-9-]+)\/$/.exec(suffix);
 const applyHref=prefix+"admissions/"+(courseMatch&&V2_COURSE_IDS.includes(courseMatch[1])?"?program="+courseMatch[1]:"");
 const compactLabel=locale==="fa"?"تعیین سطح":locale==="ps"?"وړیا ارزونه":"Free assessment";
 const nav=[[anchorBase+"#programs",c.navPrograms],[prefix+"guides/",c.navGuides],[anchorBase+"#why-us",c.navWhy],[anchorBase+"#online",c.navOnline],[anchorBase+"#faq",c.navFaq],[anchorBase+"#contact",c.navContact]];
 const links=nav.map(([href,label])=>'<a href="'+href+'">'+v2T(label)+'</a>').join("");
 return '<a class="skip" href="#main">'+(locale==="en"?"Skip to content":locale==="fa"?"رفتن به محتوا":"منځپانګې ته لاړ شئ")+'</a>'
  +'<div class="topline"><div class="shell topline-inner"><span class="top-dots"></span><span>'+v2T(c.badge)+'</span><a class="toplink" href="https://wa.me/93794357509" rel="noopener noreferrer">'+v2T(c.wa)+' <span aria-hidden="true">↗</span></a></div></div>'
  +'<header class="site-header"><div class="shell header-inner"><a class="brand" href="'+prefix+'" aria-label="'+v2T(c.name)+'"><img src="'+V2_LOGO+'" width="48" height="48" alt="" decoding="async"><span><strong>THE TOEFL HOUSE</strong><small>'+v2T(c.localName)+'</small></span></a>'
  +'<nav class="main-nav" aria-label="'+v2T(c.navMenu)+'">'+links+'</nav>'
  +'<div class="header-actions"><div class="language-links" role="group" aria-label="'+v2T(locale==="en"?"Choose language":locale==="fa"?"انتخاب زبان":"ژبه وټاکئ")+'">'+l+'</div><a class="button button-primary desktop-apply" href="'+applyHref+'">'+v2T(c.navApply)+' <span aria-hidden="true">↗</span></a></div>'
  +'<a class="mobile-quick-apply" href="'+applyHref+'" aria-label="'+v2T(c.heroCta)+'">'+v2T(compactLabel)+'</a>'
  +'<details class="mobile-menu"><summary aria-label="'+v2T(c.navMenu)+'"><span></span><span></span><span></span></summary><nav aria-label="'+v2T(c.navMenu)+'">'+links+'<div class="mobile-language">'+l+'</div><a class="mobile-apply" href="'+applyHref+'">'+v2T(c.navApply)+'</a></nav></details></div></header>';
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
const V2_GOALS={
 en:{title:"What do you want to achieve?",hint:"Choose your goal to find a suitable learning path.",label:"Explore English programs by goal",items:[["general-english","Start with the foundations"],["special-speaking","Speak with confidence"],["academic-english","Prepare for university"],["toefl-preparation","Prepare for TOEFL"]]},
 fa:{title:"هدف شما از یادگیری انگلیسی چیست؟",hint:"هدف خود را انتخاب کنید و برنامهٔ مناسب را بشناسید.",label:"انتخاب برنامه بر اساس هدف آموزشی",items:[["general-english","از پایه شروع کنم"],["special-speaking","با اطمینان صحبت کنم"],["academic-english","برای دانشگاه آماده شوم"],["toefl-preparation","برای TOEFL آماده شوم"]]},
 ps:{title:"له انګلیسي زده‌کړې موخه مو څه ده؟",hint:"خپله موخه وټاکئ او مناسب پروګرام ومومئ.",label:"د زده‌کړې د موخې له مخې د پروګرام ټاکنه",items:[["general-english","له بنسټ څخه پیل کوم"],["special-speaking","په ډاډه زړه خبرې کوم"],["academic-english","پوهنتون ته چمتو کېږم"],["toefl-preparation","TOEFL ته چمتو کېږم"]]}
};
function v2Programs(c,content,locale){
 const prefix=v2Prefix(locale);
 const src=locale==="ps"?content.pashto.programs:content.main.locales[locale].programs;
 const goal=V2_GOALS[locale],goalNav='<nav class="goal-finder" aria-label="'+v2T(goal.label)+'"><div class="goal-finder-intro"><strong>'+v2T(goal.title)+'</strong><span>'+v2T(goal.hint)+'</span></div><div class="goal-finder-links">'+goal.items.map(([id,label])=>'<a href="#course-'+id+'">'+v2T(label)+' <span aria-hidden="true">↗</span></a>').join("")+'</div></nav>';
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
  // Owner-confirmed program facts take precedence over older CMS summaries.
  const reviewed={
    en:{"special-speaking":"Two-month semester with Master Speaking and grammar in conversation. Total semester fee: AFN 2,000.","toefl-preparation":"Four-month preparation for the updated 2026 TOEFL iBT: Reading, Listening, Writing and Speaking."},
    fa:{"special-speaking":"سمستر دوماهه با کتاب اختصاصی Master Speaking و گرامر مکالمه؛ فیس مجموعی ۲٬۰۰۰ افغانی.","toefl-preparation":"آمادگی چهارماههٔ TOEFL iBT مطابق ساختار جدید سال ۲۰۲۶؛ چهار مهارت اصلی زبان."},
    ps:{"special-speaking":"دوه میاشتنی سمستر د Master Speaking او د خبرو ګرامر له کتابونو سره؛ ټول فیس ۲٬۰۰۰ افغانۍ.","toefl-preparation":"د ۲۰۲۶ نوې TOEFL iBT بڼې ته څلور میاشتنی چمتووالی؛ د انګلیسي څلور مهارتونه."}
  };
  if(reviewed[locale]?.[id])desc=reviewed[locale][id];
  return '<article id="course-'+id+'" class="course-card '+(id==="toefl-preparation"?"course-featured":"")+'"><div class="course-top"><span class="course-number">'+String(i+1).padStart(2,"0")+'</span><span class="course-mark" aria-hidden="true">↗</span></div><h3>'+v2T(c.courseNames[i]||program.title||id)+'</h3><p class="course-copy">'+v2Short(desc,160)+'</p><div class="course-bottom"><span><small>'+v2T(c.courseDuration)+'</small><strong>'+v2Short(duration||"",85)+'</strong></span><a aria-label="'+v2T(c.courseDetail+' — '+(program.title||c.courseNames[i]))+'" href="'+prefix+'courses/'+id+'/">'+v2T(c.courseDetail)+' <span aria-hidden="true">↗</span></a></div></article>';
 }).join("");
 return '<section class="programs-section section" id="programs"><div class="shell"><div class="section-head"><div><p class="eyebrow">'+v2T(c.courseEyebrow)+'</p><h2>'+v2T(c.coursesTitle)+' <em>'+v2T(c.coursesAccent)+'</em></h2></div><p class="section-intro">'+v2T(c.coursesLead)+'</p></div>'+goalNav+'<div class="courses-grid">'+cards+'</div></div></section>';
}
function v2CleanFaqAnswer(value){
 return String(value||"").replace(/\s*(?:رایگان‌بودن تعیین سطح به معنای رایگان‌بودن صنف‌ها نیست|It does not make course tuition free|د سویې وړیا ارزونه د دې معنا نه لري چې درسي ټولګي هم وړیا دي)\.?/gi,"").trim();
}
function v2Faq(c,content,locale){
 const raw=locale==="ps"?content.pashto.faq:content.main.locales[locale].faq;
 const items=(Array.isArray(raw)?raw:raw?.items)||[];
 const prioritized=[
  items.find(x=>/تعیین سطح|placement|سویې معلومولو|سویې ارزونه/i.test(x.q||x.question||"")),
  items.find(x=>/ایمیل|email|ایمېل/i.test(x.q||x.question||"")),
  items.find(x=>/آنلاین|online|آنلاين/i.test(x.q||x.question||""))
 ].filter(Boolean);
 const list=prioritized.length===3?prioritized:items.slice(0,3);
 const entries=list.length?list.map(x=>[x.q||x.question,x.a||x.answer]):c.fallbackFaq;
 return '<section class="faq-section section" id="faq"><div class="shell faq-layout"><div class="faq-aside"><p class="eyebrow">'+v2T(c.faqLabel)+'</p><h2>'+v2T(c.faqTitle)+'</h2><p>'+v2T(c.faqLead)+'</p><a class="text-link" href="https://wa.me/93794357509" rel="noopener noreferrer">'+v2T(c.faqMore)+' <span aria-hidden="true">↗</span></a></div><div class="faq-list">'+entries.map(([q,a],i)=>'<details'+(i===0?' open':'')+'><summary>'+v2Short(q,160)+'<span class="faq-plus" aria-hidden="true"></span></summary><p>' +v2T(v2CleanFaqAnswer(a),680)+'</p></details>').join("")+'</div></div></section>';
}
function v2Footer(c,locale,content){
 const prefix=v2Prefix(locale);
 const contact=locale==="ps"?content?.pashto?.contact:content?.main?.locales?.[locale]?.contact;
 const published=(value,fallback,max)=>typeof value==="string"&&value.trim()&&value.length<=max?value:fallback;
 const storedTitle=published(contact?.title,c.visitTitle,180);
 const visitTitle=locale==="fa"&&storedTitle==="در کابل پذیرای شما هستیم."?"تافل هوس در کابل":storedTitle;
 const storedAddress=published(contact?.address,c.visitText,350);
 const visitAddress=locale==="fa"?storedAddress.replace("روبروی","روبه‌روی"):storedAddress;
 const storedHours=published(contact?.operatingHours||contact?.hours,c.hours,250);
 // Keep later CMS edits visible; normalize only the exact three stale published summaries.
 const outdatedHours={
  en:"Teaching: Saturday–Thursday · Men: 6:20 AM–5:50 PM · Women: 6:30 AM–5:40 PM · Friday: Closed",
  fa:"جلسات درسی: شنبه الی پنج‌شنبه · برادران: ۶:۲۰ صبح تا ۵:۵۰ شام · خواهران: ۶:۳۰ صبح تا ۵:۴۰ شام · جمعه: رخصت",
  ps:"شنبه تر پنجشنبې: سهار ۶:۲۰ تر ماښام ۶:۰۰؛ جمعه رخصتي، ځانګړي پروګرامونه جلا اعلانېږي"
 };
 const visitHours=storedHours===outdatedHours[locale]?c.hours:storedHours;
 const maps="https://www.google.com/maps/search/?api=1&query=The%20TOEFL%20House%20Dasht-e-Barchi%20Kabul";
 return '<footer class="footer" id="contact"><div class="shell"><div class="footer-main"><div class="footer-brand"><span class="eyebrow">'+v2T(c.visitLabel)+'</span><h2>'+v2T(visitTitle)+'</h2><p>'+v2T(visitAddress)+'</p><span class="footer-hours">'+v2T(visitHours)+'</span><a class="button button-primary footer-cta" href="'+prefix+'admissions/">'+v2T(c.finalCta)+' <span aria-hidden="true">↗</span></a></div><div class="footer-links"><a href="'+prefix+'#programs">'+v2T(c.footPrograms)+'</a><a href="'+prefix+'guides/">'+v2T(c.navGuides)+'</a><a href="https://wa.me/93794357509" rel="noopener noreferrer">'+v2T(c.wa)+'</a><a href="tel:+93745651844">'+v2T(c.phone)+'</a><a href="'+maps+'" target="_blank" rel="noopener noreferrer">'+v2T(c.map)+' ↗</a></div></div><div class="footer-bottom"><span>© '+new Date().getUTCFullYear()+' THE TOEFL HOUSE · '+v2T(c.footerRights)+'</span></div></div></footer>';
}
// Google Course list: only six real, publicly described curricula; online is a format, not a seventh course.
function v2CourseListSchema(locale,content){
 const names=V2_COPY[locale].courseNames,root=v2Prefix(locale);
 const programs=locale==="ps"?content.pashto.programs:content.main.locales[locale].programs;
 const provider={"@type":"Organization","name":"The TOEFL House","url":V2_ORIGIN+"/"};
 return {"@context":"https://schema.org","@type":"ItemList","itemListElement":V2_COURSE_IDS.map((id,i)=>{
  const course=programs.find(p=>p.id===id)||{};
  const url=V2_ORIGIN+root+"courses/"+id+"/";
  const name=String(course.title||names[i]).trim().slice(0,180);
  const summary=String(course.summary||course.details||"").replace(/\s+/g," ").trim();
  const description=(summary.length>=10?summary:name+" course at The TOEFL House in Kabul.").slice(0,280);
  return {"@type":"ListItem","position":i+1,"url":url,"item":{"@type":"Course","name":name,"description":description,"url":url,"provider":provider}};
 })};
}
function v2Page(locale,content){
 const c=V2_COPY[locale],prefix=v2Prefix(locale),title=locale==="en"?"The TOEFL House | English Classes & TOEFL Preparation in Kabul":locale==="fa"?"تافل هوس | کورس زبان انگلیسی و آمادگی تافل در کابل":"The TOEFL House | په کابل کې انګلیسي او TOEFL زده‌کړه";
 const desc=c.subtitle,canonical=V2_ORIGIN+prefix;
 const language="<link rel=\"alternate\" hreflang=\"en\" href=\""+V2_ORIGIN+"/\"><link rel=\"alternate\" hreflang=\"fa-AF\" href=\""+V2_ORIGIN+"/fa/\"><link rel=\"alternate\" hreflang=\"ps-AF\" href=\""+V2_ORIGIN+"/ps/\"><link rel=\"alternate\" hreflang=\"x-default\" href=\""+V2_ORIGIN+"/\">";
 const ld=JSON.stringify([{"@context":"https://schema.org","@type":"EducationalOrganization","name":"The TOEFL House","alternateName":"تافل هوس","url":V2_ORIGIN+"/","description":c.subtitle,"address":{"@type":"PostalAddress","streetAddress":"Opposite Jalili Center, Maghaza Station, Dasht-e-Barchi","addressLocality":"Kabul","addressCountry":"AF"},"telephone":"+93745651844","availableLanguage":["en","fa-AF","ps-AF"]},v2CourseListSchema(locale,content)]).replace(/</g,"\\u003c");
 return '<!doctype html><html lang="'+c.lang+'" dir="'+c.dir+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+v2T(title)+'</title><meta name="description" content="'+v2T(desc,400)+'"><meta name="theme-color" content="#f7f6f2"><meta property="og:type" content="website"><meta property="og:locale" content="'+V2_OG_LOCALE[locale]+'"><meta property="og:title" content="'+v2T(title)+'"><meta property="og:description" content="'+v2T(desc)+'"><meta property="og:url" content="'+canonical+'"><meta property="og:image" content="'+V2_ORIGIN+V2_OG+'"><meta property="og:image:alt" content="'+v2T(c.photoSub,180)+'"><meta property="og:site_name" content="The TOEFL House"><meta name="twitter:card" content="summary_large_image"><link rel="canonical" href="'+canonical+'">'+language+'<link rel="icon" href="' + V2_LOGO + '"><link rel="preload" href="'+V2_IMG_640+'" as="image" imagesrcset="'+V2_IMG_SET+'" imagesizes="'+V2_IMG_SIZES+'" fetchpriority="high"><link rel="stylesheet" href="/__th/v2/site.css?v='+V2_REV+'"><script defer src="/__th/v2/site.js?v='+V2_REV+'"></script><script defer src="/__th/engagement-v1.js"></script><script type="application/ld+json">'+ld+'</script></head><body>'
 +v2Header(c,locale)
 +'<main id="main"><section class="hero"><div class="shell hero-grid"><div class="hero-copy"><span class="eyebrow eyebrow-hero"><span class="eyebrow-rule"></span>'+v2T(c.tag)+'</span><a class="semester-hero-pill" href="#semester-qaws-1405"><span class="semester-mini-dot" aria-hidden="true"></span>'+v2T(V2_SEMESTER[locale].heroTeaser)+' <span aria-hidden="true">↗</span></a><h1>'+v2T(c.lead)+' <span>'+v2T(c.leadAccent)+'</span></h1><p class="hero-lead">'+v2T(c.subtitle)+'</p><div class="hero-actions"><a class="button button-primary button-xl" href="'+prefix+'admissions/">'+v2T(c.heroCta)+' <span aria-hidden="true">↗</span></a><a class="button button-quiet button-xl" href="#programs">'+v2T(c.heroSecondary)+'</a></div><div class="hero-fine"><span aria-hidden="true">✦</span>'+v2T(c.heroBottom)+'</div></div><div class="hero-art"><div class="photo-frame"><img src="'+V2_IMG_640+'" srcset="'+V2_IMG_SET+'" sizes="'+V2_IMG_SIZES+'" width="680" height="820" alt="'+v2T(V2_CAMPUS_ALT[locale])+'" fetchpriority="high" decoding="async"><div class="photo-shade"></div><div class="photo-label"><strong>'+v2T(c.photoBadge)+'</strong><small>'+v2T(c.photoSub)+'</small></div></div><div class="photo-side"><span>'+v2T(c.micro)+'</span></div><div class="photo-accent" aria-hidden="true"></div></div></div></section>'
 +v2SemesterCampaign(locale)
 +v2Stats(c,content,locale)
 +v2Programs(c,content,locale)
 +'<section class="online-section section" id="online"><div class="shell"><div class="online-panel"><div class="online-symbol" aria-hidden="true"><span>1:1</span><svg viewBox="0 0 70 70" fill="none" aria-hidden="true"><circle cx="35" cy="35" r="31" stroke="currentColor" stroke-width="1.5"/><path d="M15 35h40M35 15v40" stroke="currentColor" stroke-width="1.5"/></svg></div><div class="online-copy"><p class="eyebrow">'+v2T(c.onlineLabel)+'</p><h2>'+v2T(c.onlineTitle)+'</h2><p>'+v2T(c.onlineText)+'</p></div><a class="button button-light" href="'+prefix+'admissions/?program=online-individual-zoom">'+v2T(c.onlineCta)+' <span aria-hidden="true">↗</span></a></div></div></section>'
 +'<section class="journey-section section" id="why-us"><div class="shell"><div class="section-head"><div><p class="eyebrow">'+v2T(c.whyLabel)+'</p><h2>'+v2T(c.whyTitle)+'</h2></div><p class="section-intro">'+v2T(c.whyLead)+'</p></div><div class="journey-grid">'+c.steps.map(([n,h,p])=>'<article class="journey-step"><span class="step-no">'+v2T(n)+'</span><div class="step-line"></div><h3>'+v2T(h)+'</h3><p>'+v2T(p)+'</p></article>').join("")+'</div><div class="tools-strip"><div class="tools-glyph" aria-hidden="true">✳</div><div class="tools-content"><span class="eyebrow">'+v2T(c.toolsLabel)+'</span><h3>'+v2T(c.toolsTitle)+'</h3><p>'+v2T(c.toolsText)+'</p></div><a class="text-link" href="'+prefix+'admissions/">'+v2T(c.toolsCta)+' <span aria-hidden="true">↗</span></a></div></div></section>'
 +v2Faq(c,content,locale)
 +'<section class="final-cta"><div class="shell final-inner"><div><p class="eyebrow">'+v2T(c.finalEyebrow)+'</p><h2>'+v2T(c.finalTitle)+'</h2><p>'+v2T(c.finalText)+'</p></div><a class="button button-white" href="'+prefix+'admissions/">'+v2T(c.finalCta)+' <span aria-hidden="true">↗</span></a></div></section>'
 +'</main>'+v2Footer(c,locale,content)+'</body></html>';
}
async function v2Home(request,env,locale){
 if(!["GET","HEAD"].includes(request.method))return new Response("Method not allowed",{status:405,headers:{"Allow":"GET, HEAD"}});
 try{
  const data=await v2Cms(env);
  const html=v2DariEditorial(v2Page(locale,data),locale),preview=new URL(request.url).hostname!=="toeflhouse.pages.dev";
  const headers=new Headers({"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache, no-store, must-revalidate","X-Content-Type-Options":"nosniff","Referrer-Policy":"strict-origin-when-cross-origin","X-Frame-Options":"DENY","Permissions-Policy":"camera=(), microphone=(), geolocation=()","Content-Language":V2_COPY[locale].lang,"Content-Security-Policy":"default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; font-src 'self'; img-src 'self' data:; media-src 'self' https://d2ol7oe51mr4n9.cloudfront.net; connect-src 'self' https://toefl-house-conversions.alfrotan2.workers.dev https://static.cloudflareinsights.com https://cloudflareinsights.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://wa.me"});
  if(preview)headers.set("X-Robots-Tag","noindex, nofollow, noarchive");
  return new Response(request.method==="HEAD"?null:html,{status:200,headers});
 }catch(error){
  console.error("V2 CMS page render unavailable; retaining original",String(error));
  return null;
 }
}
