import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('public CMS archiving fails before a network request while nested schema is unapproved',()=>{
 const script=fileURLToPath(new URL('../../cms-readiness/public-content-snapshot.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:5000,env:{...process.env}});
 assert.equal(result.status,1);
 assert.match(result.stderr,/Public CMS archive disabled: owner-reviewed nested public schema and projection are required/);
 assert.doesNotMatch(result.stderr,/fetch failed|ENOTFOUND|ETIMEDOUT/);
});
