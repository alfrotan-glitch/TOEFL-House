import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditPublicShape} from '../../cms-readiness/public-schema-preflight.mjs';

const script=fileURLToPath(new URL('../../cms-readiness/public-schema-preflight.mjs',import.meta.url));
const locale=()=>({programs:[{id:'general-english',title:'Public label',highlights:['Public skill']}],faq:{items:[{q:'Question?',a:'Answer'}]},contact:{address:'Example address'}});
const example=()=>({locales:{en:locale(),fa:locale(),ps:locale()},media:{},timetable:[{id:'shift',timeEn:'Example time',open:true}],revision:1,psRevision:1,updatedAt:'example',cmsStatus:'connected'});

test('schema proposal counts only known structural categories, not field values or unknown names',()=>{
 const value=example();value.locales.en['secret-key-name']='sensitive-value-one';
 value.locales.fa.programs[0].unknown_private_field={nested:'sensitive-value-two'};
 value.locales.ps.faq.items[0].unknown_question_data='sensitive-value-three';
 value.media={private_media_field:'sensitive-value-four'};
 const report=auditPublicShape(value),text=JSON.stringify(report);
 assert.equal(report.status,'proposal-only');assert.equal(report.unknownFields,3);
 assert.equal(report.byCategory.locale,1);assert.equal(report.byCategory.program,1);assert.equal(report.byCategory.faq,1);assert.equal(report.unreviewedMedia,1);
 assert.equal(report.invalidShapes,0);
 for(const secret of ['sensitive-value','secret-key-name','unknown_private_field','unknown_question_data','private_media_field','Example address'])assert.ok(!text.includes(secret));
});

test('preflight detects invalid known shapes without inspecting or exposing nested values',()=>{
 const value=example();value.locales.en.programs[0].title={internal:'do-not-print'};
 value.locales.fa.faq.items=[null];value.locales.ps.statistics='bad';
 const report=auditPublicShape(value);assert.equal(report.invalidShapes,3);assert.doesNotMatch(JSON.stringify(report),/do-not-print|internal/);
});

test('CLI accepts bounded stdin only and never echoes input or parser errors',()=>{
 const value=example();value.locales.en['private_name']='do-not-echo';
 const result=spawnSync(process.execPath,[script],{input:JSON.stringify(value),encoding:'utf8',timeout:5000});
 assert.equal(result.status,0);const report=JSON.parse(result.stdout);assert.equal(report.unknownFields,1);
 assert.doesNotMatch(result.stdout+result.stderr,/private_name|do-not-echo|Public label/);
 const bad=spawnSync(process.execPath,[script],{input:'{ "secret": "do-not-echo"',encoding:'utf8',timeout:5000});
 assert.equal(bad.status,1);assert.equal(bad.stdout,'');assert.match(bad.stderr,/Unable to audit input/);assert.doesNotMatch(bad.stderr,/secret|do-not-echo|SyntaxError/);
 const large=spawnSync(process.execPath,[script],{input:'x'.repeat(3_000_001),encoding:'utf8',timeout:5000});
 assert.equal(large.status,1);assert.equal(large.stdout,'');assert.match(large.stderr,/Unable to audit input/);
});
