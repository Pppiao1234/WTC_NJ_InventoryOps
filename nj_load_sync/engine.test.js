'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const C = require('./engine.js');
const locs=['C1','C2','W11','Y2'];
const inventory=[{inventoryId:'i1',location:'C1',destination:'TEB9',shipmentId:'01003',physicalP:20,occupiedSlots:20,slotBasis:'one_per_pallet'}];
function input(extra={}) {return {taskId:'t1',status:'已开始',plannedText:'C1:8',actualText:'',destination:'TEB9',allowedLocations:locs,baseline:{confirmed:true,version:'b1',appliedTasks:{}},inventory:structuredClone(inventory),otherTaskPlans:[],...extra};}
function assertBlocked(x,code){assert.equal(x.blocked,true);assert.ok(x.issues.some(i=>i.code===code),JSON.stringify(x.issues));assert.equal(x.proposal,null);}
test('parser is strict, preserves zero and location alias',()=>{
 assert.deepEqual(C.parseMap('',{allowedLocations:locs}),{known:false,entries:[]});
 assert.equal(C.parseMap('C1:0，W#:2',{allowedLocations:locs}).entries[0].physicalP,0);
 assert.equal(C.parseMap('C1:0，W#:2',{allowedLocations:locs}).entries[1].location,'W11');
 assert.equal(C.parseMap('Y2 HEA2 @00001:3; C2:4P',{allowedLocations:locs}).entries[0].shipmentId,'00001');
 for(const s of ['C1:-1','C1:1.5','C1:8, bad','C1:8,C1:2','Q1:8','同预计'])assert.throws(()=>C.parseMap(s,{allowedLocations:locs}));
});
test('no confirmed baseline never changes inventory',()=>{
 const i=input({baseline:{confirmed:false,version:'b1'},actualText:'C1:6',status:'已结束'}),x=C.computeLoadingEffect(i);
 assertBlocked(x,'UNCONFIRMED_BASELINE');assert.deepEqual(x.inventoryAfter,i.inventory);
});
test('planned 8 then actual 6 only gives back 2 projected slots',()=>{
 const a=C.computeLoadingEffect(input());assert.equal(a.ok,true);assert.equal(a.inventoryAfter[0].physicalP,20);assert.equal(a.nextLedger.projectedRemaining[0].releasedSlots,8);
 const b=C.computeLoadingEffect(input({status:'已结束',actualText:'C1:6',previous:a.nextLedger,inventory:a.inventoryAfter}));
 assert.equal(b.ok,true);assert.equal(b.inventoryAfter[0].physicalP,14);assert.equal(b.inventoryAfter[0].occupiedSlots,14);
 assert.equal(b.actualDeltas[0].physicalP,6);assert.equal(b.actualDeltas[0].releasedSlots,6);assert.equal(b.planSlotDeltas[0].releasedSlots,-8);
 assert.equal(b.actualDeltas[0].releasedSlots+b.planSlotDeltas[0].releasedSlots,-2);
 const repeat=C.computeLoadingEffect(input({status:'已结束',actualText:'C1:6',previous:b.nextLedger,inventory:b.inventoryAfter}));
 assert.equal(repeat.ok,true);assert.deepEqual(repeat.actualDeltas,[]);assert.deepEqual(repeat.inventoryAfter,b.inventoryAfter);
});
test('actual can be recorded during active state without double planned release',()=>{
 const x=C.computeLoadingEffect(input({actualText:'C1:2'}));
 assert.equal(x.ok,true);assert.equal(x.inventoryAfter[0].physicalP,18);assert.equal(x.nextLedger.projectedRemaining[0].releasedSlots,6);
 assert.equal(x.inventoryAfter[0].occupiedSlots-x.nextLedger.projectedRemaining[0].releasedSlots,12);
});
test('holding cumulative 8 to 12 only adds 4; correction requires explicit acknowledgement',()=>{
 const a=C.computeLoadingEffect(input({status:'留台等货',actualText:'C1:8'}));
 const b=C.computeLoadingEffect(input({status:'留台等货',actualText:'C1:12',previous:a.nextLedger,inventory:a.inventoryAfter}));
 assert.equal(b.ok,true);assert.equal(b.actualDeltas[0].physicalP,4);assert.equal(b.inventoryAfter[0].physicalP,8);
 const bad=C.computeLoadingEffect(input({status:'留台等货',actualText:'C1:11',previous:b.nextLedger,inventory:b.inventoryAfter}));
 assertBlocked(bad,'ACTUAL_DECREASE_NEEDS_CONFIRMATION');
 const fixed=C.computeLoadingEffect(input({status:'留台等货',actualText:'C1:11',previous:b.nextLedger,inventory:b.inventoryAfter,correctionConfirmed:true,correctionReason:'清点后更正累计数量'}));
 assert.equal(fixed.ok,true);assert.equal(fixed.actualDeltas[0].physicalP,-1);assert.equal(fixed.inventoryAfter[0].physicalP,9);
});
test('new daily baseline includes historical actual, which is never subtracted again',()=>{
 const baseline={confirmed:true,version:'b2',appliedTasks:{t1:{taskId:'t1',status:'留台等货',actual:[{inventoryId:'i1',location:'C1',destination:'TEB9',shipmentId:'01003',physicalP:8,releasedSlots:8}]}}};
 const inv=[{...inventory[0],physicalP:12,occupiedSlots:12}];
 const same=C.computeLoadingEffect(input({status:'留台等货',actualText:'C1:8',baseline,inventory:inv}));
 assert.equal(same.ok,true);assert.equal(same.actualDeltas.length,0);assert.equal(same.inventoryAfter[0].physicalP,12);
 const more=C.computeLoadingEffect(input({status:'留台等货',actualText:'C1:12',baseline,inventory:inv}));
 assert.equal(more.actualDeltas[0].physicalP,4);assert.equal(more.inventoryAfter[0].physicalP,8);
});
test('unknown stacking never equates physical pallets and released slots',()=>{
 const inv=[{...inventory[0],physicalP:28,occupiedSlots:27,slotBasis:'unknown'}];
 const a=C.computeLoadingEffect(input({inventory:inv}));assert.equal(a.ok,true);assert.equal(a.nextLedger.projectedRemaining[0].releasedSlots,null);assert.equal(a.capacityCertain,false);
 const b=C.computeLoadingEffect(input({status:'已结束',actualText:'C1:6',inventory:inv}));
 assert.equal(b.ok,true);assert.equal(b.actualDeltas[0].releasedSlots,null);assert.equal(b.inventoryAfter[0].physicalP,22);assert.equal(b.inventoryAfter[0].occupiedSlots,null);
 assert.equal(b.inventoryAfter[0].conservativeOccupiedSlots,22);assert.equal(b.inventoryAfter[0].conservativeBasis,'one_pallet_upper_bound');
 assert.equal(a.inventoryAfter[0].conservativeOccupiedSlots,27);assert.equal(a.inventoryAfter[0].conservativeBasis,'confirmed_occupancy');
});
test('shared short line requires destination when ambiguous',()=>{
 const inv=[{inventoryId:'y1',location:'Y2',destination:'HEA2',physicalP:4,occupiedSlots:4,slotBasis:'one_per_pallet'}, {inventoryId:'y2',location:'Y2',destination:'CHO1',physicalP:2,occupiedSlots:2,slotBasis:'one_per_pallet'}];
 assertBlocked(C.computeLoadingEffect(input({inventory:inv,destination:'',plannedText:'Y2:3'})),'AMBIGUOUS_INVENTORY');
 const x=C.computeLoadingEffect(input({inventory:inv,destination:'',plannedText:'Y2 HEA2:3;Y2 CHO1:1',actualText:'Y2 HEA2:2;Y2 CHO1:1',status:'已结束'}));
 assert.equal(x.ok,true);assert.equal(x.inventoryAfter.find(r=>r.inventoryId==='y1').physicalP,2);assert.equal(x.inventoryAfter.find(r=>r.inventoryId==='y2').physicalP,1);
});
test('regression or cancellation preserves already recorded actual',()=>{
 const a=C.computeLoadingEffect(input({actualText:'C1:6',status:'已结束'}));
 for(const status of ['取消','靠台在等']){
  const b=C.computeLoadingEffect(input({status,actualText:'',previous:a.nextLedger,inventory:a.inventoryAfter}));
  assert.equal(b.ok,true);assert.deepEqual(b.actualDeltas,[]);assert.equal(b.nextLedger.actual[0].physicalP,6);assert.equal(b.inventoryAfter[0].physicalP,14);
 }
});
test('finished or holding missing actual is blocked, zero with plan context is explicit',()=>{
 assertBlocked(C.computeLoadingEffect(input({status:'已结束'})),'MISSING_ACTUAL');
 const zero=C.computeLoadingEffect(input({status:'已结束',actualText:'0'}));assert.equal(zero.ok,true);assert.equal(zero.nextLedger.actual[0].physicalP,0);assert.equal(zero.inventoryAfter[0].physicalP,20);
});
test('unknown location, missing stock and overdraw are rejected atomically',()=>{
 assertBlocked(C.computeLoadingEffect(input({plannedText:'C99:3'})),'UNKNOWN_LOCATION');
 assertBlocked(C.computeLoadingEffect(input({plannedText:'C2:3'})),'INVENTORY_NOT_FOUND');
 const x=C.computeLoadingEffect(input({status:'已结束',actualText:'C1:21'}));assertBlocked(x,'INSUFFICIENT_PHYSICAL');assert.deepEqual(x.inventoryAfter,inventory);
});
test('dropping one previously confirmed source is blocked',()=>{
 const inv=[...structuredClone(inventory),{...inventory[0],inventoryId:'i2',location:'C2'}];
 const a=C.computeLoadingEffect(input({inventory:inv,status:'留台等货',plannedText:'C1:8;C2:4',actualText:'C1:8;C2:4'}));
 const b=C.computeLoadingEffect(input({inventory:a.inventoryAfter,previous:a.nextLedger,status:'留台等货',plannedText:'C1:10;C2:4',actualText:'C1:10'}));
 assertBlocked(b,'ACTUAL_ENTRY_REMOVED');
});
test('AI proposal cannot change quantities, stock identity, capacity or movement',()=>{
 const x=C.computeLoadingEffect(input({status:'已结束',actualText:'C1:6'}));
 assert.equal(C.deterministicValidateProposal(x.proposal,x).ok,true);
 assert.equal(C.deterministicValidateProposal({proposal:x.proposal,explanation:'核对通过'},x).ok,true);
 for(const mutate of [p=>p.actualDeltas[0].physicalP=8,p=>p.inventoryAfter[0].location='C2',p=>p.inventoryAfter[0].capacitySlots=999,p=>p.taskId='other']){
  const p=structuredClone(x.proposal);mutate(p);assert.equal(C.deterministicValidateProposal(p,x).ok,false);
 }
 const blocked=C.computeLoadingEffect(input({baseline:{confirmed:false}}));assert.equal(C.deterministicValidateProposal(x.proposal,blocked).ok,false);
});
test('explicit stacking release evidence is supported without one-to-one inference',()=>{
 const inv=[{...inventory[0],occupiedSlots:10,slotBasis:'explicit'}];
 const x=C.computeLoadingEffect(input({inventory:inv,status:'已结束',actualEntries:[{location:'C1',physicalP:6,releasedSlots:3}]}));
 assert.equal(x.ok,true);assert.equal(x.inventoryAfter[0].physicalP,14);assert.equal(x.inventoryAfter[0].occupiedSlots,7);assert.equal(x.actualDeltas[0].releasedSlots,3);
});
test('two tasks cannot both reserve the same remaining stock',()=>{
 const inv=[{...inventory[0],physicalP:8,occupiedSlots:8}];
 const other=[{taskId:'t2',projectedRemaining:[{inventoryId:'i1',physicalP:6,releasedSlots:6}]}];
 const blocked=C.computeLoadingEffect(input({inventory:inv,plannedText:'C1:6',otherTaskPlans:other}));
 assertBlocked(blocked,'PLAN_OVERBOOKED');assert.deepEqual(blocked.inventoryAfter,inv);
 const valid=C.computeLoadingEffect(input({inventory:inv,plannedText:'C1:2',otherTaskPlans:other}));assert.equal(valid.ok,true);assert.equal(valid.reservationSummary[0].physicalP,8);
});
test('current task old reservation is replaced and is not counted a second time',()=>{
 const inv=[{...inventory[0],physicalP:8,occupiedSlots:8}];
 const first=C.computeLoadingEffect(input({inventory:inv,plannedText:'C1:6'}));
 const same=C.computeLoadingEffect(input({inventory:first.inventoryAfter,plannedText:'C1:6',previous:first.nextLedger,otherTaskPlans:[first.nextLedger]}));
 assert.equal(same.ok,true);assert.deepEqual(same.planSlotDeltas,[]);assert.equal(same.reservationSummary[0].physicalP,6);
});
test('absence of other-task context is not treated as an empty warehouse',()=>{
 const i=input();delete i.otherTaskPlans;assertBlocked(C.computeLoadingEffect(i),'MISSING_RESERVATION_SCOPE');
});
test('stale explicit previous ledger cannot override a new baseline checkpoint',()=>{
 const baseline={confirmed:true,version:'b2',appliedTasks:{t1:{actual:[{inventoryId:'i1',location:'C1',physicalP:6,releasedSlots:6}]}}};
 const inv=[{...inventory[0],physicalP:14,occupiedSlots:14}];
 const x=C.computeLoadingEffect(input({baseline,inventory:inv,status:'已结束',actualText:'C1:6',previous:{taskId:'t1',baselineVersion:'b1',actual:[]}}));
 assertBlocked(x,'STALE_LEDGER_BASELINE');assert.equal(x.inventoryAfter[0].physicalP,14);
});
test('slot-only cumulative correction is explicit and applied to occupancy',()=>{
 const inv=[{...inventory[0],occupiedSlots:10,slotBasis:'explicit'}];
 const a=C.computeLoadingEffect(input({inventory:inv,status:'已结束',actualEntries:[{location:'C1',physicalP:6,releasedSlots:3}]}));
 const args=input({inventory:a.inventoryAfter,previous:a.nextLedger,status:'已结束',actualEntries:[{location:'C1',physicalP:6,releasedSlots:4}]});
 assertBlocked(C.computeLoadingEffect(args),'SLOT_CORRECTION_NEEDS_CONFIRMATION');
 const b=C.computeLoadingEffect({...args,correctionConfirmed:true,correctionReason:'现场核实实际释放4位'});
 assert.equal(b.ok,true);assert.equal(b.actualDeltas[0].physicalP,0);assert.equal(b.actualDeltas[0].releasedSlots,1);assert.equal(b.inventoryAfter[0].occupiedSlots,6);
});
test('explicit slot release cannot invent a wider capacity operation',()=>{
 const inv=[{...inventory[0],occupiedSlots:10,slotBasis:'explicit'}];
 assertBlocked(C.computeLoadingEffect(input({inventory:inv,status:'已结束',actualEntries:[{location:'C1',physicalP:1,releasedSlots:9}]})),'IMPOSSIBLE_SLOT_RELEASE');
 assertBlocked(C.computeLoadingEffect(input({status:'已结束',actualEntries:[{location:'C1',physicalP:6,releasedSlots:3}]})),'SLOT_BASIS_CONFLICT');
});
test('conservative physical estimate does not overwrite source theoretical fields',()=>{
 const inv=[{...inventory[0],occupiedSlots:null,slotBasis:'unknown',sourceTheoreticalP:32.5}];
 const x=C.computeLoadingEffect(input({inventory:inv,status:'已开始',plannedText:'C1:8'}));
 assert.equal(x.ok,true);assert.equal(x.inventoryAfter[0].conservativeOccupiedSlots,20);assert.equal(x.inventoryAfter[0].sourceTheoreticalP,32.5);assert.equal(x.inventoryAfter[0].occupiedSlots,null);
});
