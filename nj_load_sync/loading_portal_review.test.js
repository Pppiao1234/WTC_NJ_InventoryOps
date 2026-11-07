'use strict';
// Independent v1.5 review: all Sheets/OpenAI interactions are local doubles.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const Core=require('./engine.js'),Portal=require('./loading_portal_core.js');
const copy=v=>JSON.parse(JSON.stringify(v));
const now='2026-10-30T19:00:00Z';
function base(){return {schemaVersion:1,version:8,inventoryVersion:3,baseline:{confirmed:true,version:'B-QA',asOf:'2026/10/29 收工后',appliedTasks:{}},inventory:[{inventoryId:'i1',location:'C1',destination:'TEB4',shipmentId:'01003',physicalP:20,occupiedSlots:20,slotBasis:'one_per_pallet',capacitySlots:27}],tasks:{},unloadTasks:{}};}
function upgraded(st=base()){const r=Portal.upgrade({state:st,now});assert.equal(r.ok,true);return r.nextState;}
function created(st=upgraded(),extra={}){const r=Portal.createTask({state:st,now,input:{taskId:'task-independent',requestId:'create-qa',label:'TEB4 QA装车',businessDate:'2026-10-30',reference:'LOAD-QA',dock:'6',...extra}});assert.equal(r.ok,true,JSON.stringify(r.issues));return r.nextState;}
function submit(st,input={}){return Portal.submit({state:st,now,input:{taskId:'task-independent',requestId:'submit-qa',expectedRevision:st.loadingPortal.tasks['task-independent'].revision,kind:'actual',actualText:'C1 TEB4:6',status:'已结束',...input}});}
function effect(st,requestId='submit-qa'){const j=Portal.jobForCore({state:st,requestId,allowSameDestinationLots:true});assert.equal(j.ok,true,JSON.stringify(j.issues));return {job:j,effect:Core.computeLoadingEffect(j.input)};}
function apply(st,requestId='submit-qa'){
 const r=effect(st,requestId);assert.equal(r.effect.ok,true,JSON.stringify(r.effect.issues));
 const next=copy(st),tid=r.job.task.taskId;next.inventory=r.effect.inventoryAfter;next.tasks[tid]={...(next.tasks[tid]||{}),ledger:r.effect.nextLedger,pending:false};
 const done=Portal.recordResult({state:next,requestId,status:'processed',message:'QA posted',now});assert.equal(done.ok,true);return done.nextState;
}
function issueCode(r,code){assert.equal(r.ok,false);assert.ok(r.issues.some(i=>i.code===code),JSON.stringify(r.issues));}

test('portal independent QA: upgrade is pure and preserves stock, baseline, historical cumulative and state versions',()=>{
 const st=base(),snap=copy(st);st.tasks.old={registration:{status:'confirmed',method:'old'}};snap.tasks=copy(st.tasks);
 const r=Portal.upgrade({state:st,now});assert.equal(r.ok,true);assert.deepEqual(st,snap);assert.deepEqual(r.nextState.inventory,snap.inventory);assert.deepEqual(r.nextState.baseline,snap.baseline);assert.equal(r.nextState.inventoryVersion,3);assert.equal(r.nextState.version,8);
 const again=Portal.upgrade({state:r.nextState,now:'2026-10-31T19:00:00Z'});assert.equal(again.noOp,true);assert.deepEqual(again.nextState,r.nextState);
});

test('portal independent QA: trusted historical actual6 migrates without deduction then cumulative8 deducts only2',()=>{
 let st=base();const first=Core.computeLoadingEffect({taskId:'old-task',status:'留台等货',plannedText:'C1 TEB4:8',actualText:'C1 TEB4:6',allowedLocations:['C1'],baseline:st.baseline,inventory:st.inventory,otherTaskPlans:[]});assert.equal(first.ok,true);
 st.inventory=first.inventoryAfter;st.tasks['old-task']={ledger:first.nextLedger,sourceMetadata:{info:'历史装车',dateLabel:'2026-10-30',reference:'OLD',dock:'6'}};
 st=upgraded(st);assert.equal(st.inventory[0].physicalP,14);assert.equal(st.loadingPortal.tasks['old-task'].actualText,'C1 TEB4@01003:6');
 const r=Portal.submit({state:st,now,input:{taskId:'old-task',requestId:'old-more',expectedRevision:0,kind:'actual',actualText:'C1 TEB4:8',status:'已结束'}});assert.equal(r.ok,true);
 const e=effect(r.nextState,'old-more').effect;assert.equal(e.ok,true);assert.equal(e.actualDeltas[0].physicalP,2);assert.equal(e.inventoryAfter[0].physicalP,12);
});

test('portal independent QA: baseline-included actual6 without local ledger is retained and never deducted twice',()=>{
 let st=base();st.inventory[0].physicalP=14;st.inventory[0].occupiedSlots=14;st.baseline.appliedTasks['task-independent']={taskId:'task-independent',status:'留台等货',actual:[{inventoryId:'i1',location:'C1',destination:'TEB4',shipmentId:'01003',physicalP:6,releasedSlots:6}]};
 st=upgraded(st);const r=submit(st,{requestId:'baseline-more',actualText:'C1 TEB4:8'});assert.equal(r.ok,true);
 const e=effect(r.nextState,'baseline-more').effect;assert.equal(e.ok,true);assert.equal(e.inventoryAfter[0].physicalP,12);assert.equal(e.actualDeltas[0].physicalP,2);
});

test('portal independent QA: unchanged migrated cumulative preserves previously measured released slots',()=>{
 let st=base();st.inventory[0].occupiedSlots=10;st.inventory[0].slotBasis='explicit';
 const first=Core.computeLoadingEffect({taskId:'task-independent',status:'已结束',actualEntries:[{location:'C1',destination:'TEB4',shipmentId:'01003',physicalP:6,releasedSlots:3}],allowedLocations:['C1'],baseline:st.baseline,inventory:st.inventory,otherTaskPlans:[]});assert.equal(first.ok,true);
 st.inventory=first.inventoryAfter;st.tasks['task-independent']={ledger:first.nextLedger};st=upgraded(st);
 const q=Portal.submit({state:st,now,input:{taskId:'task-independent',requestId:'same-status',expectedRevision:0,kind:'status',status:'已结束'}});assert.equal(q.ok,true);const e=effect(q.nextState,'same-status').effect;assert.equal(e.ok,true);assert.equal(e.nextLedger.actual[0].releasedSlots,3);assert.equal(e.inventoryAfter[0].occupiedSlots,7);assert.equal(e.actualDeltas.length,0);
});

test('portal independent QA: unconfirmed orphan source identities are not promoted to accounting tasks',()=>{
 const st=base();st.tasks.orphan={registration:{status:'legacy_unconfirmed'},pending:true,pendingCode:'API_MISSING'};st.tasks.confirmed={registration:{status:'confirmed'},pending:true,pendingCode:'RULE_REVIEW',lastResult:'unprocessed source'};
 const next=upgraded(st);assert.equal(next.loadingPortal.tasks.orphan,undefined);assert.equal(next.loadingPortal.tasks.confirmed.actualText,'');assert.equal(next.loadingPortal.tasks.confirmed.processingStatus,'review');assert.equal(next.inventory[0].physicalP,20);assert.equal(next.tasks.confirmed.pending,false);assert.ok(next.tasks.confirmed.legacyPortalMigration);
});

test('portal independent QA: creation is stable by request ID and conflicting content cannot create a second task',()=>{
 const st=created();const same=Portal.createTask({state:st,now,input:{taskId:'other-server-generated-id',requestId:'create-qa',label:'TEB4 QA装车',businessDate:'2026-10-30',reference:'LOAD-QA',dock:'6'}});assert.equal(same.ok,true);assert.equal(same.noOp,true);assert.equal(same.task.taskId,'task-independent');
 const bad=Portal.createTask({state:st,now,input:{taskId:'another',requestId:'create-qa',label:'Different',businessDate:'2026-10-30',reference:'LOAD-QA',dock:'6'}});issueCode(bad,'CREATE_REQUEST_REUSED');
 assert.equal(Object.keys(st.loadingPortal.tasks).length,1);
});

test('portal independent QA: a second same-day load reference needs explicit new-trip confirmation',()=>{
 const st=created();let r=Portal.createTask({state:st,now,input:{taskId:'second',requestId:'create-second',label:'different text',businessDate:'2026-10-30',reference:'LOAD-QA'}});issueCode(r,'DUPLICATE_TASK_REVIEW');
 r=Portal.createTask({state:st,now,input:{taskId:'second',requestId:'create-second',label:'different text',businessDate:'2026-10-30',reference:'LOAD-QA',newTripConfirmed:true,newTripReason:'第二车次'}});assert.equal(r.ok,true);assert.equal(r.nextState.inventory[0].physicalP,20);
});

test('portal independent QA: unknown-date migrated load cannot be recreated from the same reference or label without explicit new-trip confirmation',()=>{
 for(const reference of ['LEGACY-REF','']){
  let st=base();const old=Core.computeLoadingEffect({taskId:'legacy-date-task',status:'已结束',actualText:'C1 TEB4:6',allowedLocations:['C1'],baseline:st.baseline,inventory:st.inventory,otherTaskPlans:[]});assert.equal(old.ok,true);st.inventory=old.inventoryAfter;st.tasks['legacy-date-task']={ledger:old.nextLedger,sourceMetadata:{info:'同一装车说明',reference,dateLabel:'10/30'}};st=upgraded(st);assert.equal(st.loadingPortal.tasks['legacy-date-task'].businessDate,'','unknown year must not be guessed');
  const input={taskId:'accidental-copy',requestId:'COPY-LEGACY-UNKNOWN-DATE',label:reference?'后来补充的Info':'同一装车说明',reference,businessDate:'2026-10-30'};const duplicate=Portal.createTask({state:st,input,now});issueCode(duplicate,'DUPLICATE_TASK_REVIEW');assert.ok(duplicate.issues[0].candidateTaskIds.includes('legacy-date-task'));assert.equal(st.inventory[0].physicalP,14);
  const explicit=Portal.createTask({state:st,input:{...input,newTripConfirmed:true,newTripReason:'核实是另一车次'},now});assert.equal(explicit.ok,true);assert.equal(explicit.nextState.inventory[0].physicalP,14);
 }
});

test('portal independent QA: repeated import snapshot returns its original task without inventory effect',()=>{
 const st=created(undefined,{importKey:'schedule-snapshot-1'});const r=Portal.createTask({state:st,now,input:{taskId:'second',requestId:'create-second',label:'same source moved',businessDate:'2026-10-31',reference:'changed',importKey:'schedule-snapshot-1'}});assert.equal(r.ok,true);assert.equal(r.noOp,true);assert.equal(r.task.taskId,'task-independent');assert.equal(r.nextState.inventory[0].physicalP,20);
});

test('portal independent QA: missing or stale task revision cannot overwrite the accepted version',()=>{
 const st=created();issueCode(submit(st,{expectedRevision:undefined}),'REVISION_REQUIRED');issueCode(submit(st,{expectedRevision:7}),'STALE_TASK_REVISION');assert.equal(st.inventory[0].physicalP,20);
});

test('portal independent QA: same request replay is idempotent, different payload with same ID is rejected',()=>{
 const first=submit(created());assert.equal(first.ok,true);const replay=submit(first.nextState,{expectedRevision:0});assert.equal(replay.ok,true);assert.equal(replay.noOp,true);
 issueCode(submit(first.nextState,{expectedRevision:0,actualText:'C1 TEB4:7'}),'SUBMISSION_ID_REUSED');assert.equal(first.nextState.inventory[0].physicalP,20);
});

test('portal independent QA: another request cannot race an outstanding request on the same task',()=>{
 const first=submit(created());issueCode(submit(first.nextState,{requestId:'another',actualText:'C1 TEB4:8'}),'TASK_SUBMISSION_PENDING');assert.equal(first.nextState.loadingPortal.tasks['task-independent'].revision,1);
});

test('portal independent QA: planned submission cannot smuggle an actual cumulative change',()=>{
 issueCode(submit(created(),{kind:'plan',plannedText:'C1 TEB4:8',actualText:'C1 TEB4:6',status:'已开始'}),'WRONG_SUBMISSION_FIELD');
});

test('portal independent QA: status submission cannot carry hidden quantity changes',()=>{
 issueCode(submit(created(),{kind:'status',status:'已开始'}),'WRONG_SUBMISSION_FIELD');
});

test('portal independent QA: actual blank is unknown but explicit per-location0 is a valid zero',()=>{
 issueCode(submit(created(),{actualText:''}),'ACTUAL_UNKNOWN');
 const r=submit(created(),{actualText:'C1 TEB4:0'});assert.equal(r.ok,true);const e=effect(r.nextState).effect;assert.equal(e.ok,true);assert.equal(e.inventoryAfter[0].physicalP,20);assert.equal(e.actualDeltas.length,0);
});

test('portal independent QA: ending before an actual cumulative exists never substitutes the plan',()=>{
 const r=Portal.submit({state:created(),now,input:{taskId:'task-independent',requestId:'end-no-actual',expectedRevision:0,kind:'status',status:'已结束'}});issueCode(r,'FINISHED_ACTUAL_UNKNOWN');
});

test('portal independent QA: a fresh planned8 submission reserves8 but does not deduct physical stock',()=>{
 const r=Portal.submit({state:created(),now,input:{taskId:'task-independent',requestId:'planned-only',expectedRevision:0,kind:'plan',plannedText:'C1 TEB4:8',status:'已开始'}});assert.equal(r.ok,true);const e=effect(r.nextState,'planned-only').effect;assert.equal(e.ok,true);assert.equal(e.inventoryAfter[0].physicalP,20);assert.equal(e.actualDeltas.length,0);assert.equal(e.nextLedger.projectedRemaining[0].physicalP,8);
});

test('portal independent QA: an active real cumulative can be recorded without inventing a prior plan',()=>{
 const r=submit(created(),{status:'已开始'});assert.equal(r.ok,true);const e=effect(r.nextState).effect;assert.equal(e.ok,true,JSON.stringify(e.issues));assert.equal(e.inventoryAfter[0].physicalP,14);assert.equal(e.nextLedger.projectedRemaining.length,0);assert.equal(e.nextLedger.planned.length,0);
});

test('portal independent QA: an accepted waiting plan survives until explicit start without releasing stock early',()=>{
 const q=Portal.submit({state:created(),now,input:{taskId:'task-independent',requestId:'wait-plan',expectedRevision:0,kind:'plan',plannedText:'C1 TEB4:8',status:'未开始'}});assert.equal(q.ok,true);let st=apply(q.nextState,'wait-plan');assert.equal(st.inventory[0].physicalP,20);assert.equal(st.tasks['task-independent'].ledger.projectedRemaining.length,0);assert.equal(st.loadingPortal.tasks['task-independent'].plannedText,'C1 TEB4:8','accepted plan intent must survive while waiting');
 const start=Portal.submit({state:st,now,input:{taskId:'task-independent',requestId:'start-saved-plan',expectedRevision:st.loadingPortal.tasks['task-independent'].revision,kind:'status',status:'已开始'}});assert.equal(start.ok,true);const e=effect(start.nextState,'start-saved-plan').effect;assert.equal(e.ok,true,JSON.stringify(e.issues));assert.equal(e.inventoryAfter[0].physicalP,20);assert.equal(e.nextLedger.projectedRemaining[0].physicalP,8);
});

test('portal independent QA: approved zero with multiple same-point lots remains known across finishing',()=>{
 let st=base();st.inventory=[{...st.inventory[0],inventoryId:'lot-a',shipmentId:'A',physicalP:10,occupiedSlots:10},{...st.inventory[0],inventoryId:'lot-b',shipmentId:'B',physicalP:10,occupiedSlots:10}];st=created(upgraded(st));
 const q=submit(st,{actualText:'C1 TEB4:0',status:'已开始'});assert.equal(q.ok,true);st=apply(q.nextState);assert.equal(st.loadingPortal.tasks['task-independent'].actualText,'C1 TEB4:0','known zero is not blank unknown even if no positive lot allocation exists');
 const end=Portal.submit({state:st,now,input:{taskId:'task-independent',requestId:'finish-known-zero',expectedRevision:st.loadingPortal.tasks['task-independent'].revision,kind:'status',status:'已结束'}});assert.equal(end.ok,true,JSON.stringify(end.issues));const e=effect(end.nextState,'finish-known-zero').effect;assert.equal(e.ok,true,JSON.stringify(e.issues));assert.equal(e.inventoryAfter.reduce((n,r)=>n+r.physicalP,0),20);
});

test('portal independent QA: unchanged new actual request after posting cannot add another deduction',()=>{
 const queued=submit(created()),done=apply(queued.nextState);assert.equal(done.inventory[0].physicalP,14);
 const replay=submit(done,{requestId:'semantic-repeat'});assert.equal(replay.ok,true);assert.equal(replay.noOp,true);assert.equal(replay.nextState.inventory[0].physicalP,14);
});

test('portal independent QA: client-side correction authorization is ignored',()=>{
 const done=apply(submit(created()).nextState);const r=submit(done,{requestId:'reduce',kind:'correction',actualText:'C1 TEB4:5',correctionReason:'现场更正',correctionAuthorized:true});assert.equal(r.ok,true);assert.equal(r.request.correctionAuthorized,false);issueCode(Portal.jobForCore({state:r.nextState,requestId:'reduce',allowSameDestinationLots:true}),'CORRECTION_NOT_AUTHORIZED');assert.equal(r.nextState.inventory[0].physicalP,14);
});

for(const resultStatus of ['review','error'])test('portal independent QA: '+resultStatus+' actual cannot later hitchhike on 保存预计',()=>{
 const queued=submit(created(),{status:'已开始'});assert.equal(queued.ok,true);
 const rejected=Portal.recordResult({state:queued.nextState,requestId:'submit-qa',status:resultStatus,message:'not posted',now});assert.equal(rejected.ok,true);
 const plan=Portal.submit({state:rejected.nextState,now,input:{taskId:'task-independent',requestId:'plan-after-rejection',expectedRevision:rejected.task.revision,kind:'plan',plannedText:'C1 TEB4:8',status:'已开始'}});assert.equal(plan.ok,true,JSON.stringify(plan.issues));
 const e=effect(plan.nextState,'plan-after-rejection').effect;assert.equal(e.ok,true,JSON.stringify(e.issues));assert.equal(e.inventoryAfter[0].physicalP,20,'save plan must not post the previously rejected actual6');assert.equal(e.actualDeltas.length,0);
});

test('portal independent QA: failed plan does not silently become active on another actual request',()=>{
 const queued=Portal.submit({state:created(),now,input:{taskId:'task-independent',requestId:'bad-plan',expectedRevision:0,kind:'plan',plannedText:'C1 TEB4:8',status:'已开始'}});assert.equal(queued.ok,true);
 const rejected=Portal.recordResult({state:queued.nextState,requestId:'bad-plan',status:'review',message:'plan not accepted',now});assert.equal(rejected.ok,true);
 const r=submit(rejected.nextState,{requestId:'actual-after-bad-plan',actualText:'C1 TEB4:6'});assert.equal(r.ok,true);assert.equal(r.request.plannedText,'','an unaccepted plan must not be carried by another action');
});

test('portal independent QA: no-source or moved-source metadata never enters the engine input accounting',()=>{
 const r=submit(created());const st=r.nextState;st.sourceRows=[{row:999,taskId:'other',actualText:'C1 TEB4:19'}];
 const j=Portal.jobForCore({state:st,requestId:'submit-qa',allowSameDestinationLots:true});assert.equal(j.ok,true);assert.equal(j.row.row,0);assert.equal(j.row.taskId,'task-independent');assert.equal(j.input.actualText,'C1 TEB4:6');assert.equal(j.input.inventory[0].physicalP,20);
});

test('portal independent QA: stale result revision is rejected without clearing another pending request',()=>{
 const queued=submit(created());const st=copy(queued.nextState);st.loadingPortal.tasks['task-independent'].revision++;
 issueCode(Portal.recordResult({state:st,requestId:'submit-qa',status:'processed',message:'stale',now}),'RESULT_STALE');assert.equal(st.loadingPortal.requests['submit-qa'].stage,'pending');assert.equal(st.inventory[0].physicalP,20);
});

test('portal independent QA: public task input validation blocks invalid dates, negative/fractional and unknown locations',()=>{
 issueCode(Portal.createTask({state:upgraded(),now,input:{taskId:'bad',requestId:'bad-create',label:'bad',businessDate:'2026-02-30'}}),'CREATE_FIELDS_REQUIRED');
 for(const actualText of ['C1 TEB4:-1','C1 TEB4:1.5','Q1 TEB4:3']){const r=submit(created(),{actualText});assert.equal(r.ok,false,actualText);}
});

// Reuse only the source-independent local REST/AI double. Do not alter original
// regression tests or production sources to expose private implementation.
const qaFile=path.join(__dirname,'qa.adapter.test.js');
let harnessSource=fs.readFileSync(qaFile,'utf8');
const boundary='\nfunction moveInputsBeforeTime';assert.ok(harnessSource.includes(boundary));
harnessSource=harnessSource.slice(0,harnessSource.indexOf(boundary));
harnessSource=harnessSource.replace('const context={WTCLoadCore:Core,Date,JSON,console,',"const context={WTCLoadCore:Core,WTCUnloadCore:require('./unload_engine.js'),WTCInventoryCore:require('./operations_engine.js'),WTCForecastCore:require('./forecast_engine.js'),WTCLoadingPortalCore:require('./loading_portal_core.js'),Date,JSON,console,");
harnessSource=harnessSource.replace('return {run:()=>context.WTCLoad.sync(null,false),','return {api:context.WTCLoad,context,scriptProps,userProps,run:()=>context.WTCLoad.sync(null,false),');
harnessSource+='\nthis.makeHarness=harness;';
const runtime={require:createRequire(qaFile),__dirname,console,structuredClone,URL};
vm.createContext(runtime);vm.runInContext(harnessSource,runtime,{filename:'loading-portal-qa.vm.js'});
function fixture(options={}){
 const h=runtime.makeHarness(options),C=h.api.config,Sheet=h.source.constructor,Range=h.source.getRange(1,1).constructor;
 const book=h.context.SpreadsheetApp.openById(C.spreadsheetId),noop=function(){return this;};
 for(const method of ['setBackground','setFontWeight','setNumberFormat','setWrap','setWrapStrategy','setVerticalAlignment','setFontSize','setFontFamily','setDataValidation','clearDataValidations','setNote'])Range.prototype[method]=noop;
 for(const method of ['setFrozenRows','setFrozenColumns','setColumnWidths','setColumnWidth','autoResizeColumns','setHiddenGridlines','hideSheet','showSheet'])Sheet.prototype[method]=noop;
 Sheet.prototype.isSheetHidden=()=>false;Sheet.prototype.getParent=()=>book;
 book.insertSheet=name=>new Sheet(name,[[]]);book.getSheets=()=>[...h.sheets.values()];book.getId=()=>C.spreadsheetId;book.setActiveSheet=()=>book;
 h.context.SpreadsheetApp.flush=()=>{};
 h.context.ScriptApp.getProjectTriggers=()=>[{getHandlerFunction:()=> 'WTCLoad_tick'},{getHandlerFunction:()=> 'WTCLoad_onUnloadEdit'}];
 h.context.ScriptApp.newTrigger=()=>{throw Error('must reuse existing triggers');};
 h.context.Utilities.formatDate=(d,_tz,format)=>format==='yyyy-MM-dd'?'2026-10-30':d.toISOString();
 const props=map=>({getProperty:key=>map.get(key)||null,setProperty:(key,value)=>{map.set(key,value);return props(map);},deleteProperty:key=>{map.delete(key);return props(map);},getProperties:()=>Object.fromEntries(map)});
 h.context.PropertiesService.getScriptProperties=()=>props(h.scriptProps);h.context.PropertiesService.getUserProperties=()=>props(h.userProps);
 h.batches=[];h.gets=[];const original=h.context.UrlFetchApp.fetch;
 h.context.UrlFetchApp.fetch=(url,opts)=>{if(opts.method==='get')h.gets.push(url);if(opts.method==='post'&&url.includes('sheets.googleapis.com'))h.batches.push(copy(JSON.parse(opts.payload)));if(h.failNextBatch&&opts.method==='post'&&url.includes('sheets.googleapis.com')){h.failNextBatch=false;return{getResponseCode:()=>503,getContentText:()=>'{"error":"QA atomic failure"}'};}return original(url,opts);};
 h.makeSheet=(name,data)=>new Sheet(name,data);h.total=()=>h.state().inventory.reduce((sum,r)=>sum+r.physicalP,0);
 h.asEditor=()=>{h.userProps.set('WTC_LOAD_INSTALLER_ID','another-editor');h.userProps.delete('WTC_OPENAI_KEY');};
 h.asOwner=()=>{h.userProps.set('WTC_LOAD_INSTALLER_ID','owner-marker');h.userProps.set('WTC_OPENAI_KEY','qa-key-never-network');};
 h.api.upgradeInventoryOps();
 h.upgrade=()=>h.api.upgradeLoadingPortal();h.portal=()=>copy(h.api.loadingPortalStatus());h.sync=()=>h.api.syncLoadingPortal(true);
 h.create=(input={})=>h.api.createLoadingTask({requestId:'CREATE-PORTAL-QA',label:'TEB4独立装车QA',businessDate:'2026-10-30',reference:'PORTAL-REF-QA',dock:'6',...input});
 h.submit=(task,input={})=>h.api.submitLoading({taskId:task.taskId,requestId:'SUBMIT-PORTAL-QA',expectedRevision:task.revision,kind:'actual',actualText:'C1 TEB4:6',status:'已结束',...input});
 if(options.upgrade!==false)h.upgrade();
 return h;
}
function acceptedTask(h,input){const r=h.create(input);assert.equal(r.ok,true,JSON.stringify(r));return r.task;}
function queued(h,task,input){const r=h.submit(task,input);assert.equal(r.ok,true,JSON.stringify(r));return r;}

test('portal adapter QA: cutover preserves stock, key, baseline and prior ledger without reading unprocessed row quantities',()=>{
 const h=fixture({upgrade:false}),before=copy(h.state()),key=h.userProps.get('WTC_OPENAI_KEY');h.upgrade();const after=h.state();
 assert.deepEqual(copy(after.inventory),before.inventory);assert.deepEqual(copy(after.baseline),before.baseline);assert.equal(after.inventoryVersion,before.inventoryVersion);assert.equal(h.userProps.get('WTC_OPENAI_KEY'),key);assert.equal(h.counts().ai,0);
 assert.equal(h.scriptProps.get('WTC_LOADING_PORTAL_ENABLED'),'true');assert.equal(after.loadingPortal.tasks['task-1'].actualText,'');h.sync();assert.equal(h.total(),20);assert.equal(h.counts().ai,0);
});

test('portal adapter QA: shared editor queues independently without key while only owner processes physical stock',()=>{
 const h=fixture();h.asEditor();const t=acceptedTask(h);queued(h,t);assert.equal(h.total(),20);assert.equal(h.counts().ai,0);h.sync();assert.equal(h.total(),20);assert.equal(h.counts().ai,0);
 h.asOwner();h.sync();assert.equal(h.total(),14);assert.equal(h.counts().ai,1);assert.equal(h.state().loadingPortal.requests['SUBMIT-PORTAL-QA'].stage,'processed');
});

test('portal adapter QA: source E/J/K/L and hiddenID edits never call AI or touch portal physical accounting',()=>{
 const h=fixture(),t=acceptedTask(h);const before=copy(h.state()),calls=h.counts().ai;
 for(const [col,value]of[[5,'完全修改Info'],[10,'已结束'],[20,'C1 TEB4:20'],[21,'C1 TEB4:19'],[25,'corrupted-source-id']]){h.source.set(2,col,value);h.api.onEdit({range:h.source.getRange(2,col)});}
 h.api.sync(null,true);assert.equal(h.total(),20);assert.equal(h.counts().ai,calls);assert.deepEqual(copy(h.state().inventory),before.inventory);assert.equal(h.state().loadingPortal.tasks[t.taskId].revision,0);
});

test('portal adapter QA: moving and then changing source status cannot change a queued task or its quantities',()=>{
 const h=fixture(),t=acceptedTask(h);queued(h,t);const id=t.taskId;h.source.data.splice(1,0,Array(25).fill(''));h.source.set(3,5,'changed-info-after-move');h.source.set(3,10,'取消');h.source.set(3,21,'C1 TEB4:19');h.api.onEdit({range:h.source.getRange(3,5,1,17)});
 h.sync();assert.equal(h.total(),14);assert.equal(h.state().tasks[id].ledger.actual[0].physicalP,6);assert.equal(h.state().loadingPortal.tasks[id].label,'TEB4独立装车QA');assert.equal(h.source.getRange(3,23).getValue(),'');
});

test('portal adapter QA: no source sheet or valid legacy quantity headers is needed to process submitted loading',()=>{
 const h=fixture(),t=acceptedTask(h);queued(h,t);h.sheets.delete('NJ装车接龙');h.sync();assert.equal(h.total(),14);assert.equal(h.counts().ai,1);
});

test('portal adapter QA: corrupting projection cells or sorting projected task rows never submits stock changes',()=>{
 const h=fixture(),t=acceptedTask(h),sheet=h.sheets.get(h.api.config.sheets.loadingTasks),before=copy(h.state());sheet.data.reverse();sheet.set(2,9,'C1 TEB4:19');h.api.onEdit({range:sheet.getRange(2,9)});h.sync();assert.equal(h.total(),20);assert.equal(h.counts().ai,0);assert.deepEqual(copy(h.state().inventory),before.inventory);assert.equal(h.state().loadingPortal.tasks[t.taskId].actualText,'');
});

test('portal adapter QA: actual6 then cumulative8 is two physical deltas6 and2 without row writes',()=>{
 const h=fixture(),t=acceptedTask(h);queued(h,t);h.sync();const next=h.portal().tasks.find(x=>x.taskId===t.taskId);queued(h,next,{requestId:'MORE-PORTAL-QA',actualText:'C1 TEB4:8'});h.sync();assert.equal(h.total(),12);
 const rows=h.sheets.get(h.api.config.sheets.physicalLedger).data.slice(1),deltas=rows.map(r=>JSON.parse(r[5]).reduce((sum,v)=>sum+v.physicalP,0));assert.deepEqual(deltas,[-6,-2]);
 const sourceId=h.source.getSheetId();assert.ok(!h.batches.some(b=>b.requests.some(r=>r.updateCells?.range.sheetId===sourceId)),'portal commits never write a potentially moved source row');
});

test('portal adapter QA: active actual6 posts correctly without requiring or fabricating an estimate',()=>{
 const h=fixture(),t=acceptedTask(h);queued(h,t,{status:'已开始'});h.sync();assert.equal(h.total(),14);assert.equal(h.state().tasks[t.taskId].ledger.planned.length,0);assert.equal(h.state().tasks[t.taskId].ledger.projectedRemaining.length,0);
});

test('portal adapter QA: AI-review actual6 is not posted by a later accepted plan8 submission',()=>{
 const opts={review:true},h=fixture(opts),t=acceptedTask(h);queued(h,t,{status:'已开始'});h.sync();assert.equal(h.total(),20);assert.equal(h.state().loadingPortal.requests['SUBMIT-PORTAL-QA'].stage,'review');
 opts.review=false;const current=h.portal().tasks.find(x=>x.taskId===t.taskId);const r=h.api.submitLoading({taskId:t.taskId,requestId:'ONLY-PLAN-AFTER-REVIEW',expectedRevision:current.revision,kind:'plan',plannedText:'C1 TEB4:8',status:'已开始'});assert.equal(r.ok,true);h.sync();assert.equal(h.total(),20);assert.equal(h.state().tasks[t.taskId].ledger.projectedRemaining[0].physicalP,8);assert.equal(h.state().tasks[t.taskId].ledger.actual.length,0);
});

test('portal adapter QA: posted and pending actual quantities are presented as different facts',()=>{
 const h=fixture(),t=acceptedTask(h);queued(h,t);let current=h.portal().tasks.find(x=>x.taskId===t.taskId);assert.equal(current.bookedActualP,0);assert.equal(current.actualText,'C1 TEB4:6');assert.equal(current.pendingRequestId,'SUBMIT-PORTAL-QA');h.sync();current=h.portal().tasks.find(x=>x.taskId===t.taskId);assert.equal(current.bookedActualP,6);assert.equal(current.pendingRequestId,'');assert.match(current.bookedActualText,/6/);
});

test('portal adapter QA: waiting plan8 can later be started and used without retyping it or debiting actual stock',()=>{
 const h=fixture(),t=acceptedTask(h);let r=h.api.submitLoading({taskId:t.taskId,requestId:'SAVE-WAITING-PLAN',expectedRevision:t.revision,kind:'plan',plannedText:'C1 TEB4:8',status:'未开始'});assert.equal(r.ok,true);h.sync();assert.equal(h.total(),20);let task=h.portal().tasks.find(x=>x.taskId===t.taskId);assert.equal(task.plannedText,'C1 TEB4:8');
 r=h.api.submitLoading({taskId:t.taskId,requestId:'START-WAITING-PLAN',expectedRevision:task.revision,kind:'status',status:'已开始'});assert.equal(r.ok,true);h.sync();assert.equal(h.total(),20);assert.equal(h.state().tasks[t.taskId].ledger.projectedRemaining[0].physicalP,8);
});

test('portal adapter QA: physical-plan invalidation survives repeated actual/status until a new plan is accepted',()=>{
 const h=fixture(),t=acceptedTask(h);let r=h.api.submitLoading({taskId:t.taskId,requestId:'FIRST-ACTIVE-PLAN',expectedRevision:t.revision,kind:'plan',plannedText:'C1 TEB4:8',status:'已开始'});assert.equal(r.ok,true);h.sync();let st=h.state();st.tasks[t.taskId].ledger.planned=[];st.tasks[t.taskId].ledger.projectedRemaining=[];st.tasks[t.taskId].pendingCode='PHYSICAL_PLAN_REVIEW';st.tasks[t.taskId].lastResult='移库后旧预计需核对';st.version++;h.writeState(st);
 let task=h.portal().tasks.find(x=>x.taskId===t.taskId);queued(h,task,{requestId:'ACTUAL-AFTER-INVALIDATION',actualText:'C1 TEB4:2',status:'已开始'});h.sync();assert.equal(h.total(),18);assert.equal(h.state().tasks[t.taskId].ledger.projectedRemaining.length,0);
 task=h.portal().tasks.find(x=>x.taskId===t.taskId);r=h.api.submitLoading({taskId:t.taskId,requestId:'STATUS-AFTER-INVALIDATION',expectedRevision:task.revision,kind:'status',status:'已开始'});assert.equal(r.ok,true);h.sync();assert.equal(h.state().tasks[t.taskId].ledger.projectedRemaining.length,0,'a second non-plan action must not restore old8');
 task=h.portal().tasks.find(x=>x.taskId===t.taskId);r=h.api.submitLoading({taskId:t.taskId,requestId:'NEW-VERIFIED-PLAN',expectedRevision:task.revision,kind:'plan',plannedText:'C1 TEB4:10',status:'已开始'});assert.equal(r.ok,true);h.sync();assert.equal(h.total(),18);assert.equal(h.state().tasks[t.taskId].ledger.projectedRemaining[0].physicalP,8);
});

test('portal adapter QA: approved same-point multilots zero remains known and can close without fake stock change',()=>{
 const h=fixture();let st=h.state();st.inventory=[{...st.inventory[0],inventoryId:'lot-a',shipmentId:'A',physicalP:10,occupiedSlots:10},{...st.inventory[0],inventoryId:'lot-b',shipmentId:'B',physicalP:10,occupiedSlots:10}];st.version++;h.writeState(st);const t=acceptedTask(h);queued(h,t,{actualText:'C1 TEB4:0',status:'已开始'});h.sync();assert.equal(h.total(),20);let task=h.portal().tasks.find(x=>x.taskId===t.taskId);assert.equal(task.bookedActualKnown,true);assert.equal(task.actualText,'C1 TEB4:0');
 const end=h.api.submitLoading({taskId:t.taskId,requestId:'END-MULTILOT-ZERO',expectedRevision:task.revision,kind:'status',status:'已结束'});assert.equal(end.ok,true,JSON.stringify(end));h.sync();assert.equal(h.total(),20);assert.equal(h.state().loadingPortal.requests['END-MULTILOT-ZERO'].stage,'processed');
});

test('portal adapter QA: legacy AI approval prepared before cutover cannot post or rewrite its source row',()=>{
 let h,once=true;h=fixture({upgrade:false,aiHook:()=>{if(once){once=false;h.upgrade();}}});const old=h.total();h.run();assert.equal(h.total(),old);assert.equal(h.source.getRange(2,23).getValue(),'');assert.equal(h.state().loadingPortal.tasks['task-1'].actualText,'');assert.equal(h.sheets.get(h.api.config.sheets.physicalLedger).data.length,1);
});

test('portal adapter QA: same submitted request remains idempotent after processing and different payload is rejected',()=>{
 const h=fixture(),t=acceptedTask(h),r=queued(h,t);h.sync();assert.equal(h.total(),14);const replay=h.submit(t);assert.equal(replay.ok,true);assert.equal(replay.noOp,true);assert.equal(h.total(),14);assert.equal(h.counts().ai,1);
 const conflict=h.submit(t,{actualText:'C1 TEB4:7'});assert.equal(conflict.ok,false);assert.equal(h.total(),14);
});

test('portal adapter QA: creation lost response replay returns the original task rather than a second task',()=>{
 const h=fixture();let once=true,original=h.context.UrlFetchApp.fetch;h.context.UrlFetchApp.fetch=(url,opts)=>{const result=original(url,opts);if(once&&opts.method==='post'&&url.includes('sheets.googleapis.com')&&JSON.parse(opts.payload).requests.some(r=>r.appendCells?.rows?.some(row=>row.values?.some(v=>v.userEnteredValue?.stringValue==='LOADING_PORTAL_CREATE')))){once=false;throw Error('local create response lost');}return result;};
 try{h.create();}catch(error){assert.match(error.message,/response lost/);}const replay=h.create();assert.equal(replay.ok,true);assert.equal(replay.noOp,true);const tasks=h.portal().tasks.filter(t=>t.reference==='PORTAL-REF-QA');assert.equal(tasks.length,1);assert.equal(h.total(),20);
});

for(const when of ['before','after'])test('portal adapter QA: '+when+' atomic commit failure does not split stock and result or debit twice',()=>{
 const h=fixture({failCommit:when}),t=acceptedTask(h);queued(h,t);h.sync();assert.equal(h.total(),when==='before'?20:14);h.sync();assert.equal(h.total(),14);assert.equal(h.sheets.get(h.api.config.sheets.physicalLedger).data.length,2);assert.equal(h.state().loadingPortal.requests['SUBMIT-PORTAL-QA'].stage,'processed');
});

test('portal adapter QA: an intervening shared state version invalidates AI and requires a new proposal',()=>{
 let h,once=true;h=fixture({aiHook:()=>{if(once){once=false;const st=h.state();st.version++;st.inventoryVersion++;h.writeState(st);}}});const t=acceptedTask(h);queued(h,t);h.sync();h.sync();assert.equal(h.total(),14);assert.ok(h.counts().ai>=2);assert.equal(h.sheets.get(h.api.config.sheets.physicalLedger).data.length,2);
});

test('portal adapter QA: changed request quantity during AI cannot post an older approved six',()=>{
 let h,once=true;h=fixture({aiHook:()=>{if(once){once=false;const st=h.state();st.loadingPortal.requests['SUBMIT-PORTAL-QA'].actualText='C1 TEB4:8';st.loadingPortal.tasks[Object.keys(st.loadingPortal.tasks).find(k=>k!=='task-1')].actualText='C1 TEB4:8';st.version++;h.writeState(st);}}});const t=acceptedTask(h);queued(h,t);h.sync();assert.notEqual(h.total(),14);h.sync();assert.equal(h.total(),12);
});

for(const field of ['taskId','stateVersion','inputHash','proposalHash'])test('portal adapter QA: forged AI '+field+' never posts physical stock',()=>{
 const h=fixture({forge:field}),t=acceptedTask(h);queued(h,t);h.sync();assert.equal(h.total(),20);assert.equal(h.state().loadingPortal.requests['SUBMIT-PORTAL-QA'].stage,'pending');assert.equal(h.sheets.get(h.api.config.sheets.physicalLedger).data.length,1);
});

test('portal adapter QA: shared editor cannot authorize cumulative corrections through client flags',()=>{
 const h=fixture(),t=acceptedTask(h);queued(h,t);h.sync();const next=h.portal().tasks.find(x=>x.taskId===t.taskId);h.asEditor();assert.throws(()=>h.submit(next,{kind:'correction',requestId:'FORGED-CORRECT',actualText:'C1 TEB4:5',correctionReason:'client reason',correctionAuthorized:true}),/安装|管理员/);assert.equal(h.total(),14);
});

test('portal adapter QA: failed upgrade is atomic and keeps old cutover flag off with maintenance pause on',()=>{
 const h=fixture({upgrade:false}),before=copy(h.state());h.failNextBatch=true;assert.throws(()=>h.upgrade(),/未完成|SHEETS_COMMIT/);assert.deepEqual(copy(h.state()),before);assert.notEqual(h.scriptProps.get('WTC_LOADING_PORTAL_ENABLED'),'true');assert.equal(h.scriptProps.get('WTC_LOAD_PAUSED'),'true');
});

test('portal adapter QA: legacy row admin writers are disabled after independent cutover',()=>{
 const h=fixture();for(const call of [()=>h.api.newTask(),()=>h.api.correction(),()=>h.api.restoreTaskId(),()=>h.api.moveTaskRow(),()=>h.api.upgradeLoadingIdentity(),()=>h.api.previewCleanup(),()=>h.api.cleanup()])assert.throws(call,/独立|集成/);assert.equal(h.total(),20);assert.equal(h.counts().ai,0);
});

test('portal adapter QA: maintenance resume does not require obsolete source input headers',()=>{
 const h=fixture();h.api.pause();h.source.set(1,20,'旧预计已停用');h.source.set(1,21,'旧实际已停用');const r=h.api.resume();assert.equal(r.status.paused,false);assert.equal(h.total(),20);
});

test('portal adapter QA: paused submission retains previous accepted accounting without queueing new physical work',()=>{
 const h=fixture(),t=acceptedTask(h);h.api.pause();assert.throws(()=>h.submit(t),/暂停/);assert.equal(h.state().loadingPortal.tasks[t.taskId].revision,0);assert.equal(h.total(),20);
});

function seedCount(h,id,p=14,location='C1',destination='TEB4',shipment='01003'){
 h.sheets.get(h.api.config.sheets.counts).data.push([id,'2026-10-30',location,destination,shipment,p,JSON.stringify([location]),true,'待核对','']);
 h.api.previewNightCount(id);
}

test('portal adapter QA: unresolved reviewed actual cannot be bypassed by adopting a count',()=>{
 const opts={review:true},h=fixture(opts),t=acceptedTask(h);queued(h,t,{status:'已开始'});h.sync();assert.equal(h.total(),20);opts.review=false;seedCount(h,'COUNT-WITH-REVIEW');assert.throws(()=>h.api.confirmNightCount('COUNT-WITH-REVIEW',true),/装车实际|实物待办|提交/);assert.equal(h.total(),20);assert.equal(h.state().counts['COUNT-WITH-REVIEW'],undefined);
});

test('portal adapter QA: successful plan/status does not resolve a reviewed actual for closing',()=>{
 const opts={review:true},h=fixture(opts),t=acceptedTask(h);queued(h,t,{status:'已开始'});h.sync();opts.review=false;let task=h.portal().tasks.find(x=>x.taskId===t.taskId);
 let r=h.api.submitLoading({taskId:t.taskId,requestId:'PLAN-DOES-NOT-RESOLVE',expectedRevision:task.revision,kind:'plan',plannedText:'C1 TEB4:8',status:'已开始'});assert.equal(r.ok,true);h.sync();task=h.portal().tasks.find(x=>x.taskId===t.taskId);
 r=h.api.submitLoading({taskId:t.taskId,requestId:'STATUS-DOES-NOT-RESOLVE',expectedRevision:task.revision,kind:'status',status:'取消'});assert.equal(r.ok,true);h.sync();assert.ok(!h.state().loadingPortal.requests['SUBMIT-PORTAL-QA'].resolvedBy);seedCount(h,'COUNT-PLAN-NOT-RESOLVED');assert.throws(()=>h.api.confirmNightCount('COUNT-PLAN-NOT-RESOLVED',true),/装车实际|实物待办|提交/);assert.equal(h.total(),20);
});

for(const p of [0,6])test('portal adapter QA: an explicit successful actual'+p+' resolves prior reviewed actual and permits count adoption',()=>{
 const opts={review:true},h=fixture(opts),t=acceptedTask(h);queued(h,t,{status:'已开始'});h.sync();opts.review=false;const task=h.portal().tasks.find(x=>x.taskId===t.taskId);queued(h,task,{requestId:'RESOLVED-ACTUAL-'+p,actualText:'C1 TEB4:'+p,status:'已结束'});h.sync();assert.equal(h.total(),20-p);assert.equal(h.state().loadingPortal.requests['SUBMIT-PORTAL-QA'].resolvedBy,'RESOLVED-ACTUAL-'+p);seedCount(h,'COUNT-RESOLVED-'+p,20-p);h.api.confirmNightCount('COUNT-RESOLVED-'+p,true);assert.ok(h.state().counts['COUNT-RESOLVED-'+p]);assert.equal(h.total(),20-p);
});

test('portal adapter QA: count adoption after resolving actual6 preserves cumulative offset for a later8',()=>{
 const opts={review:true},h=fixture(opts),t=acceptedTask(h);queued(h,t,{status:'已开始'});h.sync();opts.review=false;let task=h.portal().tasks.find(x=>x.taskId===t.taskId);queued(h,task,{requestId:'RESOLVE-BEFORE-COUNT',actualText:'C1 TEB4:6'});h.sync();seedCount(h,'COUNT-CUMULATIVE-PORTAL',14);h.api.confirmNightCount('COUNT-CUMULATIVE-PORTAL',true);assert.equal(h.total(),14);task=h.portal().tasks.find(x=>x.taskId===t.taskId);queued(h,task,{requestId:'MORE-AFTER-COUNT',actualText:'C1 TEB4:8'});h.sync();assert.equal(h.total(),12);
});

test('portal adapter QA: reviewed actual outside a partial count scope does not close the whole warehouse',()=>{
 const opts={review:true},h=fixture(opts),t=acceptedTask(h);queued(h,t,{status:'已开始'});h.sync();opts.review=false;let st=h.state();st.inventory.push({inventoryId:'c2-zero',location:'C2',destination:'ABE8',shipmentId:'C2S',physicalP:0,occupiedSlots:0,slotBasis:'one_per_pallet',capacitySlots:27});st.version++;h.writeState(st);seedCount(h,'COUNT-UNRELATED-LOCATION',0,'C2','ABE8','C2S');h.api.confirmNightCount('COUNT-UNRELATED-LOCATION',true);assert.ok(h.state().counts['COUNT-UNRELATED-LOCATION']);assert.equal(h.total(),20);assert.ok(!h.state().loadingPortal.requests['SUBMIT-PORTAL-QA'].resolvedBy);
});

function clientScript(){const h=fixture(),html=h.context.WTCLoad_loadingPortalHtml();assert.ok(html.includes('登记已完成的移库'),'existing convenient move form remains available');const match=/<script>([\s\S]*?)<\/script>/.exec(html);assert.ok(match);return match[1];}
function validateClientLine(quantity,extra={}){
 const script=clientScript(),start=script.indexOf('function lineItems('),end=script.indexOf('function mapText(',start);assert.ok(start>=0&&end>start);
 const vals={'.location':'C1','.destination':'TEB4','.quantity':quantity,'.shipment':'',...extra},row={querySelector:name=>({value:vals[name]})};
 return vm.runInNewContext(script.slice(start,end)+'\nlineItems("actualRows",true);',{el:()=>({querySelectorAll:()=>[row]})});
}

test('portal GUI QA: generated inline JavaScript parses as delivered, not merely as the Apps Script template',()=>{
 assert.doesNotThrow(()=>new vm.Script(clientScript()));
});

test('portal GUI QA: ordinary numeric6 and explicit0 pass the delivered client validators',()=>{
 assert.equal(validateClientLine('6')[0].physicalP,6);assert.equal(validateClientLine('0')[0].physicalP,0);
});

test('portal GUI QA: blank, negative, fractional and newline-injected shipment are rejected before submit',()=>{
 for(const raw of ['', '-1','1.5'])assert.throws(()=>validateClientLine(raw));assert.throws(()=>validateClientLine('6',{'.shipment':'A\nB'}));
});
