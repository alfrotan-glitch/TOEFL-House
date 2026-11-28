import test from 'node:test';
import assert from 'node:assert/strict';
import {compactStyles,buildStyles} from '../build-styles.mjs';

test('style compiler preserves string and escape content and removes only standalone comments',()=>{
 const source='  .a { content: "/* keep */"; } /* inline stays */\n  /* remove */\n  .b { content: \'a\\\n b\'; }\n  .c\\/\\*name { color: red; }  \n';
 assert.equal(compactStyles(source),'.a { content: "/* keep */"; } /* inline stays */ .b { content: \'a\\\n b\'; }.c\\/\\*name { color: red; }');
 assert.throws(()=>compactStyles('a{/* open'),/Unterminated CSS comment/);
 assert.throws(()=>compactStyles('a{content:"open'),/Unterminated CSS string/);
});

test('significant newlines and inline token-separating comments are not silently merged',()=>{
 assert.equal(compactStyles('.parent\n.child { color: red; }'),'.parent .child { color: red; }');
 assert.equal(compactStyles('@media screen\nand (min-width: 10px) {\n.a { color: red; }\n}'),'@media screen and (min-width: 10px) { .a { color: red; } }');
 assert.equal(compactStyles('a/**/b { color: red; }'),'a/**/b { color: red; }');
 assert.equal(compactStyles(':root{--example:{\nalpha\nbeta};}'),':root{--example:{ alpha beta};}');
 assert.equal(compactStyles('.a{color:red}\n.b{color:blue}'),'.a{color:red}.b{color:blue}');
 assert.equal(compactStyles('a\\ '),'a\\ ');
 assert.equal(compactStyles('.\\31 \n.child { color: red; }'),'.\\31  .child { color: red; }');
 assert.equal(compactStyles('.\\31\r\n .child { color: red; }'),'.\\31\r\n .child { color: red; }');
 assert.equal(compactStyles('.a{background:url("data:text/plain,/*keep*/")}'),'.a{background:url("data:text/plain,/*keep*/")}');
});

test('compiled styles are deterministic',async()=>{
 const first=await buildStyles(),second=await buildStyles();
 assert.equal(first.css,second.css);
 assert.equal(first.sourceBytes,second.sourceBytes);
});
