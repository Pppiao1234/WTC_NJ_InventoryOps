'use strict';
// Independent administrative identity regression: local VM only, no external calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const Core = require('./engine.js');

const harnessFile = __dirname + '/qa.adapter.test.js';
let source = fs.readFileSync(harnessFile, 'utf8');
const boundary = '\nfunction moveInputsBeforeTime';
assert.ok(source.includes(boundary), 'Review the shared QA harness extraction boundary');
source = source.slice(0, source.indexOf(boundary));
source = source.replace('return {run:()=>context.WTCLoad.sync(null,false),', 'return {context,scriptProps,userProps,run:()=>context.WTCLoad.sync(null,false),');
const dimensionBranch = 'else if(req.appendDimension)';
assert.ok(source.includes(dimensionBranch), 'Review the shared atomic REST mock before extending it');
source = source.replace(dimensionBranch, "else if(req.moveDimension){const x=req.moveDimension;assert.equal(x.source.dimension,'ROWS');const d=staged.get(x.source.sheetId),n=x.source.endIndex-x.source.startIndex;assert.ok(d);const moved=d.splice(x.source.startIndex,n),at=x.destinationIndex>x.source.startIndex?x.destinationIndex-n:x.destinationIndex;d.splice(at,0,...moved);}\n        " + dimensionBranch);
source += '\nthis.makeHarness=harness;';
const runtime = { require:createRequire(harnessFile), __dirname, console, structuredClone, URL };
vm.createContext(runtime);
vm.runInContext(source, runtime, {filename:'identity-admin-harness.vm.js'});

function json(value) { return JSON.parse(JSON.stringify(value)); }
function fixture(options={}) {
  const h = runtime.makeHarness(options);
  h.selectedRow = 2; h.answers = []; h.batches = [];
  const book = h.context.SpreadsheetApp.openById('qa');
  book.getId = () => h.context.WTCLoad.config.spreadsheetId;
  book.setActiveSheet = () => book;
  book.setActiveRange = range => { h.selectedRow=range.getRow(); return range; };
  const Sheet = h.source.constructor;
  Sheet.prototype.getParent = () => book;
  Sheet.prototype.activate = function(){return this;};
  const Range = h.source.getRange(1,1).constructor;
  Range.prototype.activate = function(){h.selectedRow=this.getRow();return this;};
  Range.prototype.getA1Notation = function(){return `R${this.getRow()}C${this.getColumn()}:${this.getNumRows()}x${this.getNumColumns()}`;};
  h.context.SpreadsheetApp.getActiveRange = () => h.source.getRange(h.selectedRow,1);
  h.context.SpreadsheetApp.flush = () => {};
  h.context.SpreadsheetApp.getUi = () => ({
    ButtonSet:{OK_CANCEL:'OK_CANCEL',YES_NO:'YES_NO'}, Button:{OK:'OK',YES:'YES',CANCEL:'CANCEL'},
    prompt:() => ({getSelectedButton:()=> 'OK',getResponseText:()=> h.answers.shift() || ''}),
    alert:()=> 'YES'
  });
  const original=h.context.UrlFetchApp.fetch;
  h.context.UrlFetchApp.fetch=(url,opts)=>{
    if(opts.method==='post'&&url.includes('sheets.googleapis.com')) {
      const body=JSON.parse(opts.payload);h.batches.push(json(body));
      if(h.failNextBatch){h.failNextBatch=false;return {getResponseCode:()=>503,getContentText:()=>'{"error":"local QA failure"}'};}
    }
    return original(url,opts);
  };
  h.api = h.context.WTCLoad;
  h.restore = id => {h.answers.push(id);return h.context.WTCLoad_restoreSelectedTaskId();};
  h.move = row => {h.answers.push(String(row));return h.context.WTCLoad_moveSelectedTaskRow();};
  h.upgrade = () => h.context.WTCLoad_upgradeLoadingIdentity();
  h.edit = (row,col,rows=1,cols=1) => h.context.WTCLoad_onEdit({range:h.source.getRange(row,col,rows,cols),source:book});
  return h;
}
function seedLegacy(h) {
  const st=h.state(), digest=value=>crypto.createHash('sha256').update(Core.stableStringify(value)).digest('hex');
  const identity=digest({dateLabel:'10/30',destination:'MGE1/CLT2',reference:'ref'});
  st.inventory[0].physicalP=14;st.inventory[0].occupiedSlots=14;
  st.tasks['task-1']={sourceIdentity:identity,sourceRow:2,committedHash:digest({identity,status:'已结束',planned:'C1:8',actual:'C1:6'}),pending:false,ledger:{taskId:'task-1',status:'已结束',baselineVersion:'BASE-QA',actual:[{inventoryId:'i1',location:'C1',destination:'TEB4',shipmentId:'01003',physicalP:6,releasedSlots:6}],planned:[],projectedRemaining:[]}};
  h.writeState(st);return json(st.tasks['task-1'].ledger);
}
function rowOf(h,id='task-1') { return h.source.data.findIndex(row=>row[24]===id)+1; }
function assertNoStockChange(h,before,counts) {
  assert.deepEqual(json(h.state().inventory),before);
  assert.equal(h.counts().ai,counts.ai);
  assert.equal(h.counts().commits,counts.commits);
}
function newLayout(h) {
  const order=[0,1,2,3,4,5,6,7,8,9,19,20,22,23,10,11,12,13,14,15,16,17,18,21,24];
  h.source.data=h.source.data.map(row=>order.map(index=>row[index]??''));
}

test('identity admin: explicit new registration atomically writes known ID and clears copied actual',()=>{
  const h=fixture({noId:true}),before=json(h.state().inventory);
  h.newTask();const id=h.source.getRange(2,25).getValue();
  assert.ok(id);assert.equal(h.source.getRange(2,21).getValue(),'');assert.equal(h.source.getRange(2,20).getValue(),'C1:8');
  assert.equal(h.state().tasks[id].registration.status,'confirmed');assertNoStockChange(h,before,{ai:0,commits:0});
  const batch=h.batches.find(b=>b.requests.some(r=>r.updateCells?.range.sheetId===h.source.id&&r.updateCells.range.startColumnIndex===24));
  assert.ok(batch);assert.ok(batch.requests.some(r=>r.updateCells?.range.sheetId===h.sheets.get('_WTC状态').id));
  assert.ok(batch.requests.some(r=>r.updateCells?.range.sheetId===h.source.id&&r.updateCells.range.startColumnIndex===20));
});

test('identity admin: failed registration batch preserves blank ID, actual text, and state',()=>{
  const h=fixture({noId:true}),before=json(h.state());h.failNextBatch=true;
  assert.throws(()=>h.newTask(),/SHEETS_COMMIT_503/);
  assert.equal(h.source.getRange(2,25).getValue(),'');assert.equal(h.source.getRange(2,21).getValue(),'C1:6');assert.deepEqual(json(h.state()),before);
});

test('identity admin: a metadata-only prepared new task can be explicitly registered without quantities',()=>{
  const h=fixture({noId:true,planned:'',actual:''});h.newTask();
  const id=h.source.getRange(2,25).getValue();assert.ok(id);assert.equal(h.state().tasks[id].registration.status,'confirmed');assert.equal(h.counts().ai,0);
});

test('identity admin: an unknown supplied UUID cannot create a new stock deduction',()=>{
  const h=fixture();const st=h.state();delete st.tasks['task-1'];h.writeState(st);h.source.set(2,25,'unregistered-foreign-uuid');
  h.run();assert.equal(h.state().inventory[0].physicalP,20);assert.equal(h.counts().ai,0);assert.equal(h.counts().commits,0);assert.equal(h.state().tasks['unregistered-foreign-uuid']?.ledger,undefined);
});

test('identity admin: all identity administration remains restricted to the original installer',()=>{
  const h=fixture({owner:false}),before=json(h.state()),rows=json(h.source.data);
  assert.throws(()=>h.newTask());assert.throws(()=>h.restore('task-1'));assert.throws(()=>h.move(3));assert.throws(()=>h.upgrade());
  assert.deepEqual(json(h.state()),before);assert.deepEqual(json(h.source.data),rows);assert.equal(h.counts().ai,0);assert.equal(h.batches.length,0);
});

test('identity admin: recovering an orphan old ID preserves inventory, actual text, and previous ledger',()=>{
  const h=fixture();h.run();const ledger=json(h.state().tasks['task-1'].ledger),inventory=json(h.state().inventory),counts=h.counts();h.source.set(2,25,'');
  h.restore('task-1');assert.equal(h.source.getRange(2,25).getValue(),'task-1');assert.equal(h.source.getRange(2,21).getValue(),'C1:6');assert.deepEqual(json(h.state().tasks['task-1'].ledger),ledger);assertNoStockChange(h,inventory,counts);
  h.run();assertNoStockChange(h,inventory,counts);
});

test('identity admin: recovery refuses an ID still attached to a nonempty original task',()=>{
  const h=fixture();h.run();h.source.data.push(json(h.source.data[1]).slice(0,24));h.selectedRow=3;
  const before=json(h.state());assert.throws(()=>h.restore('task-1'));assert.equal(h.source.getRange(2,25).getValue(),'task-1');assert.equal(h.source.getRange(3,25).getValue(),'');assert.deepEqual(json(h.state()),before);
});

test('identity admin: recovery refuses metadata remaining on a purported empty leftover row',()=>{
  const h=fixture();h.run();const moved=json(h.source.data[1]).slice(0,24);h.source.data[1]=Array(25).fill('');h.source.set(2,25,'task-1');h.source.set(2,5,'原业务仍有Info');h.source.data.push(moved);h.selectedRow=3;
  assert.throws(()=>h.restore('task-1'));assert.equal(h.source.getRange(2,25).getValue(),'task-1');assert.equal(h.source.getRange(3,25).getValue(),'');
});

test('identity admin: recovery moves an ID from a genuinely empty leftover row in one batch',()=>{
  const h=fixture();h.run();const ledger=json(h.state().tasks['task-1'].ledger),inventory=json(h.state().inventory),counts=h.counts(),moved=json(h.source.data[1]).slice(0,24);
  h.source.data[1]=Array(25).fill('');h.source.set(2,25,'task-1');h.source.data.push(moved);h.selectedRow=3;const batchStart=h.batches.length;
  h.restore('task-1');assert.equal(h.source.getRange(2,25).getValue(),'');assert.equal(h.source.getRange(3,25).getValue(),'task-1');assert.deepEqual(json(h.state().tasks['task-1'].ledger),ledger);assertNoStockChange(h,inventory,counts);
  const batch=h.batches.slice(batchStart).find(b=>b.requests.some(r=>r.updateCells?.range.sheetId===h.sheets.get('_WTC状态').id));assert.ok(batch);
  assert.ok(batch.requests.some(r=>r.updateCells?.range.sheetId===h.source.id&&r.updateCells.range.startRowIndex===1&&r.updateCells.range.startColumnIndex===24));
  assert.ok(batch.requests.some(r=>r.updateCells?.range.sheetId===h.source.id&&r.updateCells.range.startRowIndex===2&&r.updateCells.range.startColumnIndex===24));
});

test('identity admin: failed recovery atomically preserves leftover ID, blank target, and original ledger',()=>{
  const h=fixture();h.run();const moved=json(h.source.data[1]).slice(0,24);h.source.data[1]=Array(25).fill('');h.source.set(2,25,'task-1');h.source.data.push(moved);h.selectedRow=3;
  const before=json(h.state()),rows=json(h.source.data);h.failNextBatch=true;assert.throws(()=>h.restore('task-1'),/SHEETS_COMMIT_503/);
  assert.deepEqual(json(h.state()),before);assert.deepEqual(json(h.source.data),rows);assert.equal(h.source.getRange(2,25).getValue(),'task-1');assert.equal(h.source.getRange(3,25).getValue(),'');
});

test('identity admin: restoring a baseline-checkpoint-only task never replays its included actual',()=>{
  const h=fixture({noId:true}),st=h.state();st.inventory[0].physicalP=14;st.inventory[0].occupiedSlots=14;st.baseline.appliedTasks['task-1']={taskId:'task-1',actual:[{inventoryId:'i1',location:'C1',destination:'TEB4',shipmentId:'01003',physicalP:6,releasedSlots:6}]};h.writeState(st);
  h.restore('task-1');assert.equal(h.state().inventory[0].physicalP,14);assert.equal(h.counts().ai,0);assert.equal(h.state().tasks['task-1'].ledger,undefined);
  h.source.set(2,21,'C1:8');h.run();h.run();assert.equal(h.state().inventory[0].physicalP,12);assert.equal(h.state().tasks['task-1'].ledger.actual[0].physicalP,8);assert.equal(h.counts().commits,1);
});

test('identity admin: confirmed recovery clears resolved binding review without changing previous actual',()=>{
  const h=fixture();h.run();newLayout(h);const inventory=json(h.state().inventory),counts=h.counts();h.edit(2,1,1,24);assert.equal(h.state().tasks['task-1'].pending,true);
  h.restore('task-1');h.run();assert.equal(h.state().tasks['task-1'].pending,false);assert.ok(!h.state().tasks['task-1'].bindingReview);assertNoStockChange(h,inventory,counts);
});

test('identity admin: removing a duplicated UUID clears only the resolved identity pending issue',()=>{
  const h=fixture();h.run();const inventory=json(h.state().inventory),counts=h.counts();h.source.data.push(json(h.source.data[1]));h.run();assert.equal(h.state().tasks['task-1'].pendingCode,'DUPLICATE_ID');
  h.source.data.pop();h.run();assert.equal(h.state().tasks['task-1'].pending,false);assertNoStockChange(h,inventory,counts);
});

test('identity admin: recovery refuses unknown IDs and an already occupied target UUID',()=>{
  const h=fixture();h.run();h.source.set(2,25,'');assert.throws(()=>h.restore('does-not-exist'));
  h.source.set(2,25,'another-existing-task');assert.throws(()=>h.restore('task-1'));assert.equal(h.source.getRange(2,25).getValue(),'another-existing-task');
});

for(const wasPaused of [false,true])test('identity admin: upgrade only migrates hashes and preserves prior pause='+wasPaused,()=>{
  const h=fixture(),ledger=seedLegacy(h);h.scriptProps.set('WTC_LOAD_PAUSED',String(wasPaused));const inventory=json(h.state().inventory),key=h.userProps.get('WTC_OPENAI_KEY');
  h.upgrade();assertNoStockChange(h,inventory,{ai:0,commits:0});assert.deepEqual(json(h.state().tasks['task-1'].ledger),ledger);assert.equal(h.api.status().paused,wasPaused);assert.equal(h.userProps.get('WTC_OPENAI_KEY'),key);
  h.upgrade();assertNoStockChange(h,inventory,{ai:0,commits:0});assert.deepEqual(json(h.state().tasks['task-1'].ledger),ledger);
});

test('identity admin: failed upgrade leaves the synchronizer paused and preserves old ledger',()=>{
  const h=fixture(),ledger=seedLegacy(h);h.failNextBatch=true;assert.throws(()=>h.upgrade(),/SHEETS_COMMIT_503|暂停/);
  assert.equal(h.api.status().paused,true);assert.deepEqual(json(h.state().tasks['task-1'].ledger),ledger);assert.equal(h.counts().ai,0);assert.equal(h.counts().commits,0);
});

test('identity admin: migration cannot swallow an actual increase that predates the upgrade',()=>{
  const h=fixture();seedLegacy(h);h.source.set(2,21,'C1:8');h.source.set(2,5,'MGE1/CLT2 / 升级前补充Info');h.upgrade();
  assert.equal(h.state().inventory[0].physicalP,14);assert.equal(h.state().tasks['task-1'].ledger.actual[0].physicalP,6);assert.equal(h.counts().ai,0);
  h.run();h.run();assert.equal(h.state().inventory[0].physicalP,12);assert.equal(h.state().tasks['task-1'].ledger.actual[0].physicalP,8);assert.equal(h.counts().commits,1);
});

test('identity admin: legacy UUID without ledger is not silently trusted by the upgrade',()=>{
  const h=fixture();const st=h.state();st.tasks['task-1']={pending:true,pendingCode:'BASELINE_MISSING',sourceRow:2};h.writeState(st);h.upgrade();h.run();
  assert.equal(h.state().inventory[0].physicalP,20);assert.equal(h.counts().ai,0);assert.equal(h.state().tasks['task-1'].ledger,undefined);
});

test('identity admin: an Info-only explicitly registered task is protected from empty-registration cleanup',()=>{
  const h=fixture({noId:true,planned:'',actual:''});h.newTask();const id=h.source.getRange(2,25).getValue(),registration=json(h.state().tasks[id].registration);h.pause();
  assert.equal(h.previewCleanup().count,0);h.cleanup();assert.equal(h.source.getRange(2,25).getValue(),id);assert.deepEqual(json(h.state().tasks[id].registration),registration);assert.equal(h.state().inventory[0].physicalP,20);
});

test('identity admin: cut to an ID-less target then background scan and recovery preserves committed stock',()=>{
  const h=fixture();h.run();const inventory=json(h.state().inventory),counts=h.counts(),ledger=json(h.state().tasks['task-1'].ledger),moved=json(h.source.data[1]).slice(0,24);
  h.source.data[1]=Array(25).fill('');h.source.set(2,25,'task-1');h.source.data.push(moved);h.run();
  assert.equal(h.state().tasks['task-1'].pendingCode,'SOURCE_BINDING_REVIEW');assertNoStockChange(h,inventory,counts);
  h.selectedRow=3;h.restore('task-1');h.run();assert.equal(h.source.getRange(2,25).getValue(),'');assert.equal(h.source.getRange(3,25).getValue(),'task-1');assert.equal(h.state().tasks['task-1'].pending,false);assert.deepEqual(json(h.state().tasks['task-1'].ledger),ledger);assertNoStockChange(h,inventory,counts);
});

test('identity admin: old unversioned correction authorization cannot authorize an actual reduction after upgrade',()=>{
  const h=fixture();seedLegacy(h);h.source.set(2,21,'C1:4');const st=h.state(),old=st.tasks['task-1'];old.correctionApprovedHash=crypto.createHash('sha256').update(Core.stableStringify({identity:old.sourceIdentity,status:'已结束',planned:'C1:8',actual:'C1:4'})).digest('hex');old.correctionReason='旧版曾经确认';h.writeState(st);
  h.upgrade();h.run();assert.equal(h.state().inventory[0].physicalP,14);assert.equal(h.state().tasks['task-1'].ledger.actual[0].physicalP,6);assert.equal(h.state().tasks['task-1'].pendingCode,'RULE_REVIEW');assert.equal(h.counts().ai,0);
});

test('identity admin: metadata updates do not erase a genuine accounting review or authorize a decrease',()=>{
  const h=fixture();h.run();h.source.set(2,21,'C1:4');h.run();const inventory=json(h.state().inventory),counts=h.counts();assert.equal(h.state().tasks['task-1'].pendingCode,'RULE_REVIEW');
  h.source.set(2,1,'10/31');h.source.set(2,5,'同一任务补充Info');h.source.set(2,6,'补充参考');h.source.set(2,9,'8');h.run();
  assert.equal(h.state().tasks['task-1'].pendingCode,'RULE_REVIEW');assert.equal(h.state().tasks['task-1'].pending,true);assert.equal(h.state().tasks['task-1'].ledger.actual[0].physicalP,6);assertNoStockChange(h,inventory,counts);
});

test('identity admin: registering a copied settled row clears only the new actual and preserves the original ledger',()=>{
  const h=fixture();h.run();const inventory=json(h.state().inventory),counts=h.counts(),ledger=json(h.state().tasks['task-1'].ledger);h.source.data.push(json(h.source.data[1]));h.selectedRow=3;
  h.newTask();const id=h.source.getRange(3,25).getValue();assert.notEqual(id,'task-1');assert.equal(h.source.getRange(3,21).getValue(),'');assert.equal(h.source.getRange(2,21).getValue(),'C1:6');assert.deepEqual(json(h.state().tasks['task-1'].ledger),ledger);h.run();assertNoStockChange(h,inventory,counts);
});

test('identity admin: an unknown UUID recorded only as pending cannot be falsely restored as a confirmed task',()=>{
  const h=fixture();const st=h.state();delete st.tasks['task-1'];h.writeState(st);h.run();assert.equal(h.state().tasks['task-1'].pendingCode,'REGISTRATION_REQUIRED');
  assert.throws(()=>h.restore('task-1'));assert.equal(h.state().inventory[0].physicalP,20);assert.equal(h.counts().ai,0);
});

test('identity admin: move before a later row sends native whole-row move and preserves all columns',()=>{
  const h=fixture();h.run();const inventory=json(h.state().inventory),counts=h.counts();h.source.set(2,40,'untracked-column-stays-with-task');
  h.source.data.push(['10/30','','','','task B'],['10/30','','','','task C'],['10/31','','','','target D']);
  const result=h.move(5),moves=h.batches.flatMap(b=>b.requests).filter(r=>r.moveDimension);assert.equal(moves.length,1);
  assert.deepEqual(moves[0].moveDimension,{source:{sheetId:h.source.id,dimension:'ROWS',startIndex:1,endIndex:2},destinationIndex:4});
  assert.equal(rowOf(h),4);assert.equal(h.source.getRange(4,40).getValue(),'untracked-column-stays-with-task');assert.equal(result.toRow,4);assertNoStockChange(h,inventory,counts);
  h.source.set(4,21,'C1:8');h.run();assert.equal(h.state().inventory[0].physicalP,12);assert.equal(h.state().tasks['task-1'].sourceRow,4);
});

test('identity admin: move before an earlier row has correct native destination index and UUID',()=>{
  const h=fixture();h.run();const original=h.source.data.splice(1,1)[0];h.source.data.push(['10/30','','','','B'],['10/30','','','','C'],['10/30','','','','D'],original);h.selectedRow=5;
  h.move(2);const move=h.batches.flatMap(b=>b.requests).find(r=>r.moveDimension).moveDimension;
  assert.equal(move.source.startIndex,4);assert.equal(move.source.endIndex,5);assert.equal(move.destinationIndex,1);assert.equal(rowOf(h),2);assert.equal(h.state().inventory[0].physicalP,14);
});

test('identity admin: moving a duplicated task UUID is refused before any row mutation',()=>{
  const h=fixture();h.source.data.push(json(h.source.data[1]));const before=json(h.source.data);assert.throws(()=>h.move(3));assert.deepEqual(json(h.source.data),before);assert.ok(!h.batches.some(b=>b.requests.some(r=>r.moveDimension)));
});

test('identity admin: a local A:X paste marks the affected registered task for binding review',()=>{
  const h=fixture();h.run();newLayout(h);const inventory=json(h.state().inventory),counts=h.counts();h.source.set(2,5,'局部粘贴后的Info');h.source.set(2,12,'C1:8');
  h.edit(2,1,1,24);assert.ok(h.state().tasks['task-1'].bindingReview,'partial business-block paste must not be accepted as a normal same-ID edit');assertNoStockChange(h,inventory,counts);
});

test('identity admin: ordinary multirow K:L quantity editing does not raise an identity binding review',()=>{
  const h=fixture();h.run();newLayout(h);h.source.set(2,12,'C1:8');h.edit(2,11,2,2);
  assert.ok(!h.state().tasks['task-1'].bindingReview);assert.equal(h.state().inventory[0].physicalP,12);assert.equal(h.state().tasks['task-1'].ledger.actual[0].physicalP,8);
});

test('identity admin: dashboard follows upgrade pending counts and metadata state versions without changing stock version',()=>{
  const legacy=fixture(),oldState=legacy.state();oldState.tasks['task-1']={sourceRow:2,pending:false};legacy.writeState(oldState);legacy.upgrade();
  const upgraded=legacy.state(),pending=Object.values(upgraded.tasks).filter(task=>task.pending).length+Object.values(upgraded.unloadTasks||{}).filter(task=>task.pending).length,dashboard=legacy.sheets.get('WTC同步状态');
  assert.equal(dashboard.getRange(9,2).getValue(),upgraded.version);assert.equal(dashboard.getRange(8,2).getValue(),pending);assert.equal(pending,1);assert.equal(legacy.counts().ai,0);
  const metadata=fixture();metadata.run();const before=metadata.state(),counts=metadata.counts();metadata.source.set(2,5,'原任务仅补充Info');metadata.run();const after=metadata.state();
  assert.ok(after.version>before.version);assert.equal(after.inventoryVersion,before.inventoryVersion);assert.deepEqual(json(after.inventory),json(before.inventory));assert.equal(metadata.counts().ai,counts.ai);assert.equal(metadata.counts().commits,counts.commits);
  assert.equal(metadata.sheets.get('WTC同步状态').getRange(9,2).getValue(),after.version);assert.equal(metadata.sheets.get('WTC同步状态').getRange(8,2).getValue(),Object.values(after.tasks).filter(task=>task.pending).length);
});
