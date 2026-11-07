'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Core=require('./engine.js');
function input(extra={}){return {taskId:'PORTAL-01',status:'已开始',plannedText:'',actualText:'C1 ABE8:6',allowedLocations:['C1'],baseline:{confirmed:true,version:'BASE-1',appliedTasks:{}},inventory:[{inventoryId:'I1',location:'C1',destination:'ABE8',shipmentId:null,physicalP:20,occupiedSlots:20,slotBasis:'one_per_pallet'}],otherTaskPlans:[],...extra};}
test('portal optin: explicit active actual without a plan records physical quantity without inventing planned release',()=>{
 const effect=Core.computeLoadingEffect(input({allowActualWithoutPlan:true}));
 assert.equal(effect.ok,true);assert.equal(effect.inventoryAfter[0].physicalP,14);assert.equal(effect.actualDeltas[0].physicalP,6);assert.equal(effect.plannedKnown,false);assert.deepEqual(effect.nextLedger.planned,[]);assert.deepEqual(effect.nextLedger.projectedRemaining,[]);assert.ok(effect.issues.some(i=>i.code==='PLAN_UNKNOWN_ACTUAL_RECORDED'));
});
test('portal optin: 6 to 8 actual without a plan deducts only the added two pallets',()=>{
 const first=Core.computeLoadingEffect(input({allowActualWithoutPlan:true}));
 const next=Core.computeLoadingEffect(input({allowActualWithoutPlan:true,inventory:first.inventoryAfter,previous:first.nextLedger,actualText:'C1 ABE8:8'}));
 assert.equal(next.ok,true);assert.equal(next.inventoryAfter[0].physicalP,12);assert.equal(next.actualDeltas[0].physicalP,2);
});
test('portal optin: legacy and unknown actual still require a real active plan',()=>{
 const legacy=Core.computeLoadingEffect(input());assert.equal(legacy.ok,false);assert.ok(legacy.issues.some(i=>i.code==='MISSING_PLANNED'));
 const unknown=Core.computeLoadingEffect(input({allowActualWithoutPlan:true,actualText:''}));assert.equal(unknown.ok,false);assert.ok(unknown.issues.some(i=>i.code==='MISSING_PLANNED'));
});
test('portal optin: unknown stacking remains unknown after a measured physical issue',()=>{
 const effect=Core.computeLoadingEffect(input({allowActualWithoutPlan:true,inventory:[{inventoryId:'I1',location:'C1',destination:'ABE8',physicalP:20,occupiedSlots:null,slotBasis:'unknown'}]}));
 assert.equal(effect.ok,true);assert.equal(effect.inventoryAfter[0].physicalP,14);assert.equal(effect.inventoryAfter[0].occupiedSlots,null);assert.equal(effect.capacityCertain,false);
});
test('portal optin: it cannot consume stock already reserved by another task',()=>{
 const effect=Core.computeLoadingEffect(input({allowActualWithoutPlan:true,otherTaskPlans:[{taskId:'OTHER',projectedRemaining:[{inventoryId:'I1',location:'C1',destination:'ABE8',physicalP:18,releasedSlots:18}]}]}));
 assert.equal(effect.ok,false);assert.equal(effect.inventoryAfter[0].physicalP,20);assert.ok(effect.issues.some(i=>i.code==='PLAN_OVERBOOKED'));
});
