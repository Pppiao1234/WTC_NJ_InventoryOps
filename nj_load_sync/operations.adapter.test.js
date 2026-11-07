'use strict';
// Independent Apps Script transaction review, with local Sheets/OpenAI doubles.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {createRequire}=require('node:module');
const Unload=require('./unload_engine.js');
const copy=value=>JSON.parse(JSON.stringify(value));

const qaFile=path.join(__dirname,'qa.adapter.test.js');
let harnessSource=fs.readFileSync(qaFile,'utf8');
const boundary='\nfunction moveInputsBeforeTime';
assert.ok(harnessSource.includes(boundary),'Review the shared local VM harness boundary');
harnessSource=harnessSource.slice(0,harnessSource.indexOf(boundary));
harnessSource=harnessSource.replace('const context={WTCLoadCore:Core,Date,JSON,console,',"const context={WTCLoadCore:Core,WTCUnloadCore:require('./unload_engine.js'),WTCInventoryCore:require('./operations_engine.js'),Date,JSON,console,");
harnessSource=harnessSource.replace('return {run:()=>context.WTCLoad.sync(null,false),','return {api:context.WTCLoad,context,scriptProps,userProps,run:()=>context.WTCLoad.sync(null,false),');
// A Sheets note-only update preserves the cell value; the older QA double only
// needed value writes, so extend that double instead of weakening this check.
harnessSource=harnessSource.replace('u.rows.forEach((r,i)=>r.values.forEach((v,j)=>set(d,u.range.startRowIndex+i,u.range.startColumnIndex+j,decode(v))));',
  "if(u.fields.includes('userEnteredValue'))u.rows.forEach((r,i)=>r.values.forEach((v,j)=>set(d,u.range.startRowIndex+i,u.range.startColumnIndex+j,decode(v))));");
harnessSource+='\nthis.makeHarness=harness;';
const runtime={require:createRequire(qaFile),__dirname,console,structuredClone,URL};
vm.createContext(runtime);vm.runInContext(harnessSource,runtime,{filename:'operations-harness.vm.js'});

function fixture(options={}) {
  const h=runtime.makeHarness({...options,planned:'',actual:'',noId:true}),C=h.api.config,Sheet=h.source.constructor;
  const book=h.context.SpreadsheetApp.openById('qa'),Range=h.source.getRange(1,1).constructor;
  const noop=function(){return this;};
  for(const method of ['setBackground','setFontWeight','setNumberFormat','setWrap','setWrapStrategy','setVerticalAlignment','setFontSize','setFontFamily','setDataValidation','clearDataValidations','setNote'])Range.prototype[method]=noop;
  for(const method of ['setFrozenRows','setFrozenColumns','setColumnWidths','setColumnWidth','autoResizeColumns','setHiddenGridlines','hideSheet','showSheet'])Sheet.prototype[method]=noop;
  Sheet.prototype.isSheetHidden=()=>false;
  Sheet.prototype.getParent=()=>book;
  book.insertSheet=name=>new Sheet(name,[[]]);book.getSheets=()=>[...h.sheets.values()];book.getId=()=>C.spreadsheetId;book.setActiveSheet=()=>book;
  h.context.SpreadsheetApp.flush=()=>{};
  h.context.SpreadsheetApp.getUi=()=>({ButtonSet:{YES_NO:'YES_NO',OK_CANCEL:'OK_CANCEL'},Button:{YES:'YES',OK:'OK',NO:'NO'},alert:()=> 'YES',prompt:()=>({getSelectedButton:()=> 'OK',getResponseText:()=>h.selectedCountId||'COUNT-QA'})});
  const props=map=>({getProperty:key=>map.get(key)||null,setProperty:(key,value)=>{map.set(key,value);return props(map);},deleteProperty:key=>{map.delete(key);return props(map);},getProperties:()=>Object.fromEntries(map)});
  h.context.PropertiesService.getScriptProperties=()=>props(h.scriptProps);h.context.PropertiesService.getUserProperties=()=>props(h.userProps);
  const plans=[C.unloadHeaders];
  C.unloadTasks.forEach((task,index)=>plans.push(['PAPER-QA','1',`qa-${task.containerNo}/part01`,task.taskId,task.containerNo,index===1?'TEB4':`D${index}`,'',index===1?'C1':index===0?'C2':`C${Math.min(index,4)}`,'ordinary',index===1?4:1,index===1?4:1,'','',true]));
  new Sheet(C.sheets.published,plans);
  const catalog=new Sheet('库位地图',[]);catalog.data[47]=['库位','收工状态','已知实物板数','图示容量','图示可用板位','保守参考余位','说明'];
  catalog.data[48]=['C1','有货',20,27,null,7,''];for(let n=2;n<=4;n++)catalog.data.push([`C${n}`,'空位',0,27,27,27,'']);
  const external=new Sheet('10/30',[]);external.data[5]=['海柜状态','拆空','拆空','拆空','拆空','拆空'];external.data[14]=['櫃號','#90004\nFCH260101-01','01001','01005','01003','01002'];
  for(const [name,headers] of [[C.sheets.unloadView,C.unloadViewHeaders],[C.sheets.capacityView,C.capacityViewHeaders],[C.sheets.unloadLedger,C.unloadLedgerHeaders]])new Sheet(name,[headers]);
  const state=h.state();state.capacityCatalog={C1:{location:'C1',status:'有货',physicalP:20,capacitySlots:27}};
  for(let n=2;n<=4;n++)state.capacityCatalog[`C${n}`]={location:`C${n}`,status:'空位',physicalP:0,capacitySlots:27};
  state.unloadTasks={};
  for(const row of plans.slice(1)) {
    const entry={};C.unloadHeaders.forEach((key,index)=>entry[key]=row[index]);
    const effect=Unload.computeUnloadEffect({taskId:entry.taskId,containerNo:entry.containerNo,status:'拆空',publicationId:'PAPER-QA',revision:'1',allocations:[entry],allowedLocations:Object.keys(state.capacityCatalog)});
    assert.equal(effect.ok,true,JSON.stringify(effect.issues));state.unloadTasks[entry.taskId]={ledger:effect.nextLedger,observedStatus:'拆空',pending:false};
  }
  h.writeState(state);h.external=external;h.catalog=catalog;h.batches=[];
  const originalFetch=h.context.UrlFetchApp.fetch;
  h.context.UrlFetchApp.fetch=(url,opts)=>{
    let physical=false;
    if(opts.method==='post'&&url.includes('sheets.googleapis.com')) {
      const body=JSON.parse(opts.payload);h.batches.push(copy(body));
      if(h.failNextAtomic){h.failNextAtomic=false;return {getResponseCode:()=>503,getContentText:()=>'{"error":"local whole-batch failure"}'};}
      physical=body.requests.some(req=>req.appendCells?.sheetId===h.sheets.get(C.sheets.physicalLedger)?.id);
      if(physical&&h.failPhysical==='before'){h.failPhysical='';return {getResponseCode:()=>503,getContentText:()=>'{"error":"local before-commit failure"}'};}
    }
    const result=originalFetch(url,opts);
    if(physical&&h.failPhysical==='after'){h.failPhysical='';throw new Error('local response lost after physical commit');}
    return result;
  };
  h.upgrade=()=>h.api.upgradeInventoryOps();h.syncOps=(force=false)=>h.api.syncInventoryOps(force);
  h.preview=id=>h.api.previewNightCount(id);h.confirm=(id,accepted)=>h.api.confirmNightCount(id,accepted);
  h.receiptRow=()=>['2026-10-30','DEMU1001001','TEB4','C1',5,4,1,'已核对·待入账','photo-QA','qa-observed','UR-QA-1','qa-DEMU1001001/part01','','本柜仓点合计','unknown','QA actual'];
  h.seedReceipt=()=>{const sheet=h.sheets.get(C.sheets.receipt);sheet.data.push(h.receiptRow());return sheet;};
  h.seedMove=()=>{const sheet=h.sheets.get(C.sheets.moves);sheet.data.push(['MOVE-QA','2026-10-30','TEB4','01003','C1','C2',5,'待执行','QA现场移库','']);return sheet;};
  h.seedCount=(p=18)=>{const sheet=h.sheets.get(C.sheets.counts);sheet.data.push(['COUNT-QA','2026-10-30','C1','TEB4','01003',p,'["C1"]',true,'待核对','']);return sheet;};
  h.total=()=>h.state().inventory.reduce((sum,row)=>sum+row.physicalP,0);
  h.physicalRows=()=>h.sheets.get(C.sheets.physicalLedger)?.data.slice(1)||[];
  return h;
}
function attempt(fn){try{return fn();}catch(error){return error;}}

test('ops adapter: upgrade preserves physical stock, existing key, baseline, and trigger configuration',()=>{
  const h=fixture(),before=copy(h.state()),key=h.userProps.get('WTC_OPENAI_KEY'),owner=h.scriptProps.get('WTC_LOAD_OWNER_MARKER');
  h.upgrade();assert.deepEqual(copy(h.state().inventory),before.inventory);assert.deepEqual(copy(h.state().baseline),before.baseline);
  assert.equal(h.userProps.get('WTC_OPENAI_KEY'),key);assert.equal(h.scriptProps.get('WTC_LOAD_OWNER_MARKER'),owner);
  assert.equal(h.scriptProps.get('WTC_INVENTORY_OPS_ENABLED'),'true');
  for(const name of ['receipt','moves','counts','countDiff','physicalLedger'])assert.ok(h.sheets.get(h.api.config.sheets[name]),name+' input exists');
  assert.equal(h.counts().ai,0);
});

test('ops adapter: original installer restriction is retained for upgrade and manual commit',()=>{
  const h=fixture({owner:false}),before=copy(h.state());assert.throws(()=>h.upgrade());assert.deepEqual(copy(h.state()),before);
});

test('ops adapter: receipt stock, estimate revocation, queue status and audit are one atomic transaction',()=>{
  const h=fixture();h.upgrade();const sheet=h.seedReceipt();h.syncOps();assert.equal(h.total(),25);
  assert.match(String(sheet.data[1][7]),/已入账|已处理/);assert.equal(h.physicalRows().length,1);
  assert.ok(!h.state().unloadTasks.DEMU1001001.ledger.reservations.some(row=>row.allocationId==='qa-DEMU1001001/part01'));
  const batch=h.batches.find(body=>body.requests.some(req=>req.appendCells?.sheetId===h.sheets.get(h.api.config.sheets.physicalLedger).id));
  for(const name of ['_WTC状态','_WTC实时库存','WTC实拆回单'])assert.ok(batch.requests.some(req=>req.updateCells?.range.sheetId===h.sheets.get(name).id),name+' shares commit');
});

test('ops adapter: replaying a receipt and refreshing source status never restores its revoked estimate',()=>{
  const h=fixture();h.upgrade();const sheet=h.seedReceipt();h.syncOps();const calls=h.counts().ai;
  h.syncOps();assert.equal(h.total(),25);assert.equal(h.physicalRows().length,1);assert.equal(h.counts().ai,calls);
  h.external.set(6,3,'在拆');h.api.syncUnload(true);h.external.set(6,3,'拆空');h.api.syncUnload(true);
  assert.equal(h.total(),25);assert.ok(!h.state().unloadTasks.DEMU1001001.ledger.reservations.some(row=>row.allocationId==='qa-DEMU1001001/part01'));
  assert.match(String(sheet.data[1][7]),/已入账|已处理/);
});

for(const when of ['before','after'])test('ops adapter: atomic '+when+' commit failure cannot double or partly post stock',()=>{
  const h=fixture();h.upgrade();const sheet=h.seedReceipt();h.failPhysical=when;attempt(()=>h.syncOps());
  assert.equal(h.total(),when==='before'?20:25);assert.equal(h.physicalRows().length,when==='before'?0:1);
  h.syncOps(true);assert.equal(h.total(),25);assert.equal(h.physicalRows().length,1);assert.match(String(sheet.data[1][7]),/已入账|已处理/);
});

for(const field of ['taskId','stateVersion','inputHash','proposalHash'])test('ops adapter: forged AI '+field+' is denied',()=>{
  const h=fixture({forge:field});h.upgrade();h.seedReceipt();attempt(()=>h.syncOps());assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);
});

test('ops adapter: a physical source change during AI cannot commit the previous quantity',()=>{
  let h,once=true;h=fixture({aiHook:()=>{if(once){once=false;h.sheets.get(h.api.config.sheets.receipt).set(2,5,6);}}});
  h.upgrade();h.seedReceipt();attempt(()=>h.syncOps());assert.notEqual(h.total(),25);
  h.syncOps(true);assert.equal(h.total(),26);assert.equal(h.physicalRows().length,1);
});

test('ops adapter: a state version change during AI forces a fresh physical proposal',()=>{
  let h,once=true;h=fixture({aiHook:()=>{if(once){once=false;const st=h.state();st.version++;st.inventoryVersion++;h.writeState(st);}}});
  h.upgrade();h.seedReceipt();attempt(()=>h.syncOps());h.syncOps(true);assert.equal(h.total(),25);assert.equal(h.physicalRows().length,1);assert.ok(h.counts().ai>=2);
});

test('ops adapter: actual move commits both lanes together and keeps total stock unchanged',()=>{
  const h=fixture();h.upgrade();const sheet=h.seedMove();h.syncOps();assert.equal(h.total(),20);
  assert.equal(h.state().inventory.filter(row=>row.location==='C1').reduce((sum,row)=>sum+row.physicalP,0),15);
  assert.equal(h.state().inventory.filter(row=>row.location==='C2').reduce((sum,row)=>sum+row.physicalP,0),5);
  assert.match(String(sheet.data[1][7]),/已入账|已处理|已完成|已移库/);assert.equal(h.physicalRows().length,1);
  h.syncOps();assert.equal(h.total(),20);assert.equal(h.physicalRows().length,1);
});

test('ops adapter: night-count preview and background ticks cannot silently adopt its discrepancy',()=>{
  const h=fixture();h.upgrade();h.seedCount();const before=copy(h.state().inventory);h.preview('COUNT-QA');
  assert.deepEqual(copy(h.state().inventory),before);h.syncOps();assert.deepEqual(copy(h.state().inventory),before);
  assert.ok(h.sheets.get(h.api.config.sheets.countDiff).data.length>1);assert.equal(h.physicalRows().length,0);
});

test('ops adapter: accepted fresh night count carries the measured inventory to a new baseline',()=>{
  const h=fixture();h.upgrade();h.seedCount();const baseline=h.state().baseline.version;h.preview('COUNT-QA');h.confirm('COUNT-QA',true);
  assert.equal(h.total(),18);assert.notEqual(h.state().baseline.version,baseline);assert.equal(h.physicalRows().length,1);
});

test('ops adapter: intervening stock version invalidates the night-count preview',()=>{
  const h=fixture();h.upgrade();h.seedCount();h.preview('COUNT-QA');const st=h.state();st.version++;st.inventoryVersion++;h.writeState(st);
  attempt(()=>h.confirm('COUNT-QA',true));assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);
});

test('ops adapter: changing night-count values after preview invalidates adoption',()=>{
  const h=fixture();h.upgrade();const sheet=h.seedCount();h.preview('COUNT-QA');sheet.set(2,6,16);
  attempt(()=>h.confirm('COUNT-QA',true));assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);
});

test('ops adapter: missing AI key never records measured receipts as posted stock',()=>{
  const h=fixture({api:false});h.upgrade();h.seedReceipt();attempt(()=>h.syncOps());assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);assert.equal(h.counts().ai,0);
});

test('ops adapter: upgrade preserves an existing maintenance pause and never posts a queued receipt',()=>{
  const h=fixture();h.scriptProps.set('WTC_LOAD_PAUSED','true');h.upgrade();h.seedReceipt();h.syncOps();
  assert.equal(h.scriptProps.get('WTC_LOAD_PAUSED'),'true');assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);assert.equal(h.counts().ai,0);
});

test('ops adapter: failed upgrade leaves original inventory untouched and background processing paused',()=>{
  const h=fixture(),before=copy(h.state().inventory);h.failNextAtomic=true;assert.throws(()=>h.upgrade());
  assert.deepEqual(copy(h.state().inventory),before);assert.equal(h.scriptProps.get('WTC_LOAD_PAUSED'),'true');assert.notEqual(h.scriptProps.get('WTC_INVENTORY_OPS_ENABLED'),'true');
});

test('ops adapter: one background tick posts a receipt before loading its measured incoming stock',()=>{
  const h=fixture();h.upgrade();h.seedReceipt();h.source.set(2,5,'TEB4');h.source.set(2,20,'C1 TEB4:25');h.source.set(2,21,'C1 TEB4:25');h.source.set(2,25,'load-after-receipt');
  const state=h.state();state.tasks['load-after-receipt']={registration:{status:'confirmed',method:'fixture'}};h.writeState(state);
  h.context.WTCLoad_tick();assert.equal(h.total(),0);assert.equal(h.physicalRows().length,1);
  assert.equal(h.sheets.get('_WTC任务流水').data.length,2);h.context.WTCLoad_tick();assert.equal(h.total(),0);
});

test('ops adapter: loss of the count commit response never applies its variance twice',()=>{
  const h=fixture();h.upgrade();h.seedCount();h.preview('COUNT-QA');h.failPhysical='after';const result=h.confirm('COUNT-QA',true);
  assert.equal(h.total(),18);assert.equal(h.physicalRows().length,1);assert.equal(result.ok,true);
  attempt(()=>h.confirm('COUNT-QA',true));assert.equal(h.total(),18);assert.equal(h.physicalRows().length,1);
});

test('ops adapter: an incomplete count may be previewed but cannot become next-day inventory',()=>{
  const h=fixture();h.upgrade();const sheet=h.seedCount();sheet.set(2,8,'');h.preview('COUNT-QA');attempt(()=>h.confirm('COUNT-QA',true));
  assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);
});

test('ops adapter: a repeated sidebar move submission creates and settles one physical move',()=>{
  const h=fixture();h.upgrade();const input={operationId:'MOVE-UI-STABLE',businessDate:'2026-10-30',sourceLocation:'C1',targetLocation:'C2',destination:'TEB4',shipmentId:'01003',physicalP:5,sourceRef:'sidebar QA'};
  h.api.registerMove(input);h.api.registerMove(copy(input));assert.equal(h.sheets.get(h.api.config.sheets.moves).data.length,2);
  assert.throws(()=>h.api.registerMove({...input,physicalP:6}));assert.equal(h.sheets.get(h.api.config.sheets.moves).data.length,2);
  h.syncOps();h.api.registerMove(copy(input));h.syncOps();assert.equal(h.total(),20);assert.equal(h.physicalRows().length,1);
  assert.equal(h.state().inventory.filter(row=>row.location==='C1').reduce((sum,row)=>sum+row.physicalP,0),15);
});

test('ops adapter: partially verified receipt groups cannot post through normal or forced scans',()=>{
  const h=fixture();h.upgrade();const source=h.seedReceipt(),state=h.state(),task=state.unloadTasks.DEMU1001001.ledger;
  const allocation={...task.publishedAllocations[0],allocationId:'qa-second/part01',location:'C2',destination:'D2',estimatedP:2,estimatedSlots:2};
  task.publishedAllocations.push(allocation);task.reservations.push({...task.reservations[0],allocationId:allocation.allocationId,location:'C2',destination:'D2',estimatedP:2,estimatedSlots:2});h.writeState(state);
  const second=h.receiptRow();second[2]='D2';second[3]='C2';second[4]=2;second[5]=2;second[6]=0;second[7]='待确认';second[11]=allocation.allocationId;source.data.push(second);
  h.syncOps();h.syncOps(true);assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);
  source.set(3,8,'已核对·待入账');h.syncOps(true);assert.equal(h.total(),27);assert.equal(h.physicalRows().length,1);
});

test('ops adapter: idempotent receipt recovery clears stale pending state without another stock change',()=>{
  const h=fixture();h.upgrade();const source=h.seedReceipt();h.syncOps();const st=h.state(),inventoryVersion=st.inventoryVersion;
  st.operationPending={'UR-QA-1':{code:'SYNC_ERROR',inputHash:'stale',message:'old failure'}};h.writeState(st);source.set(2,8,'待核查');h.syncOps(true);
  assert.equal(h.total(),25);assert.equal(h.physicalRows().length,1);assert.equal(h.state().inventoryVersion,inventoryVersion);
  assert.equal(h.state().operationPending['UR-QA-1'],undefined);assert.match(String(source.data[1][7]),/已入账/);
});

for(const kind of ['receipt','move'])test('ops adapter: a same-day pending '+kind+' touching the counted lane prevents adoption',()=>{
  const h=fixture();h.upgrade();h.seedCount();if(kind==='receipt')h.seedReceipt();else h.seedMove();h.preview('COUNT-QA');
  const baseline=h.state().baseline.version;attempt(()=>h.confirm('COUNT-QA',true));assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);assert.equal(h.state().baseline.version,baseline);
  h.syncOps(true);h.preview('COUNT-QA');h.confirm('COUNT-QA',true);assert.equal(h.state().inventory.filter(row=>row.location==='C1').reduce((p,row)=>p+row.physicalP,0),18);
});

test('ops adapter: a same-day unreviewed receipt cannot be hidden from the night-count gate',()=>{
  const h=fixture();h.upgrade();h.seedCount();const receipt=h.seedReceipt();receipt.set(2,8,'待确认');h.preview('COUNT-QA');
  attempt(()=>h.confirm('COUNT-QA',true));assert.equal(h.total(),20);assert.equal(h.physicalRows().length,0);
});

test('ops adapter: future pending receipts do not block a completed earlier night count',()=>{
  const h=fixture();h.upgrade();h.seedCount();const receipt=h.seedReceipt();receipt.set(2,1,'2026-10-31');h.preview('COUNT-QA');h.confirm('COUNT-QA',true);
  assert.equal(h.total(),18);assert.equal(h.physicalRows().length,1);assert.match(String(receipt.data[1][7]),/待入账/);
});

test('ops adapter: pending receipts wholly outside the declared count scope do not block adoption',()=>{
  const h=fixture();h.upgrade();h.seedCount();const receipt=h.seedReceipt();receipt.set(2,4,'C2');h.preview('COUNT-QA');h.confirm('COUNT-QA',true);
  assert.equal(h.total(),18);assert.equal(h.physicalRows().length,1);assert.match(String(receipt.data[1][7]),/待入账/);
});

test('ops adapter: an already posted receipt duplicate is not an unresolved night-count blocker',()=>{
  const h=fixture();h.upgrade();const receipt=h.seedReceipt();h.syncOps();receipt.set(2,8,'待核查');h.seedCount();h.preview('COUNT-QA');h.confirm('COUNT-QA',true);
  assert.equal(h.total(),18);assert.equal(h.physicalRows().length,2);assert.equal(h.state().operationJournal.filter(entry=>entry.type==='receipt').length,1);
});

test('ops adapter: previewing an adopted historical count retains its original discrepancy after later movements',()=>{
  const h=fixture();h.upgrade();h.seedCount();const original=h.preview('COUNT-QA');h.confirm('COUNT-QA',true);
  const moves=h.seedMove();moves.set(2,2,'2026-10-31');h.syncOps();assert.equal(h.state().inventory.filter(row=>row.location==='C1').reduce((p,row)=>p+row.physicalP,0),13);
  const before=copy(h.state().inventory),again=h.preview('COUNT-QA');assert.equal(again.historical,true);
  assert.deepEqual(copy(again.report.rows),copy(original.report.rows));assert.equal(again.report.rows[0].expectedP,20);assert.equal(again.report.rows[0].actualP,18);assert.equal(again.report.rows[0].differenceP,-2);
  assert.deepEqual(copy(h.state().inventory),before);assert.equal(h.physicalRows().length,2);
});
