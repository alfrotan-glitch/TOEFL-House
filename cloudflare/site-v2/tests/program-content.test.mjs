import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileContent} from '../content-compiler.mjs';
const load=async name=>JSON.parse(await readFile(new URL('../content/'+name,import.meta.url),'utf8'));

test('localized course content compiles deterministically and rejects missing or malformed translations',async()=>{
 const general=await load('general.json'),academic=await load('academic.json'),special=await load('special.json'),guides=await load('guides.json'),home=await load('home.json');
 const output=compileContent(general,academic,special,guides,home);
 assert.equal(output,compileContent(general,academic,special,guides,home));
 assert.match(output,/^const V2_GENERAL_ENGLISH=/);
 assert.match(output,/const V2_EAP=/);
 assert.match(output,/const V2_SPECIAL_COURSES=/);
 const missing=structuredClone(academic);delete missing.ps;
 assert.throws(()=>compileContent(general,missing,special,guides,home),/locales/);
 const keys=structuredClone(special);delete keys.ui.fa.cta;
 assert.throws(()=>compileContent(general,academic,keys,guides,home),/keys/);
 const wrong=structuredClone(special);wrong.courses.ps.special.facts='invalid';
 assert.throws(()=>compileContent(general,academic,wrong,guides,home),/array/);
 const book=structuredClone(guides);delete book.bookData.fa['got-it-series'];
 assert.throws(()=>compileContent(general,academic,special,book,home),/keys/);
});
