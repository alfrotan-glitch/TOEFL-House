// Minimum shared contract for the three published program collections.
// Empty or partial arrays are valid editorial omissions; malformed entries or
// duplicate identities are not. Do not silently add missing CMS programs here.
function v2PublishedProgramsValid(main,pashto){
 const locales=[main?.locales?.en,main?.locales?.fa,pashto];
 return locales.every(locale=>{
  if(!Array.isArray(locale?.programs))return false;
  const seen=new Set();
  for(const program of locale.programs){
   if(!program||typeof program!=="object"||Array.isArray(program)||typeof program.id!=="string"||!program.id.trim()||seen.has(program.id))return false;
   seen.add(program.id);
  }
  return true;
 });
}
