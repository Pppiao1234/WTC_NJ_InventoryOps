'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('./engine.js');
const rows = () => [
  {inventoryId:'baseline',location:'C4',destination:'TEB9',shipmentId:'',physicalP:14,occupiedSlots:null,slotBasis:'unknown'},
  {inventoryId:'receipt1',location:'C4',destination:'TEB9',shipmentId:'new',physicalP:5,occupiedSlots:null,slotBasis:'unknown',receivedAt:'2026-10-30T12:00:00Z'}
];
function calc(extra={}) {
  return Core.computeLoadingEffect({taskId:'load1',status:'留台等货',actualText:'C4 TEB9:6',plannedText:'',inventory:rows(),
    baseline:{confirmed:true,version:'b1',appliedTasks:{}},allowedLocations:['C4'],otherTaskPlans:[],allowSameDestinationLots:true,...extra});
}
function good(result) { assert.equal(result.ok,true,JSON.stringify(result.issues)); return result; }
function total(rows) {return rows.reduce((s,r)=>s+r.physicalP,0);}
test('same warehouse point accepts a receipt lot and cumulative 6 to 8 only deducts 2',()=>{
 const a=good(calc());assert.equal(total(a.inventoryAfter),13);
 const b=good(calc({actualText:'C4 TEB9:8',previous:a.nextLedger,inventory:a.inventoryAfter}));
 assert.equal(total(b.actualDeltas),2);assert.equal(total(b.inventoryAfter),11);
 const repeat=good(calc({actualText:'C4 TEB9:8',previous:b.nextLedger,inventory:b.inventoryAfter}));
 assert.deepEqual(repeat.actualDeltas,[]);
 assert.deepEqual(repeat.inventoryAfter,b.inventoryAfter);
 assert.equal(repeat.capacityCertain,false);
});
test('fully consumed old lot stays bound when cumulative quantity spills into a receipt',()=>{
 const a=good(calc({actualText:'C4 TEB9:16'}));
 assert.equal(a.inventoryAfter.find(r=>r.inventoryId==='baseline').physicalP,0);
 assert.equal(a.nextLedger.actual.find(r=>r.inventoryId==='baseline').physicalP,14);
 const b=good(calc({actualText:'C4 TEB9:17',previous:a.nextLedger,inventory:a.inventoryAfter}));
 assert.equal(total(b.actualDeltas),1);
 assert.equal(b.nextLedger.actual.find(r=>r.inventoryId==='baseline').physicalP,14);
});
test('a later imported receipt never reassigns already committed loading to a different lot',()=>{
 const a=good(calc());
 const inv=[{...rows()[1],inventoryId:'aaa',physicalP:20,receivedAt:''},...a.inventoryAfter];
 const b=good(calc({inventory:inv,previous:a.nextLedger}));
 assert.deepEqual(b.actualDeltas,[]);
 assert.equal(b.nextLedger.actual.find(r=>r.inventoryId==='baseline').physicalP,6);
 assert.equal(b.inventoryAfter.find(r=>r.inventoryId==='aaa').physicalP,20);
});
test('other loading reservations are respected while allocating new consumption across lots',()=>{
 const b=good(calc({actualText:'C4 TEB9:4',otherTaskPlans:[{taskId:'other',projectedRemaining:[{inventoryId:'baseline',physicalP:13,releasedSlots:null}]}]}));
 assert.equal(b.inventoryAfter.find(r=>r.inventoryId==='baseline').physicalP,13);
 assert.equal(b.inventoryAfter.find(r=>r.inventoryId==='receipt1').physicalP,2);
});
test('active loading retains the same lot plan as actual quantity rises and completes',()=>{
 const a=good(calc({status:'已开始',plannedText:'C4 TEB9:16'}));
 const b=good(calc({status:'已开始',plannedText:'C4 TEB9:16',actualText:'C4 TEB9:8',previous:a.nextLedger,inventory:a.inventoryAfter}));
 assert.equal(total(b.actualDeltas),2);
 const c=good(calc({status:'已结束',actualText:'C4 TEB9:16',previous:b.nextLedger,inventory:b.inventoryAfter}));
 assert.equal(total(c.actualDeltas),8);assert.equal(total(c.inventoryAfter),3);
});
test('multiple lots still require an explicit warehouse point and the opt in policy',()=>{
 for(const extra of [{actualText:'C4:6'},{allowSameDestinationLots:false}]){
   const a=calc(extra);assert.equal(a.blocked,true);assert.ok(a.issues.some(r=>r.code==='AMBIGUOUS_INVENTORY'));
 }
});
test('explicit shipment selection excludes other goods within the same warehouse point',()=>{
 const inv=[...rows(),{...rows()[1],inventoryId:'receipt2',physicalP:4}];
 const a=good(calc({inventory:inv,actualText:'C4 TEB9@new:7'}));
 assert.equal(a.inventoryAfter.find(r=>r.inventoryId==='baseline').physicalP,14);
 assert.equal(total(a.actualDeltas),7);
});
test('decreasing a multi lot cumulative quantity still requires a correction reason',()=>{
 const a=good(calc({actualText:'C4 TEB9:16'}));
 const blocked=calc({actualText:'C4 TEB9:12',previous:a.nextLedger,inventory:a.inventoryAfter});
 assert.equal(blocked.blocked,true);assert.ok(blocked.issues.some(r=>r.code==='ACTUAL_DECREASE_NEEDS_CONFIRMATION'));
 const b=good(calc({actualText:'C4 TEB9:12',previous:a.nextLedger,inventory:a.inventoryAfter,correctionConfirmed:true,correctionReason:'回单复核更正'}));
 assert.equal(total(b.actualDeltas),-4);assert.equal(total(b.inventoryAfter),7);
});
test('overdraw and ambiguous measured slot allocation leave inventory unchanged',()=>{
 for(const extra of [{actualText:'C4 TEB9:20'},{actualEntries:[{location:'C4',destination:'TEB9',physicalP:6,releasedSlots:3}]}]){
   const inv=rows(),a=calc({...extra,inventory:inv});assert.equal(a.blocked,true);assert.deepEqual(a.inventoryAfter,inv);
 }
});
