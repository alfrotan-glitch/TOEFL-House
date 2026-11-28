import test from 'node:test';
import assert from 'node:assert/strict';
import {proposePublicProjection} from '../../cms-readiness/proposed-public-projection.mjs';

const locale=()=>({programs:[{id:'general-english',title:'Public title',summary:'Description',highlights:['One','Two']}],faq:{items:[{q:'Question',a:'Answer'}]},stats:{graduates:123},statistics:[{value:'1',label:'Example'}],contact:{address:'Public address',hours:null}});
const example=()=>({locales:{en:locale(),fa:locale(),ps:locale()},media:{},timetable:[{id:'one',timeEn:'Morning',timeFa:'صبح',open:true,popular:false}],revision:1,psRevision:2,updatedAt:'2026-01-01',cmsStatus:'connected'});

test('proposal preserves recognized synthetic fields and both FAQ shapes without sharing references',()=>{
 const source=example();source.locales.fa.faq=[{question:'Question',answer:'Answer'}];source.locales.ps.stats=null;
 const result=proposePublicProjection(source);
 assert.equal(result.ok,true);assert.deepEqual(result.payload,source);assert.notEqual(result.payload,source);
 result.payload.locales.en.programs[0].highlights[0]='Changed';
 result.payload.locales.en.faq.items[0].q='Changed';
 result.payload.timetable[0].open=false;
 assert.equal(source.locales.en.programs[0].highlights[0],'One');assert.equal(source.locales.en.faq.items[0].q,'Question');assert.equal(source.timetable[0].open,true);
});

test('unknown data, unreviewed media and invalid shapes fail closed without echoing source',()=>{
 const changes=[
  x=>{x.extra='sensitive';},
  x=>{x.locales.en.internal_note='sensitive';},
  x=>{x.locales.fa.programs[0].internal_note={deep:'sensitive'};},
  x=>{x.locales.ps.faq.items[0].internal_note='sensitive';},
  x=>{x.locales.en.contact.private='sensitive';},
  x=>{x.timetable[0].private='sensitive';},
  x=>{x.media={image:'sensitive'};},
  x=>{x.locales.en.programs[0].title={text:'sensitive'};},
  x=>{x.locales.fa.faq={};},
  x=>{x.locales.ps.programs=null;}
 ];
 for(const change of changes){const source=example();change(source);const result=proposePublicProjection(source);assert.equal(result.ok,false);assert.equal(result.reason,'schema-review-required');assert.ok(!('payload' in result));assert.doesNotMatch(JSON.stringify(result),/sensitive|internal_note|private/);}
});

test('absent and null optional fields remain distinguishable',()=>{
 const source=example();delete source.locales.en.contact;source.locales.fa.faq=null;source.media=null;source.timetable=null;
 const result=proposePublicProjection(source);assert.equal(result.ok,true);assert.deepEqual(result.payload,source);
});
