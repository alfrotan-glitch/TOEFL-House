import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileBrand} from '../brand-asset.mjs';

test('embedded brand is checksum-pinned and fails closed on corruption',async()=>{
 const source=await readFile(new URL('../content/brand.webp.base64',import.meta.url),'utf8');
 const output=compileBrand(source);
 assert.match(output,/^const V2_LOGO_REV="753895f6e945";/);
 assert.throws(()=>compileBrand(source.replace(/U/, 'V')),/integrity/);
 assert.throws(()=>compileBrand(source+'!'),/base64/);
});
