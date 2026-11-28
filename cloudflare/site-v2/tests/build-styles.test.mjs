import test from 'node:test';
import assert from 'node:assert/strict';
import {compactStyles,buildStyles} from '../build-styles.mjs';

test('style compiler removes comments without corrupting quoted or escaped content',()=>{
 const source='  .a { content: "/* keep */"; } /* remove */\n  .b { content: \'a\\\n b\'; }\n  .c\\/\\*name { color: red; }  \n';
 assert.equal(compactStyles(source),'.a { content: "/* keep */"; }.b { content: \'a\\\n b\'; }.c\\/\\*name { color: red; }');
 assert.throws(()=>compactStyles('a{/* open'),/Unterminated CSS comment/);
 assert.throws(()=>compactStyles('a{content:"open'),/Unterminated CSS string/);
});

test('compiled styles are deterministic',async()=>{
 const first=await buildStyles(),second=await buildStyles();
 assert.equal(first.css,second.css);
 assert.equal(first.sourceBytes,second.sourceBytes);
});
