/* TOEFL House V2 — CMS-driven, accessible, server-rendered public homepage.
 * No enrollment, account, or finance data is fetched. CMS reads are read-only.
 * The original interactive portal remains reachable at /tools/ per language.
 */
// This is the only public/canonical website host; legacy origin stays internal to the edge worker.
const V2_ORIGIN="https://toeflhouse.pages.dev";
const V2_IMG="/assets/aistudio/FB_IMG_1793645643808_dad823ce.jpg";
const V2_CAMPUS_ALT={en:"Exterior of The TOEFL House campus in Dasht-e-Barchi, Kabul",fa:"نمای ساختمان تافل هوس در دشت برچی، کابل",ps:"د کابل په دشت برچي کې د تافل هوس د ودانۍ بڼه"};
const V2_OG_LOCALE={en:"en_US",fa:"fa_AF",ps:"ps_AF"};

// Only one campus image exists; do not advertise fictitious resized variants.
const V2_IMG_640=V2_IMG;
const V2_LOGO_REV="753895f6e945";
const V2_LOGO="/__th/v2/brand.webp?v="+V2_LOGO_REV;
const V2_LOGO_DATA="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";
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
  courseDetail:"View program",courseDuration:"Duration",scheduleEyebrow:"CLASS SCHEDULE",scheduleTitle:"Seven shifts a day, six days a week.",scheduleLead:"Seventy-minute sessions, Saturday–Thursday. Friday is closed.",scheduleShift:"Shift",scheduleMen:"Men",scheduleWomen:"Women",schedulePopular:"Popular",scheduleFull:"Full",scheduleNote:"Women's morning shifts start 10 minutes later and afternoon shifts 10 minutes earlier than men's.",onlineLabel:"Private online learning",onlineTitle:"Personalized English lessons, wherever you are.",onlineText:"Live, one-to-one Google Meet lessons can be arranged for learners in Kabul or abroad, including Europe and Canada. The curriculum, teacher availability, time zone and fees are confirmed before registration.",onlineCta:"Ask about online classes",
  whyLabel:"A CLEAR WAY FORWARD",whyTitle:"A clear route to your next class.",whyLead:"Choose your goal, assess your current level and confirm the class that suits you.",
  steps:[["01","Tell us your goal","Share what you want to improve—speaking, academic English, TOEFL or everyday communication."],["02","Find your level, free","Our team helps you select a suitable starting level through a free assessment."],["03","Join the right class","Confirm available shifts, teaching format and tuition with our admissions team."]],
  toolsLabel:"ADMISSIONS SUPPORT",toolsTitle:"Need help choosing your next step?",toolsText:"Our admissions team can help you choose a suitable English program and arrange your free placement assessment.",toolsCta:"Request guidance",
  faqLabel:"GOOD TO KNOW",faqTitle:"Questions before you enroll?",faqLead:"Essential information about placement, tuition and available classes.",faqMore:"More questions? Message our team",
  visitLabel:"VISIT US",visitTitle:"Visit The TOEFL House in Kabul.",visitText:"Opposite Jalili Center, Maghaza Station, Dasht-e-Barchi, Kabul, Afghanistan.",hours:"Classes Saturday–Thursday · Friday closed · Confirm class times with admissions",phone:"Call admissions",wa:"WhatsApp admissions",map:"Find our campus",
  finalEyebrow:"YOUR NEXT CHAPTER",finalTitle:"Your next step begins with the right level.",finalText:"Request a free placement assessment and ask our admissions team about current programs, fees and class times.",finalCta:"Request your free assessment",
  footerRights:"All rights reserved.",footPrograms:"Programs",footTools:"Student tools",notFoundTitle:"Page not found",notFoundText:"The page you were looking for may have moved, or the address may be incorrect. You can return to the homepage or explore our programs.",notFoundHome:"Back to the homepage",
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
  courseDetail:"معرفی کامل برنامه",courseDuration:"مدت دوره",scheduleEyebrow:"تقسیم اوقات صنف‌ها",scheduleTitle:"هفت شیفت در روز، شش روز در هفته.",scheduleLead:"هر جلسه ۷۰ دقیقه، شنبه تا پنج‌شنبه. جمعه رخصت است.",scheduleShift:"شیفت",scheduleMen:"برادران",scheduleWomen:"خواهران",schedulePopular:"پرتقاضا",scheduleFull:"تکمیل ظرفیت",scheduleNote:"شیفت‌های صبح خواهران ۱۰ دقیقه دیرتر و شیفت‌های عصر ۱۰ دقیقه زودتر شروع می‌شوند.",onlineLabel:"صنف‌های آنلاین انفرادی",onlineTitle:"آموزش خصوصی انگلیسی، مطابق هدف و وقت شما.",onlineText:"صنف‌های زنده و انفرادی از طریق Google Meet برای علاقه‌مندان داخل و خارج از کابل، به‌شمول اروپا و کانادا، با هماهنگی قبلی برگزار می‌شوند. محتوای آموزشی، وقت صنف، دسترسی استاد و فیس پیش از ثبت‌نام تأیید می‌گردد.",onlineCta:"معلومات دربارهٔ صنف‌های آنلاین",
  whyLabel:"مسیر روشن ثبت‌نام",whyTitle:"با یک انتخاب آگاهانه آغاز کنید.",whyLead:"از تعیین هدف تا انتخاب صنف مناسب، سه گام مشخص پیش روی شماست.",
  steps:[["۰۱","هدف‌تان را بگویید","مکالمه، انگلیسی اکادمیک، تافل یا انگلیسی روزمره؛ بگویید کدام مهارت را می‌خواهید بهتر سازید."],["۰۲","سطح زبان خود را رایگان تعیین کنید","با رهنمایی تیم آموزشی، صنف و سطح مناسب خود را پیدا کنید."],["۰۳","در صنف مناسب شامل شوید","تقسیم اوقات، شیوهٔ تدریس و فیس را با پذیرش تأیید کنید."]],
  toolsLabel:"رهنمایی پذیرش",toolsTitle:"برای انتخاب گام بعدی راهنمایی بگیرید.",toolsText:"بخش پذیرش در انتخاب برنامهٔ مناسب انگلیسی و هماهنگی ارزیابی رایگان سطح شما کمک می‌کند.",toolsCta:"درخواست راهنمایی",
  faqLabel:"معلومات ضروری",faqTitle:"پرسش‌های مهم پیش از ثبت‌نام",faqLead:"معلومات روشن دربارهٔ تعیین سطح، فیس و شیوهٔ اشتراک در صنف‌ها.",faqMore:"پرسش دیگری دارید؟ در واتساپ پیام بدهید",
  visitLabel:"نشانی مرکز",visitTitle:"تافل هوس در کابل",visitText:"کابل، دشت برچی، ایستگاه مغازه، روبروی مرکز جلیلی، افغانستان.",hours:"صنف‌ها از شنبه تا پنج‌شنبه · جمعه رخصت · وقت دقیق صنف را از پذیرش بپرسید",phone:"تماس با پذیرش",wa:"واتساپ پذیرش",map:"مسیریابی تا مرکز",
  finalEyebrow:"گام بعدی شما",finalTitle:"برای پیشرفت، از سطح مناسب آغاز کنید.",finalText:"تعیین سطح رایگان انجام دهید و دربارهٔ صنف‌های موجود، فیس و تقسیم اوقات از پذیرش معلومات بگیرید.",finalCta:"درخواست تعیین سطح رایگان",
  footerRights:"تمام حقوق محفوظ است.",footPrograms:"برنامه‌ها",footTools:"ابزارهای درسی",notFoundTitle:"صفحه پیدا نشد",notFoundText:"ممکن است این صفحه منتقل شده باشد یا نشانی آن را اشتباه وارد کرده باشید. می‌توانید به صفحهٔ اصلی برگردید یا برنامه‌های آموزشی را ببینید.",notFoundHome:"بازگشت به صفحهٔ اصلی",
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
  courseDetail:"د پروګرام بشپړ معلومات",courseDuration:"د کورس موده",scheduleEyebrow:"ورځنی مهالوېش",scheduleTitle:"خپل مناسب وخت وټاکئ",scheduleLead:"هره درسي غونډه ۷۰ دقیقې ده او درسي ورځې له شنبې تر پنجشنبې دي. جمعه د مرکز اوونیزه رخصتي ده.",scheduleShift:"شفټ",scheduleMen:"وروڼه",scheduleWomen:"خویندې",schedulePopular:"ډېر غوښتل شوی",scheduleFull:"ډک شوی",scheduleNote:"د خویندو د سهار شفټونه ۱۰ دقیقې وروسته او د ماسپښین شفټونه ۱۰ دقیقې مخکې پیلېږي.",onlineLabel:"انفرادي آنلاین زده‌کړه",onlineTitle:"انفرادي آنلاین زده‌کړه؛ ستاسو د موخې او وخت له مخې.",onlineText:"د Google Meet له لارې ژوندۍ انفرادي ټولګي په کابل او بهر کې، د اروپا او کاناډا په ګډون، د مخکینۍ همغږۍ له مخې برابرېږي. درسي مواد، د ښوونکي شتون، وخت او فیس تر نوم‌لیکنې مخکې تاییدېږي.",onlineCta:"د آنلاین ټولګیو معلومات",
  whyLabel:"روښانه پیل",whyTitle:"په روښانه پلان زده‌کړه پیل کړئ.",whyLead:"خپله موخه وټاکئ، سویه مو معلومه کړئ او مناسب ټولګی تایید کړئ.",
  steps:[["۰۱","خپل هدف ووایئ","خبرې کول، اکاډمیکه انګلیسي، TOEFL یا ورځنۍ انګلیسي؛ خپل هدف راسره شریک کړئ."],["۰۲","خپله سویه وړیا معلومه کړئ","زموږ ښوونیز ټیم له تاسو سره د مناسبې سویې په ټاکلو کې مرسته کوي."],["۰۳","مناسب ټولګي ته لاړ شئ","مهالوېش، د زده‌کړې بڼه او فیس له ادارې سره تایید کړئ."]],
  toolsLabel:"د نوم‌لیکنې لارښوونه",toolsTitle:"د خپل راتلونکي ګام په ټاکلو کې مرسته وغواړئ.",toolsText:"زموږ د نوم‌لیکنې ډله د مناسب انګلیسي پروګرام په ټاکلو او د سویې د وړیا ارزونې په تنظیم کې مرسته کوي.",toolsCta:"لارښوونه وغواړئ",
  faqLabel:"اړین معلومات",faqTitle:"له نوم‌لیکنې مخکې مهمې پوښتنې",faqLead:"د سویې ارزونې، فیس او د ټولګیو د ګډون په اړه روښانه ځوابونه.",faqMore:"نورې پوښتنې لرئ؟ موږ ته په واټساپ پیغام واستوئ",
  visitLabel:"زموږ پته",visitTitle:"په کابل کې تافل هوس ته راشئ.",visitText:"کابل، دشت برچي، مغازه تمځای، د جلیلي مرکز مخامخ، افغانستان.",hours:"ټولګي له شنبې تر پنجشنبې · جمعه رخصتي · د ټولګي دقیق وخت له ادارې وپوښتئ",phone:"له ادارې سره اړیکه",wa:"د واټساپ اړیکه",map:"زموږ ځای ومومئ",
  finalEyebrow:"ستاسو راتلونکی ګام",finalTitle:"خپل پرمختګ له مناسبې کچې پیل کړئ.",finalText:"د سویې وړیا ارزونه وغواړئ او د شته ټولګیو، فیس او مهالوېش په اړه له ادارې معلومات واخلئ.",finalCta:"د وړیا سویې معلومولو غوښتنه",
  footerRights:"ټول حقونه خوندي دي.",footPrograms:"پروګرامونه",footTools:"د زده‌کړې وسایل",notFoundTitle:"پاڼه ونه موندل شوه",notFoundText:"کېدای شي دا پاڼه لېږدول شوې وي، یا یې پته غلطه لیکل شوې وي. تاسې کولای شئ کورپاڼې ته بېرته لاړ شئ یا پروګرامونه وګورئ.",notFoundHome:"کورپاڼې ته لاړ شئ",
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
 return '<section class="semester-section" id="semester-qaws-1405" aria-labelledby="semester-heading"><div class="shell"><div class="semester-card"><div class="semester-copy"><p class="semester-eyebrow"><span class="semester-dot" aria-hidden="true"></span>'+v2T(c.eyebrow)+'</p><h2 id="semester-heading" class="semester-title">'+v2T(c.title)+' <span>'+v2T(c.accent)+'</span></h2><p class="semester-lead">'+v2T(c.lead)+'</p><ul class="semester-chips">'+c.chips.map(x=>'<li>'+v2T(x)+'</li>').join("")+'</ul><div class="semester-actions"><a class="button semester-primary" href="'+signup+'">'+v2T(c.cta)+' <span aria-hidden="true">↗</span></a><a class="button semester-secondary" href="#programs">'+v2T(c.secondary)+'</a></div></div><div class="semester-media"><div class="semester-video-frame"><video class="semester-video" controls playsinline preload="none" poster="'+V2_IMG_640+'" width="720" height="1280" aria-label="'+v2T(c.videoLabel)+'"><source src="'+V2_SEMESTER_VIDEO+'" type="video/mp4">'+v2T(c.videoFallback)+'</video><button class="semester-video-cover" type="button" hidden aria-label="'+v2T(c.playText)+' — '+v2T(c.play)+'"><img src="'+V2_IMG_640+'" width="640" height="820" loading="lazy" decoding="async" alt=""><span class="semester-cover-shade" aria-hidden="true"></span><span class="semester-play-circle" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M8 5.6c0-.8.9-1.3 1.6-.9L20 11.2c.6.4.6 1.2 0 1.6L9.6 19.3C8.9 19.7 8 19.2 8 18.4V5.6z"/></svg></span><span class="semester-play-caption" aria-hidden="true">'+v2T(c.playText)+'</span></button><span class="semester-filmmark" aria-hidden="true">THE TOEFL HOUSE · 00:36</span></div><p class="semester-video-caption">'+v2T(c.videoCaption)+'</p></div></div><a class="semester-eap-spotlight" href="'+p+'courses/academic-english/"><span class="semester-eap-mark">EAP</span><span class="semester-eap-copy"><small>'+v2T(c.eapLabel)+'</small><strong>'+v2T(c.eapTeaser)+'</strong><span>'+v2T(c.eapDetail)+'</span></span><span class="semester-eap-link">'+v2T(c.eapLink)+' <span aria-hidden="true">↗</span></span></a></div></section>';
}
// Keep the legacy online program ID and URL stable; normalize only its public editorial fields.
function v2OnlineProgramCopy(locale){
 const editorial=value=>Array.isArray(value)?value.map(editorial):typeof value==="string"?value.replace(/https?:\/\/[^\s<>]+|(?<![\w\-./])Zoom(?![\w\-/]|\.(?:us|com)\b)|زوم/gi,match=>/^https?:\/\//i.test(match)?match:"Google Meet"):value;
 const program=locale?.programs?.find(p=>p.id==="online-individual-zoom");
 if(program)for(const key of ["title","summary","details","duration","highlights","levels","schedule","recommendedFor","recommended"])if(Object.hasOwn(program,key))program[key]=editorial(program[key]);
 const faq=Array.isArray(locale?.faq)?locale.faq:locale?.faq?.items;
 if(Array.isArray(faq))for(const item of faq)if(/آنلاین|online|آنلاين|Zoom|زوم/i.test(item.q||item.question||""))for(const key of ["q","question","a","answer"])if(Object.hasOwn(item,key))item[key]=editorial(item[key]);
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
async function v2FallbackCms(){
 const ids=V2_COURSE_IDS;
 const duration={en:["Pre-Starter: 1 month; other levels: 2 months","2 months per level","4 months","2 months","2 months","2 months"],fa:["Pre-Starter: یک ماه؛ سایر سطح‌ها: دو ماه","دو ماه برای هر سطح","چهار ماه","دو ماه","دو ماه","دو ماه"],ps:["Pre-Starter: یوه میاشت؛ نورې کچې: دوه میاشتې","د هرې کچې لپاره دوه میاشتې","څلور میاشتې","دوه میاشتې","دوه میاشتې","دوه میاشتې"]};
 const programs=locale=>ids.map((id,i)=>({id,title:V2_COPY[locale].courseNames[i]||id,summary:V2_COPY[locale].subtitle,duration:duration[locale][i]||""}));
 return {main:{locales:{en:{programs:programs("en")},fa:{programs:programs("fa")}},media:{},timetable:{}},pashto:{programs:programs("ps")},revision:0,psRevision:0,cmsStatus:"fallback"};
}
async function v2Cms(env){
 if(!env?.CMS_DB)return v2FallbackCms();
 try{
  const [main,ps]=await Promise.all([
   env.CMS_DB.prepare("SELECT body,revision FROM content WHERE id='main'").first(),
   env.CMS_DB.prepare("SELECT body,revision FROM pashto_content WHERE id='main'").first()
  ]);
  if(!main?.body||!ps?.body)throw Error("Published CMS not available");
  const parsed=JSON.parse(main.body),pashto=JSON.parse(ps.body);
  if(!parsed?.locales?.en?.programs||!parsed?.locales?.fa?.programs||!pashto?.programs)throw Error("Unexpected CMS schema");
  for(const locale of [parsed.locales.en,parsed.locales.fa,pashto])v2OnlineProgramCopy(locale);
  return {main:parsed,pashto,revision:main.revision,psRevision:ps.revision};
 }catch(error){
  console.error("Published CMS read failed; serving reviewed static fallback",String(error));
  return v2FallbackCms();
 }
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
  +'<a class="mobile-quick-apply" href="'+applyHref+'" aria-label="'+v2T(compactLabel)+' — '+v2T(c.heroCta)+'">'+v2T(compactLabel)+'</a>'
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
  return '<article id="course-'+id+'" class="course-card '+(id==="toefl-preparation"?"course-featured":"")+'"><div class="course-top"><span class="course-number">'+String(i+1).padStart(2,"0")+'</span><span class="course-mark" aria-hidden="true">↗</span></div><h3>'+v2T(c.courseNames[i]||program.title||id)+'</h3>'+(id==="academic-english"?'<bdi class="course-full-name" lang="en" dir="ltr">EAP (English for Academic Purposes)</bdi>':"")+'<p class="course-copy">'+v2Short(desc,160)+'</p><div class="course-bottom"><span><small>'+v2T(c.courseDuration)+'</small><strong>'+v2Short(duration||"",85)+'</strong></span><a aria-label="'+v2T(c.courseDetail+' — '+(program.title||c.courseNames[i]))+'" href="'+prefix+'courses/'+id+'/">'+v2T(c.courseDetail)+' <span aria-hidden="true">↗</span></a></div></article>';
 }).join("");
 return '<section class="programs-section section" id="programs"><div class="shell"><div class="section-head"><div><p class="eyebrow">'+v2T(c.courseEyebrow)+'</p><h2>'+v2T(c.coursesTitle)+' <em>'+v2T(c.coursesAccent)+'</em></h2></div><p class="section-intro">'+v2T(c.coursesLead)+'</p></div>'+goalNav+'<div class="courses-grid">'+cards+'</div></div></section>';
}
function v2ShiftParts(shift,locale){
 const raw=locale==="fa"?(shift.timeFa||shift.timeEn||""):(shift.timeEn||"");
 const parts=String(raw).split("·").map(x=>x.trim());
 if(parts.length<2)return null;
 const men=parts[0].replace(/^(Men|برادران:)\s*/,"");
 const women=parts[1].replace(/^(Women|خواهران:)\s*/,"");
 return men&&women?{men,women}:null;
}
function v2PsDigits(s){return String(s).replace(/[0-9]/g,d=>"۰۱۲۳۴۵۶۷۸۹"[d]);}
function v2PsTime(part){
 const m=/^(\d{1,2}):(\d{2})\s*–\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/.exec(String(part).trim());
 if(!m)return v2PsDigits(part);
 const h24=parseInt(m[1],10)%12+(m[5]==="PM"?12:0);
 const word=h24<12?"سهار":h24<16?"ماسپښین":"ماښام";
 return v2PsDigits(m[1]+":"+m[2]+" – "+m[3]+":"+m[4])+" "+word;
}
function v2Schedule(c,content,locale){
 const shifts=content?.main?.timetable;
 if(!Array.isArray(shifts)||!shifts.length)return "";
 const rows=shifts.map((shift,i)=>{
  const num=locale==="en"?String(i+1):v2PsDigits(i+1);
  const badge=shift.open===false?'<span class="schedule-full">'+v2T(c.scheduleFull)+'</span>':shift.popular?'<span class="schedule-popular">'+v2T(c.schedulePopular)+'</span>':"";
  const parts=v2ShiftParts(shift,locale);
  const closed=shift.open===false?' is-closed':"";
  if(!parts){
   const raw=locale==="fa"?(shift.timeFa||shift.timeEn||""):(shift.timeEn||"");
   return '<tr class="schedule-row'+closed+'"><th scope="row">'+v2T(c.scheduleShift+" "+num)+badge+'</th><td colspan="2"><strong>'+v2T(raw)+'</strong></td></tr>';
  }
  const men=locale==="ps"?v2PsTime(parts.men):parts.men;
  const women=locale==="ps"?v2PsTime(parts.women):parts.women;
  return '<tr class="schedule-row'+closed+'"><th scope="row">'+v2T(c.scheduleShift+" "+num)+badge+'</th><td><strong>'+v2T(men)+'</strong></td><td><strong>'+v2T(women)+'</strong></td></tr>';
 }).join("");
 return '<section class="schedule-section section" id="schedule"><div class="shell"><div class="section-head"><div><p class="eyebrow">'+v2T(c.scheduleEyebrow)+'</p><h2 id="schedule-title">'+v2T(c.scheduleTitle)+'</h2></div><p class="section-intro">'+v2T(c.scheduleLead)+'</p></div><div class="schedule-table-wrap" tabindex="0" role="region" aria-labelledby="schedule-title"><table class="schedule-table"><thead><tr><th scope="col">'+v2T(c.scheduleShift)+'</th><th scope="col">'+v2T(c.scheduleMen)+'</th><th scope="col">'+v2T(c.scheduleWomen)+'</th></tr></thead><tbody>'+rows+'</tbody></table></div><p class="schedule-note">'+v2T(c.scheduleNote)+'</p></div></section>';
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
 return '<!doctype html><html lang="'+c.lang+'" dir="'+c.dir+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+v2T(title)+'</title><meta name="description" content="'+v2T(desc,400)+'"><meta name="theme-color" content="#faf9f8"><meta property="og:type" content="website"><meta property="og:locale" content="'+V2_OG_LOCALE[locale]+'"><meta property="og:title" content="'+v2T(title)+'"><meta property="og:description" content="'+v2T(desc)+'"><meta property="og:url" content="'+canonical+'"><meta property="og:image" content="'+V2_ORIGIN+V2_OG+'"><meta property="og:image:alt" content="'+v2T(c.photoSub,180)+'"><meta property="og:site_name" content="The TOEFL House"><meta name="twitter:card" content="summary_large_image"><link rel="canonical" href="'+canonical+'">'+language+(locale==="fa"?'<link rel="preload" href="/__th/v2/font/vazirmatn-33.003.woff2" as="font" type="font/woff2" crossorigin>':'')+'<link rel="icon" href="' + V2_LOGO + '"><link rel="preload"'+(locale==="fa"?'':' media="(min-width: 761px)"')+' href="'+V2_IMG_640+'" as="image" fetchpriority="high"><link rel="stylesheet" href="/__th/v2/site.css?v='+V2_REV+'"><script defer src="/__th/v2/site.js?v='+V2_REV+'"></script><script defer src="/__th/engagement-v1.js"></script><script type="application/ld+json">'+ld+'</script></head><body>'
 +v2Header(c,locale)
 +'<main id="main"><section class="hero"><div class="shell hero-grid"><div class="hero-copy"><span class="eyebrow eyebrow-hero"><span class="eyebrow-rule"></span>'+v2T(c.tag)+'</span><a class="semester-hero-pill" href="#semester-qaws-1405"><span class="semester-mini-dot" aria-hidden="true"></span>'+v2T(V2_SEMESTER[locale].heroTeaser)+' <span aria-hidden="true">↗</span></a><h1>'+v2T(c.lead)+' <span>'+v2T(c.leadAccent)+'</span></h1><p class="hero-lead">'+v2T(c.subtitle)+'</p><div class="hero-actions"><a class="button button-primary button-xl" href="'+prefix+'admissions/">'+v2T(c.heroCta)+' <span aria-hidden="true">↗</span></a><a class="button button-quiet button-xl" href="#programs">'+v2T(c.heroSecondary)+'</a></div><div class="hero-fine"><span aria-hidden="true">✦</span>'+v2T(c.heroBottom)+'</div></div><div class="hero-art"><div class="photo-frame"><img src="'+V2_IMG_640+'" width="680" height="820" alt="'+v2T(V2_CAMPUS_ALT[locale])+'" '+(locale==="fa"?'loading="eager" fetchpriority="high"':'loading="lazy"')+' decoding="async"><div class="photo-shade"></div><div class="photo-label"><strong>'+v2T(c.photoBadge)+'</strong><small>'+v2T(c.photoSub)+'</small></div></div><div class="photo-side"><span>'+v2T(c.micro)+'</span></div></div></div></section>'
 +v2SemesterCampaign(locale)
 +v2Stats(c,content,locale)
 +v2Programs(c,content,locale)
 +v2Schedule(c,content,locale)
 +'<section class="online-section section" id="online"><div class="shell"><div class="online-panel"><div class="online-symbol" aria-hidden="true"><span>1:1</span><svg viewBox="0 0 70 70" fill="none" aria-hidden="true"><circle cx="35" cy="35" r="31" stroke="currentColor" stroke-width="1.5"/><path d="M15 35h40M35 15v40" stroke="currentColor" stroke-width="1.5"/></svg></div><div class="online-copy"><p class="eyebrow">'+v2T(c.onlineLabel)+'</p><h2>'+v2T(c.onlineTitle)+'</h2><p>'+v2T(c.onlineText)+'</p></div><a class="button button-light" href="'+prefix+'admissions/?program=online-individual-zoom&amp;format=online">'+v2T(c.onlineCta)+' <span aria-hidden="true">↗</span></a></div></div></section>'
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
// Branded 404 page. No CMS dependency, so it renders even when the CMS is down.
// Locale comes from the URL prefix (/fa/, /ps/); anything else is English.
// No canonical or hreflang: a missing page must not present itself as a real URL.
function v2NotFound(request){
 const url=new URL(request.url);
 const locale=url.pathname==="/fa"||url.pathname.startsWith("/fa/")?"fa":url.pathname==="/ps"||url.pathname.startsWith("/ps/")?"ps":"en";
 const c=V2_COPY[locale],prefix=v2Prefix(locale);
 const title=c.notFoundTitle+" | The TOEFL House";
 const html='<!doctype html><html lang="'+c.lang+'" dir="'+c.dir+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+v2T(title,200)+'</title><meta name="description" content="'+v2T(c.notFoundText,400)+'"><meta name="robots" content="noindex, nofollow"><meta name="theme-color" content="#faf9f8"><link rel="icon" href="'+V2_LOGO+'"><link rel="stylesheet" href="/__th/v2/site.css?v='+V2_REV+'"><script defer src="/__th/v2/site.js?v='+V2_REV+'"></script><script defer src="/__th/engagement-v1.js"></script></head><body>'
 +v2Header(c,locale,"404/")
 +'<main id="main"><section class="notfound-section"><div class="shell"><div class="notfound-inner"><span class="notfound-code" dir="ltr" aria-hidden="true">404</span><h1>'+v2T(c.notFoundTitle)+'</h1><p>'+v2T(c.notFoundText)+'</p><div class="notfound-actions"><a class="button button-primary button-xl" href="'+prefix+'">'+v2T(c.notFoundHome)+'</a><a class="button button-quiet button-xl" href="'+prefix+'#programs">'+v2T(c.navPrograms)+'</a></div></div></div></section></main>'
 +v2Footer(c,locale,undefined)+'</body></html>';
 const headers=new Headers({"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache, no-store, must-revalidate","X-Content-Type-Options":"nosniff","Referrer-Policy":"strict-origin-when-cross-origin","X-Frame-Options":"DENY","Permissions-Policy":"camera=(), microphone=(), geolocation=()","Content-Language":c.lang,"X-Robots-Tag":"noindex, nofollow, noarchive","Content-Security-Policy":"default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://toefl-house-conversions.alfrotan2.workers.dev https://static.cloudflareinsights.com https://cloudflareinsights.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://wa.me"});
 return new Response(request.method==="HEAD"?null:v2DariEditorial(html,locale),{status:404,headers});
}
