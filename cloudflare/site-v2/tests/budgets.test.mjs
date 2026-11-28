import test from 'node:test';
import assert from 'node:assert/strict';
import {BUDGETS,checkBudgets,measureBudgets} from '../budgets.mjs';

test('each size budget fails closed at the boundary or for missing measurements',()=>{
 const good=Object.fromEntries(Object.entries(BUDGETS).map(([key,max])=>[key,max-1]));
 assert.deepEqual(checkBudgets(good),[]);
 for(const [key,max] of Object.entries(BUDGETS)){
  assert.equal(checkBudgets({...good,[key]:max}).length,1,key);
  const missing={...good};delete missing[key];assert.equal(checkBudgets(missing).length,1,key);
 }
});

test('built Worker, combined styles and client script meet the common budgets',async()=>{
 assert.deepEqual(checkBudgets(await measureBudgets()),[]);
});
