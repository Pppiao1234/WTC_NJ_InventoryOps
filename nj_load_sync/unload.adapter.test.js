'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const buildLargePlan = require('./fixtures/synthetic_unload.js').buildLargePlan;
// Reuse the independent fresh-REST Apps Script doubles without registering their tests.
const qaFile = path.join(__dirname, 'qa.adapter.test.js');
let harnessSource = fs.readFileSync(qaFile, 'utf8');
harnessSource = harnessSource.slice(0, harnessSource.indexOf("test('QA no API"));
harnessSource = harnessSource.replace('const context={WTCLoadCore:Core,Date,JSON,console,', "const context={WTCLoadCore:Core,WTCUnloadCore:require('./unload_engine.js'),Date,JSON,console,");
harnessSource = harnessSource.replace('return {run:()=>context.WTCLoad.sync(null,false),', 'return {api:context.WTCLoad,context,scriptProps,userProps,run:()=>context.WTCLoad.sync(null,false),');
harnessSource += '\nthis.makeHarness=harness;';
const localRequire = name => name.startsWith('.') ? require(path.resolve(__dirname, name)) : require(name);
const runtime = {require:localRequire,__dirname,console,structuredClone,Date,URL};
vm.createContext(runtime); vm.runInContext(harnessSource, runtime, {filename:'unload-harness.vm.js'});

function fixture(options={}) {
 const h=runtime.makeHarness(options), Sheet=h.source.constructor, C=h.api.config;
 const plan=[C.unloadHeaders];
 C.unloadTasks.forEach((task,index)=>plan.push(['PAPER-20261030','1','group-'+index+'/part01',task.taskId,task.containerNo,index===1?'TEB4':'D'+index,'',index===0||index===4?'检查区':'C'+index,index===0||index===4?'via_inspection':'ordinary',[9,6,5,3,8][index],[9,6,5,3,8][index],'',index===0||index===4?'中票':'',true]));
 new Sheet(C.sheets.published,plan);
 const catalog=new Sheet('库位地图',[]);
 catalog.data[47]=['库位','收工状态','已知实物板数','图示容量','图示可用板位','保守参考余位','说明'];
 catalog.data[48]=['C1','有货',20,27,null,7,''];
 catalog.data[49]=['C2','空位',0,27,27,27,''];
 catalog.data[50]=['C3','空位',0,27,27,27,''];
 catalog.data[51]=['检查区','空位',0,64,64,64,''];
 const external=new Sheet('10/30',[]);
 external.data[5]=['海柜状态','已到','已到','已到','已到','已到'];
 external.data[14]=['櫃號','#90004\nFCH260101-01','01001','01005','01003','01002'];
 for(const [name,headers] of [[C.sheets.unloadView,C.unloadViewHeaders],[C.sheets.capacityView,C.capacityViewHeaders],[C.sheets.unloadLedger,C.unloadLedgerHeaders]])new Sheet(name,[headers]);
 const rangePrototype=Object.getPrototypeOf(h.source.getRange(1,1));rangePrototype.setBackground=function(){return this;};rangePrototype.setFontWeight=function(){return this;};
 Sheet.prototype.setFrozenRows=function(){};Sheet.prototype.isSheetHidden=function(){return false;};Sheet.prototype.hideSheet=function(){};
 h.context.SpreadsheetApp.flush=()=>{};
 h.external=external;h.plan=plan;h.catalog=catalog;h.unload=()=>h.api.syncUnload(true);return h;
}
function json(value){return JSON.parse(JSON.stringify(value));}

test('unload adapter accepts confirmed after-close boundary without inventing a clock',()=>{
 const h=fixture();assert.equal(h.api.validBaselineBoundary('2026/10/29 收工后'),true);assert.equal(h.api.validBaselineBoundary('2026/02/30 收工后'),false);assert.equal(h.api.validBaselineBoundary('2026/10/29'),false);
 const settings=h.sheets.get('_WTC设置');settings.set(4,2,'2026/10/29 收工后');
 const st=h.state();st.baseline.confirmed=false;h.writeState(st);const b=h.sheets.get('_WTC库位基准');b.data.push(['BASE-1','C1','TEB4','',20,20,'one_per_pallet',27]);h.confirmBaseline();assert.equal(h.state().baseline.asOf,'2026/10/29 收工后');
});
test('unload adapter reviews all five paper plans but never creates physical incoming stock',()=>{
 const h=fixture();const before=json(h.state().inventory);h.unload();assert.deepEqual(json(h.state().inventory),before);assert.equal(Object.keys(h.state().unloadTasks).length,5);assert.equal(h.counts().ai,5);
 assert.ok(Object.values(h.state().unloadTasks).every(task=>!task.pending&&task.ledger.reservations.every(r=>r.kind==='planned_hold')));
 const calls=h.counts().ai;h.unload();assert.equal(h.counts().ai,calls);
});
test('unload adapter active then emptied ordinary cargo keeps one estimate and no physical receipt',()=>{
 const h=fixture();h.external.set(6,3,'在拆');h.unload();let ledger=h.state().unloadTasks.DEMU1001001.ledger;assert.equal(ledger.reservations.length,1);assert.equal(ledger.reservations[0].estimatedP,6);
 h.external.set(6,3,'拆空');h.unload();ledger=h.state().unloadTasks.DEMU1001001.ledger;assert.equal(ledger.highestPhase,2);assert.equal(ledger.reservations[0].estimatedP,6);assert.equal(h.state().inventory[0].physicalP,20);
 h.external.set(6,3,'已到');h.unload();assert.equal(h.state().unloadTasks.DEMU1001001.ledger.highestPhase,2);
});
test('unload adapter inspection release preserves unknown final cargo and blocks automatic allocation',()=>{
 const h=fixture();h.external.set(6,2,'在拆');h.unload();h.external.set(6,2,'拆空');h.unload();
 const task=h.state().unloadTasks['FCH260101-01'];assert.ok(task.ledger.reservations.every(r=>r.location!=='检查区'));assert.equal(task.ledger.unresolved[0].estimatedP,9);assert.equal(h.state().inventory.length,1);
 const view=h.sheets.get(h.api.config.sheets.capacityView).data;assert.ok(view.some(row=>row.includes('暂停自动分位')));
});
test('unload adapter AI failure retains observed conservative paper budget with explicit pending state',()=>{
 const h=fixture({forge:'proposalHash'});h.external.set(6,3,'在拆');h.unload();
 const task=h.state().unloadTasks.DEMU1001001;assert.equal(task.pending,true);assert.equal(task.pendingCode,'SYNC_ERROR');assert.equal(task.ledger.highestPhase,1);assert.equal(task.ledger.physicalInventoryPosted,false);assert.equal(h.state().inventory[0].physicalP,20);
});
test('unload adapter source change while AI runs invalidates the old candidate',()=>{
 let h,once=true;h=fixture({aiHook:()=>{if(once){once=false;h.external.set(6,2,'在拆');}}});h.unload();assert.equal(h.state().unloadTasks?.['FCH260101-01'],undefined);h.unload();assert.equal(h.state().unloadTasks['FCH260101-01'].ledger.highestPhase,1);
});
test('unload adapter refuses silent changes to already reviewed printed placements',()=>{
 const h=fixture();h.unload();const old=h.state().unloadTasks.DEMU1001001.ledger;h.sheets.get(h.api.config.sheets.published).set(3,8,'C2');h.unload();
 const task=h.state().unloadTasks.DEMU1001001;assert.equal(task.pendingCode,'RULE_REVIEW');assert.deepEqual(json(task.ledger),json(old));assert.equal(task.ledger.publishedAllocations[0].location,'C1');
});
test('unload adapter paused module makes no API decision or shared-state mutation',()=>{
 const h=fixture();h.pause();const version=h.state().version;h.unload();assert.equal(h.counts().ai,0);assert.equal(h.state().version,version);
});
test('load and unload share forecast space while only confirmed stock can be loaded',()=>{
 const h=fixture({status:'已开始',planned:'C1:8',actual:''});h.unload();h.scriptProps.set('WTC_UNLOAD_ENABLED','true');h.run();assert.equal(h.state().inventory[0].physicalP,20);
 const refreshed=h.sheets.get(h.api.config.sheets.capacityView).data.find(row=>row[0]==='C1');
 assert.equal(refreshed[15],9); // 27 - confirmed20 - inbound6 + loading8
});
test('enable validates prepared baseline and preserves existing tick/key/owner while adding only source edit',()=>{
 const h=fixture();let created=[];const existing=[{getHandlerFunction:()=> 'onEdit'},{getHandlerFunction:()=> 'WTCLoad_tick'}];
 h.context.ScriptApp.getProjectTriggers=()=>existing;
 h.context.ScriptApp.newTrigger=name=>({forSpreadsheet:()=>({onEdit:()=>({create:()=>created.push(name)})}),timeBased:()=>({everyMinutes:()=>({create:()=>created.push(name)})})});
 const key=h.userProps.get('WTC_OPENAI_KEY'),owner=h.scriptProps.get('WTC_LOAD_OWNER_MARKER');h.api.enableUnload();
 assert.deepEqual(created,['WTCLoad_onUnloadEdit']);assert.equal(h.userProps.get('WTC_OPENAI_KEY'),key);assert.equal(h.scriptProps.get('WTC_LOAD_OWNER_MARKER'),owner);assert.equal(h.scriptProps.get('WTC_UNLOAD_ENABLED'),'true');assert.equal(h.scriptProps.get('WTC_LOAD_PAUSED'),'false');assert.equal(h.counts().ai,0);assert.ok(Object.values(h.state().unloadTasks).every(task=>task.pending));
});
test('enable failure keeps pause and cannot claim the module enabled',()=>{
 const h=fixture();h.sheets.get(h.api.config.sheets.published).set(2,8,'G10');h.sheets.get(h.api.config.sheets.published).set(2,9,'special_direct');h.catalog.data.push(['G10','不可用',null,27,0,0,'']);
 assert.throws(()=>h.api.enableUnload(),/暂停/);assert.equal(h.scriptProps.get('WTC_LOAD_PAUSED'),'true');assert.notEqual(h.scriptProps.get('WTC_UNLOAD_ENABLED'),'true');
});
test('catalog-only source change advances shared inventory context rather than comparing overwritten values',()=>{
 const h=fixture();h.unload();const old=h.state().inventoryVersion;h.catalog.set(49,4,28);h.unload();assert.ok(h.state().inventoryVersion>old);assert.equal(h.state().capacityCatalog.C1.capacitySlots,28);
});
test('unload atomic batch failure cannot partially write shared state or estimated capacity rows',()=>{
 const h=fixture();const original=h.context.UrlFetchApp.fetch;h.context.UrlFetchApp.fetch=(url,options)=>{
  if(options.method==='post'&&url.includes('sheets.googleapis.com')&&JSON.parse(options.payload).requests.some(r=>r.appendCells?.sheetId===h.sheets.get(h.api.config.sheets.unloadLedger).id))return {getResponseCode:()=>503,getContentText:()=>'{"error":"test unavailable"}'};
  return original(url,options);
 };
 const initial=json(h.state());assert.throws(()=>h.unload(),/SHEETS_COMMIT_503/);assert.deepEqual(json(h.state()),initial);assert.equal(h.sheets.get(h.api.config.sheets.unloadLedger).data.length,1);
});
test('lost response after shared unload commit is recovered by committed hash without another AI call',()=>{
 const h=fixture();const original=h.context.UrlFetchApp.fetch;let lost=false;h.context.UrlFetchApp.fetch=(url,options)=>{
  const response=original(url,options);
  if(!lost&&options.method==='post'&&url.includes('sheets.googleapis.com')&&JSON.parse(options.payload).requests.some(r=>r.appendCells?.sheetId===h.sheets.get(h.api.config.sheets.unloadLedger).id)){lost=true;throw new Error('response lost after commit');}
  return response;
 };
 assert.throws(()=>h.unload(),/response lost/);h.unload();assert.equal(h.counts().ai,5);assert.equal(h.sheets.get(h.api.config.sheets.unloadLedger).data.length,6);assert.equal(h.state().inventory[0].physicalP,20);
});
test('enable rejects unknown whitelist positions before opening any trigger or changing physical baseline',()=>{
 const h=fixture();h.sheets.get(h.api.config.sheets.published).set(3,8,'Z99');const initial=json(h.state().inventory);assert.throws(()=>h.api.enableUnload(),/暂停/);assert.deepEqual(json(h.state().inventory),initial);assert.notEqual(h.scriptProps.get('WTC_UNLOAD_ENABLED'),'true');
});
test('generated five-container plan retains all 54 allocation pieces and full 184P budget',()=>{
 const h=fixture(),C=h.api.config,example=buildLargePlan(C.unloadTasks),published=example.published;
 const state=h.state();state.inventory=example.inventory;h.writeState(state);
 h.catalog.data=Array.from({length:47},()=>[]).concat(example.capacity);
 const rows=[C.unloadHeaders];for(const group of published.groups)for(let index=0;index<group.allocations.length;index++){
  const piece=group.allocations[index],route=piece.location==='检查区'?'via_inspection':'ordinary';rows.push([published.plan_id,'1',group.group_key+'/part'+String(index+1).padStart(2,'0'),group.task_reference||group.container_no,group.container_no,group.destination,'',piece.location,route,piece.qty,piece.qty,'',group.ticket_type||'',true]);
 }
 h.sheets.get(C.sheets.published).data=rows;h.unload();const tasks=Object.values(h.state().unloadTasks),allocations=tasks.flatMap(task=>task.ledger.publishedAllocations),reservations=tasks.flatMap(task=>task.ledger.reservations);
 assert.equal(allocations.length,54);assert.equal(allocations.reduce((sum,row)=>sum+row.estimatedP,0),184);assert.equal(reservations.filter(r=>r.location==='检查区').reduce((sum,row)=>sum+row.estimatedP,0),43);assert.ok(reservations.every(r=>r.kind==='planned_hold'));
 assert.equal(h.state().inventory.length,160);assert.equal(h.state().inventory.reduce((sum,row)=>sum+row.physicalP,0),state.inventory.reduce((sum,row)=>sum+row.physicalP,0));
 const triggers=[];h.context.ScriptApp.getProjectTriggers=()=>[{getHandlerFunction:()=> 'WTCLoad_tick'}];h.context.ScriptApp.newTrigger=name=>({forSpreadsheet:()=>({onEdit:()=>({create:()=>triggers.push(name)})})});h.api.enableUnload();assert.equal(h.scriptProps.get('WTC_UNLOAD_ENABLED'),'true');assert.deepEqual(triggers,['WTCLoad_onUnloadEdit']);
});
test('AI sees the replacement candidate capacity and an explicit planned-hold review policy',()=>{
 const h=fixture(),original=h.context.UrlFetchApp.fetch;let prompt='',capacity;
 h.context.UrlFetchApp.fetch=(url,options)=>{if(url==='https://api.openai.com/v1/responses'){const body=JSON.parse(options.payload);prompt=body.input[0].content[0].text;const facts=JSON.parse(body.input[1].content[0].text);if(facts.taskId==='FCH260101-01')capacity=facts.capacity;}return original(url,options);};
 h.unload();assert.match(prompt,/planned_hold/);assert.match(prompt,/循环/);assert.equal(capacity.byLocation['检查区'].plannedHoldP,9);assert.ok(!capacity.issues.some(issue=>issue.code==='UNLOAD_AI_PENDING'));
});
test('single enable imports the prepared after-close baseline while paused then starts source polling',()=>{
 const h=fixture({baseline:false}),state=h.state();state.inventory=[];h.writeState(state);h.sheets.get('_WTC设置').set(4,2,'2026/10/29 收工后');
 h.sheets.get('_WTC库位基准').data.push(['INIT-1','C1','TEB4','',20,20,'one_per_pallet',27]);
 const created=[];h.context.ScriptApp.getProjectTriggers=()=>[{getHandlerFunction:()=> 'WTCLoad_tick'}];h.context.ScriptApp.newTrigger=name=>({forSpreadsheet:()=>({onEdit:()=>({create:()=>created.push(name)})})});
 h.api.enableUnload();assert.equal(h.state().baseline.confirmed,true);assert.equal(h.state().baseline.asOf,'2026/10/29 收工后');assert.equal(h.state().inventory[0].physicalP,20);assert.equal(h.scriptProps.get('WTC_LOAD_PAUSED'),'false');assert.deepEqual(created,['WTCLoad_onUnloadEdit']);assert.equal(h.counts().ai,0);
});
test('enable directly rejects unknown ordinary P even when slots are known and fit the lane',()=>{
 const h=fixture();h.sheets.get(h.api.config.sheets.published).set(3,10,'');assert.throws(()=>h.api.enableUnload(),/预估数量或占位尚未确认/);assert.equal(h.scriptProps.get('WTC_LOAD_PAUSED'),'true');assert.notEqual(h.scriptProps.get('WTC_UNLOAD_ENABLED'),'true');
});
test('enable rechecks published estimates in its final locked fresh snapshot',()=>{
 const h=fixture(),original=h.context.UrlFetchApp.fetch;let reads=0;
 h.context.UrlFetchApp.fetch=(url,options)=>{if(options.method==='get'&&url.includes('values:batchGet')&&decodeURIComponent(url).includes(h.api.config.sheets.published)){reads++;if(reads===2)h.sheets.get(h.api.config.sheets.published).set(3,10,'');}return original(url,options);};
 assert.throws(()=>h.api.enableUnload(),/预估数量或占位尚未确认/);assert.equal(h.scriptProps.get('WTC_LOAD_PAUSED'),'true');assert.notEqual(h.scriptProps.get('WTC_UNLOAD_ENABLED'),'true');assert.equal(Object.keys(h.state().unloadTasks||{}).length,0);
});
