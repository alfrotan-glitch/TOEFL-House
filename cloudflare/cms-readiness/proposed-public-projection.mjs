// Offline proposal only. Not imported by the Worker, archive, or CI release path.
// These field names are renderer-derived, not an owner-approved public contract.
// Never use this module to classify a source record as public.
import {auditPublicShape} from './public-schema-preflight.mjs';

const fields={
 program:['id','title','subtitle','summary','details','duration','highlights','levels','schedule','recommendedFor','recommended'],
 faq:['q','question','a','answer'],
 stats:['graduates','graduatesLabel','toeflTakers','toeflLabel','universityAdmissions','universityLabel'],
 statistic:['value','label'],
 contact:['title','address','operatingHours','hours'],
 shift:['id','timeEn','timeFa','open','popular']
};
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const pick=(object,names)=>Object.fromEntries(names.filter(key=>own(object,key)).map(key=>[key,Array.isArray(object[key])?[...object[key]]:object[key]]));

/** Returns either a new provisional envelope or a fixed error and counts.
 * Unknown fields and media fail closed rather than being silently discarded:
 * consumers may depend on them, and their classification is not known.
 * Do not log or export the returned payload from sensitive records.
 */
export function proposePublicProjection(input){
 const report=auditPublicShape(input);
 if(report.unknownFields||report.invalidShapes||report.unreviewedMedia){
  return {ok:false,reason:'schema-review-required',report};
 }
 const locales={};
 for(const language of ['en','fa','ps']){
  const source=input.locales[language];
  const locale={programs:source.programs.map(program=>pick(program,fields.program))};
  if(source.faq!=null){
   const items=Array.isArray(source.faq)?source.faq:source.faq.items;
   const projected=items.map(item=>pick(item,fields.faq));
   locale.faq=Array.isArray(source.faq)?projected:{items:projected};
  }
  else if(own(source,'faq'))locale.faq=null;
  if(own(source,'stats'))locale.stats=source.stats==null?null:pick(source.stats,fields.stats);
  if(own(source,'statistics'))locale.statistics=source.statistics==null?null:source.statistics.map(item=>pick(item,fields.statistic));
  if(own(source,'contact'))locale.contact=source.contact==null?null:pick(source.contact,fields.contact);
  locales[language]=locale;
 }
 const payload={locales};
 if(own(input,'media'))payload.media=input.media==null?null:{};
 if(own(input,'timetable'))payload.timetable=input.timetable==null?null:Array.isArray(input.timetable)?input.timetable.map(shift=>pick(shift,fields.shift)):{};
 Object.assign(payload,pick(input,['revision','updatedAt','cmsStatus','psRevision']));
 return {ok:true,payload};
}
