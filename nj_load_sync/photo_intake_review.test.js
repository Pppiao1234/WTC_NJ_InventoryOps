'use strict';
// Independent photo intake review. All images, inventory and AI results are local fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const Photo = require('./photo_intake_core.js');
const Ops = require('./operations_engine.js');
const Unload = require('./unload_engine.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const copy = v => JSON.parse(JSON.stringify(v));
const NOW = '2026-11-02T23:30:00.000Z';
const CAB = 'DEMU1001001';
const sum = st => st.inventory.reduce((s,r) => s+r.physicalP,0);
const failure = r => r.ok === false || r.job?.stage === 'review' || r.job?.stage === 'error';
function fixture() {
  const st = {schemaVersion:1,version:25,inventoryVersion:7,
    baseline:{confirmed:true,version:'BASE-QA',asOf:'2026/10/29 收工后',sourceVersion:'QA',appliedTasks:{old:{actual:[{physicalP:3}]}}},
    inventory:[{inventoryId:'old-C1',location:'C1',destination:'TEB4',shipmentId:'',physicalP:14,occupiedSlots:null,slotBasis:'unknown',capacitySlots:27},
      {inventoryId:'old-C2',location:'C2',destination:'ABE8',shipmentId:'',physicalP:9,occupiedSlots:null,slotBasis:'unknown',capacitySlots:27}],
    tasks:{historical:{ledger:{actual:[{location:'C1',physicalP:3}],projectedRemaining:[]}}},
    unloadTasks:{},capacityCatalog:{C1:{location:'C1',capacitySlots:27},C2:{location:'C2',capacitySlots:27},C3:{location:'C3',capacitySlots:27}},
    operations:{},receipts:{},counts:{},operationJournal:[],lastCheckedAt:'',lastCommittedAt:'',lastError:''};
  const allocations = [{allocationId:'qa-teb4',taskId:CAB,containerNo:CAB,publicationId:'QA-PAPER',revision:'1',destination:'TEB4',shipmentId:'',location:'C1',route:'ordinary',estimatedP:4,estimatedSlots:4,published:true}];
  const u=Unload.computeUnloadEffect({taskId:CAB,containerNo:CAB,status:'拆空',publicationId:'QA-PAPER',revision:'1',allocations,allowedLocations:['C1','C2','C3']});
  assert.equal(u.ok,true,JSON.stringify(u.issues));st.unloadTasks[CAB]={ledger:u.nextLedger,pending:false,observedStatus:'拆空'};
  const r=Photo.upgrade({state:st,now:NOW});assert.equal(r.ok,true,JSON.stringify(r.issues));return r.nextState;
}
function img(hash='a'.repeat(64),extra={}){return {fileId:'drive-photo-1',sha256:hash,mimeType:'image/jpeg',name:'receipt.jpg',url:'https://drive.google.com/file/d/drive-photo-1/view',...extra};}
function registered(st=fixture(),override={}) {
  const r=Photo.register({state:st,input:{jobId:'PHOTO-QA',requestId:'upload-qa',kind:'receipt',source:'upload',businessDate:'2026-10-30',containerNo:CAB,images:[img()],sourceRefs:['photo://qa'],...override},now:NOW});
  assert.equal(r.ok,true,JSON.stringify(r.issues));return {state:r.nextState,job:r.job};
}
function extraction(override={}) {return {kind:'receipt',businessDate:'2026-10-30',containerNo:CAB,allRowsRead:true,
  items:[{destination:'TEB4',location:'C1',locationOrder:[],shipmentId:'',physicalP:5,quantityBasis:'actual',note:'手写5P'}],
  scopeLocations:[],explicitEmptyLocations:[],scopeComplete:false,totalP:5,issues:[],summary:'回单已完整识别',...override};}
function extracted(st=undefined,ext=extraction(),options={}) {
  const reg=st?{state:st,job:st.photoIntake.jobs['PHOTO-QA']}:registered();
  const r=Photo.applyExtraction({state:reg.state,jobId:reg.job.jobId,expectedRevision:reg.job.revision,extraction:ext,now:NOW,...options});
  return r;
}
function ready(st=undefined,ext=extraction(),options={}){const r=extracted(st,ext,options);assert.equal(r.ok,true,JSON.stringify(r.issues));assert.equal(r.job.stage,'ready',JSON.stringify(r));return r.nextState;}
function operation(st,extra={}){return Photo.buildOperation({state:st,jobId:'PHOTO-QA',...extra});}
function countRegistered(override={}){return registered(fixture(),{kind:'count',businessDate:'2026-10-30',containerNo:'',...override});}
function countExtraction(override={}){return extraction({kind:'count',containerNo:null,
  items:[{destination:'TEB4',location:'C1',locationOrder:[],shipmentId:'',physicalP:12,quantityBasis:'actual',note:'实盘12P'}],
  scopeLocations:['C1'],scopeComplete:false,totalP:12,...override});}
function countReady(ext=countExtraction()) {const r=countRegistered();return ready(r.state,ext);}
function confirmPreview(st){return Photo.requestPreview({state:st,input:{jobId:'PHOTO-QA',expectedRevision:st.photoIntake.jobs['PHOTO-QA'].revision,completeScopeConfirmed:true},now:NOW});}

// Build the existing inventory transaction fixture and add only local Drive/image doubles.
function adapterFixture(options={}) {
 const opsFile=path.join(__dirname,'operations.adapter.test.js');
 let src=fs.readFileSync(opsFile,'utf8');src=src.slice(0,src.indexOf("\ntest('ops adapter:"));
 const harnessMarker="harnessSource+='\\nthis.makeHarness=harness;';";
 assert.ok(src.includes(harnessMarker),'Review shared fixture before changing local deletion double');
 const dimensionTarget='else if(req.appendDimension){',dimensionReplacement="else if(req.deleteDimension){const d=req.deleteDimension.range;assert.equal(d.dimension,'ROWS');staged.get(d.sheetId).splice(d.startIndex,d.endIndex-d.startIndex);dimensions.get(d.sheetId).rows-=d.endIndex-d.startIndex;}else if(req.appendDimension){";
 src=src.replace(harnessMarker,'harnessSource=harnessSource.replace('+JSON.stringify(dimensionTarget)+','+JSON.stringify(dimensionReplacement)+');\n'+harnessMarker);
 src+='\nthis.makeOpsFixture=fixture;';
 const rt={require:createRequire(opsFile),__dirname,console,structuredClone,URL};vm.createContext(rt);vm.runInContext(src,rt,{filename:'photo-independent-ops-fixture.vm.js'});
 const h=rt.makeOpsFixture(),ctx=h.context;ctx.WTCPhotoCore=Photo;ctx.WTCLoadingPortalCore=require('./loading_portal_core.js');ctx.WTCForecastCore=require('./forecast_engine.js');
 let seq=0,lockDepth=0,visionCalls=0;const driveFiles=new Map(),folders=new Map(),shareEvents=[];
 const user=email=>({getEmail:()=>email});const blob=(bytes,mime,name)=>({getBytes:()=>Array.from(bytes),getContentType:()=>mime,getName:()=>name});
 const file=(id,bytes,mime,name)=>({id,name,getId:()=>id,getName:()=>name,getUrl:()=>`https://drive.google.com/file/d/${id}/view`,getBlob:()=>blob(bytes,mime,name),getEditors:()=>[user('coworker@example.invalid')],getOwner:()=>user('sheet-owner@example.invalid'),isTrashed:()=>false,setDescription:()=>{},setTrashed:()=>{}});
 ctx.Utilities.base64Decode=s=>Array.from(Buffer.from(s,'base64'));
 ctx.Utilities.base64Encode=bytes=>Buffer.from(bytes).toString('base64');
 ctx.Utilities.newBlob=(bytes,mime,name)=>blob(bytes,mime,name);
 ctx.Utilities.computeDigest=(_algorithm,v)=>Array.from(crypto.createHash('sha256').update(typeof v==='string'?v:Buffer.from(v)).digest());
 ctx.Session={getEffectiveUser:()=>user('installer@example.invalid'),getActiveUser:()=>user('coworker@example.invalid')};
 const sheetFile=file(h.api.config.spreadsheetId,[],'application/vnd.google-apps.spreadsheet','Main');driveFiles.set(sheetFile.id,sheetFile);
 ctx.DriveApp={getFileById:id=>{assert.ok(driveFiles.has(id),'Drive fixture missing '+id);return driveFiles.get(id);},getFolderById:id=>{assert.ok(folders.has(id));return folders.get(id);},createFolder:name=>{const id='folder-'+(++seq),f={getId:()=>id,getName:()=>name,addEditors:emails=>{shareEvents.push({kind:'editors',emails:[...emails]});return f;},addEditor:email=>{shareEvents.push({kind:'editor',email});return f;},createFile:bl=>{const id='image-'+(++seq),df=file(id,bl.getBytes(),bl.getContentType(),bl.getName());driveFiles.set(id,df);return df;},getEditors:()=>[user('coworker@example.invalid')]};folders.set(id,f);return f;}};
 const trigger={forSpreadsheet(){return this;},onEdit(){return this;},onOpen(){return this;},timeBased(){return this;},everyMinutes(){return this;},create(){return this;},getHandlerFunction:()=>''};ctx.ScriptApp.getProjectTriggers=()=>[];ctx.ScriptApp.newTrigger=()=>trigger;
 ctx.LockService={getScriptLock:()=>({tryLock:()=>{
   if(options.cancelBeforeMaterialize&&!h.cancelInjected&&ctx.WTCLoad_cancelPhotoJob){const candidate=Object.values(h.state().photoIntake?.jobs||{}).find(job=>job.kind==='receipt'&&job.stage==='ready');if(candidate){h.cancelInjected=true;ctx.WTCLoad_cancelPhotoJob({jobId:candidate.jobId,expectedRevision:candidate.revision,reason:'QA误传退出'});if(options.throwAfterCancel)throw Error('QA materialize attempt failed after user cancelled');}}
   lockDepth++;return true;},releaseLock:()=>{lockDepth--;}})};
 const originalFetch=ctx.UrlFetchApp.fetch;
 ctx.UrlFetchApp.fetch=(url,opts)=>{if(url==='https://api.openai.com/v1/responses'&&opts.method==='post'){const body=JSON.parse(opts.payload);if(body.text?.format?.name==='wtc_photo_extraction'){visionCalls++;assert.equal(lockDepth,0,'Vision call must happen outside script lock');if(options.visionHook)options.visionHook(h);const answer=typeof options.extraction==='function'?options.extraction(h):options.extraction||extraction();return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(answer)}]}]})};}if(h.inventoryReview){const facts=JSON.parse(body.input[1].content[0].text),answer={decision:'review',taskId:facts.taskId,stateVersion:facts.stateVersion,inputHash:facts.inputHash,proposalHash:facts.proposalHash,reason:'QA pending physical review'};return{getResponseCode:()=>200,getContentText:()=>JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(answer)}]}]})};}}return originalFetch(url,opts);};
 vm.runInContext(fs.readFileSync(path.join(__dirname,'photo_adapter.gs'),'utf8'),ctx,{filename:'photo_adapter.gs'});
 h.upgrade();h.api.upgradeLoadingPortal();h.scriptProps.set('WTC_FORECAST_ENABLED','true');
 h.photo=ctx.WTCPhoto;h.photoUpgrade=()=>h.photo.upgrade();h.photoStatus=()=>h.photo.status();h.visionCalls=()=>visionCalls;h.driveFiles=driveFiles;h.shareEvents=shareEvents;h.photoLockDepth=()=>lockDepth;
 h.uploadInput=(extra={})=>({requestId:'UPLOAD-ADAPTER',kind:'receipt',businessDate:'2026-10-30',containerNo:CAB,clarification:'',files:[{name:'receipt.jpg',mimeType:'image/jpeg',dataBase64:Buffer.from([255,216,255,224,1,2,3,4]).toString('base64')}],...extra});
 return h;
}

test('photo independent review: upgrade preserves baseline, physical stock, historical actuals and existing versions',()=>{
 const before=fixture(),snapshot=copy(before);const r=Photo.upgrade({state:before,now:NOW});assert.equal(r.ok,true);assert.deepEqual(before,snapshot);assert.deepEqual(r.nextState.inventory,snapshot.inventory);assert.deepEqual(r.nextState.baseline,snapshot.baseline);assert.deepEqual(r.nextState.tasks,snapshot.tasks);assert.equal(r.nextState.inventoryVersion,7);assert.equal(r.nextState.version,25);
});

test('photo independent review: accepted photo registration is not a physical receipt',()=>{
 const before=fixture(),r=registered(before);assert.equal(sum(r.state),23);assert.deepEqual(r.state.receipts,{});assert.deepEqual(before.photoIntake.jobs,{});assert.ok(r.job.jobId);assert.notEqual(r.job.stage,'posted');
});

test('photo independent review: same upload request is idempotent; reused ID with different facts cannot register twice',()=>{
 const r=registered(),same=Photo.register({state:r.state,input:{jobId:'NEW-SERVER-ID',requestId:'upload-qa',kind:'receipt',source:'upload',businessDate:'2026-10-30',containerNo:CAB,images:[img()],sourceRefs:['photo://qa']},now:NOW});assert.equal(same.ok,true);assert.equal(same.noOp,true);assert.equal(same.job.jobId,r.job.jobId);
 const altered=Photo.register({state:r.state,input:{jobId:'SECOND',requestId:'upload-qa',kind:'receipt',source:'upload',businessDate:'2026-10-31',containerNo:CAB,images:[img()],sourceRefs:['photo://qa']},now:NOW});assert.ok(failure(altered));assert.equal(Object.keys(r.state.photoIntake.jobs).length,1);assert.equal(sum(r.state),23);
});

test('photo independent review: same photo renamed and sent with a new request/date does not create a new stock event',()=>{
 const r=registered(),again=Photo.register({state:r.state,input:{jobId:'PHOTO-SECOND',requestId:'other-request',kind:'receipt',source:'upload',businessDate:'2026-10-31',containerNo:CAB,images:[img(undefined,{name:'renamed.jpg'})],sourceRefs:['photo://renamed']},now:NOW});
 if(again.ok&&!again.noOp){const candidate=Photo.applyExtraction({state:again.nextState,jobId:again.job.jobId,expectedRevision:again.job.revision,extraction:extraction({businessDate:'2026-10-31'}),now:NOW});assert.ok(failure(candidate)||!Photo.buildOperation({state:candidate.nextState,jobId:again.job.jobId}).ok);}assert.equal(sum(again.nextState||r.state),23);
});

test('photo independent review: source is required and cannot silently become an untraceable receipt',()=>{
 const r=Photo.register({state:fixture(),input:{jobId:'NO-SOURCE',requestId:'NO-SOURCE',kind:'receipt',source:'chatgpt',sourceRefs:[],images:[],businessDate:'2026-10-30',containerNo:CAB},now:NOW});assert.ok(failure(r));
});

for(const [name,p,basis] of [['printed theory',5,'theoretical'],['unknown mark',null,'unknown'],['fractional P',4.5,'actual'],['negative P',-1,'actual']])test('photo independent review: '+name+' cannot become actual stock',()=>{
 const ext=extraction({items:[{destination:'TEB4',location:'C1',locationOrder:[],shipmentId:'',physicalP:p,quantityBasis:basis,note:'✓'}],totalP:p});const r=extracted(undefined,ext);assert.ok(failure(r)||!operation(r.nextState).ok);assert.equal(sum(r.nextState||fixture()),23);
});

test('photo independent review: missing business date is not replaced by upload day',()=>{
 const r=registered(fixture(),{businessDate:''}),out=extracted(r.state,extraction({businessDate:null}));assert.ok(failure(out));assert.notEqual(out.job?.businessDate,'2026-11-02');assert.equal(sum(out.nextState||r.state),23);
});

for(const [field,value] of [['businessDate','2026-10-31'],['containerNo','DEMU1001003']])test('photo independent review: contradictory '+field+' requires clarification',()=>{
 const r=extracted(undefined,extraction({[field]:value}));assert.ok(failure(r));assert.equal(sum(r.nextState||fixture()),23);
});

test('photo independent review: ambiguous extraction and incomplete page are not marked ready',()=>{
 for(const extra of [{allRowsRead:false},{issues:['数字无法辨认']},{totalP:6}]){const r=extracted(undefined,extraction(extra));assert.ok(failure(r));assert.equal(sum(r.nextState||fixture()),23);}
});

test('photo independent review: ready result is still unposted until fixed inventory operation succeeds',()=>{
 const st=ready(),built=operation(st);assert.equal(built.ok,true,JSON.stringify(built.issues));assert.equal(sum(st),23);assert.notEqual(st.photoIntake.jobs['PHOTO-QA'].stage,'posted');
 const effect=Ops.computeOperation({state:st,operation:built.operation,now:NOW});assert.equal(effect.ok,true,JSON.stringify(effect.issues));assert.equal(sum(effect.nextState),28);assert.equal(sum(st),23);
 assert.ok(!effect.nextState.unloadTasks[CAB].ledger.reservations.some(r=>r.allocationId==='qa-teb4'));
 const done=Photo.reconcileJobs({state:effect.nextState,now:NOW});assert.equal(done.ok,true);assert.equal(done.nextState.photoIntake.jobs['PHOTO-QA'].stage,'posted');assert.equal(sum(done.nextState),28);
});

test('photo independent review: the model cannot choose operation ID, stock changes or fake posting status',()=>{
 const ext=extraction({operationId:'MALICIOUS-OP',stage:'posted',inventory:[{physicalP:99999}],actualDeltas:[{physicalP:99999}]});const st=ready(undefined,ext),r=operation(st);assert.equal(r.ok,true);assert.notEqual(r.operation.operationId,'MALICIOUS-OP');assert.equal(sum(st),23);assert.notEqual(st.photoIntake.jobs['PHOTO-QA'].stage,'posted');
});

test('photo independent review: later photo with the same physical receipt cannot add stock twice',()=>{
 let st=ready(),r=operation(st),posted=Ops.computeOperation({state:st,operation:r.operation,now:NOW});assert.equal(posted.ok,true);st=Photo.reconcileJobs({state:posted.nextState,now:NOW}).nextState;
 const reg=registered(st,{jobId:'PHOTO-SECOND',requestId:'SECOND',images:[img('b'.repeat(64),{fileId:'other-photo'})]}),ext=Photo.applyExtraction({state:reg.state,jobId:reg.job.jobId,expectedRevision:reg.job.revision,extraction:extraction(),now:NOW});
 if(ext.ok){const b=Photo.buildOperation({state:ext.nextState,jobId:reg.job.jobId});if(b.ok&&b.operation){const e=Ops.computeOperation({state:ext.nextState,operation:b.operation,now:NOW});assert.ok(e.noOp||!e.ok);assert.equal(sum(e.nextState||ext.nextState),28);}}assert.equal(sum(ext.nextState||reg.state),28);
});

test('photo independent review: a new photo cannot bypass a posted container by changing its date',()=>{
 let st=ready(),b=operation(st),posted=Ops.computeOperation({state:st,operation:b.operation,now:NOW});assert.equal(posted.ok,true);st=Photo.reconcileJobs({state:posted.nextState,now:NOW}).nextState;
 const reg=registered(st,{jobId:'PHOTO-LATER-DATE',requestId:'LATER-DATE',businessDate:'2026-10-31',images:[img('c'.repeat(64),{fileId:'later-date'})]}),ext=Photo.applyExtraction({state:reg.state,jobId:reg.job.jobId,expectedRevision:reg.job.revision,extraction:extraction({businessDate:'2026-10-31'}),now:NOW});
 assert.ok(failure(ext)||!Photo.buildOperation({state:ext.nextState,jobId:reg.job.jobId}).ok);assert.equal(sum(ext.nextState||reg.state),28);
});

test('photo independent review: old queued matching receipt is reused instead of appending a second backend receipt',()=>{
 const st=ready(),legacy=[{operationId:'OLD-REGISTERED-RECEIPT',containerNo:CAB,businessDate:'2026-10-30',posted:false,items:[{location:'C1',destination:'TEB4',shipmentId:'',physicalP:5,allocationIds:['qa-teb4']}]}];
 const r=operation(st,{existingReceipts:legacy});assert.equal(r.ok,true,JSON.stringify(r.issues));assert.equal(r.existingOperationId,'OLD-REGISTERED-RECEIPT');assert.equal(sum(st),23);
});

test('photo independent review: disagreement with old queued receipt is review rather than a second stock event',()=>{
 const st=ready(),r=operation(st,{existingReceipts:[{operationId:'OLD',containerNo:CAB,businessDate:'2026-10-30',posted:false,items:[{location:'C1',destination:'TEB4',shipmentId:'',physicalP:7,allocationIds:['qa-teb4']}]}]});assert.equal(r.ok,false);assert.equal(sum(st),23);
});

test('photo independent review: a partial night scope leaves unshown neighboring locations intact',()=>{
 let st=countReady(),p=confirmPreview(st);assert.equal(p.ok,true,JSON.stringify(p.issues));st=p.nextState;const b=operation(st);assert.equal(b.ok,true,JSON.stringify(b.issues));assert.deepEqual(b.operation.scopeLocations,['C1']);const report=Ops.reconcile({state:st,operation:b.operation});assert.equal(report.ok,true);assert.ok(report.rows.every(r=>r.location==='C1'));
 const effect=Ops.computeOperation({state:st,operation:{...b.operation,acceptDifferences:true},now:NOW});assert.equal(effect.ok,true,JSON.stringify(effect.issues));assert.equal(effect.nextState.inventory.find(r=>r.inventoryId==='old-C2').physicalP,9);assert.equal(st.inventory.find(r=>r.inventoryId==='old-C1').physicalP,14);
});

test('photo independent review: named scope with no visible row and no explicit empty marker cannot clear old stock',()=>{
 const r=countRegistered(),out=extracted(r.state,countExtraction({scopeLocations:['C1','C2'],scopeComplete:true}));assert.ok(failure(out)||!operation(out.nextState).ok);assert.equal(sum(out.nextState||r.state),23);
});

test('photo independent review: explicit empty is distinct from an absent photo row and still needs user scope confirmation',()=>{
 let st=countReady(countExtraction({scopeLocations:['C1','C2'],explicitEmptyLocations:['C2'],scopeComplete:true}));const no=Photo.requestPreview({state:st,input:{jobId:'PHOTO-QA',expectedRevision:st.photoIntake.jobs['PHOTO-QA'].revision,completeScopeConfirmed:false},now:NOW});assert.ok(failure(no));
 const yes=confirmPreview(st);assert.equal(yes.ok,true,JSON.stringify(yes.issues));const b=operation(yes.nextState);assert.equal(b.ok,true,JSON.stringify(b.issues));assert.ok(b.operation.counts.some(r=>r.location==='C2'&&r.physicalP===0));assert.equal(sum(yes.nextState),23);
});

test('photo independent review: night checkmark without exact P is never replaced by nominal lane capacity',()=>{
 const r=countRegistered(),out=extracted(r.state,countExtraction({items:[{destination:'TEB4',location:'C1',locationOrder:[],shipmentId:'',physicalP:null,quantityBasis:'unknown',note:'✓满线'}],totalP:null}));assert.ok(failure(out));assert.equal(sum(out.nextState||r.state),23);
});

test('photo independent review: adoption cannot be requested before preview or with a forged preview token',()=>{
 const st=countReady(),out=Photo.requestAdoption({state:st,input:{jobId:'PHOTO-QA',expectedRevision:st.photoIntake.jobs['PHOTO-QA'].revision,previewToken:'invented'},now:NOW});assert.ok(failure(out));assert.equal(sum(out.nextState||st),23);
 const previewed=copy(st),job=previewed.photoIntake.jobs['PHOTO-QA'];job.stage='previewed';job.preview={token:'server-preview',stateVersion:previewed.version,inputHash:'source',report:{summary:{differenceP:-2}}};const forged=Photo.requestAdoption({state:previewed,input:{jobId:job.jobId,expectedRevision:job.revision,previewToken:'forged'},now:NOW});assert.ok(failure(forged));assert.equal(sum(forged.nextState||previewed),23);
});

test('photo independent review: count state labels cannot claim adopted without a count ledger record',()=>{
 let st=countReady();st.photoIntake.jobs['PHOTO-QA'].stage='adopt_requested';const r=Photo.reconcileJobs({state:st,now:NOW});assert.equal(r.ok,true);assert.notEqual(r.nextState.photoIntake.jobs['PHOTO-QA'].stage,'adopted');assert.equal(sum(r.nextState),23);
});

test('photo independent review: stale extraction and clarification revisions cannot overwrite accepted photo work',()=>{
 const st=ready(),job=st.photoIntake.jobs['PHOTO-QA'],snapshot=copy(st);const a=Photo.applyExtraction({state:st,jobId:job.jobId,expectedRevision:job.revision-1,extraction:extraction({totalP:99}),now:NOW});assert.ok(failure(a));const b=Photo.clarify({state:st,input:{jobId:job.jobId,expectedRevision:job.revision-1,clarification:'改99P'},now:NOW});assert.ok(failure(b));assert.deepEqual(st,snapshot);
});

test('photo independent review: recognition data cannot silently turn a receipt job into a night count',()=>{
 const r=extracted(undefined,countExtraction());assert.ok(failure(r));assert.equal(sum(r.nextState||fixture()),23);
});

test('photo independent review: a night photo showing only explicit empty locations is a valid zero-stock scope',()=>{
 const reg=countRegistered(),r=extracted(reg.state,countExtraction({items:[],scopeLocations:['C1','C2'],explicitEmptyLocations:['C1','C2'],totalP:0,scopeComplete:true}));assert.equal(r.ok,true,JSON.stringify(r.issues));assert.equal(r.job.stage,'ready',JSON.stringify(r.issues));const p=confirmPreview(r.nextState);assert.equal(p.ok,true);const b=operation(p.nextState);assert.equal(b.ok,true);assert.equal(b.operation.counts.length,2);assert.ok(b.operation.counts.every(row=>row.physicalP===0));assert.equal(sum(p.nextState),23);
});

test('photo independent review: published sequential receipt retains original lane quota after later stock has moved out',()=>{
 let st=fixture();const rows=[['qa-front','C1',3],['qa-overflow','C3',12]].map(([allocationId,location,p])=>({allocationId,taskId:CAB,containerNo:CAB,publicationId:'QA-PAPER',revision:'1',destination:'TEB4',shipmentId:'',location,route:'ordinary',estimatedP:p,estimatedSlots:p,published:true}));const u=Unload.computeUnloadEffect({taskId:CAB,containerNo:CAB,status:'拆空',publicationId:'QA-PAPER',revision:'1',allocations:rows,allowedLocations:['C1','C2','C3']});assert.equal(u.ok,true);st.unloadTasks[CAB].ledger=u.nextLedger;
 st.inventory.find(r=>r.location==='C1').physicalP=0;const reg=registered(st),out=extracted(reg.state,extraction({items:[{destination:'TEB4',location:null,locationOrder:['C1','C3'],shipmentId:'',physicalP:17,quantityBasis:'actual',note:'先满C1再C3'}],totalP:17}));assert.equal(out.ok,true);assert.equal(out.job.stage,'ready',JSON.stringify(out.issues));const b=operation(out.nextState);assert.equal(b.ok,true,JSON.stringify(b.issues));const effect=Ops.computeOperation({state:out.nextState,operation:b.operation,now:NOW});assert.equal(effect.ok,true,JSON.stringify(effect.issues));assert.equal(effect.nextState.inventory.filter(r=>r.receiptId===b.operation.operationId&&r.location==='C1').reduce((s,r)=>s+r.physicalP,0),3);assert.equal(effect.nextState.inventory.filter(r=>r.receiptId===b.operation.operationId&&r.location==='C3').reduce((s,r)=>s+r.physicalP,0),14);
 const reconciled=Photo.reconcileJobs({state:effect.nextState,now:NOW}).nextState,again=registered(reconciled,{jobId:'REPHOTO',requestId:'REPHOTO',images:[img('d'.repeat(64),{fileId:'new-crop'})]}),rerun=Photo.applyExtraction({state:again.state,jobId:again.job.jobId,expectedRevision:again.job.revision,extraction:extraction({items:[{destination:'TEB4',location:null,locationOrder:['C1','C3'],shipmentId:'',physicalP:17,quantityBasis:'actual',note:'先满C1再C3'}],totalP:17}),now:NOW});assert.equal(rerun.ok,true);assert.equal(rerun.job.stage,'posted',JSON.stringify(rerun.issues));assert.equal(sum(rerun.nextState),26);
});

test('photo independent adapter: upgrade prepares evidence entry without resetting stock, baseline, key or pending receipts',()=>{
 const h=adapterFixture(),before=copy(h.state()),key=h.userProps.get('WTC_OPENAI_KEY');h.photoUpgrade();assert.equal(h.total(),20);assert.deepEqual(copy(h.state().inventory),before.inventory);assert.deepEqual(copy(h.state().baseline),before.baseline);assert.equal(h.userProps.get('WTC_OPENAI_KEY'),key);assert.equal(h.physicalRows().length,0);assert.equal(h.visionCalls(),0);assert.equal(h.photoStatus().enabled,true);
 assert.ok(h.shareEvents.some(e=>e.emails?.includes('coworker@example.invalid')),'Known shared editor receives upload folder access');
});

test('photo independent adapter: paused upload is durably accepted while all physical stock remains unchanged',()=>{
 const h=adapterFixture();h.photoUpgrade();h.api.pause();const r=h.photo.upload(h.uploadInput());assert.equal(r.ok,true);assert.equal(r.portal.paused,true);assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);assert.equal(h.visionCalls(),0);h.context.WTCLoad_syncPhotoIntake();assert.equal(h.visionCalls(),0);assert.equal(h.total(),20);assert.equal(Object.keys(h.state().photoIntake.jobs).length,1);
});

test('photo independent adapter: a repeated upload request after lost response reuses image files and one photo job',()=>{
 const h=adapterFixture();h.photoUpgrade();const input=h.uploadInput(),a=h.photo.upload(input),files=h.driveFiles.size,b=h.photo.upload(input);assert.equal(a.job.jobId,b.job.jobId);assert.equal(h.driveFiles.size,files);assert.equal(Object.keys(h.state().photoIntake.jobs).length,1);assert.equal(h.total(),20);
});

test('photo independent adapter: receipt vision runs outside lock then stock, estimate revocation and posted status agree',()=>{
 const h=adapterFixture();h.photoUpgrade();const r=h.photo.upload(h.uploadInput());assert.equal(h.total(),20);h.context.WTCLoad_syncPhotoIntake();assert.equal(h.visionCalls(),1);assert.equal(h.photoLockDepth(),0);assert.equal(h.total(),25);assert.equal(h.physicalRows().length,1);assert.equal(h.state().photoIntake.jobs[r.job.jobId].stage,'posted');assert.ok(!h.state().unloadTasks[CAB].ledger.reservations.some(row=>row.allocationId==='qa-'+CAB+'/part01'));
 h.context.WTCLoad_syncPhotoIntake();assert.equal(h.total(),25);assert.equal(h.physicalRows().length,1);
});

test('photo independent adapter: shared editor may upload, installer background owns AI and physical posting',()=>{
 const h=adapterFixture();h.photoUpgrade();h.userProps.set('WTC_LOAD_INSTALLER_ID','coworker-marker');const r=h.photo.upload(h.uploadInput());assert.equal(r.ok,true);assert.equal(r.portal.isOwner,false);h.context.WTCLoad_syncPhotoIntake();assert.equal(h.visionCalls(),0);assert.equal(h.total(),20);h.userProps.set('WTC_LOAD_INSTALLER_ID','owner-marker');h.context.WTCLoad_syncPhotoIntake();assert.equal(h.visionCalls(),1);assert.equal(h.total(),25);assert.equal(h.state().photoIntake.jobs[r.job.jobId].stage,'posted');
});

test('photo independent adapter: stale vision result cannot overwrite clarification submitted during image recognition',()=>{
 let first=true;const h=adapterFixture({visionHook:h=>{if(first){first=false;const job=Object.values(h.state().photoIntake.jobs)[0];h.photo.retry({requestId:'CLARIFY-DURING-VISION',jobId:job.jobId,expectedRevision:job.revision,clarification:'原照片数量需复核，请以新说明为准'});}}});h.photoUpgrade();const r=h.photo.upload(h.uploadInput());h.context.WTCLoad_syncPhotoIntake();assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);assert.equal(h.state().photoIntake.jobs[r.job.jobId].stage,'uploaded');
});

test('photo independent adapter: invalid image bytes cannot be accepted under a JPEG filename or MIME label',()=>{
 const h=adapterFixture();h.photoUpgrade();assert.throws(()=>h.photo.upload(h.uploadInput({files:[{name:'pretend.jpg',mimeType:'image/jpeg',dataBase64:Buffer.from('not an image').toString('base64')}]})));assert.equal(Object.keys(h.state().photoIntake.jobs).length,0);assert.equal(h.total(),20);
});

test('photo independent adapter: night photo generates differences first and explicit adoption survives photo metadata revisions',()=>{
 const h=adapterFixture({extraction:countExtraction({items:[{destination:'TEB4',location:'C1',locationOrder:[],shipmentId:'',physicalP:18,quantityBasis:'actual',note:'18P'}],totalP:18})});h.photoUpgrade();const r=h.photo.upload(h.uploadInput({kind:'count',containerNo:''}));h.context.WTCLoad_syncPhotoIntake();let job=h.state().photoIntake.jobs[r.job.jobId];assert.equal(job.stage,'ready');assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);
 h.photo.requestPreview({jobId:job.jobId,expectedRevision:job.revision,completeScopeConfirmed:true});h.context.WTCLoad_syncPhotoIntake();job=h.state().photoIntake.jobs[r.job.jobId];assert.equal(job.stage,'previewed',job.result);assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);const token=job.preview.token;
 h.photo.requestAdoption({jobId:job.jobId,expectedRevision:job.revision,previewToken:token});assert.equal(h.total(),20);h.context.WTCLoad_syncPhotoIntake();job=h.state().photoIntake.jobs[r.job.jobId];assert.equal(job.stage,'adopted',job.result);assert.equal(h.total(),18);assert.equal(h.physicalRows().length,1);
});

test('photo independent adapter: actual stock change after night preview requires a fresh view of discrepancies',()=>{
 const h=adapterFixture({extraction:countExtraction({items:[{destination:'TEB4',location:'C1',locationOrder:[],shipmentId:'',physicalP:18,quantityBasis:'actual',note:'18P'}],totalP:18})});h.photoUpgrade();const r=h.photo.upload(h.uploadInput({kind:'count',containerNo:''}));h.context.WTCLoad_syncPhotoIntake();let job=h.state().photoIntake.jobs[r.job.jobId];h.photo.requestPreview({jobId:job.jobId,expectedRevision:job.revision,completeScopeConfirmed:true});h.context.WTCLoad_syncPhotoIntake();job=h.state().photoIntake.jobs[r.job.jobId];assert.equal(job.stage,'previewed',job.result);
 const st=h.state();st.inventory[0].physicalP=19;st.inventoryVersion++;st.version++;h.writeState(st);assert.throws(()=>h.photo.requestAdoption({jobId:job.jobId,expectedRevision:job.revision,previewToken:job.preview.token}));assert.equal(h.total(),19);assert.equal(h.physicalRows().length,0);
});

test('photo independent adapter: clearer replacement photos reuse the same job and preserve original evidence/hash without repeat stock',()=>{
 const h=adapterFixture({extraction:h=>h.visionCalls()===1?extraction({items:[{destination:'TEB4',location:'C1',locationOrder:[],shipmentId:'',physicalP:null,quantityBasis:'unknown',note:'模糊'}],totalP:null}):extraction()});h.photoUpgrade();const input=h.uploadInput(),first=h.photo.upload(input);h.context.WTCLoad_syncPhotoIntake();let job=h.state().photoIntake.jobs[first.job.jobId];assert.equal(job.stage,'review');const original=copy(job.images[0]),fileCount=h.driveFiles.size;
 const retryInput={requestId:'CLEARER-PHOTO-RETRY',jobId:job.jobId,expectedRevision:job.revision,clarification:'这张补拍可看清是5P',files:[{name:'clear.jpg',mimeType:'image/jpeg',dataBase64:Buffer.from([255,216,255,224,4,3,2,1,9]).toString('base64')}]};const retry=h.photo.retry(retryInput);assert.equal(retry.job.jobId,job.jobId);assert.equal(Object.keys(h.state().photoIntake.jobs).length,1);job=h.state().photoIntake.jobs[job.jobId];assert.equal(job.images.length,1);assert.notEqual(job.images[0].fileId,original.fileId);assert.ok(job.imageHistory.some(im=>im.fileId===original.fileId));assert.equal(h.state().photoIntake.imageIndex[original.sha256],job.jobId);assert.equal(h.driveFiles.size,fileCount+1);
 const again=h.photo.retry(retryInput);assert.equal(again.job.jobId,job.jobId);assert.equal(h.driveFiles.size,fileCount+1);assert.equal(Object.keys(h.state().photoIntake.jobs).length,1);h.context.WTCLoad_syncPhotoIntake();assert.equal(h.total(),25);assert.equal(h.physicalRows().length,1);assert.equal(h.state().photoIntake.jobs[job.jobId].stage,'posted');
 const originalAgain=h.photo.upload({...input,requestId:'RESEND-ORIGINAL-AFTER-CLEAR'});assert.equal(originalAgain.job.jobId,job.jobId);assert.equal(h.driveFiles.size,fileCount+1);h.context.WTCLoad_syncPhotoIntake();assert.equal(h.total(),25);assert.equal(h.physicalRows().length,1);
});

test('photo independent adapter: a queued receipt photo blocks adopting related night count until actual receipt is settled',()=>{
 const h=adapterFixture({extraction:countExtraction({items:[{destination:'TEB4',location:'C1',locationOrder:[],shipmentId:'',physicalP:18,quantityBasis:'actual',note:'18P'}],totalP:18})});h.photoUpgrade();const r=h.photo.upload(h.uploadInput({kind:'count',containerNo:''}));h.context.WTCLoad_syncPhotoIntake();let job=h.state().photoIntake.jobs[r.job.jobId];h.photo.requestPreview({jobId:job.jobId,expectedRevision:job.revision,completeScopeConfirmed:true});h.context.WTCLoad_syncPhotoIntake();job=h.state().photoIntake.jobs[r.job.jobId];assert.equal(job.stage,'previewed');
 h.photo.upload(h.uploadInput({requestId:'OTHER-RECEIPT',files:[{name:'receipt-other.jpg',mimeType:'image/jpeg',dataBase64:Buffer.from([255,216,255,224,4,3,2,1,8]).toString('base64')}]}));h.photo.requestAdoption({jobId:job.jobId,expectedRevision:job.revision,previewToken:job.preview.token});h.context.WTCLoad_syncPhotoIntake();assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);assert.notEqual(h.state().photoIntake.jobs[job.jobId].stage,'adopted');
});

for(const when of ['before','after'])test('photo independent adapter: '+when+' physical-commit failure never partly or twice posts a recognized receipt',()=>{
 const h=adapterFixture();h.photoUpgrade();const r=h.photo.upload(h.uploadInput());h.failPhysical=when;h.context.WTCLoad_syncPhotoIntake();assert.equal(h.total(),when==='before'?20:25);assert.equal(h.physicalRows().length,when==='before'?0:1);if(when==='before')assert.notEqual(h.state().photoIntake.jobs[r.job.jobId].stage,'posted');h.context.WTCLoad_syncPhotoIntake();assert.equal(h.total(),25);assert.equal(h.physicalRows().length,1);assert.equal(h.state().photoIntake.jobs[r.job.jobId].stage,'posted');
});

test('photo independent adapter: unrecognized photo quantity is shown as unknown rather than confirmed zero',()=>{
 const h=adapterFixture();h.photoUpgrade();const r=h.photo.upload(h.uploadInput());assert.equal(r.job.actualP,null);assert.equal(h.photoStatus().jobs[0].actualP,null);assert.equal(h.total(),20);
});

test('photo independent review: old same-cab same-day unclear photo ceases blocking only after a later photo is durably posted',()=>{
 const old=registered(fixture(),{jobId:'OLD-UNCLEAR',requestId:'OLD-UNCLEAR'}),review=Photo.applyExtraction({state:old.state,jobId:old.job.jobId,expectedRevision:old.job.revision,extraction:extraction({allRowsRead:false,issues:['原照片模糊']}),now:NOW});assert.equal(review.job.stage,'review');const originalIssues=copy(review.job.issues),originalImages=copy(review.job.images);
 const newer=registered(review.nextState,{images:[img('f'.repeat(64),{fileId:'newer-clear-photo'})]}),st=ready(newer.state);assert.ok(Photo.unsettledReceiptJobs({state:st,businessDate:'2026-10-30',scopeLocations:['C1']}).some(j=>j.jobId==='OLD-UNCLEAR'));
 const b=operation(st),posted=Ops.computeOperation({state:st,operation:b.operation,now:NOW});assert.equal(posted.ok,true);const reconciled=Photo.reconcileJobs({state:posted.nextState,now:NOW}),oldAfter=reconciled.nextState.photoIntake.jobs['OLD-UNCLEAR'];assert.equal(oldAfter.resolvedBy,'PHOTO-QA');assert.notEqual(oldAfter.stage,'posted');assert.deepEqual(oldAfter.issues,originalIssues);assert.deepEqual(oldAfter.images,originalImages);assert.equal(Photo.unsettledReceiptJobs({state:reconciled.nextState,businessDate:'2026-10-30',scopeLocations:['C1']}).length,0);assert.equal(sum(reconciled.nextState),28);
});

test('photo independent review: unknown-cab or unknown-day photo is not blindly resolved by another successful receipt',()=>{
 const old=registered(fixture(),{jobId:'OLD-UNKNOWN',requestId:'OLD-UNKNOWN',containerNo:'',businessDate:''}),review=Photo.applyExtraction({state:old.state,jobId:old.job.jobId,expectedRevision:old.job.revision,extraction:extraction({containerNo:null,businessDate:null,allRowsRead:false}),now:NOW});assert.equal(review.job.stage,'review');const newer=registered(review.nextState,{images:[img('e'.repeat(64),{fileId:'other-clear'})]}),st=ready(newer.state),b=operation(st),posted=Ops.computeOperation({state:st,operation:b.operation,now:NOW});assert.equal(posted.ok,true);const done=Photo.reconcileJobs({state:posted.nextState,now:NOW});assert.ok(!done.nextState.photoIntake.jobs['OLD-UNKNOWN'].resolvedBy);assert.ok(Photo.unsettledReceiptJobs({state:done.nextState,businessDate:'2026-10-30',scopeLocations:['C1']}).some(j=>j.jobId==='OLD-UNKNOWN'));
});

test('photo independent review: forged resolution labels without a physical receipt never bypass the night gate',()=>{
 const old=registered(fixture(),{jobId:'OLD-REVIEW',requestId:'OLD-REVIEW'}),review=Photo.applyExtraction({state:old.state,jobId:old.job.jobId,expectedRevision:old.job.revision,extraction:extraction({allRowsRead:false}),now:NOW}),newer=registered(review.nextState,{images:[img('d'.repeat(64),{fileId:'not-posted-yet'})]}),st=ready(newer.state);st.photoIntake.jobs['OLD-REVIEW'].resolvedBy='PHOTO-QA';st.photoIntake.jobs['OLD-REVIEW'].resolvedOperationId='PHOTO-QA';st.photoIntake.jobs['PHOTO-QA'].stage='posted';assert.ok(Photo.unsettledReceiptJobs({state:st,businessDate:'2026-10-30',scopeLocations:['C1']}).some(j=>j.jobId==='OLD-REVIEW'));assert.equal(sum(st),23);
});

test('photo independent adapter: re-previewing a multi-location night photo uses semantic rows rather than photo row order',()=>{
 const ex=countExtraction({items:[{destination:'TEB4',location:'C1',locationOrder:[],shipmentId:'',physicalP:18,quantityBasis:'actual',note:'18P'},{destination:'BNA2',location:'C2',locationOrder:[],shipmentId:'',physicalP:2,quantityBasis:'actual',note:'2P'}],scopeLocations:['C2','C1'],totalP:20});const h=adapterFixture({extraction:ex});h.photoUpgrade();const r=h.photo.upload(h.uploadInput({kind:'count',containerNo:''}));h.context.WTCLoad_syncPhotoIntake();let job=h.state().photoIntake.jobs[r.job.jobId];h.photo.requestPreview({jobId:job.jobId,expectedRevision:job.revision,completeScopeConfirmed:true});h.context.WTCLoad_syncPhotoIntake();job=h.state().photoIntake.jobs[job.jobId];assert.equal(job.stage,'previewed',job.result);
 h.photo.requestPreview({jobId:job.jobId,expectedRevision:job.revision,completeScopeConfirmed:true});h.context.WTCLoad_syncPhotoIntake();job=h.state().photoIntake.jobs[job.jobId];assert.equal(job.stage,'previewed',job.result);assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);
});

test('photo independent adapter: an unposted AI-review receipt is corrected in the same job and operation without posting its old draft',()=>{
 const h=adapterFixture({extraction:h=>extraction({items:[{destination:'TEB4',location:'C1',locationOrder:[],shipmentId:'',physicalP:h.visionCalls()===1?5:6,quantityBasis:'actual',note:'核对P'}],totalP:h.visionCalls()===1?5:6})});h.photoUpgrade();h.inventoryReview=true;const r=h.photo.upload(h.uploadInput());h.context.WTCLoad_syncPhotoIntake();let job=h.state().photoIntake.jobs[r.job.jobId],opId=job.operationId;assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);assert.ok(h.state().operationPending[opId]);assert.equal(h.sheets.get(h.api.config.sheets.receipt).data.filter(row=>row[10]===opId).length,1);
 const retry=h.photo.retry({requestId:'CORRECT-UNPOSTED',jobId:job.jobId,expectedRevision:job.revision,clarification:'现场核实这柜是6P，原5P未入账'});assert.equal(retry.job.jobId,job.jobId);job=h.state().photoIntake.jobs[job.jobId];assert.equal(job.operationId,opId);assert.equal(job.stage,'uploaded');assert.ok(job.backendDraftHistory?.length,'Prior unposted row is archived in the same job');assert.equal(h.sheets.get(h.api.config.sheets.receipt).data.filter(row=>row[10]===opId).length,0);
 h.inventoryReview=false;h.syncOps(true);assert.equal(h.total(),20,'Old five-pallet draft cannot post while new recognition is pending');h.context.WTCLoad_syncPhotoIntake();job=h.state().photoIntake.jobs[job.jobId];assert.equal(job.operationId,opId);assert.equal(job.stage,'posted',job.result);assert.equal(h.total(),26);assert.equal(h.physicalRows().length,1);const activeRows=h.sheets.get(h.api.config.sheets.receipt).data.filter(row=>row[10]===opId);assert.equal(activeRows.length,1);assert.equal(activeRows[0][4],6);assert.equal(Object.keys(h.state().photoIntake.jobs).length,1);
 assert.throws(()=>h.photo.retry({requestId:'SPOOF-AFTER-POSTED',jobId:job.jobId,expectedRevision:job.revision,authorizedUnpostedReceiptRetry:true,clarification:'改99P'}));assert.equal(h.total(),26);
});

test('photo independent adapter: an unadopted night preview may be corrected without retaining old backend rows',()=>{
 const h=adapterFixture({extraction:h=>countExtraction({items:[{destination:'TEB4',location:'C1',locationOrder:[],shipmentId:'',physicalP:h.visionCalls()===1?18:17,quantityBasis:'actual',note:'夜盘核对'}],totalP:h.visionCalls()===1?18:17})});h.photoUpgrade();const r=h.photo.upload(h.uploadInput({kind:'count',containerNo:''}));h.context.WTCLoad_syncPhotoIntake();let job=h.state().photoIntake.jobs[r.job.jobId];h.photo.requestPreview({jobId:job.jobId,expectedRevision:job.revision,completeScopeConfirmed:true});h.context.WTCLoad_syncPhotoIntake();job=h.state().photoIntake.jobs[job.jobId];assert.equal(job.stage,'previewed');const oldToken=job.preview.token;
 h.photo.retry({requestId:'FIX-NIGHT-DRAFT',jobId:job.jobId,expectedRevision:job.revision,clarification:'收工核实实际是17P'});assert.equal(h.total(),20);job=h.state().photoIntake.jobs[job.jobId];assert.equal(job.stage,'uploaded');assert.ok(!job.preview);assert.equal(h.sheets.get(h.api.config.sheets.counts).data.filter(row=>row[0]===job.operationId).length,0);h.context.WTCLoad_syncPhotoIntake();job=h.state().photoIntake.jobs[job.jobId];assert.equal(job.stage,'ready');assert.throws(()=>h.photo.requestAdoption({jobId:job.jobId,expectedRevision:job.revision,previewToken:oldToken}));
 h.photo.requestPreview({jobId:job.jobId,expectedRevision:job.revision,completeScopeConfirmed:true});h.context.WTCLoad_syncPhotoIntake();job=h.state().photoIntake.jobs[job.jobId];assert.equal(job.stage,'previewed',job.result);assert.notEqual(job.preview.token,oldToken);h.photo.requestAdoption({jobId:job.jobId,expectedRevision:job.revision,previewToken:job.preview.token});h.context.WTCLoad_syncPhotoIntake();job=h.state().photoIntake.jobs[job.jobId];assert.equal(job.stage,'adopted',job.result);assert.equal(h.total(),17);assert.equal(h.physicalRows().length,1);assert.throws(()=>h.photo.retry({requestId:'AFTER-NIGHT-ADOPT',jobId:job.jobId,expectedRevision:job.revision,clarification:'改16P'}));
});

test('photo independent adapter: reusing a chat candidate request with changed extraction cannot alter an accepted candidate',()=>{
 const h=adapterFixture();h.photoUpgrade();const input={requestId:'CHAT-CANDIDATE',kind:'receipt',businessDate:'2026-10-30',containerNo:CAB,sourceRefs:['https://chatgpt.com/library?file_id=qa-photo'],extraction:extraction()},r=h.photo.registerChat(input);assert.equal(r.ok,true);assert.throws(()=>h.photo.registerChat({...input,extraction:extraction({totalP:99})}));assert.equal(h.total(),20);assert.equal(Object.keys(h.state().photoIntake.jobs).length,1);const job=h.state().photoIntake.jobs[r.job.jobId];assert.equal(job.extraction.totalP,5);
});

test('photo independent review: cancelling an unknown-cab unmaterialized photo preserves evidence and releases night gate without stock reversal',()=>{
 const reg=registered(fixture(),{jobId:'WRONG-UPLOAD',requestId:'WRONG-UPLOAD',containerNo:'',businessDate:''}),review=Photo.applyExtraction({state:reg.state,jobId:reg.job.jobId,expectedRevision:reg.job.revision,extraction:extraction({containerNo:null,businessDate:null,allRowsRead:false,issues:['误传图片']}),now:NOW});assert.equal(review.job.stage,'review');const images=copy(review.job.images),issues=copy(review.job.issues);assert.ok(Photo.unsettledReceiptJobs({state:review.nextState,businessDate:'2026-10-30',scopeLocations:['C1']}).length);
 const cancelled=Photo.cancel({state:review.nextState,input:{jobId:review.job.jobId,expectedRevision:review.job.revision,reason:'误传，与仓库无关'},now:NOW});assert.equal(cancelled.ok,true,JSON.stringify(cancelled.issues));assert.equal(cancelled.job.stage,'cancelled');assert.deepEqual(cancelled.job.images,images);assert.deepEqual(cancelled.job.issues,issues);assert.equal(sum(cancelled.nextState),23);assert.equal(Photo.unsettledReceiptJobs({state:cancelled.nextState,businessDate:'2026-10-30',scopeLocations:['C1']}).length,0);
 const staleWork=Photo.applyExtraction({state:cancelled.nextState,jobId:cancelled.job.jobId,expectedRevision:cancelled.job.revision,extraction:extraction(),now:NOW}),retry=Photo.clarify({state:cancelled.nextState,input:{jobId:cancelled.job.jobId,expectedRevision:cancelled.job.revision,clarification:'复活'},now:NOW});assert.equal(staleWork.ok,false);assert.equal(retry.ok,false);assert.equal(cancelled.nextState.photoIntake.jobs[cancelled.job.jobId].stage,'cancelled');
});

test('photo independent adapter: cancelling a materialized receipt or previewed count is refused and does not cancel a stock operation',()=>{
 const h=adapterFixture();h.photoUpgrade();h.inventoryReview=true;const r=h.photo.upload(h.uploadInput());h.context.WTCLoad_syncPhotoIntake();let job=h.state().photoIntake.jobs[r.job.jobId];assert.equal(job.materialized,true);assert.throws(()=>h.context.WTCLoad_cancelPhotoJob({jobId:job.jobId,expectedRevision:job.revision}));assert.equal(h.total(),20);assert.equal(h.sheets.get(h.api.config.sheets.receipt).data.filter(row=>row[10]===job.operationId).length,1);
 const n=adapterFixture({extraction:countExtraction({items:[{destination:'TEB4',location:'C1',locationOrder:[],shipmentId:'',physicalP:18,quantityBasis:'actual',note:'18P'}],totalP:18})});n.photoUpgrade();const nr=n.photo.upload(n.uploadInput({kind:'count',containerNo:''}));n.context.WTCLoad_syncPhotoIntake();job=n.state().photoIntake.jobs[nr.job.jobId];n.photo.requestPreview({jobId:job.jobId,expectedRevision:job.revision,completeScopeConfirmed:true});n.context.WTCLoad_syncPhotoIntake();job=n.state().photoIntake.jobs[job.jobId];assert.equal(job.stage,'previewed');assert.throws(()=>n.context.WTCLoad_cancelPhotoJob({jobId:job.jobId,expectedRevision:job.revision}));assert.equal(n.total(),20);assert.equal(n.physicalRows().length,0);
});

test('photo independent adapter: cancelling between ready snapshot and materialization prevents both backend writes and failure resurrection',()=>{
 for(const throwAfterCancel of [false,true]){const h=adapterFixture({cancelBeforeMaterialize:true,throwAfterCancel});h.photoUpgrade();const r=h.photo.upload(h.uploadInput());h.context.WTCLoad_syncPhotoIntake();assert.equal(h.cancelInjected,true);const job=h.state().photoIntake.jobs[r.job.jobId];assert.equal(job.stage,'cancelled',job.result);assert.equal(h.sheets.get(h.api.config.sheets.receipt).data.filter(row=>row[10]===job.operationId).length,0);assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);assert.equal(h.photoLockDepth(),0);h.context.WTCLoad_syncPhotoIntake();assert.equal(h.state().photoIntake.jobs[job.jobId].stage,'cancelled');assert.equal(h.total(),20);}
});
