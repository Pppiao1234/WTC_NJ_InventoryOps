'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const U=require('./unload_engine.js');
function input(extra={}){
 const common={publicationId:'PUB-QA',revision:'1',taskId:'QA-CONT-1',containerNo:'QA000000001',published:true};
 return {taskId:common.taskId,containerNo:common.containerNo,publicationId:common.publicationId,revision:'1',status:'在拆',allowedLocations:['C1','C2','检查区'],allocations:[
  {...common,allocationId:'ordinary-1',destination:'TEB4',location:'C1',route:'ordinary',estimatedP:5,estimatedSlots:5},
  {...common,allocationId:'special-1',destination:'EXAMPLE PRIVATE',shipmentId:'00001',location:'检查区',route:'via_inspection',estimatedP:9,estimatedSlots:9}
 ],...extra};
}
function pSum(rows){return rows.reduce((n,r)=>n+(r.estimatedP||0),0);}
test('publication review: unloading to empty preserves ordinary estimates and unresolved special cargo',()=>{
 const active=U.computeUnloadEffect(input());assert.equal(active.ok,true);assert.equal(pSum(active.nextLedger.reservations),14);
 const empty=U.computeUnloadEffect(input({status:'拆空',previous:active.nextLedger}));assert.equal(empty.ok,true);assert.deepEqual(empty.actualDeltas,[]);
 assert.equal(pSum(empty.nextLedger.reservations.filter(r=>r.location==='C1')),5);
 assert.equal(pSum(empty.nextLedger.reservations.filter(r=>r.location==='检查区')),0);
 assert.equal(pSum(empty.nextLedger.unresolved),9);assert.equal(pSum(empty.nextLedger.reservations),14);assert.equal(empty.nextLedger.autoAllocationBlocked,true);
});
test('publication review: repeated poll cannot add cargo a second time',()=>{
 const a=U.computeUnloadEffect(input({status:'拆空'}));const b=U.computeUnloadEffect(input({status:'拆空',previous:a.nextLedger}));
 assert.equal(b.ok,true);assert.equal(b.changed,false);assert.deepEqual(b.nextLedger,a.nextLedger);assert.equal(pSum(b.nextLedger.reservations),14);
});
test('publication review: status rollback never frees completed cargo or reopens inspection',()=>{
 const a=U.computeUnloadEffect(input({status:'拆空'}));
 for(const status of ['在拆','已到','未到']){const b=U.computeUnloadEffect(input({status,previous:a.nextLedger}));assert.equal(b.ok,true);assert.equal(b.nextLedger.highestPhase,2);assert.equal(pSum(b.nextLedger.reservations),14);assert.equal(b.nextLedger.reservations.some(r=>r.location==='检查区'),false);assert.equal(b.issues.some(i=>i.code==='STATUS_REGRESSION'),true);}
});
test('publication review: printed allocation identity, quantity and location are frozen',()=>{
 const args=input(),first=U.computeUnloadEffect(args);
 for(const mutate of [r=>r[0].location='C2',r=>r[0].estimatedP=6,r=>r[0].destination='OTHER',r=>r[0].allocationId='replacement']){
  const allocations=structuredClone(args.allocations);mutate(allocations);const x=U.computeUnloadEffect(input({allocations,previous:first.nextLedger}));assert.equal(x.ok,false);assert.equal(x.proposal,null);assert.deepEqual(x.nextLedger,first.nextLedger);
 }
 const revised=structuredClone(args.allocations).map(r=>({...r,revision:'2'}));assert.equal(U.computeUnloadEffect(input({allocations:revised,revision:'2',previous:first.nextLedger})).blocked,true);
});
test('publication review: row reordering does not invalidate a published plan',()=>{
 const args=input(),first=U.computeUnloadEffect(args),x=U.computeUnloadEffect(input({allocations:[...args.allocations].reverse(),previous:first.nextLedger}));assert.equal(x.ok,true);assert.equal(x.changed,false);
});
test('publication review: actual later facts do not pretend a receipt or rewrite printed assignments',()=>{
 const args=input(),first=U.computeUnloadEffect({...args,status:'拆空'});
 const allocations=args.allocations.map(r=>({...r,actualP:9,actualFinalLocation:'C2'}));
 const x=U.computeUnloadEffect(input({status:'拆空',allocations,previous:first.nextLedger}));assert.equal(x.ok,true);assert.deepEqual(x.actualDeltas,[]);assert.equal(x.nextLedger.physicalInventoryPosted,false);assert.equal(pSum(x.nextLedger.unresolved),9);assert.equal(x.nextLedger.publishedAllocations.find(r=>r.allocationId==='special-1').finalLocation,null);
});
test('publication review: unpublished, duplicate and out-of-catalog instructions cannot execute',()=>{
 const args=input();
 for(const mutate of [r=>r[0].published=false,r=>r[1].allocationId=r[0].allocationId,r=>r[0].location='C99',r=>r[0].taskId='OTHER']){const allocations=structuredClone(args.allocations);mutate(allocations);const x=U.computeUnloadEffect(input({allocations}));assert.equal(x.ok,false);assert.equal(x.proposal,null);}
});
test('publication review: forged candidate cannot discard unresolved shipments',()=>{
 const effect=U.computeUnloadEffect(input({status:'拆空'}));assert.equal(U.validateProposal(effect.proposal,effect).ok,true);const forged=structuredClone(effect.proposal);forged.nextLedger.reservations=forged.nextLedger.reservations.filter(r=>r.kind!=='unresolved_estimate');forged.nextLedger.unresolved=[];assert.equal(U.validateProposal(forged,effect).ok,false);
});
test('publication review: published paper holds capacity before arrival and before source observation',()=>{
 for(const status of ['未到','已到','未读取','未观测','']){const x=U.computeUnloadEffect(input({status}));assert.equal(x.ok,true,status);assert.equal(pSum(x.nextLedger.reservations),14,status);assert.ok(x.nextLedger.reservations.every(r=>r.kind==='planned_hold'),status);assert.deepEqual(x.actualDeltas,[]);assert.equal(x.nextLedger.physicalInventoryPosted,false);if(['未读取','未观测',''].includes(status))assert.equal(x.nextLedger.autoAllocationBlocked,true);}
});
test('publication review: starting converts published holds without adding duplicate capacity',()=>{
 const waiting=U.computeUnloadEffect(input({status:'已到'})),active=U.computeUnloadEffect(input({status:'在拆',previous:waiting.nextLedger}));
 const context={inventory:[],knownEmptyLocations:['C1','检查区'],capacities:{C1:27,'检查区':70},baselineConfirmed:true};
 const a=U.aggregateReservations({...context,unloadTasks:[waiting.nextLedger]}),b=U.aggregateReservations({...context,unloadTasks:[active.nextLedger]});
 assert.equal(a.byLocation.C1.incomingEstimatedP,5);assert.equal(b.byLocation.C1.incomingEstimatedP,5);assert.equal(a.byLocation.C1.plannedHoldP,5);assert.equal(b.byLocation.C1.plannedHoldP,0);assert.equal(b.byLocation.C1.activeEstimatedP,5);
 assert.equal(a.inspection.plannedHoldP,9);assert.equal(a.inspection.activeEstimatedP,0);assert.equal(b.inspection.plannedHoldP,0);assert.equal(b.inspection.activeEstimatedP,9);assert.equal(a.inspection.totalProjectedP,9);assert.equal(b.inspection.totalProjectedP,9);
});
test('publication review: unknown observation never removes active or completed paper budget',()=>{
 for(const previousStatus of ['在拆','拆空']){const a=U.computeUnloadEffect(input({status:previousStatus})),b=U.computeUnloadEffect(input({status:'未读取',previous:a.nextLedger}));assert.equal(b.ok,true);assert.equal(b.nextLedger.highestPhase,a.nextLedger.highestPhase);assert.equal(pSum(b.nextLedger.reservations),14);assert.equal(b.nextLedger.autoAllocationBlocked,true);assert.equal(pSum(b.nextLedger.unresolved),previousStatus==='拆空'?9:0);}
});
