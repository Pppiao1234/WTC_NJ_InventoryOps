'use strict';
// Independent stock-flow integration review; local pure modules only.
const test = require('node:test');
const assert = require('node:assert/strict');
const Ops = require('./operations_engine.js');
const Load = require('./engine.js');
const Unload = require('./unload_engine.js');

const NOW = '2026-10-30T17:00:00.000Z';
const copy = value => JSON.parse(JSON.stringify(value));
const sum = state => state.inventory.reduce((total, row) => total + row.physicalP, 0);
function allocation(id, taskId, containerNo, location, destination, p) {
  return { allocationId:id, taskId, containerNo, publicationId:'PAPER-QA', revision:'1',
    destination, shipmentId:'', location, route:'ordinary', estimatedP:p, estimatedSlots:p, published:true };
}
function fixture() {
  const first=allocation('20261030-DEMU1001001-G01/part01','DEMU1001001','DEMU1001001','C1','TEB4',4);
  const second=allocation('20261030-DEMU1001002-G01/part01','DEMU1001002','DEMU1001002','C1','TEB4',3);
  const state={schemaVersion:1,version:10,inventoryVersion:4,
    baseline:{confirmed:true,version:'BASE-20261029',asOf:'2026/10/29 收工后',sourceVersion:'QA',appliedTasks:{}},
    inventory:[{inventoryId:'old-C1',location:'C1',destination:'TEB4',shipmentId:'',physicalP:14,occupiedSlots:null,slotBasis:'unknown',capacitySlots:27},
      {inventoryId:'private-B1',location:'B1',destination:'PRIVATE',shipmentId:'private-ticket',physicalP:8,occupiedSlots:null,slotBasis:'unknown',capacitySlots:20}],
    tasks:{},unloadTasks:{},capacityCatalog:{C1:{location:'C1',status:'有货',capacitySlots:27},C2:{location:'C2',status:'空位',physicalP:0,capacitySlots:27},B1:{location:'B1',status:'有货',capacitySlots:20}},
    lastCheckedAt:'',lastCommittedAt:'',lastError:''};
  for(const row of [first,second]) {
    const effect=Unload.computeUnloadEffect({taskId:row.taskId,containerNo:row.containerNo,status:'拆空',publicationId:'PAPER-QA',revision:'1',allocations:[row],allowedLocations:['C1','C2','B1']});
    assert.equal(effect.ok,true,JSON.stringify(effect.issues));
    state.unloadTasks[row.taskId]={ledger:effect.nextLedger,pending:false,observedStatus:'拆空'};
  }
  return {state,first,second};
}
function receipt(override={}) {
  return Object.assign({type:'receipt',operationId:'RECEIPT-DEMU1001001-v1',containerNo:'DEMU1001001',businessDate:'2026-10-30',sourceRef:'photo-one',
    items:[{location:'C1',destination:'TEB4',shipmentId:'',physicalP:5,allocationIds:['20261030-DEMU1001001-G01/part01']}]},override);
}
function run(state,operation) { return Ops.computeOperation({state,operation,now:NOW}); }
function success(effect) { assert.equal(effect.ok,true,JSON.stringify(effect.issues));assert.equal(effect.blocked,false,JSON.stringify(effect.issues));return effect.nextState; }
function loadEffect(state,actual,previous) {
  return Load.computeLoadingEffect({taskId:'load-1',status:'已结束',plannedText:'C1 TEB4:8',actualText:`C1 TEB4:${actual}`,
    inventory:state.inventory,baseline:state.baseline,previous:previous||state.tasks['load-1']?.ledger,
    allowedLocations:Object.keys(state.capacityCatalog),otherTaskPlans:[],allowSameDestinationLots:true});
}
function countOperation(override={}) {
  return Object.assign({type:'count',operationId:'COUNT-20261030',countId:'COUNT-20261030',businessDate:'2026-10-30',
    scopeLocations:['C1','C2'],completeScope:true,acceptDifferences:true,
    counts:[{location:'C1',destination:'TEB4',shipmentId:'',physicalP:12}]},override);
}

test('ops review: receipt adds measured physical quantities and removes only its own estimates',()=>{
  const {state,second}=fixture(),before=copy(state),next=success(run(state,receipt()));
  assert.equal(sum(next),sum(state)+5);assert.deepEqual(state,before);
  const own=next.unloadTasks.DEMU1001001.ledger,other=next.unloadTasks.DEMU1001002.ledger;
  assert.ok(!(own.reservations||[]).some(row=>row.allocationId==='20261030-DEMU1001001-G01/part01'));
  assert.ok(other.reservations.some(row=>row.allocationId===second.allocationId&&row.estimatedP===3));
  assert.ok(next.inventory.some(row=>row.inventoryId==='old-C1'&&row.physicalP===14));
  assert.ok(next.inventory.filter(row=>row.physicalP>0&&row.location==='C1').every(row=>row.occupiedSlots===null));
});

test('ops review: replaying a committed receipt does not add stock or advance inventory version',()=>{
  const first=success(run(fixture().state,receipt())),repeat=run(first,receipt());
  assert.equal(repeat.ok,true);assert.equal(repeat.noOp,true);assert.equal(sum(repeat.nextState),sum(first));
  assert.equal(repeat.nextState.inventoryVersion,first.inventoryVersion);
});

test('ops review: same physical receipt with another photo and operation ID is still one receipt',()=>{
  const first=success(run(fixture().state,receipt())),repeat=run(first,receipt({operationId:'another-upload',sourceRef:'photo-two'}));
  assert.equal(repeat.ok,true);assert.equal(repeat.noOp,true);assert.equal(sum(repeat.nextState),sum(first));
});

test('ops review: changed counts for a previously posted physical receipt are blocked',()=>{
  const first=success(run(fixture().state,receipt())),before=copy(first),changed=receipt({operationId:'changed-photo',items:[{location:'C1',destination:'TEB4',physicalP:7,allocationIds:['20261030-DEMU1001001-G01/part01']}]});
  const effect=run(first,changed);assert.equal(effect.blocked,true);assert.deepEqual(first,before);
  assert.equal(sum(effect.nextState||first),sum(first));
});

test('ops review: a receipt cannot revoke another container allocation',()=>{
  const {state}=fixture(),before=copy(state),effect=run(state,receipt({items:[{location:'C1',destination:'TEB4',physicalP:5,allocationIds:['20261030-DEMU1001002-G01/part01']}]}));
  assert.equal(effect.blocked,true);assert.deepEqual(state,before);
});

test('ops review: measured stock is retained when a conservative quantity exceeds lane capacity',()=>{
  const {state}=fixture(),next=success(run(state,receipt({items:[{location:'C1',destination:'TEB4',physicalP:30,allocationIds:['20261030-DEMU1001001-G01/part01']}]})));
  assert.equal(sum(next),sum(state)+30);assert.ok(next.inventory.filter(row=>row.location==='C1').every(row=>row.occupiedSlots===null));
});

test('ops review: office/private receipt scope cannot silently enter this ordinary-lane module',()=>{
  const {state}=fixture(),effect=run(state,receipt({items:[{location:'office',destination:'PRIVATE',physicalP:5,allocationIds:['20261030-DEMU1001001-G01/part01']}]}));
  assert.equal(effect.blocked,true);assert.equal(sum(effect.nextState||state),sum(state));
});

test('ops review: moving a partial lot conserves warehouse quantity and preserves old location identity',()=>{
  const {state}=fixture(),next=success(run(state,{type:'move',operationId:'MOVE-1',businessDate:'2026-10-30',sourceLocation:'C1',targetLocation:'C2',destination:'TEB4',physicalP:5,sourceRef:'QA move'}));
  assert.equal(sum(next),sum(state));assert.equal(next.inventory.find(row=>row.inventoryId==='old-C1').location,'C1');
  assert.equal(next.inventory.find(row=>row.inventoryId==='old-C1').physicalP,9);
  assert.equal(next.inventory.filter(row=>row.location==='C2').reduce((total,row)=>total+row.physicalP,0),5);
});

test('ops review: an empty original moved lot remains available to historical loading ledgers',()=>{
  const {state}=fixture(),next=success(run(state,{type:'move',operationId:'MOVE-ALL',businessDate:'2026-10-30',sourceLocation:'C1',targetLocation:'C2',destination:'TEB4',physicalP:14}));
  assert.equal(next.inventory.find(row=>row.inventoryId==='old-C1').physicalP,0);assert.equal(sum(next),sum(state));
});

test('ops review: repeated moves and overdraws cannot alter stock twice or partly',()=>{
  const {state}=fixture(),op={type:'move',operationId:'MOVE-ONE',businessDate:'2026-10-30',sourceLocation:'C1',targetLocation:'C2',destination:'TEB4',physicalP:5};
  const next=success(run(state,op)),repeat=run(next,op);assert.equal(repeat.noOp,true);assert.deepEqual(repeat.nextState.inventory,next.inventory);
  const before=copy(next),bad=run(next,{...op,operationId:'MOVE-OVERDRAW',physicalP:50});assert.equal(bad.blocked,true);assert.deepEqual(next,before);
});

test('ops review: a count preview exposes differences and cannot change inventory',()=>{
  const {state}=fixture(),before=copy(state),report=Ops.reconcile({state,operation:countOperation()});
  assert.equal(report.ok,true,JSON.stringify(report.issues));assert.ok(report.rows.some(row=>row.location==='C1'&&row.expectedP===14&&row.actualP===12&&row.differenceP===-2));
  assert.deepEqual(state,before);
});

test('ops review: incomplete night-count scope cannot zero unobserved inventory',()=>{
  const {state}=fixture(),before=copy(state),effect=run(state,countOperation({completeScope:false}));
  assert.equal(effect.blocked,true);assert.deepEqual(state,before);
});

test('ops review: a night-count discrepancy needs an explicit acceptance to change physical stock',()=>{
  const {state}=fixture(),effect=run(state,countOperation({acceptDifferences:false}));
  assert.equal(effect.blocked,true);assert.equal(sum(effect.nextState||state),sum(state));
});

test('ops review: accepted night count preserves every region outside its declared scope',()=>{
  const {state}=fixture(),beforePrivate=copy(state.inventory.find(row=>row.inventoryId==='private-B1'));
  const next=success(run(state,countOperation()));assert.equal(sum(next),20);
  assert.deepEqual(next.inventory.find(row=>row.inventoryId==='private-B1'),beforePrivate);
  assert.equal(next.inventory.find(row=>row.inventoryId==='old-C1').location,'C1');
});

test('ops review: explicit complete scope can confirm a counted empty lane without deleting its lot IDs',()=>{
  const {state}=fixture(),next=success(run(state,countOperation({counts:[]})));
  assert.equal(next.inventory.find(row=>row.inventoryId==='old-C1').physicalP,0);
  assert.equal(next.inventory.find(row=>row.inventoryId==='private-B1').physicalP,8);
});

test('ops review: receipt then ordinary multi-lot loading stays usable and cumulative 6 to 8 deducts only 2',()=>{
  const initial=success(run(fixture().state,receipt())),loaded=loadEffect(initial,6);
  assert.equal(loaded.ok,true,JSON.stringify(loaded.issues));assert.equal(sum({inventory:loaded.inventoryAfter}),sum(initial)-6);
  const after={...initial,inventory:loaded.inventoryAfter,tasks:{'load-1':{ledger:loaded.nextLedger}}};
  const increased=loadEffect(after,8);assert.equal(increased.ok,true,JSON.stringify(increased.issues));
  assert.equal(sum({inventory:increased.inventoryAfter}),sum(after)-2);
  assert.equal(increased.actualDeltas.reduce((total,row)=>total+row.physicalP,0),2);
});

test('ops review: night count carries historical loading cumulative across the new baseline',()=>{
  const {state}=fixture(),loaded=loadEffect(state,6);assert.equal(loaded.ok,true,JSON.stringify(loaded.issues));
  state.inventory=loaded.inventoryAfter;state.tasks['load-1']={ledger:loaded.nextLedger,committedAccountingHash:'committed'};
  const next=success(run(state,countOperation({counts:[{location:'C1',destination:'TEB4',shipmentId:'',physicalP:7}]})));
  assert.notEqual(next.baseline.version,state.baseline.version);
  assert.equal(next.tasks['load-1'].ledger.baselineVersion,next.baseline.version);
  assert.equal(next.tasks['load-1'].ledger.actual.reduce((total,row)=>total+row.physicalP,0),6);
  const same=loadEffect(next,6);assert.equal(same.ok,true,JSON.stringify(same.issues));assert.equal(same.actualDeltas.reduce((total,row)=>total+row.physicalP,0),0);
  assert.equal(sum({inventory:same.inventoryAfter}),sum(next));
  const increased=loadEffect({...next,inventory:same.inventoryAfter},8,same.nextLedger);
  assert.equal(increased.ok,true,JSON.stringify(increased.issues));assert.equal(sum({inventory:increased.inventoryAfter}),sum(next)-2);
});

test('ops review: receipt deduplication survives a night-count baseline transition',()=>{
  const posted=success(run(fixture().state,receipt())),counted=success(run(posted,countOperation({counts:[{location:'C1',destination:'TEB4',physicalP:19}]})));
  const repeat=run(counted,receipt({operationId:'later-copy',sourceRef:'later-photo'}));assert.equal(repeat.noOp,true);assert.equal(sum(repeat.nextState),sum(counted));
});

test('ops review: a late prior-day count cannot erase already recorded next-day physical flows',()=>{
  const {state}=fixture(),later=success(run(state,{type:'receipt',operationId:'RECEIPT-NEXT-DAY',containerNo:'DEMU1001002',businessDate:'2026-10-31',sourceRef:'next-day-photo',
    items:[{location:'C1',destination:'TEB4',physicalP:3,allocationIds:['20261030-DEMU1001002-G01/part01']}]}));
  const before=copy(later),effect=run(later,countOperation());assert.equal(effect.blocked,true);
  assert.deepEqual(later,before);assert.equal(sum(effect.nextState||later),sum(later));
});

test('ops review: an inferred allocation binding remains idempotent after its first commit',()=>{
  const {state}=fixture(),op=receipt({items:[{location:'C1',destination:'TEB4',shipmentId:'',physicalP:5}]}),posted=success(run(state,op));
  const repeated=run(posted,op);assert.equal(repeated.ok,true,JSON.stringify(repeated.issues));assert.equal(repeated.noOp,true);assert.equal(sum(repeated.nextState),sum(posted));
  const reuploaded=run(posted,{...op,operationId:'different-photo-id',sourceRef:'another-photo'});
  assert.equal(reuploaded.ok,true,JSON.stringify(reuploaded.issues));assert.equal(reuploaded.noOp,true);assert.equal(sum(reuploaded.nextState),sum(posted));
});

test('ops review: first-fill sequential receipt allocates 17P as 3 and 14 without inventing measured occupancy',()=>{
  const {state}=fixture();state.inventory=[{inventoryId:'initial-F1',location:'F1',destination:'TEB4',shipmentId:'',physicalP:24,occupiedSlots:null,slotBasis:'unknown',capacitySlots:27},
    {inventoryId:'empty-F2',location:'F2',destination:'',shipmentId:'',physicalP:0,occupiedSlots:0,slotBasis:'explicit',capacitySlots:27}];
  state.capacityCatalog={F1:{location:'F1',status:'有货',capacitySlots:27},F2:{location:'F2',status:'空位',physicalP:0,capacitySlots:27}};
  const parts=[allocation('20261030-DEMU1001005-TEB4/part01','DEMU1001005','DEMU1001005','F1','TEB4',3),allocation('20261030-DEMU1001005-TEB4/part02','DEMU1001005','DEMU1001005','F2','TEB4',12)];
  const ledger=Unload.computeUnloadEffect({taskId:'DEMU1001005',containerNo:'DEMU1001005',status:'拆空',publicationId:'PAPER-QA',revision:'1',allocations:parts,allowedLocations:['F1','F2']});
  assert.equal(ledger.ok,true,JSON.stringify(ledger.issues));state.unloadTasks={DEMU1001005:{ledger:ledger.nextLedger,pending:false}};
  const op={type:'receipt',operationId:'RECEIPT-782-FILL',containerNo:'DEMU1001005',businessDate:'2026-10-30',sourceRef:'IMG_4304.jpeg',
    items:[{locationOrder:['F1','F2'],destination:'TEB4',physicalP:17,allocationIds:parts.map(row=>row.allocationId)}]};
  const posted=success(run(state,op)),lots=posted.inventory.filter(row=>row.receiptKey==='DEMU1001005|2026-10-30');
  assert.equal(sum(posted),41);assert.equal(lots.find(row=>row.location==='F1').physicalP,3);assert.equal(lots.find(row=>row.location==='F2').physicalP,14);
  assert.ok(lots.every(row=>row.occupiedSlots===null&&/非逐线实测/.test(row.allocationBasis)));
  const moved=success(run(posted,{type:'move',operationId:'MOVE-AFTER-782',businessDate:'2026-10-30',sourceLocation:'F1',targetLocation:'F2',destination:'TEB4',physicalP:2}));
  const repeated=run(moved,{...op,operationId:'new-photo-782',sourceRef:'new-photo.jpg'});assert.equal(repeated.ok,true,JSON.stringify(repeated.issues));assert.equal(repeated.noOp,true);
  assert.deepEqual(repeated.nextState.inventory,moved.inventory);
});

test('ops review: closing one counted lane cannot close an uncounted lane for the whole warehouse',()=>{
  const {state}=fixture(),other=state.unloadTasks.DEMU1001002.ledger;
  other.publishedAllocations.forEach(row=>row.location='C2');other.reservations.forEach(row=>row.location='C2');
  const first=success(run(state,countOperation({operationId:'CLOSE-C1',countId:'CLOSE-C1',scopeLocations:['C1'],counts:[{location:'C1',destination:'TEB4',physicalP:14}]})));
  const effect=run(first,{type:'receipt',operationId:'UNCOUNTED-C2',businessDate:'2026-10-30',containerNo:'DEMU1001002',sourceRef:'C2 photo',
    items:[{location:'C2',destination:'TEB4',physicalP:3,allocationIds:['20261030-DEMU1001002-G01/part01']}]});
  const next=success(effect);assert.equal(sum(next),sum(first)+3);
});

test('ops review: independently counted lanes can be accepted on the same business day',()=>{
  const {state}=fixture(),first=success(run(state,countOperation({operationId:'CLOSE-C1',countId:'CLOSE-C1',scopeLocations:['C1'],counts:[{location:'C1',destination:'TEB4',physicalP:14}]})));
  const second=success(run(first,countOperation({operationId:'CLOSE-C2',countId:'CLOSE-C2',scopeLocations:['C2'],counts:[]})));
  assert.equal(sum(second),sum(first));assert.equal(Object.keys(second.counts).length,2);
});

test('ops review: a late multi-lane receipt keeps its published split after the first lane was subsequently loaded out',()=>{
  const {state}=fixture();state.inventory=[{inventoryId:'historical-F1',location:'F1',destination:'TEB4',shipmentId:'',physicalP:0,occupiedSlots:0,slotBasis:'explicit',capacitySlots:27},
    {inventoryId:'empty-F2',location:'F2',destination:'',shipmentId:'',physicalP:0,occupiedSlots:0,slotBasis:'explicit',capacitySlots:27}];
  state.capacityCatalog={F1:{location:'F1',status:'空位',physicalP:0,capacitySlots:27},F2:{location:'F2',status:'空位',physicalP:0,capacitySlots:27}};
  state.tasks['later-loaded-F1']={ledger:{taskId:'later-loaded-F1',baselineVersion:state.baseline.version,actual:[{inventoryId:'historical-F1',location:'F1',destination:'TEB4',physicalP:24}],planned:[],projectedRemaining:[]}};
  const parts=[allocation('20261030-DEMU1001005-TEB4/part01','DEMU1001005','DEMU1001005','F1','TEB4',3),allocation('20261030-DEMU1001005-TEB4/part02','DEMU1001005','DEMU1001005','F2','TEB4',12)];
  const unloading=Unload.computeUnloadEffect({taskId:'DEMU1001005',containerNo:'DEMU1001005',status:'拆空',publicationId:'PAPER-QA',revision:'1',allocations:parts,allowedLocations:['F1','F2']});
  assert.equal(unloading.ok,true,JSON.stringify(unloading.issues));state.unloadTasks={DEMU1001005:{ledger:unloading.nextLedger,pending:false}};
  const op={type:'receipt',operationId:'LATE-782-RECEIPT',containerNo:'DEMU1001005',businessDate:'2026-10-30',sourceRef:'IMG_4304.jpeg',
    items:[{locationOrder:['F1','F2'],destination:'TEB4',physicalP:17,allocationIds:parts.map(row=>row.allocationId)}]};
  const posted=success(run(state,op)),lots=posted.inventory.filter(row=>row.receiptKey==='DEMU1001005|2026-10-30');
  assert.equal(lots.find(row=>row.location==='F1').physicalP,3,'later empty F1 cannot rewrite the historical first-lane allocation to 17');
  assert.equal(lots.find(row=>row.location==='F2').physicalP,14);assert.equal(sum(posted),17);
  assert.ok(lots.every(row=>row.occupiedSlots===null&&/发布|纸/.test(row.allocationBasis)&&/非.*实测/.test(row.allocationBasis)));
  assert.equal(posted.inventory.find(row=>row.inventoryId==='historical-F1').physicalP,0);
});
