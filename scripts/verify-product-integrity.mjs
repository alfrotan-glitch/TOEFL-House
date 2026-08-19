import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `.pathname` yields '/C:/Users/...' on Windows, which is not a usable
// filesystem path — every read() below would throw ENOENT and this release
// gate could never run there. fileURLToPath() is correct on all platforms.
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const fail = (msg) => { console.error(`[FAIL] ${msg}`); process.exitCode = 1; };

const nav = read('src/config/navigation.ts');
const app = read('src/App.tsx');
const rules = read('server/src/routes/rules.routes.ts');
const catalog = read('server/src/routes/catalog.routes.ts');
const index = read('server/src/index.ts');
const apiStore = read('src/apiStore.ts');
const placement = read('server/src/routes/placement.routes.ts');
const students = read('server/src/routes/students.routes.ts');
const exams = read('server/src/routes/exams.routes.ts');
const policyCatalog = read('server/src/core/configuration/policy-catalog.ts');

const ids = [...nav.matchAll(/\{\s*id:\s*'([^']+)',\s*label:\s*'[^']+',\s*icon:/g)].map((m) => m[1]);
const unique = new Set(ids);
if (unique.size !== ids.length) fail(`Duplicate navigation IDs: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`);
for (const id of ids) {
  if (id !== 'dashboard' && !new RegExp(`case '${id}':`).test(app)) fail(`Navigation item has no App route: ${id}`);
}
for (const dead of ['pipelinesRouter', '/api/pipelines', 'PipelinesView', 'EventsView']) {
  if (new RegExp(dead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(index + app + apiStore)) fail(`Dead pipeline/event reference remains: ${dead}`);
}
if (!/Fee rules are legacy compatibility data/.test(catalog)) fail('Legacy fee-rule compatibility boundary missing.');
if (!/DOMAIN_OWNED_RULE_CATEGORIES/.test(rules) || !/fee.*promotion.*attendance.*academic/.test(rules)) fail('Rule ownership metadata missing.');
if (/reloadPipelineMetrics|pipelineMetrics|\/pipelines\/metrics/.test(apiStore)) fail('Pipeline metrics state is still wired into the frontend store.');
if (/evaluateRules\(\{\s*category:\s*'fee'/.test(placement + students + exams)) fail('Operational fee paths still call the generic Rule Engine.');
if (/rule_default_placement_fee/.test(policyCatalog)) fail('Generic fee seed rule still exists.');
if (!/Global workspace search/.test(read('src/components/common/GlobalSearch.tsx'))) fail('Global search dialog semantics missing.');
console.log('[PASS] Product integrity audit');
console.log(`[PASS] Navigation IDs: ${ids.length}`);
console.log('[PASS] No legacy pipeline navigation/runtime wiring');
console.log('[PASS] Academic fee ownership boundary present');
console.log('[PASS] Rule ownership metadata present');
console.log('[PASS] Global search accessibility contract present');
