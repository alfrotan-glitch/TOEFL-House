// Build composition uses explicit, unique, adjacent hooks instead of searching
// for generic JavaScript text that might occur in unrelated edge functions.
export function insertExactlyOnce(source,marker,value){
 const first=source.indexOf(marker);
 if(first<0||source.indexOf(marker,first+marker.length)!==-1)throw Error('Missing or duplicate build hook: '+marker);
 return source.slice(0,first)+value+source.slice(first+marker.length);
}
export function composeEdge(source,modules){
 const declaration='// SITE_V2_MODULES: build-time insertion point; standalone edge remains functional.\nexport default {';
 const entry='export default {\n  async fetch(request,env,ctx){\n    const url=new URL(request.url);\n';
 const route=entry+'    // SITE_V2_ROUTE: optional public renderer, inserted before legacy routing.\n    // Preview deployments are strictly read-only; enforce before every route, including internal CMS.';
 source=insertExactlyOnce(source,declaration,modules+'\nexport default {');
 return insertExactlyOnce(source,route,entry+'    const v2Page=await v2Route(request,env,url); if(v2Page)return v2Page;\n    // Preview deployments are strictly read-only; enforce before every route, including internal CMS.');
}
