// Required field names for the existing localized content contract, including
// retained editorial fields that may not currently be rendered. This is a
// checked-in review boundary, not generated on each build: updating content
// and renderer ownership must update these requirements and tests together.
// It enforces field presence and basic type, not facts, translation quality,
// all nested shapes or the public CMS API schema. Additional compatible fields
// are permitted.
export const REQUIRED_CONTENT_KEYS=Object.freeze({
 homeCopy:`lang dir name localName tag navPrograms navGuides navWhy navOnline navFaq navContact navMenu navApply badge lead leadAccent subtitle heroCta heroSecondary heroBottom photoBadge photoSub micro trustTitle trustSub courseEyebrow coursesTitle coursesAccent coursesLead courseDetail courseDuration scheduleEyebrow scheduleTitle scheduleLead scheduleShift scheduleMen scheduleWomen schedulePopular scheduleFull scheduleNote onlineLabel onlineTitle onlineText onlineCta whyLabel whyTitle whyLead steps toolsLabel toolsTitle toolsText toolsCta faqLabel faqTitle faqLead faqMore visitLabel visitTitle visitText hours phone wa map finalEyebrow finalTitle finalText finalCta footerRights footPrograms footTools notFoundTitle notFoundText notFoundHome statsFallback fallbackFaq seoTitle`.split(' '),
 homeSemester:`heroTeaser eyebrow title accent lead chips cta secondary videoLabel play playText videoCaption videoFallback eapLabel eapTeaser eapDetail eapLink`.split(' '),
 homeGoals:`title hint label items`.split(' '),
 homeHabits:`label title intro habits resourceTitle resourceIntro links open all`.split(' '),
 general:`eyebrow title intro facts levelsTitle levelsIntro foundation semester pacing tuition monthlyRate semesterRate twoTitle twoText oxfordLabel oxfordTitle oxfordIntro oxfordFeatures oxfordLevelsLabel oxfordLevels oxfordNote speakingLabel speakingTitle speakingText feeLabel feeTitle feeIntro colLevel colDuration colFee totalTitle totalDuration totalFee totalNote faqTitle faqs sourcesTitle sourcesNote cta ctaSub heroTitle heroIntro heroDuration heroSkills overviewTitle overview audience seoTitle seoDescription heroTagline roadmapLink roadmapNote ctaTitle skillTitle skillIntro skills stageData`.split(' '),
 academic:`badge title accent intro heroNote facts whoTitle whoText outcomesLabel outcomesTitle outcomesIntro outcomes pathLabel pathTitle pathIntro levels booksLabel booksTitle booksIntro books staffLabel staffTitle staffText feeLabel feeTitle feeMonth feeTerm feeNote faqLabel faqTitle faq ctaLabel ctaTitle ctaText cta secondary other levelBookLabel fourthNote writingTitles seoTitle seoDescription feeMonthDisplay feeLevelDisplay levelDuration`.split(' '),
 specialUi:`breadcrumb overview outcomes curriculum resources method questions duration price assessment cta details other admissions last exam source feeNote`.split(' '),
 specialCourse:`title accent intro lead facts whoTitle whoText outcomesTitle outcomesIntro outcomes pathTitle pathIntro path resourcesTitle resourcesIntro resources methodTitle methodIntro method faqTitle faq feeTitle feeMain feeSub ctaTitle ctaText meta description durationDisplay`.split(' '),
 guideUi:`section back open start ctaTitle ctaText indexTitle indexDescription`.split(' '),
 bookUi:`heading read source course other`.split(' '),
 feedback:`notes label example hints`.split(' '),
 guideNav:`contents related relatedIntro all course ets`.split(' '),
 detail:`back course duration who learn curriculum levels schedule notice start whatsapp related all proof steps admissionEyebrow admissionTitle admissionIntro formTitle program programPlaceholder format campus online when morning afternoon flexible submit formNote noEmail free legacy need needCopy call faqs`.split(' '),
 practice:`title intro question choice check reveal correct incorrect progress score reset explanations`.split(' '),
 academicLevel:`title subtitle desc skills textbooks`.split(' '),
 academicBook:`title publisher role intro points guide`.split(' '),
 specialPath:`title desc items`.split(' '),
 specialResource:`title by desc points`.split(' '),
 guideArticle:`title description intro program sections`.split(' '),
 guideBook:`title description intro program sections publisher source`.split(' '),
});

// All required fields are text unless explicitly listed here. This prevents all
// locales from drifting together to a wrong JSON type while still agreeing with
// one another. Deeper array/object validation remains in content-compiler.mjs.
export const NON_TEXT_CONTENT_FIELDS=Object.freeze({
 homeCopy:{steps:'array',statsFallback:'array',fallbackFaq:'array'},
 homeSemester:{chips:'array'},homeGoals:{items:'array'},homeHabits:{habits:'array',links:'array'},
 general:{facts:'array',oxfordFeatures:'array',faqs:'array',heroSkills:'array',skills:'array',stageData:'object'},
 academic:{facts:'array',outcomes:'array',levels:'array',books:'array',faq:'array',writingTitles:'array'},
 specialCourse:{facts:'array',outcomes:'array',path:'array',resources:'array',method:'array',faq:'array'},
 feedback:{hints:'object'},detail:{steps:'array',faqs:'array'},practice:{explanations:'array'},
 academicLevel:{skills:'array',textbooks:'array'},academicBook:{points:'array'},
 specialPath:{items:'array'},specialResource:{points:'array'},
 guideArticle:{sections:'array'},guideBook:{sections:'array'}
});
