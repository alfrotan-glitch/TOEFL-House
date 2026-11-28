import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {composeEdge} from '../compose-edge.mjs';

test('edge composition fails closed when either explicit hook is missing, moved or duplicated',async()=>{
 const edge=await readFile(new URL('../../pages-edge/worker.mjs',import.meta.url),'utf8');
 const moduleHook='// SITE_V2_MODULES: build-time insertion point; standalone edge remains functional.\nexport default {';
 const routeHook='export default {\n  async fetch(request,env,ctx){\n    const url=new URL(request.url);\n    // SITE_V2_ROUTE: optional public renderer, inserted before legacy routing.\n    // Preview deployments are strictly read-only; enforce before every route, including internal CMS.';
 const output=composeEdge(edge,'// test module');
 assert.ok(output.includes('// test module\nexport default {'));
 assert.ok(output.includes('const v2Page=await v2Route(request,env,url); if(v2Page)return v2Page;'));
 for(const hook of [moduleHook,routeHook]){
  assert.throws(()=>composeEdge(edge.replace(hook,''),'// test'),/Missing or duplicate/);
  assert.throws(()=>composeEdge(edge+'\n'+hook,'// test'),/Missing or duplicate/);
 }
 assert.throws(()=>composeEdge(edge.replace(routeHook,routeHook.replace('const url=new URL(request.url);','const url = new URL(request.url);')),'// test'),/Missing or duplicate/);
});
