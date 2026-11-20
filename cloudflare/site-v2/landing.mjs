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
  toolsLabel:"LEARNING SUPPORT",toolsTitle:"Academic resources in one place.",toolsText:"View available learning tools, course information, TOEFL score planning and placement guidance in the student section.",toolsCta:"Open learning tools",
  faqLabel:"GOOD TO KNOW",faqTitle:"Questions before you enroll?",faqLead:"Essential information about placement, tuition and available classes.",faqMore:"More questions? Message our team",
  visitLabel:"VISIT US",visitTitle:"Visit The TOEFL House in Kabul.",visitText:"Opposite Jalili Center, Maghaza Station, Dasht-e-Barchi, Kabul, Afghanistan.",hours:"Classes Saturday–Thursday · Friday closed · Confirm class times with admissions",phone:"Call admissions",wa:"WhatsApp admissions",map:"Find our campus",
  finalEyebrow:"YOUR NEXT CHAPTER",finalTitle:"Your next step begins with the right level.",finalText:"Request a free placement assessment and ask our admissions team about current programs, fees and class times.",finalCta:"Request your free assessment",
  footerLine:"Unlock the world with TOEFL.",footerRights:"All rights reserved.",footerNote:"Free placement assessment · Tuition applies to courses",footPrograms:"Programs",footJoin:"Admissions",footTools:"Student tools",
  statsFallback:[["6,000+","Graduates since 2013"],["500+","TOEFL test-takers guided"],["100+","University admissions worldwide"]],courseNames:["General English","Academic English","TOEFL Preparation","Special Speaking","Professional Writing","Teacher Training"],fallbackFaq:[["Is the placement assessment free?","Yes. Placement assessment is free; course tuition is separate."],["Can I enroll without an email?","Yes. You may contact admissions through WhatsApp or by phone."],["Are online classes available?","Private online classes can be arranged based on teacher availability and time zones."]]
 },
 fa:{
  lang:"fa-AF",dir:"rtl",name:"THE TOEFL HOUSE",localName:"تافل هوس",tag:"آموزش تخصصی زبان انگلیسی · کابل",
  navPrograms:"برنامه‌ها",navGuides:"رهنماهای درسی",navWhy:"چرا تافل هوس؟",navOnline:"صنف‌های آنلاین",navFaq:"پرسش‌ها",navContact:"تماس",navMenu:"فهرست",
  navApply:"تعیین سطح رایگان",badge:"ثبت‌نام جریان دارد · تعیین سطح رایگان",
  lead:"انگلیسی را هدفمند بیاموزید.",leadAccent:"با اطمینان پیش بروید.",subtitle:"برای مکالمهٔ روزمره، تحصیل در پوهنتون و آمادگی امتحان TOEFL، مهارت‌های زبان انگلیسی خود را تقویت کنید. با تعیین سطح رایگان، از سطح مناسب آغاز نمایید.",
  heroCta:"درخواست تعیین سطح رایگان",heroSecondary:"دیدن برنامه‌های آموزشی",heroBottom:"صنف‌های حضوری در کابل · آموزش آنلاین انفرادی با هماهنگی قبلی",
  photoBadge:"یادگیری در کنار هم",photoSub:"دشت برچی · کابل",micro:"تافل هوس • از سال ۲۰۱۳",
  trustTitle:"آموزش برای فرصت‌های بیشتر",trustSub:"نگاهی به جامعهٔ آموزشی تافل هوس",
  courseEyebrow:"برنامه‌های آموزشی",coursesTitle:"برنامه‌ای متناسب با",coursesAccent:"هدف شما.",coursesLead:"شش برنامهٔ آموزشی، از انگلیسی عمومی تا مهارت‌های اکادمیک و مسلکی. برای دریافت معلومات دقیق دربارهٔ فیس، تقسیم اوقات و ظرفیت صنف‌ها با پذیرش تماس بگیرید.",
  courseDetail:"معرفی کامل برنامه",courseDuration:"مدت دوره",onlineLabel:"صنف‌های آنلاین انفرادی",onlineTitle:"آموزش خصوصی انگلیسی، مطابق هدف و وقت شما.",onlineText:"صنف‌های زنده و انفرادی از طریق Zoom برای علاقه‌مندان داخل و خارج از کابل، به‌شمول اروپا و کانادا، با هماهنگی قبلی برگزار می‌شوند. محتوای آموزشی، وقت صنف، دسترسی استاد و فیس پیش از ثبت‌نام تأیید می‌گردد.",onlineCta:"معلومات دربارهٔ صنف‌های آنلاین",
  whyLabel:"مسیر روشن ثبت‌نام",whyTitle:"با یک انتخاب آگاهانه آغاز کنید.",whyLead:"از تعیین هدف تا انتخاب صنف مناسب، سه گام مشخص پیش روی شماست.",
  steps:[["۰۱","هدف‌تان را بگویید","مکالمه، انگلیسی اکادمیک، تافل یا انگلیسی روزمره؛ بگویید کدام مهارت را می‌خواهید بهتر سازید."],["۰۲","سطح زبان خود را رایگان تعیین کنید","با رهنمایی تیم آموزشی، صنف و سطح مناسب خود را پیدا کنید."],["۰۳","در صنف مناسب شامل شوید","تقسیم اوقات، شیوهٔ تدریس و فیس را با پذیرش تأیید کنید."]],
  toolsLabel:"ابزارهای آموزشی",toolsTitle:"منابع و ابزارهای درسی در یک‌جا.",toolsText:"معلومات برنامه‌ها، تقسیم اوقات، ابزار برنامه‌ریزی نمرهٔ TOEFL و رهنمای تعیین سطح را در بخش آموزشی سایت ببینید.",toolsCta:"باز کردن ابزارهای آموزشی",
  faqLabel:"معلومات ضروری",faqTitle:"پرسش‌های مهم پیش از ثبت‌نام",faqLead:"معلومات روشن دربارهٔ تعیین سطح، فیس و شیوهٔ اشتراک در صنف‌ها.",faqMore:"پرسش دیگری دارید؟ در واتساپ پیام بدهید",
  visitLabel:"آدرس ما",visitTitle:"از تافل هوس در کابل دیدن کنید.",visitText:"کابل، دشت برچی، ایستگاه مغازه، روبروی مرکز جلیلی، افغانستان.",hours:"صنف‌ها از شنبه تا پنج‌شنبه · جمعه رخصت · وقت دقیق صنف را از پذیرش بپرسید",phone:"تماس با پذیرش",wa:"واتساپ پذیرش",map:"پیدا کردن آدرس کورس",
  finalEyebrow:"گام بعدی شما",finalTitle:"برای پیشرفت، از سطح مناسب آغاز کنید.",finalText:"تعیین سطح رایگان انجام دهید و دربارهٔ صنف‌های موجود، فیس و تقسیم اوقات از پذیرش معلومات بگیرید.",finalCta:"درخواست تعیین سطح رایگان",
  footerLine:"با تافل، دریچه‌های تازه‌ای به جهان باز کنید.",footerRights:"تمام حقوق محفوظ است.",footerNote:"تعیین سطح رایگان · صنف‌های آموزشی دارای فیس",footPrograms:"برنامه‌ها",footJoin:"پذیرش",footTools:"ابزارهای درسی",
  statsFallback:[["۶٬۰۰۰+","فارغ‌التحصیل از سال ۲۰۱۳"],["۵۰۰+","اشتراک‌کننده در تافل"],["۱۰۰+","پذیرش در پوهنتون‌های جهان"]],courseNames:["انگلیسی عمومی","انگلیسی اکادمیک","آمادگی تافل","مکالمهٔ ویژه","نگارش مسلکی","تربیهٔ استاد"],fallbackFaq:[["آیا تعیین سطح رایگان است؟","بلی، تعیین سطح رایگان است؛ فیس دوره‌های آموزشی جداگانه می‌باشد."],["آیا بدون ایمیل می‌توانم معلومات بگیرم؟","بلی. از طریق واتساپ یا تماس تلفونی با بخش پذیرش در ارتباط شوید."],["آیا صنف آنلاین دارید؟","صنف‌های آنلاین انفرادی مطابق ظرفیت استاد و منطقهٔ زمانی با هماهنگی برگزار می‌شود."]]
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
  toolsLabel:"د زده‌کړې وسایل",toolsTitle:"درسي سرچینې او وسایل په یوه ځای کې.",toolsText:"د پروګرامونو معلومات، د ټولګیو مهالوېش، د TOEFL نمرې پلان او د سویې د ارزونې لارښود په زده‌کړیزه برخه کې وګورئ.",toolsCta:"زده‌کړیز وسایل پرانیزئ",
  faqLabel:"اړین معلومات",faqTitle:"له نوم‌لیکنې مخکې مهمې پوښتنې",faqLead:"د سویې ارزونې، فیس او د ټولګیو د ګډون په اړه روښانه ځوابونه.",faqMore:"نورې پوښتنې لرئ؟ موږ ته په واټساپ پیغام واستوئ",
  visitLabel:"زموږ پته",visitTitle:"په کابل کې تافل هوس ته راشئ.",visitText:"کابل، دشت برچي، مغازه تمځای، د جلیلي مرکز مخامخ، افغانستان.",hours:"ټولګي له شنبې تر پنجشنبې · جمعه رخصتي · د ټولګي دقیق وخت له ادارې وپوښتئ",phone:"له ادارې سره اړیکه",wa:"د واټساپ اړیکه",map:"زموږ ځای ومومئ",
  finalEyebrow:"ستاسو راتلونکی ګام",finalTitle:"خپل پرمختګ له مناسبې کچې پیل کړئ.",finalText:"د سویې وړیا ارزونه وغواړئ او د شته ټولګیو، فیس او مهالوېش په اړه له ادارې معلومات واخلئ.",finalCta:"د وړیا سویې معلومولو غوښتنه",
  footerLine:"له TOEFL سره نړۍ ته ورسېږئ.",footerRights:"ټول حقونه خوندي دي.",footerNote:"د سویې ارزونه وړیا ده · درسي ټولګي فیس لري",footPrograms:"پروګرامونه",footJoin:"نوم‌لیکنه",footTools:"د زده‌کړې وسایل",
  statsFallback:[["۶٬۰۰۰+","له ۲۰۱۳ کال راهیسې فارغان"],["۵۰۰+","د TOEFL ازموینې لارښوونه ترلاسه کوونکي"],["۱۰۰+","په نړیوالو پوهنتونونو کې منل شوي"]],courseNames:["عمومي انګلیسي","اکاډمیکه انګلیسي","د TOEFL چمتووالی","ځانګړې خبرې","مسلکي لیکنه","د ښوونکو روزنه"],fallbackFaq:[["آیا د سویې معلومول وړیا دي؟","هو. د سویې معلومول وړیا دي، خو د کورس فیس جلا دی."],["له ایمیل پرته نوم‌لیکنه کېدای شي؟","هو. له ادارې سره په واټساپ یا ټیلیفون اړیکه ونیسئ."],["آنلاین ټولګي شته؟","انفرادي آنلاین ټولګي د ښوونکي د وخت او ظرفیت له مخې همغږي کېږي."]]
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
  "free": "Placement assessment is free; course tuition is separate.",
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
  "lead": "برای مکالمهٔ روان‌تر، تحصیل در پوهنتون، نگارش مسلکی یا آمادگی TOEFL، برنامهٔ متناسب با هدف خود را انتخاب کنید. در تافل هوس شش برنامهٔ آموزشی ارائه می‌شود و تعیین سطح برای انتخاب سطح مناسب رایگان است.",
  "chips": [
   "General English",
   "Academic English · EAP",
   "Special Speaking"
  ],
  "free": "تعیین سطح رایگان است؛ صنف‌های آموزشی فیس دارند.",
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
  "free": "د سویې ارزونه وړیا ده؛ درسي ټولګي فیس لري.",
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
 return '<section class="semester-section" id="semester-qaws-1405" aria-labelledby="semester-heading"><div class="shell"><div class="semester-card"><div class="semester-copy"><p class="semester-eyebrow"><span class="semester-dot" aria-hidden="true"></span>'+v2T(c.eyebrow)+'</p><h2 id="semester-heading" class="semester-title">'+v2T(c.title)+' <span>'+v2T(c.accent)+'</span></h2><p class="semester-lead">'+v2T(c.lead)+'</p><ul class="semester-chips">'+c.chips.map(x=>'<li>'+v2T(x)+'</li>').join("")+'</ul><p class="semester-free"><span aria-hidden="true">✦</span> '+v2T(c.free)+'</p><div class="semester-actions"><a class="button semester-primary" href="'+signup+'">'+v2T(c.cta)+' <span aria-hidden="true">↗</span></a><a class="button semester-secondary" href="#programs">'+v2T(c.secondary)+'</a></div></div><div class="semester-media"><div class="semester-video-frame"><video class="semester-video" controls playsinline preload="none" poster="'+V2_IMG_640+'" width="720" height="1280" aria-label="'+v2T(c.videoLabel)+'"><source src="'+V2_SEMESTER_VIDEO+'" type="video/mp4">'+v2T(c.videoFallback)+'</video><button class="semester-video-cover" type="button" hidden aria-label="'+v2T(c.play)+'"><img src="'+V2_IMG_640+'" width="640" height="820" loading="lazy" decoding="async" alt=""><span class="semester-cover-shade" aria-hidden="true"></span><span class="semester-play-circle" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M8 5.6c0-.8.9-1.3 1.6-.9L20 11.2c.6.4.6 1.2 0 1.6L9.6 19.3C8.9 19.7 8 19.2 8 18.4V5.6z"/></svg></span><span class="semester-play-caption" aria-hidden="true">'+v2T(c.playText)+'</span></button><span class="semester-filmmark" aria-hidden="true">THE TOEFL HOUSE · 00:36</span></div><p class="semester-video-caption">'+v2T(c.videoCaption)+'</p></div></div><a class="semester-eap-spotlight" href="'+p+'courses/academic-english/"><span class="semester-eap-mark">EAP</span><span class="semester-eap-copy"><small>'+v2T(c.eapLabel)+'</small><strong>'+v2T(c.eapTeaser)+'</strong><span>'+v2T(c.eapDetail)+'</span></span><span class="semester-eap-link">'+v2T(c.eapLink)+' <span aria-hidden="true">↗</span></span></a></div></section>';
}
function v2Esc(s){return String(s??"").replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[x]));}
function v2T(s,max=1000){const publicCopy=String(s??"").replace(/خانه موفقیت/g,"تافل هوس");return v2Esc(publicCopy.slice(0,max));}
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
 const nav=[[anchorBase+"#programs",c.navPrograms],[prefix+"guides/",c.navGuides],[anchorBase+"#why-us",c.navWhy],[anchorBase+"#online",c.navOnline],[anchorBase+"#faq",c.navFaq],[anchorBase+"#contact",c.navContact]];
 const links=nav.map(([href,label])=>'<a href="'+href+'">'+v2T(label)+'</a>').join("");
 return '<a class="skip" href="#main">'+(locale==="en"?"Skip to content":locale==="fa"?"رفتن به محتوا":"منځپانګې ته لاړ شئ")+'</a>'
  +'<div class="topline"><div class="shell topline-inner"><span class="top-dots"></span><span>'+v2T(c.badge)+'</span><a class="toplink" href="https://wa.me/93794357509" rel="noopener noreferrer">'+v2T(c.wa)+' <span aria-hidden="true">↗</span></a></div></div>'
  +'<header class="site-header"><div class="shell header-inner"><a class="brand" href="'+prefix+'" aria-label="'+v2T(c.name)+'"><img src="'+V2_LOGO+'" width="48" height="48" alt="" decoding="async"><span><strong>THE TOEFL HOUSE</strong><small>'+v2T(c.localName)+'</small></span></a>'
  +'<nav class="main-nav" aria-label="'+v2T(c.navMenu)+'">'+links+'</nav>'
  +'<div class="header-actions"><div class="language-links" role="group" aria-label="'+v2T(locale==="en"?"Choose language":locale==="fa"?"انتخاب زبان":"ژبه وټاکئ")+'">'+l+'</div><a class="button button-primary desktop-apply" href="'+prefix+'admissions/">'+v2T(c.navApply)+' <span aria-hidden="true">↗</span></a></div>'
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
  // Owner-confirmed program facts take precedence over older CMS summaries.
  const reviewed={
    en:{"special-speaking":"Two-month semester with Master Speaking and grammar in conversation. Total semester fee: AFN 2,000.","toefl-preparation":"Four-month preparation for the updated 2026 TOEFL iBT: Reading, Listening, Writing and Speaking."},
    fa:{"special-speaking":"سمستر دوماهه با کتاب اختصاصی Master Speaking و گرامر مکالمه؛ فیس مجموعی ۲٬۰۰۰ افغانی.","toefl-preparation":"آمادگی چهارماههٔ TOEFL iBT مطابق ساختار جدید سال ۲۰۲۶؛ چهار مهارت اصلی زبان."},
    ps:{"special-speaking":"دوه میاشتنی سمستر د Master Speaking او د خبرو ګرامر له کتابونو سره؛ ټول فیس ۲٬۰۰۰ افغانۍ.","toefl-preparation":"د ۲۰۲۶ نوې TOEFL iBT بڼې ته څلور میاشتنی چمتووالی؛ د انګلیسي څلور مهارتونه."}
  };
  if(reviewed[locale]?.[id])desc=reviewed[locale][id];
  return '<article class="course-card '+(id==="toefl-preparation"?"course-featured":"")+'"><div class="course-top"><span class="course-number">'+String(i+1).padStart(2,"0")+'</span><span class="course-mark" aria-hidden="true">↗</span></div><h3>'+v2T(program.title||c.courseNames[i])+'</h3><p class="course-copy">'+v2Short(desc,160)+'</p><div class="course-bottom"><span><small>'+v2T(c.courseDuration)+'</small><strong>'+v2Short(duration||"",85)+'</strong></span><a aria-label="'+v2T(c.courseDetail+' — '+(program.title||c.courseNames[i]))+'" href="'+prefix+'courses/'+id+'/">'+v2T(c.courseDetail)+' <span aria-hidden="true">↗</span></a></div></article>';
 }).join("");
 return '<section class="programs-section section" id="programs"><div class="shell"><div class="section-head"><div><p class="eyebrow">'+v2T(c.courseEyebrow)+'</p><h2>'+v2T(c.coursesTitle)+' <em>'+v2T(c.coursesAccent)+'</em></h2></div><p class="section-intro">'+v2T(c.coursesLead)+'</p></div><div class="courses-grid">'+cards+'</div></div></section>';
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
 return '<section class="faq-section section" id="faq"><div class="shell faq-layout"><div class="faq-aside"><p class="eyebrow">'+v2T(c.faqLabel)+'</p><h2>'+v2T(c.faqTitle)+'</h2><p>'+v2T(c.faqLead)+'</p><a class="text-link" href="https://wa.me/93794357509" rel="noopener noreferrer">'+v2T(c.faqMore)+' <span aria-hidden="true">↗</span></a></div><div class="faq-list">'+entries.map(([q,a],i)=>'<details'+(i===0?' open':'')+'><summary>'+v2Short(q,160)+'<span class="faq-plus" aria-hidden="true"></span></summary><p>'+v2T(a,680)+'</p></details>').join("")+'</div></div></section>';
}
function v2Footer(c,locale,content){
 const prefix=v2Prefix(locale);
 const contact=locale==="ps"?content?.pashto?.contact:content?.main?.locales?.[locale]?.contact;
 const published=(value,fallback,max)=>typeof value==="string"&&value.trim()&&value.length<=max?value:fallback;
 const visitTitle=published(contact?.title,c.visitTitle,180);
 const visitAddress=published(contact?.address,c.visitText,350);
 const storedHours=published(contact?.operatingHours||contact?.hours,c.hours,250);
 // Keep later CMS edits visible; normalize only the exact three stale published summaries.
 const outdatedHours={
  en:"Teaching: Saturday–Thursday · Men: 6:20 AM–5:50 PM · Women: 6:30 AM–5:40 PM · Friday: Closed",
  fa:"جلسات درسی: شنبه الی پنج‌شنبه · برادران: ۶:۲۰ صبح تا ۵:۵۰ شام · خواهران: ۶:۳۰ صبح تا ۵:۴۰ شام · جمعه: رخصت",
  ps:"شنبه تر پنجشنبې: سهار ۶:۲۰ تر ماښام ۶:۰۰؛ جمعه رخصتي، ځانګړي پروګرامونه جلا اعلانېږي"
 };
 const visitHours=storedHours===outdatedHours[locale]?c.hours:storedHours;
 const maps="https://www.google.com/maps/search/?api=1&query=The%20TOEFL%20House%20Dasht-e-Barchi%20Kabul";
 return '<footer class="footer" id="contact"><div class="shell"><div class="footer-main"><div class="footer-brand"><span class="eyebrow">'+v2T(c.visitLabel)+'</span><h2>'+v2T(visitTitle)+'</h2><p>'+v2T(visitAddress)+'</p><span class="footer-hours">'+v2T(visitHours)+'</span></div><div class="footer-links"><a href="'+prefix+'#programs">'+v2T(c.footPrograms)+'</a><a href="'+prefix+'guides/">'+v2T(c.navGuides)+'</a><a href="'+prefix+'admissions/">'+v2T(c.footJoin)+'</a><a href="'+prefix+'tools/">'+v2T(c.footTools)+'</a><a href="https://wa.me/93794357509" rel="noopener noreferrer">'+v2T(c.wa)+'</a><a href="tel:+93745651844">'+v2T(c.phone)+'</a><a href="'+maps+'" target="_blank" rel="noopener noreferrer">'+v2T(c.map)+' ↗</a></div></div><div class="footer-bottom"><span>© '+new Date().getUTCFullYear()+' THE TOEFL HOUSE · '+v2T(c.footerRights)+'</span><span>'+v2T(c.footerNote)+'</span></div></div></footer>';
}
function v2Page(locale,content){
 const c=V2_COPY[locale],prefix=v2Prefix(locale),title=locale==="en"?"The TOEFL House | English Classes & TOEFL Preparation in Kabul":locale==="fa"?"تافل هوس | کورس زبان انگلیسی و آمادگی تافل در کابل":"The TOEFL House | په کابل کې انګلیسي او TOEFL زده‌کړه";
 const desc=c.subtitle,canonical=V2_ORIGIN+prefix;
 const language="<link rel=\"alternate\" hreflang=\"en\" href=\""+V2_ORIGIN+"/\"><link rel=\"alternate\" hreflang=\"fa-AF\" href=\""+V2_ORIGIN+"/fa/\"><link rel=\"alternate\" hreflang=\"ps-AF\" href=\""+V2_ORIGIN+"/ps/\"><link rel=\"alternate\" hreflang=\"x-default\" href=\""+V2_ORIGIN+"/\">";
 const ld=JSON.stringify({"@context":"https://schema.org","@type":"EducationalOrganization","name":"The TOEFL House","alternateName":"تافل هوس","url":V2_ORIGIN+"/","description":c.subtitle,"address":{"@type":"PostalAddress","streetAddress":"Opposite Jalili Center, Maghaza Station, Dasht-e-Barchi","addressLocality":"Kabul","addressCountry":"AF"},"telephone":"+93745651844","availableLanguage":["en","fa-AF","ps-AF"]}).replace(/</g,"\\u003c");
 return '<!doctype html><html lang="'+c.lang+'" dir="'+c.dir+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+v2T(title)+'</title><meta name="description" content="'+v2T(desc,400)+'"><meta name="theme-color" content="#f7f6f2"><meta property="og:type" content="website"><meta property="og:title" content="'+v2T(title)+'"><meta property="og:description" content="'+v2T(desc)+'"><meta property="og:url" content="'+canonical+'"><meta property="og:image" content="'+V2_ORIGIN+V2_OG+'"><meta property="og:image:alt" content="'+v2T(c.photoSub,180)+'"><meta property="og:site_name" content="The TOEFL House"><meta name="twitter:card" content="summary_large_image"><link rel="canonical" href="'+canonical+'">'+language+'<link rel="icon" href="/assets/aistudio/favicon_afa00a26.png"><link rel="preload" href="'+V2_IMG_640+'" as="image" imagesrcset="'+V2_IMG_SET+'" imagesizes="'+V2_IMG_SIZES+'" fetchpriority="high"><link rel="stylesheet" href="/__th/v2/site.css?v='+V2_REV+'"><script defer src="/__th/v2/site.js?v='+V2_REV+'"></script><script defer src="/__th/engagement-v1.js"></script><script type="application/ld+json">'+ld+'</script></head><body>'
 +v2Header(c,locale)
 +'<main id="main"><section class="hero"><div class="shell hero-grid"><div class="hero-copy"><span class="eyebrow eyebrow-hero"><span class="eyebrow-rule"></span>'+v2T(c.tag)+'</span><a class="semester-hero-pill" href="#semester-qaws-1405"><span class="semester-mini-dot" aria-hidden="true"></span>'+v2T(V2_SEMESTER[locale].heroTeaser)+' <span aria-hidden="true">↗</span></a><h1>'+v2T(c.lead)+' <span>'+v2T(c.leadAccent)+'</span></h1><p class="hero-lead">'+v2T(c.subtitle)+'</p><div class="hero-actions"><a class="button button-primary button-xl" href="'+prefix+'admissions/">'+v2T(c.heroCta)+' <span aria-hidden="true">↗</span></a><a class="button button-quiet button-xl" href="#programs">'+v2T(c.heroSecondary)+'</a></div><div class="hero-fine"><span aria-hidden="true">✦</span>'+v2T(c.heroBottom)+'</div></div><div class="hero-art"><div class="photo-frame"><img src="'+V2_IMG_640+'" srcset="'+V2_IMG_SET+'" sizes="'+V2_IMG_SIZES+'" width="680" height="820" alt="'+v2T(c.photoSub)+'" fetchpriority="high" decoding="async"><div class="photo-shade"></div><div class="photo-label"><strong>'+v2T(c.photoBadge)+'</strong><small>'+v2T(c.photoSub)+'</small></div></div><div class="photo-side"><span>'+v2T(c.micro)+'</span></div><div class="photo-accent" aria-hidden="true"></div></div></div></section>'
 +v2SemesterCampaign(locale)
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
  const headers=new Headers({"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache, no-store, must-revalidate","X-Content-Type-Options":"nosniff","Referrer-Policy":"strict-origin-when-cross-origin","X-Frame-Options":"DENY","Permissions-Policy":"camera=(), microphone=(), geolocation=()","Content-Language":V2_COPY[locale].lang,"Content-Security-Policy":"default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; font-src 'self'; img-src 'self' data:; media-src 'self' https://d2ol7oe51mr4n9.cloudfront.net; connect-src 'self' https://toefl-house-conversions.alfrotan2.workers.dev https://static.cloudflareinsights.com https://cloudflareinsights.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://wa.me"});
  if(preview)headers.set("X-Robots-Tag","noindex, nofollow, noarchive");
  return new Response(request.method==="HEAD"?null:html,{status:200,headers});
 }catch(error){
  console.error("V2 CMS page render unavailable; retaining original",String(error));
  return null;
 }
}
