'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Photo = require('./photo_intake_core.js');
const Ops = require('./operations_engine.js');
const Unload = require('./unload_engine.js');
const NOW = '2026-11-02T23:00:00Z', CAB = 'DEMU1001005';
const clone = value => JSON.parse(JSON.stringify(value));
const sum = state => state.inventory.reduce((n, row) => n + row.physicalP, 0);
function fixture() {
  const state = { schemaVersion:1, version:40, inventoryVersion:12, baseline:{confirmed:true,version:'BASE',asOf:'2026/10/29 收工后',appliedTasks:{}},
    inventory:[{inventoryId:'old-F1',location:'F1',destination:'TEB4',shipmentId:'',physicalP:24,occupiedSlots:null,slotBasis:'unknown',capacitySlots:27},
      {inventoryId:'old-G1',location:'G1',destination:'AKR1',shipmentId:'',physicalP:8,occupiedSlots:null,slotBasis:'unknown',capacitySlots:27}],
    capacityCatalog:{F1:{location:'F1',capacitySlots:27},F2:{location:'F2',capacitySlots:27},G1:{location:'G1',capacitySlots:27}}, tasks:{}, unloadTasks:{},operations:{},receipts:{},counts:{},operationJournal:[]};
  const allocations=[['G01/part01','F1',3],['G01/part02','F2',12]].map(([allocationId,location,estimatedP])=>({allocationId,location,estimatedP,estimatedSlots:estimatedP,taskId:CAB,containerNo:CAB,publicationId:'PAPER',revision:'1',destination:'TEB4',shipmentId:'FBA-TEB4',route:'ordinary',published:true}));
  const effect=Unload.computeUnloadEffect({taskId:CAB,containerNo:CAB,status:'拆空',publicationId:'PAPER',revision:'1',allocations,allowedLocations:['F1','F2','G1']});
  assert.equal(effect.ok,true,JSON.stringify(effect.issues));state.unloadTasks[CAB]={ledger:effect.nextLedger,pending:false};
  return Photo.upgrade({state,now:NOW}).nextState;
}
function image(char='a',extra={}) {return {fileId:'file-'+char,sha256:char.repeat(64),mimeType:'image/jpeg',name:'photo.jpg',url:'https://drive.google.com/file/d/file-'+char+'/view',...extra};}
function register(state=fixture(),override={}) {return Photo.register({state,input:{jobId:'PHOTO-A',requestId:'REQ-A',kind:'receipt',source:'upload',images:[image()],businessDate:'2026-10-30',containerNo:CAB,...override},now:NOW});}
function extract(override={}) {return {kind:'receipt',businessDate:'2026-10-30',containerNo:CAB,allRowsRead:true,items:[{destination:'TEB4',location:null,locationOrder:['F1','F2'],shipmentId:'FBA-TEB4',physicalP:17,quantityBasis:'actual',note:'手写17P，先F1再F2'}],scopeLocations:[],explicitEmptyLocations:[],scopeComplete:false,totalP:17,issues:[],summary:'合计17P',...override};}
function apply(reg=register(),extraction=extract(),extra={}) {return Photo.applyExtraction({state:reg.nextState,jobId:reg.job.jobId,expectedRevision:reg.job.revision,extraction,now:NOW,...extra});}
function countReg(state=fixture(),extra={}) {return register(state,{kind:'count',containerNo:'',...extra});}
function countExt(extra={}) {return extract({kind:'count',containerNo:null,items:[{destination:'TEB4',location:'F1',locationOrder:[],shipmentId:'',physicalP:24,quantityBasis:'actual',note:''}],scopeLocations:['F1'],totalP:24,...extra});}

test('photo core: signature rejects prototype IDs and malformed image hashes without changing inventory',()=>{
 const state=fixture();for(const extra of [{jobId:'__proto__'},{requestId:'constructor'},{images:[image('z')]}]){const r=register(state,extra);assert.equal(r.ok,false);assert.equal(sum(r.nextState),32);assert.deepEqual(state.photoIntake.jobs,{});}
});
test('photo core: retrying an identical image under another filename follows the original job',()=>{
 const first=register(),second=register(first.nextState,{jobId:'PHOTO-B',requestId:'REQ-B',images:[image('a',{name:'renamed.jpg',fileId:'new-file',url:'https://drive.google.com/file/d/new-file/view'})]});
 assert.equal(second.ok,true);assert.equal(second.job.jobId,'PHOTO-A');assert.equal(Object.keys(second.nextState.photoIntake.jobs).length,1);assert.equal(sum(second.nextState),32);
});
test('photo core: partial overlap across upload groups cannot silently create a second receipt',()=>{
 const first=register(),second=register(first.nextState,{jobId:'PHOTO-B',requestId:'REQ-B',images:[image(),image('b')]});assert.equal(second.ok,false);assert.equal(second.issues[0].code,'PHOTO_DUPLICATE_REVIEW');
});
test('photo core: duplicate image in one submission is review instead of twice the image count',()=>{
 const r=register(undefined,{images:[image(),image()]});assert.equal(r.ok,false);assert.equal(r.issues[0].code,'PHOTO_IMAGE_REPEATED');
});
test('photo core: sequential receipt binds frozen published quota and does not use later free space',()=>{
 const r=apply();assert.equal(r.job.stage,'ready',JSON.stringify(r.issues));const built=Photo.buildOperation({state:r.nextState,jobId:'PHOTO-A'});assert.equal(built.ok,true);assert.deepEqual(built.operation.items[0].allocationIds,['G01/part01','G01/part02']);
 r.nextState.inventory[0].physicalP=0;const effect=Ops.computeOperation({state:r.nextState,operation:built.operation,now:NOW});assert.equal(effect.ok,true,JSON.stringify(effect.issues));const receipt=effect.nextState.receipts[CAB+'|2026-10-30'];assert.deepEqual(receipt.items.map(row=>[row.location,row.physicalP]),[['F1',3],['F2',14]]);
});
test('photo core: same sequential receipt photographed again reuses durable old receipt operation',()=>{
 const first=apply(),built=Photo.buildOperation({state:first.nextState,jobId:'PHOTO-A'}),posted=Ops.computeOperation({state:first.nextState,operation:built.operation,now:NOW});assert.equal(posted.ok,true);
 const next=register(posted.nextState,{jobId:'PHOTO-B',requestId:'REQ-B',images:[image('b')]});const again=apply(next);assert.equal(again.job.stage,'posted',JSON.stringify(again.issues));assert.equal(again.job.operationId,'PHOTO-A');assert.equal(sum(again.nextState),49);
});
test('photo core: receipt paper theory and actual combined total disagree requires review',()=>{
 const r=apply(undefined,extract({totalP:15}));assert.equal(r.job.stage,'review');assert.ok(r.job.issues.some(i=>i.code==='PHOTO_TOTAL_CONFLICT'));assert.equal(sum(r.nextState),32);
});
test('photo core: repeated same item across overlapping photos is not merged by summing',()=>{
 const ext=extract();ext.items.push(clone(ext.items[0]));ext.totalP=34;const r=apply(undefined,ext);assert.equal(r.job.stage,'review');assert.ok(r.job.issues.some(i=>i.code==='PHOTO_OVERLAPPING_ROWS'));
});
test('photo core: unrelated live location cannot be invented by image recognition',()=>{
 const r=apply(undefined,extract({items:[{destination:'TEB4',location:'F99',locationOrder:[],shipmentId:'',physicalP:17,quantityBasis:'actual',note:''}]}));assert.equal(r.job.stage,'review');assert.ok(r.job.issues.some(i=>i.code==='PHOTO_LOCATION_UNKNOWN'));
});
test('photo core: full night photo explicitly stating only empty F2 can produce zero-scoped preview',()=>{
 const r=apply(countReg(),countExt({items:[],scopeLocations:['F2'],explicitEmptyLocations:['F2'],totalP:0}));assert.equal(r.job.stage,'ready',JSON.stringify(r.issues));assert.deepEqual(r.job.extraction.items.map(i=>[i.location,i.physicalP]),[['F2',0]]);
 const requested=Photo.requestPreview({state:r.nextState,input:{jobId:'PHOTO-A',expectedRevision:r.job.revision,completeScopeConfirmed:true},now:NOW});assert.equal(requested.ok,true);
 const built=Photo.buildOperation({state:requested.nextState,jobId:'PHOTO-A'});assert.equal(built.ok,true);assert.deepEqual(built.operation.scopeLocations,['F2']);assert.equal(built.operation.completeScope,true);assert.equal(sum(requested.nextState),32);
});
test('photo core: night count cannot use combined F1/F2 quantity to close each lane',()=>{
 const r=apply(countReg(),countExt({items:[{destination:'TEB4',location:null,locationOrder:['F1','F2'],shipmentId:'',physicalP:17,quantityBasis:'actual',note:''}],scopeLocations:['F1','F2'],totalP:17}));assert.equal(r.job.stage,'review');assert.ok(r.issues.some(i=>i.code==='PHOTO_COUNT_SPLIT_REQUIRED'));
});
test('photo core: explicit empty and positive cargo in same night location conflict',()=>{
 const r=apply(countReg(),countExt({explicitEmptyLocations:['F1']}));assert.equal(r.job.stage,'review');assert.ok(r.issues.some(i=>i.code==='PHOTO_EMPTY_CONFLICT'));
});
test('photo core: night model scopeComplete flag is not a user confirmation',()=>{
 const r=apply(countReg(),countExt({scopeComplete:true}));assert.equal(r.job.stage,'ready');const built=Photo.buildOperation({state:r.nextState,jobId:'PHOTO-A'});assert.equal(built.operation.completeScope,false);
 const request=Photo.requestPreview({state:r.nextState,input:{jobId:'PHOTO-A',expectedRevision:r.job.revision,completeScopeConfirmed:false},now:NOW});assert.equal(request.ok,false);
});
test('photo core: clear explanation retries same source without losing evidence or creating receipt',()=>{
 const reg=register(undefined,{businessDate:''}),bad=apply(reg,extract({businessDate:null}));assert.equal(bad.job.stage,'review');
 const fixed=Photo.clarify({state:bad.nextState,input:{jobId:'PHOTO-A',expectedRevision:bad.job.revision,businessDate:'2026-10-30',clarification:'这是10月30日的回单'},now:NOW});assert.equal(fixed.job.stage,'uploaded');assert.deepEqual(fixed.job.images,bad.job.images);assert.equal(fixed.job.operationId,'PHOTO-A');assert.equal(Object.keys(fixed.nextState.photoIntake.jobs).length,1);assert.equal(sum(fixed.nextState),32);
});
test('photo core: adopted night needs authoritative count plus count operation proof',()=>{
 const r=apply(countReg(),countExt()),state=r.nextState;state.counts['PHOTO-A']={operationId:'PHOTO-A'};let result=Photo.reconcileJobs({state,now:NOW});assert.notEqual(result.nextState.photoIntake.jobs['PHOTO-A'].stage,'adopted');
 state.operations['PHOTO-A']={type:'count',recordedAt:NOW};result=Photo.reconcileJobs({state,now:NOW});assert.equal(result.nextState.photoIntake.jobs['PHOTO-A'].stage,'adopted');assert.equal(sum(result.nextState),32);
});
test('photo core: inventory changed after preview requires a new difference preview',()=>{
 const r=apply(countReg(),countExt()),state=r.nextState,job=state.photoIntake.jobs['PHOTO-A'];job.stage='previewed';job.completeScopeConfirmed=true;job.preview={token:'TOKEN',inventoryVersion:12};state.inventoryVersion=13;
 const result=Photo.requestAdoption({state,input:{jobId:'PHOTO-A',expectedRevision:job.revision,previewToken:'TOKEN'},now:NOW});assert.equal(result.ok,false);assert.equal(result.issues[0].code,'PHOTO_PREVIEW_STALE');
});
test('photo core: metadata-only version advancement does not turn identical inventory preview into a different count',()=>{
 const r=apply(countReg(),countExt()),state=r.nextState,job=state.photoIntake.jobs['PHOTO-A'];job.stage='previewed';job.completeScopeConfirmed=true;job.preview={token:'TOKEN',inventoryVersion:12,stateVersion:40};state.version=42;
 const result=Photo.requestAdoption({state,input:{jobId:'PHOTO-A',expectedRevision:job.revision,previewToken:'TOKEN'},now:NOW});assert.equal(result.ok,true);assert.equal(result.job.stage,'adopt_requested');assert.equal(sum(result.nextState),32);
});
test('photo core: pending unknown-location receipt conservatively blocks count adoption scope',()=>{
 const reg=register(),pending=Photo.unsettledReceiptJobs({state:reg.nextState,businessDate:'2026-10-30',scopeLocations:['G1']});assert.deepEqual(pending.map(j=>j.jobId),['PHOTO-A']);
 const known=apply(reg),unrelated=Photo.unsettledReceiptJobs({state:known.nextState,businessDate:'2026-10-30',scopeLocations:['G1']});assert.deepEqual(unrelated,[]);
 const future=Photo.unsettledReceiptJobs({state:reg.nextState,businessDate:'2026-10-29',scopeLocations:['F1']});assert.deepEqual(future,[]);
});
test('photo core: backend posted text without authoritative receipt and operation cannot mark photo posted',()=>{
 const reg=register(),external=[{operationId:'OLD',containerNo:CAB,businessDate:'2026-10-30',items:[{destination:'TEB4',locationOrder:['F1','F2'],shipmentId:'FBA-TEB4',physicalP:17}],posted:true}];
 const r=apply(reg,extract(),{existingReceipts:external});assert.equal(r.job.stage,'review');assert.ok(r.issues.some(i=>i.code==='PHOTO_RECEIPT_PROOF_MISSING'));assert.equal(sum(r.nextState),32);
});
test('photo core: settled photo ledger reconciliation is idempotent and does not keep increasing task revision',()=>{
 const ready=apply(),built=Photo.buildOperation({state:ready.nextState,jobId:'PHOTO-A'}),effect=Ops.computeOperation({state:ready.nextState,operation:built.operation,now:NOW});const first=Photo.reconcileJobs({state:effect.nextState,now:NOW}),second=Photo.reconcileJobs({state:first.nextState,now:NOW});assert.equal(second.noOp,true);assert.equal(second.nextState.photoIntake.jobs['PHOTO-A'].revision,first.nextState.photoIntake.jobs['PHOTO-A'].revision);assert.equal(sum(second.nextState),49);
});
test('photo core: unposted receipt under AI review can be retried only with verified server authorization',()=>{
 const prepared=apply(),state=prepared.nextState,job=state.photoIntake.jobs['PHOTO-A'];job.stage='posting';state.operationPending={'PHOTO-A':{code:'AI_REVIEW',inputHash:'review-hash'}};
 const input={jobId:'PHOTO-A',expectedRevision:job.revision,clarification:'补充清晰图片，并核对实际17P'};
 const forged=Photo.clarify({state,input:{...input,authorizedUnpostedReceiptRetry:true},now:NOW});assert.equal(forged.ok,false);
 const allowed=Photo.clarify({state,input,authorizedUnpostedReceiptRetry:true,now:NOW});assert.equal(allowed.ok,true);assert.equal(allowed.job.stage,'uploaded');assert.equal(allowed.job.operationId,'PHOTO-A');assert.equal(sum(allowed.nextState),32);assert.deepEqual(allowed.nextState.operationPending,state.operationPending);assert.equal(state.photoIntake.jobs['PHOTO-A'].stage,'posting');
});
test('photo core: server draft retry flag cannot reopen formally posted receipt even when projection says posting',()=>{
 const ready=apply(),built=Photo.buildOperation({state:ready.nextState,jobId:'PHOTO-A'}),effect=Ops.computeOperation({state:ready.nextState,operation:built.operation,now:NOW}),state=effect.nextState,job=state.photoIntake.jobs['PHOTO-A'];job.stage='posting';state.operationPending={'PHOTO-A':{code:'AI_REVIEW'}};
 const result=Photo.clarify({state,input:{jobId:'PHOTO-A',expectedRevision:job.revision,clarification:'尝试重传'},authorizedUnpostedReceiptRetry:true,now:NOW});assert.equal(result.ok,false);assert.equal(sum(result.nextState),49);assert.deepEqual(result.nextState.receipts,state.receipts);
});
test('photo core: verified server retry also recognizes same unposted backend draft before an AI-pending marker exists',()=>{
 const ready=apply(),state=ready.nextState,job=state.photoIntake.jobs['PHOTO-A'];job.stage='posting';
 const input={jobId:'PHOTO-A',expectedRevision:job.revision,clarification:'更清楚的回单'};
 assert.equal(Photo.clarify({state,input,authorizedUnpostedReceiptRetry:true,now:NOW}).ok,false);
 const existingReceipts=[{operationId:'PHOTO-A',containerNo:CAB,businessDate:job.businessDate,items:[],posted:false}];
 const result=Photo.clarify({state,input,existingReceipts,authorizedUnpostedReceiptRetry:true,now:NOW});assert.equal(result.ok,true);assert.equal(result.job.operationId,'PHOTO-A');assert.equal(sum(result.nextState),32);
});
test('photo core: cancelling an unmaterialized mistaken photo preserves evidence and ceases blocking night counts',()=>{
 const reg=register(),state=reg.nextState,job=state.photoIntake.jobs['PHOTO-A'];job.stage='review';job.issues=[{code:'UNCLEAR',message:'照片不清晰',severity:'error'}];job.imageHistory=[{images:[image('b')]}];
 const cancelled=Photo.cancel({state,input:{jobId:'PHOTO-A',expectedRevision:job.revision},now:NOW});assert.equal(cancelled.ok,true);assert.equal(cancelled.job.stage,'cancelled');assert.equal(sum(cancelled.nextState),32);assert.deepEqual(cancelled.job.images,job.images);assert.deepEqual(cancelled.job.issues,job.issues);assert.deepEqual(cancelled.job.imageHistory,job.imageHistory);assert.deepEqual(Photo.unsettledReceiptJobs({state:cancelled.nextState,businessDate:'2026-10-30',scopeLocations:['F1']}),[]);
 assert.equal(Photo.clarify({state:cancelled.nextState,input:{jobId:'PHOTO-A',expectedRevision:cancelled.job.revision,clarification:'重新识别'},now:NOW}).ok,false);assert.equal(Photo.applyExtraction({state:cancelled.nextState,jobId:'PHOTO-A',expectedRevision:cancelled.job.revision,extraction:extract(),now:NOW}).ok,false);
});
test('photo core: cancellation is refused after materialization or any processing and terminal stage',()=>{
 for(const stage of ['recognizing','posting','preview_requested','previewed','adopt_requested','posted','adopted','cancelled']){const r=register(),job=r.nextState.photoIntake.jobs['PHOTO-A'];job.stage=stage;const out=Photo.cancel({state:r.nextState,input:{jobId:'PHOTO-A',expectedRevision:job.revision},now:NOW});assert.equal(out.ok,false,stage);assert.equal(sum(out.nextState),32);}
 const r=register(),job=r.nextState.photoIntake.jobs['PHOTO-A'];job.stage='ready';job.materialized=true;assert.equal(Photo.cancel({state:r.nextState,input:{jobId:'PHOTO-A',expectedRevision:job.revision},now:NOW}).ok,false);
});
test('photo core: falsely editable projection cannot cancel a formal receipt, operation, or count',()=>{
 for(const proof of ['receipt','operation','count']){const r=register(),st=r.nextState,job=st.photoIntake.jobs['PHOTO-A'];job.stage='ready';if(proof==='receipt')st.receipts[CAB+'|2026-10-30']={operationId:'OLD-PHYSICAL',containerNo:CAB,businessDate:'2026-10-30'};if(proof==='operation')st.operations['PHOTO-A']={type:'receipt'};if(proof==='count')st.counts['PHOTO-A']={operationId:'PHOTO-A'};const out=Photo.cancel({state:st,input:{jobId:'PHOTO-A',expectedRevision:job.revision},now:NOW});assert.equal(out.ok,false,proof);assert.equal(sum(out.nextState),32);}
});
test('photo core: cancellation after successful recognition blocks a stale materializer from building a physical operation',()=>{
 const ready=apply(),cancelled=Photo.cancel({state:ready.nextState,input:{jobId:'PHOTO-A',expectedRevision:ready.job.revision,reason:'选错照片'},now:NOW});assert.equal(cancelled.ok,true);assert.equal(cancelled.job.cancelReason,'选错照片');const built=Photo.buildOperation({state:cancelled.nextState,jobId:'PHOTO-A'});assert.equal(built.ok,false);assert.equal(built.issues[0].code,'PHOTO_CANCELLED');assert.equal(sum(cancelled.nextState),32);
});
