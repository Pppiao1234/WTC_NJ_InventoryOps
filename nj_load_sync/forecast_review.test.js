'use strict';
// Independent v1.4 review. These tests exercise forecast identity and snapshot
// semantics using pure rules and generated examples. They never call a network API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const Forecast = require('./forecast_engine.js');
const syntheticForecast = require('./fixtures/synthetic_forecast.js');
const syntheticSeeds = require('./fixtures/synthetic_unload.js').seeds;
const copy = value => JSON.parse(JSON.stringify(value));
const A = 'DEMU1001001';
const B = 'DEMU1001005';
const collision = 'XHCU1231001';
const anchorDate = '2026-10-30';

function registry(extra = {}) {
  return Forecast.buildRegistry({
    seeds: [
      {taskId:A,containerNo:A,aliases:['01001'],carriers:['以星']},
      {taskId:B,containerNo:B,aliases:['01005'],carriers:['以星']},
      {taskId:'FCH260101-01',containerNo:'DEMU1001004',aliases:['#90004','FCH260101-01','1-01'],carriers:['SM LINE']}
    ],
    publishedAllocations:[],receipts:[],mappings:[],...extra
  });
}

function matrix(rawId, entries, carrier='以星') {
  const rows = [['總計',null,'1'],[null,'台口',carrier],[null,'櫃號',rawId]];
  for (const [destination,p] of entries) rows.push([p,destination,p]);
  const total = entries.reduce((sum,entry)=>sum + (typeof entry[1] === 'number' ? entry[1] : Number(entry[1]) || 0),0);
  rows.push([total,'总计',total]);
  return rows;
}

function source({id='s1',title='10/30/26拆柜预报',rawId=A,entries=[['ABE8',5]],carrier='以星',observedAt='2026-10-30T12:00:00Z',priorSource,values}={}) {
  return Forecast.parseForecast({sheetId:id,title,values:values||matrix(rawId,entries,carrier),observedAt,priorSource,anchorDate});
}

function dedup(sources, options={}) {
  return Forecast.deduplicate({sources,registry:registry(),postedContainers:[],publishedContainers:[],observations:[],...options});
}

function one(result, id=A) {
  const matches=result.rows.filter(row=>row.containerNo===id);
  assert.equal(matches.length,1,'one physical container has one selected forecast snapshot');
  return matches[0];
}

test('forecast QA: daily whole-container snapshot removes points absent from old week/month',()=>{
  const daily=source({id:'day',entries:[['ABE8',5]]});
  const weekly=source({id:'week',title:'11/2/26当周拆柜预报',entries:[['ABE8',8],['TEB4',4]]});
  const monthly=source({id:'month',title:'11月拆柜预报',entries:[['ABE8',10],['TEB4',7]]});
  const result=dedup([monthly,weekly,daily]),row=one(result);
  assert.equal(row.sourceKind,'daily');assert.equal(row.selectedSourceId,daily.sourceId);
  assert.equal(row.ordinaryP,5);assert.ok(!row.items.some(item=>item.destination==='TEB4'));
  assert.equal(result.totals.verifiedOrdinaryP,5);
});

test('forecast QA: newest business-date wins between daily exports without summing days',()=>{
  const old=source({id:'old',title:'10/30/26拆柜预报',entries:[['ABE8',9]],observedAt:'2026-11-02T16:00:00Z'});
  const fresh=source({id:'new',title:'11/2/26拆柜预报',entries:[['ABE8',6]],observedAt:'2026-11-02T15:00:00Z'});
  const row=one(dedup([old,fresh]));assert.equal(row.selectedSourceId,fresh.sourceId);assert.equal(row.ordinaryP,6);
});

test('forecast QA: an explicit daily zero is authoritative over a nonzero weekly snapshot',()=>{
  const daily=source({id:'day-zero',entries:[['ABE8',0]]});
  const week=source({id:'week',title:'11/2/26当周拆柜预报',entries:[['ABE8',10]]});
  const row=one(dedup([week,daily]));assert.equal(row.sourceKind,'daily');assert.equal(row.ordinaryP,0);
});

test('forecast QA: an entirely blank container column is unknown rather than confirmed zero',()=>{
  const values=matrix(A,[['ABE8',5]]);values[3][2]=null;values.at(-1)[2]=null;
  const parsed=source({values}),row=one(dedup([parsed]));
  assert.equal(parsed.columns[0].valid,false);assert.equal(row.valid,false);assert.equal(row.eligible,false);assert.equal(row.ordinaryP,null);
});

test('forecast QA: latest invalid daily quantity does not silently revive older weekly values',()=>{
  const bad=source({id:'bad-day',entries:[['ABE8','待核对']]});
  const week=source({id:'week',title:'11/2/26当周拆柜预报',entries:[['ABE8',10]]});
  const row=one(dedup([week,bad]));assert.equal(row.sourceKind,'daily');assert.equal(row.valid,false);assert.equal(row.eligible,false);
});

test('forecast QA: duplicate destination rows lacking shipment identity need review',()=>{
  const duplicate=source({entries:[['ABE8',5],['ABE8',4]]});
  assert.equal(duplicate.columns[0].valid,false);
  const row=one(dedup([duplicate]));assert.equal(row.eligible,false);assert.ok(row.issues.length>0);
});

test('forecast QA: private and pickup quantities are separated from ordinary location planning',()=>{
  const row=one(dedup([source({entries:[['ABE8',5],['私',7],['自提',3],['FEDEX',1]]})]));
  assert.equal(row.ordinaryP,5);assert.equal(row.specialP,11);assert.equal(row.totalP,16);
  assert.equal(row.items.filter(item=>item.kind==='ordinary').reduce((sum,item)=>sum+item.p,0),5);
});

test('forecast QA: rescanning identical content keeps changedAt and fingerprint stable',()=>{
  const first=source({observedAt:'2026-10-30T12:00:00Z'});
  const second=source({observedAt:'2026-10-30T13:00:00Z',priorSource:first});
  assert.equal(second.contentFingerprint,first.contentFingerprint);assert.equal(second.changedAt,first.changedAt);
});

test('forecast QA: actual source content change gets a distinct version without altering prior evidence',()=>{
  const first=source({entries:[['ABE8',5]],observedAt:'2026-10-30T12:00:00Z'}),snapshot=copy(first);
  const changed=source({entries:[['ABE8',6]],observedAt:'2026-10-30T13:00:00Z',priorSource:first});
  assert.notEqual(changed.contentFingerprint,first.contentFingerprint);assert.notEqual(changed.changedAt,first.changedAt);
  assert.deepEqual(first,snapshot);
});

test('forecast QA: legacy non-container task identity survives canonical full-container resolution',()=>{
  const r=registry(),resolved=Forecast.resolveIdentity('#90004\nFCH260101-01',r);
  assert.equal(resolved.resolved,true);assert.equal(resolved.containerNo,'DEMU1001004');assert.equal(resolved.taskId,'FCH260101-01');
  const row=one(dedup([source({rawId:'1-01',carrier:'SM LINE'})]),'DEMU1001004');assert.equal(row.taskId,'FCH260101-01');
});

test('forecast QA: ambiguous four-digit suffix cannot resolve to the first matching full number',()=>{
  const r=registry({publishedAllocations:[{containerNo:collision,taskId:collision}]});
  const resolved=Forecast.resolveIdentity('1001',r);
  assert.equal(resolved.resolved,false);assert.equal(resolved.ambiguous,true);
  assert.ok(resolved.candidates.includes(A));assert.ok(resolved.candidates.includes(collision));
});

test('forecast QA: an exact complete container ID remains distinct despite matching suffixes',()=>{
  const r=registry({publishedAllocations:[{containerNo:collision,taskId:collision}]});
  assert.equal(Forecast.resolveIdentity(A,r).containerNo,A);
  const result=dedup([source({id:'a',rawId:A,entries:[['ABE8',5]]}),source({id:'b',rawId:collision,entries:[['ABE8',9]]})],{registry:r});
  assert.equal(result.rows.filter(row=>row.verified).length,2);assert.equal(result.totals.verifiedOrdinaryP,14);
});

test('forecast QA: incompatible known carrier cannot turn a short tail into a verified cabinet',()=>{
  const r=registry();
  const resolved=Forecast.resolveIdentity('1001',r,'长荣');
  assert.equal(resolved.resolved,false,'explicit carrier disagreement requires full number review');
  const direct=Forecast.resolveIdentity(A,r,'长荣');
  assert.equal(direct.resolved,true,'a complete physical identifier remains authoritative');assert.equal(direct.containerNo,A);
});

test('forecast QA: colliding manually confirmed aliases remain ambiguous even with a carrier label',()=>{
  const r=registry({mappings:[{alias:'9999',containerNo:A,carrier:'以星'},{alias:'9999',containerNo:B,carrier:'长荣'}]});
  const resolved=Forecast.resolveIdentity('9999',r,'以星');assert.equal(resolved.resolved,false);assert.equal(resolved.ambiguous,true);
});

test('forecast QA: calendar validation rejects impossible dates and resolves year rollover explicitly',()=>{
  assert.equal(Forecast.parseBusinessDate('2026-02-30',anchorDate),'');
  assert.equal(Forecast.parseBusinessDate('2/30',anchorDate),'');
  assert.equal(Forecast.parseBusinessDate('1/2','2026-12-30'),'2027-01-02');
  assert.equal(Forecast.parseBusinessDate('12/31','2027-01-02'),'2026-12-31');
  assert.equal(Forecast.parseBusinessDate('010/23',anchorDate),'');
});

test('forecast QA: unknown short IDs stay provisional and never enter verified incoming total',()=>{
  const result=dedup([source({rawId:'304',entries:[['ABE8',7]]})]);
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].verified,false);assert.equal(result.rows[0].eligible,false);
  assert.equal(result.totals.verifiedOrdinaryP,0);assert.equal(result.totals.provisionalOrdinaryP,7);
});

test('forecast QA: equal unresolved tails from different carriers remain separate provisional candidates',()=>{
  const result=dedup([source({id:'x',rawId:'9999',carrier:'以星',entries:[['ABE8',5]]}),source({id:'y',rawId:'9999',carrier:'长荣',entries:[['ABE8',9]]})]);
  assert.equal(result.rows.length,2);assert.equal(result.rows.filter(row=>row.verified).length,0);
});

test('forecast QA: receipt-posted containers leave pending incoming without erasing source quantities',()=>{
  const result=dedup([source({entries:[['ABE8',5]]})],{postedContainers:[A]}),row=one(result);
  assert.equal(row.excludedPosted,true);assert.equal(row.eligible,false);assert.equal(row.ordinaryP,5);
  assert.equal(result.totals.verifiedOrdinaryP,0);assert.equal(result.totals.excludedPostedP,5);
});

test('forecast QA: already published paper plan is not added again as forecast capacity',()=>{
  const result=dedup([source({entries:[['ABE8',5]]})],{publishedContainers:[A]}),row=one(result);
  assert.equal(row.alreadyPublished,true);assert.equal(row.eligible,false);assert.equal(row.ordinaryP,5);
  assert.equal(result.totals.verifiedOrdinaryP,0);assert.equal(result.totals.alreadyPublishedP,5);
});

test('forecast QA: deduplication is pure and cannot mutate stock, registry, or original source evidence',()=>{
  const sources=[source()],r=registry(),inventory=[{location:'F6',physicalP:20}],inputs={sources,registry:r,postedContainers:[],publishedContainers:[],observations:[],inventory};
  const before=copy(inputs),result=Forecast.deduplicate(inputs);
  assert.deepEqual(inputs,before);assert.equal(result.physicalInventoryUnchanged,true);assert.equal(inventory[0].physicalP,20);
});

function mapInput(id,status,title='10/30',date='2026-10-30',column=2) {
  const values=Array.from({length:16},()=>[]);values[5][0]='海柜状态';values[14][0]='櫃號';
  values[5][column-1]=status;values[14][column-1]=id;
  return Forecast.discoverMap({sheetId:title,title,values,businessDate:date,anchorDate});
}

test('forecast QA: map parser ignores status-only empty template columns',()=>{
  const values=Array.from({length:16},()=>[]);values[5]=['海柜状态','已到','未到','未到'];values[14]=['櫃號',A];
  const map=Forecast.discoverMap({sheetId:'map',title:'10/30',values,businessDate:'2026-10-30',anchorDate});
  assert.equal(map.valid,true);assert.equal(map.observations.length,1);assert.equal(map.observations[0].rawId,A);
});

test('forecast QA: same container moved to a later day and another column resolves as one identity',()=>{
  const old=mapInput('01001','在拆','10/30','2026-10-30',3),fresh=mapInput(A,'拆空','11/2','2026-11-02',7);
  const selected=Forecast.selectObservations([...old.observations,...fresh.observations],registry());
  const rows=Array.isArray(selected)?selected:selected.observations;
  const matches=rows.filter(row=>row.containerNo===A);assert.equal(matches.length,1);
  assert.equal(matches[0].status,'拆空');assert.equal(matches[0].sourceColumn,7);assert.equal(matches[0].businessDate,'2026-11-02');
});

test('forecast QA: same-date contradictory map statuses require review instead of column-order guessing',()=>{
  const a=mapInput(A,'在拆','10/30','2026-10-30',2),b=mapInput('01001','拆空','10/30','2026-10-30',8);
  const selected=Forecast.selectObservations([...a.observations,...b.observations],registry());
  const rows=Array.isArray(selected)?selected:selected.observations;
  const row=rows.find(item=>item.containerNo===A);assert.ok(row);assert.equal(row.conflict,true);assert.equal(row.status,'待核查');
});

test('forecast QA: malformed map fails locally while another map remains parseable',()=>{
  const bad=Forecast.discoverMap({sheetId:'bad',title:'11/2',values:[['wrong header']],businessDate:'2026-11-02',anchorDate});
  assert.equal(bad.valid,false);assert.ok(bad.issues.length>0);
  const good=mapInput(A,'已到');assert.equal(good.valid,true);assert.equal(good.observations.length,1);
});

test('forecast QA: generated map contains six cabinets beyond the five configured seeds',()=>{
  const live=syntheticForecast(syntheticSeeds);
  const map=Forecast.discoverMap({sheetId:104,title:live.map.title,values:live.map.values,businessDate:'2026-10-30',anchorDate});
  assert.equal(map.valid,true);assert.equal(map.observations.length,6);assert.ok(map.observations.some(row=>row.rawId==='88888'));
});

test('forecast QA: generated daily/weekly/monthly sources select one snapshot for each known physical cabinet',()=>{
  const live=syntheticForecast(syntheticSeeds);
  const seeds=[
    {taskId:'FCH260101-01',containerNo:'DEMU1001004',aliases:['1-01','#90004','FCH260101-01']},
    {taskId:A,containerNo:A,aliases:['01001']},
    {taskId:B,containerNo:B,aliases:['01005']},
    {taskId:'DEMU1001003',containerNo:'DEMU1001003',aliases:['01003']},
    {taskId:'DEMU1001002',containerNo:'DEMU1001002',aliases:['01002']}
  ];
  const r=Forecast.buildRegistry({seeds,publishedAllocations:[],receipts:[],mappings:[]});
  const sources=live.forecasts.map((item,index)=>Forecast.parseForecast({sheetId:'example-'+index,title:item.title,values:item.values,observedAt:'2026-10-30T18:00:00Z',anchorDate}));
  const result=dedup(sources,{registry:r});
  for(const seed of seeds){const row=one(result,seed.containerNo);assert.equal(row.sourceKind,'daily');}
  assert.equal(result.rows.filter(row=>row.containerNo===A).length,1);
  assert.ok(result.rows.some(row=>row.verified===false),'unmapped future tails remain visible rather than fabricated complete IDs');
});

// Independently extend the preexisting in-memory Sheets REST harness. It exposes
// no credentials and makes no network requests; metadata is served from the same
// local cell store as values/batchUpdate.
const qaFile=path.join(__dirname,'qa.adapter.test.js');
let harnessSource=fs.readFileSync(qaFile,'utf8');
harnessSource=harnessSource.slice(0,harnessSource.indexOf('\nfunction moveInputsBeforeTime'));
harnessSource=harnessSource.replace('const context={WTCLoadCore:Core,Date,JSON,console,',"const context={WTCLoadCore:Core,WTCUnloadCore:require('./unload_engine.js'),WTCInventoryCore:require('./operations_engine.js'),WTCForecastCore:require('./forecast_engine.js'),Date,JSON,console,");
harnessSource=harnessSource.replace('return {run:()=>context.WTCLoad.sync(null,false),','return {api:context.WTCLoad,context,scriptProps,userProps,run:()=>context.WTCLoad.sync(null,false),');
harnessSource+='\nthis.makeHarness=harness;';
const runtime={require:createRequire(qaFile),__dirname,console,structuredClone,URL};
vm.createContext(runtime);vm.runInContext(harnessSource,runtime,{filename:'forecast-review-harness.vm.js'});

function adapterFixture() {
  const h=runtime.makeHarness({planned:'',actual:'',noId:true}),C=h.api.config,Sheet=h.source.constructor,Range=h.source.getRange(1,1).constructor;
  const book=h.context.SpreadsheetApp.openById(C.spreadsheetId),noop=function(){return this;};
  for(const method of ['setBackground','setFontWeight','setNumberFormat','setWrap','setWrapStrategy','setVerticalAlignment','setFontSize','setFontFamily','setDataValidation','clearDataValidations','setNote'])Range.prototype[method]=noop;
  for(const method of ['setFrozenRows','setFrozenColumns','setColumnWidths','setColumnWidth','autoResizeColumns','setHiddenGridlines','hideSheet','showSheet'])Sheet.prototype[method]=noop;
  Sheet.prototype.isSheetHidden=function(){return !!this.hidden;};
  Sheet.prototype.getParent=()=>book;
  book.insertSheet=name=>new Sheet(name,[[]]);book.getSheets=()=>[...h.sheets.values()];book.getId=()=>C.spreadsheetId;book.setActiveSheet=()=>book;
  h.context.SpreadsheetApp.flush=()=>{};
  h.context.Utilities.formatDate=(date,_tz,format)=>format==='yyyy-MM-dd'?'2026-10-30':date.toISOString();
  h.context.ScriptApp.getProjectTriggers=()=>[{getHandlerFunction:()=> 'WTCLoad_tick'},{getHandlerFunction:()=> 'WTCLoad_onUnloadEdit'}];
  h.context.ScriptApp.newTrigger=()=>{throw new Error('existing triggers must be reused');};
  const props=map=>({getProperty:key=>map.get(key)||null,setProperty:(key,value)=>{map.set(key,value);return props(map);},deleteProperty:key=>{map.delete(key);return props(map);},getProperties:()=>Object.fromEntries(map)});
  h.context.PropertiesService.getScriptProperties=()=>props(h.scriptProps);h.context.PropertiesService.getUserProperties=()=>props(h.userProps);
  h.externalNames=new Set();
  h.addMap=(name,id,rawId,status='已到',hidden=false,column=2)=>{
    const data=Array.from({length:16},()=>[]);data[5][0]='海柜状态';data[14][0]='櫃號';data[5][column-1]=status;data[14][column-1]=rawId;
    const sheet=new Sheet(name,data);sheet.id=id;sheet.hidden=hidden;h.externalNames.add(name);return sheet;
  };
  h.addForecast=(name,id,rawId=A,entries=[['ABE8',5]],carrier='以星')=>{const sheet=new Sheet(name,matrix(rawId,entries,carrier));sheet.id=id;return sheet;};
  h.daily=h.addForecast('10/30/26拆柜预报',101,A,[['ABE8',5]]);
  h.week=h.addForecast('11/2/26当周拆柜预报',102,A,[['ABE8',8]]);
  h.month=h.addForecast('11月拆柜预报',103,A,[['ABE8',9]]);
  h.map=h.addMap('10/30',104,A,'在拆');
  const plans=[C.unloadHeaders];
  C.unloadTasks.forEach((task,index)=>plans.push(['QA-PAPER','1',`qa-${task.containerNo}/part01`,task.taskId,task.containerNo,index===1?'TEB4':`D${index}`,'',`C${index+1}`,'ordinary',1,1,'','',true]));
  new Sheet(C.sheets.published,plans);
  const catalog=new Sheet('库位地图',[]);catalog.data[47]=['库位','收工状态','已知实物板数','图示容量','图示可用板位','保守参考余位','说明'];
  for(let i=1;i<=8;i++)catalog.data.push([`C${i}`,i===1?'有货':'空位',i===1?20:0,27,i===1?null:27,i===1?7:27,'']);
  for(const [name,headers]of [[C.sheets.unloadView,C.unloadViewHeaders],[C.sheets.capacityView,C.capacityViewHeaders],[C.sheets.unloadLedger,C.unloadLedgerHeaders]])new Sheet(name,[headers]);
  h.originalFetch=h.context.UrlFetchApp.fetch;
  h.context.UrlFetchApp.fetch=(url,options)=>{
    const parsed=new URL(url);
    if(options.method==='get'&&!parsed.pathname.includes('/values')) {
      const spreadsheetId=decodeURIComponent(parsed.pathname.split('/spreadsheets/')[1]||'');
      const sheets=[...h.sheets.values()].filter(sheet=>spreadsheetId===C.unloadSourceId?h.externalNames.has(sheet.name):!h.externalNames.has(sheet.name));
      return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({spreadsheetId,sheets:sheets.map(sheet=>({properties:{sheetId:sheet.id,title:sheet.name,hidden:!!sheet.hidden,gridProperties:{rowCount:sheet.maxRows,columnCount:sheet.maxColumns}}}))})};
    }
    if(h.failForecastRead&&options.method==='get'&&parsed.pathname.endsWith('/values:batchGet')&&parsed.searchParams.getAll('ranges').some(range=>range.includes('拆柜预报')))
      return {getResponseCode:()=>503,getContentText:()=>'{"error":"local forecast read failure"}'};
    return h.originalFetch(url,options);
  };
  h.rename=(sheet,name)=>{h.sheets.delete(sheet.name);const external=h.externalNames.delete(sheet.name);sheet.name=name;h.sheets.set(name,sheet);if(external)h.externalNames.add(name);};
  h.upgrade=()=>h.api.upgradeForecast();h.preview=()=>copy(h.api.forecastPreview());h.forecastSync=()=>h.api.syncForecast(true);
  return h;
}

test('forecast adapter QA: upgrade preserves all actual inventory, baseline, task history, key and inventoryVersion',()=>{
  const h=adapterFixture(),before=copy(h.state()),key=h.userProps.get('WTC_OPENAI_KEY');
  h.upgrade();const after=copy(h.state());assert.deepEqual(after.inventory,before.inventory);assert.deepEqual(after.baseline,before.baseline);assert.deepEqual(after.tasks,before.tasks);
  assert.equal(after.inventoryVersion,before.inventoryVersion);assert.equal(h.userProps.get('WTC_OPENAI_KEY'),key);assert.equal(h.counts().ai,0);
});

test('forecast adapter QA: unchanged scan performs no further state write or AI decision',()=>{
  const h=adapterFixture();h.upgrade();const version=h.state().version;h.forecastSync();h.forecastSync();assert.equal(h.state().version,version);assert.equal(h.counts().ai,0);
});

test('forecast adapter QA: visible new date is observed while old hidden date pages are not imported',()=>{
  const h=adapterFixture();h.addMap('11/2',999002,B,'已到',false);h.addMap('11/3',999003,'MSCU1111111','拆空',true);
  h.upgrade();const preview=h.preview();assert.ok(preview.mapSheets.some(sheet=>sheet.sheetId===999002));assert.ok(!preview.mapSheets.some(sheet=>sheet.sheetId===999003));
});

test('forecast adapter QA: a previously observed full number resolves later tail-only exports automatically',()=>{
  const h=adapterFixture(),newId='ABCD1119999';h.daily.data=matrix(newId,[['ABE8',7]]);h.week.data=matrix('9999',[['ABE8',8]]);h.month.data=matrix('9999',[['ABE8',9]]);
  h.upgrade();assert.equal(h.preview().result.rows.filter(row=>row.containerNo===newId).length,1);
  h.daily.data=matrix('9999',[['ABE8',6]]);h.forecastSync();const preview=h.preview(),matches=preview.result.rows.filter(row=>row.containerNo===newId);
  assert.equal(matches.length,1);assert.equal(matches[0].ordinaryP,6);assert.equal(matches[0].verified,true);
});

test('forecast adapter QA: renamed configured date tab derives its current business date',()=>{
  const h=adapterFixture();h.upgrade();h.rename(h.daily,'11/3/26拆柜预报');h.forecastSync();
  const row=h.preview().result.rows.find(row=>row.containerNo===A);assert.equal(row.businessDate,'2026-11-03');
});

test('forecast adapter QA: malformed latest daily header blocks known cabinet instead of using old weekly data',()=>{
  const h=adapterFixture();h.upgrade();h.daily.set(3,2,'失效柜号表头');h.forecastSync();
  const row=h.preview().result.rows.find(row=>row.containerNo===A);assert.ok(row);assert.equal(row.sourceKind,'daily');assert.equal(row.valid,false);assert.equal(row.eligible,false);
});

test('forecast adapter QA: unreadable latest source retains known cabinet as blocked, with explicit source issue',()=>{
  const h=adapterFixture();h.upgrade();h.failForecastRead=true;h.forecastSync();const preview=h.preview();
  const row=preview.result.rows.find(row=>row.containerNo===A);assert.ok(row,'failed source is unknown, not vanished');assert.equal(row.valid,false);assert.equal(row.eligible,false);
  assert.ok(preview.issues.some(issue=>/FORECAST_SOURCE/.test(issue.code)));
});

test('forecast adapter QA: mapped cabinet moved to another day/column keeps one paper reservation and physical stock',()=>{
  const h=adapterFixture();h.upgrade();h.api.syncUnload(true);const first=copy(h.state()),calls=h.counts().ai;
  h.addMap('11/2',999002,A,'在拆',false,8);h.forecastSync();h.api.syncUnload(true);const after=copy(h.state());
  assert.equal(h.counts().ai,calls);assert.deepEqual(after.inventory,first.inventory);
  assert.equal(after.unloadTasks[A].ledger.reservations.length,first.unloadTasks[A].ledger.reservations.length);
  assert.deepEqual(after.unloadTasks[A].ledger.publishedAllocations,first.unloadTasks[A].ledger.publishedAllocations);
});

test('forecast adapter QA: newly recognized cabinet without paper allocation never creates inventory or unload reservation',()=>{
  const h=adapterFixture(),newId='ABCD1119999';h.addMap('11/2',999002,newId,'已到',false);h.upgrade();const before=copy(h.state().inventory);
  h.api.syncUnload(true);assert.deepEqual(copy(h.state().inventory),before);assert.equal(h.state().unloadTasks?.[newId],undefined);
  assert.ok(h.sheets.get(h.api.config.sheets.arrivals).data.some(row=>row[1]===newId&&String(row[7]).includes('待发布')));
});

test('forecast adapter QA: atomic upgrade commit failure preserves state and leaves module disabled and paused',()=>{
  const h=adapterFixture(),before=copy(h.state()),fetch=h.context.UrlFetchApp.fetch;
  h.context.UrlFetchApp.fetch=(url,options)=>{
    if(options.method==='post'&&url.includes('sheets.googleapis.com')&&JSON.parse(options.payload).requests.some(request=>request.appendCells?.rows?.some(row=>row.values?.some(value=>value.userEnteredValue?.stringValue==='FORECAST_UPGRADE'))))
      return {getResponseCode:()=>503,getContentText:()=>'{"error":"local atomic upgrade failure"}'};
    return fetch(url,options);
  };
  assert.throws(()=>h.upgrade(),/503|未完成/);assert.deepEqual(copy(h.state()),before);
  assert.notEqual(h.scriptProps.get('WTC_FORECAST_ENABLED'),'true');assert.equal(h.scriptProps.get('WTC_LOAD_PAUSED'),'true');
});

test('forecast adapter QA: disabled configured forecast does not reappear through automatic tab discovery',()=>{
  const h=adapterFixture();h.upgrade();
  h.sheets.get(h.api.config.sheets.forecastSources).data.push([h.api.config.spreadsheetId,String(h.daily.id),h.daily.name,'daily','',false,'Explicitly disabled generated source']);
  h.forecastSync();
  const preview=h.preview(),row=preview.result.rows.find(item=>item.containerNo===A);
  assert.ok(!preview.sources.some(item=>String(item.nativeSheetId)==='101'));assert.equal(row.sourceKind,'weekly');
});

test('forecast adapter QA: legacy FCH task keeps its identity with daily 1-01 and a multiline operational map label',()=>{
  const h=adapterFixture();h.daily.data=matrix('1-01',[['CLT2',11]],'SM LINE');h.map.set(15,2,'#90004\nFCH260101-01');
  h.upgrade();const preview=h.preview(),row=preview.result.rows.find(item=>item.containerNo==='DEMU1001004');
  assert.ok(row);assert.equal(row.taskId,'FCH260101-01');h.api.syncUnload(true);
  assert.ok(h.state().unloadTasks['FCH260101-01']);assert.equal(h.state().unloadTasks.DEMU1001004,undefined);
});

test('forecast adapter QA: future cabinet with a published valid location joins status estimates but never physical stock',()=>{
  const h=adapterFixture(),newId='ABCD1119999',before=copy(h.state().inventory),C=h.api.config;
  h.addMap('11/2',999002,newId,'在拆',false);
  h.sheets.get(C.sheets.published).data.push(['QA-NEW','1','new-9999/part01',newId,newId,'ABE8','','C6','ordinary',7,7,'','',true]);
  h.upgrade();h.api.syncUnload(true);const after=h.state();assert.deepEqual(copy(after.inventory),before);
  assert.equal(after.unloadTasks[newId].ledger.reservations.reduce((sum,row)=>sum+row.estimatedP,0),7);
  const calls=h.counts().ai;h.api.syncUnload(true);assert.equal(h.counts().ai,calls);assert.equal(after.unloadTasks[newId].ledger.publishedAllocations.length,1);
});

test('forecast adapter QA: whitespace date-tab names are discovered without guessing malformed three-digit months',()=>{
  const h=adapterFixture();h.addMap('11/ 2',999002,B,'已到',false);h.addMap('011/3',999003,'MSCU1111111','拆空',false);
  h.upgrade();const sheets=h.preview().mapSheets;assert.ok(sheets.some(sheet=>sheet.sheetId===999002));assert.ok(!sheets.some(sheet=>sheet.sheetId===999003));
});

test('forecast adapter QA: duplicate confirmed aliases quarantine only the affected tail and preserve direct known map sync',()=>{
  const h=adapterFixture();h.upgrade();h.daily.data=matrix('9999',[['ABE8',7]]);
  h.sheets.get(h.api.config.sheets.aliases).data.push(['9999',A,'以星',true],['9999',B,'以星',true]);h.forecastSync();
  const preview=h.preview(),row=preview.result.rows.find(item=>item.rawIds.includes('9999'));
  assert.ok(row);assert.equal(row.verified,false);assert.equal(row.resolutionStatus,'ambiguous');assert.equal(row.eligible,false);
  h.api.syncUnload(true);assert.ok(h.state().unloadTasks[A]);
});

test('forecast adapter QA: posted cabinet reappearing with a new paper batch is quarantined without reopening prior estimate',()=>{
  const h=adapterFixture(),C=h.api.config;h.upgrade();h.api.syncUnload(true);
  const before=h.state(),old=copy(before.unloadTasks[A].ledger),oldId=old.publishedAllocations[0].allocationId;
  before.receipts={[A+'|2026-10-30']:{containerNo:A,businessDate:'2026-10-30',postedAllocationIds:[oldId]}};h.writeState(before);
  h.sheets.get(C.sheets.published).data.push(['NEW-TRIP','1','new-trip/part01',A,A,'TEB4','','C6','ordinary',4,4,'','',true]);
  h.addMap('11/2',999002,A,'已到',false);h.forecastSync();const preview=h.preview();
  assert.equal(preview.blockedPublications[A],true);assert.ok(preview.issues.some(issue=>issue.code==='POSTED_CONTAINER_NEW_PUBLICATION'));
  h.api.syncUnload(true);assert.deepEqual(copy(h.state().unloadTasks[A].ledger),old);assert.deepEqual(copy(h.state().inventory),copy(before.inventory));
});

test('forecast adapter QA: renaming the same operational map sheet updates its business date',()=>{
  const h=adapterFixture();h.upgrade();assert.equal(h.preview().mapSheets.find(sheet=>sheet.sheetId===104).businessDate,'2026-10-30');
  h.rename(h.map,'11/2');h.forecastSync();const preview=h.preview(),sheet=preview.mapSheets.find(item=>item.sheetId===104);
  assert.equal(sheet.businessDate,'2026-11-02');assert.equal(preview.selected.find(item=>item.containerNo===A).businessDate,'2026-11-02');
});

test('forecast adapter QA: a forecast reaching the 300-row boundary without a total is blocked as incomplete',()=>{
  const h=adapterFixture(),values=matrix(A,[['ABE8',5]]);values.pop();
  for(let i=values.length;i<300;i++)values.push([1,'D'+i,1]);h.daily.data=values;h.upgrade();
  const preview=h.preview(),daily=preview.sources.find(item=>String(item.nativeSheetId)==='101'),row=preview.result.rows.find(item=>item.containerNo===A);
  assert.equal(daily.valid,false);assert.ok(daily.issues.some(issue=>issue.code==='FORECAST_RANGE_LIMIT'));
  assert.equal(row.sourceKind,'daily');assert.equal(row.valid,false);assert.equal(row.eligible,false);
});

test('forecast adapter QA: automatic forecasts use a bounded horizon while overlapping week and month remain eligible',()=>{
  const h=adapterFixture();h.addForecast('10/1/26拆柜预报',999101,'ABCD1111111',[['ABE8',7]]);
  h.addForecast('1/15/27拆柜预报',999102,'ABCD2222222',[['ABE8',8]]);
  h.addForecast('10/26/26当周拆柜预报',999103,'ABCD3333333',[['ABE8',9]]);
  h.addForecast('10月拆柜预报',999104,'ABCD4444444',[['ABE8',10]]);
  h.upgrade();const ids=h.preview().sources.map(item=>String(item.nativeSheetId));
  assert.ok(!ids.includes('999101'));assert.ok(!ids.includes('999102'));assert.ok(ids.includes('999103'));assert.ok(ids.includes('999104'));
});

test('forecast adapter QA: an explicitly enabled source may override automatic date bounds',()=>{
  const h=adapterFixture(),old=h.addForecast('10/1/26拆柜预报',999101,'ABCD1111111',[['ABE8',7]]);h.upgrade();
  h.sheets.get(h.api.config.sheets.forecastSources).data.push([h.api.config.spreadsheetId,String(old.id),old.name,'daily','',true,'QA deliberate historical source']);h.forecastSync();
  assert.ok(h.preview().sources.some(item=>String(item.nativeSheetId)==='999101'));
});

function manyDateMaps(h) {
  const maps=[];
  for(let i=1;i<=60;i++){
    const date=new Date(Date.parse('2026-10-30T12:00:00Z')+i*86400000),title=(date.getUTCMonth()+1)+'/          '+date.getUTCDate(),container='ABCD'+String(1120000+i);
    maps.push({title,container,sheet:h.addMap(title,999200+i,container,'已到',false)});
  }
  return maps;
}

test('forecast adapter QA: many daily map pages use bounded batch URLs and preserve ordered page identities',()=>{
  const h=adapterFixture(),maps=manyDateMaps(h),fetch=h.context.UrlFetchApp.fetch,calls=[];
  h.context.UrlFetchApp.fetch=(url,options)=>{
    const parsed=new URL(url);
    if(options.method==='get'&&parsed.pathname.endsWith('/values:batchGet')&&parsed.pathname.includes(h.api.config.unloadSourceId)){
      calls.push(parsed.searchParams.getAll('ranges'));assert.ok(url.length<=2000,'Apps Script UrlFetch URL must remain below its 2 KB boundary');
    }
    return fetch(url,options);
  };
  h.upgrade();const before=copy(h.state().inventory),preview=h.preview();assert.ok(calls.length>=4,'one scan must span multiple bounded map reads');
  for(const expected of [maps[0],maps[19],maps.at(-1)]){
    const row=preview.selected.find(item=>item.containerNo===expected.container);assert.ok(row,'page after any chunk boundary remains observable');assert.equal(row.sourceTab,expected.title);assert.equal(row.sourceSheetId,expected.sheet.id);assert.equal(row.sourceColumn,2);
  }
  assert.deepEqual(copy(h.state().inventory),before);
});

test('forecast adapter QA: one failed map chunk preserves other chunks and reports missing pages without clearing physical stock',()=>{
  const h=adapterFixture(),maps=manyDateMaps(h),bad=maps[35],last=maps.at(-1),fetch=h.context.UrlFetchApp.fetch,initial=copy(h.state().inventory);let failures=0;
  h.context.UrlFetchApp.fetch=(url,options)=>{
    const parsed=new URL(url);
    if(options.method==='get'&&parsed.pathname.endsWith('/values:batchGet')&&parsed.pathname.includes(h.api.config.unloadSourceId)&&parsed.searchParams.getAll('ranges').some(range=>range.includes(bad.title))){
      failures++;return {getResponseCode:()=>503,getContentText:()=>'{"error":"local one-map-chunk failure"}'};
    }
    return fetch(url,options);
  };
  h.upgrade();const preview=h.preview();assert.ok(failures>=1);assert.ok(preview.issues.some(issue=>issue.code==='MAP_SOURCE_READ'));
  assert.ok(preview.selected.some(item=>item.containerNo===A));assert.ok(preview.selected.some(item=>item.containerNo===last.container));
  assert.ok(!preview.selected.some(item=>item.containerNo===bad.container));assert.deepEqual(copy(h.state().inventory),initial);
});

test('forecast adapter QA: a failed map chunk retains the previously committed paper budget for its cabinets',()=>{
  const h=adapterFixture();h.upgrade();h.api.syncUnload(true);const before=copy(h.state()),fetch=h.context.UrlFetchApp.fetch;
  h.context.UrlFetchApp.fetch=(url,options)=>{
    const parsed=new URL(url);
    if(options.method==='get'&&parsed.pathname.endsWith('/values:batchGet')&&parsed.pathname.includes(h.api.config.unloadSourceId))
      return {getResponseCode:()=>503,getContentText:()=>'{"error":"local unavailable known map"}'};
    return fetch(url,options);
  };
  h.forecastSync();h.api.syncUnload(true);assert.deepEqual(copy(h.state().unloadTasks[A].ledger),before.unloadTasks[A].ledger);assert.deepEqual(copy(h.state().inventory),before.inventory);
  assert.ok(h.preview().issues.some(issue=>issue.code==='MAP_SOURCE_READ'));
});

test('forecast adapter QA: many dated forecast exports use bounded URLs and preserve source-to-container association',()=>{
  const h=adapterFixture(),expected=[];
  for(let i=1;i<=40;i++){
    const date=new Date(Date.parse('2026-10-30T12:00:00Z')+i*86400000),title=(date.getUTCMonth()+1)+'/'+date.getUTCDate()+'/26拆柜预报',container='QAZW'+String(2230000+i),id=999400+i;
    h.addForecast(title,id,container,[['ABE8',i]]);expected.push({id,container,p:i});
  }
  const fetch=h.context.UrlFetchApp.fetch,calls=[];h.context.UrlFetchApp.fetch=(url,options)=>{
    const parsed=new URL(url);
    if(options.method==='get'&&parsed.pathname.endsWith('/values:batchGet')&&parsed.searchParams.getAll('ranges').some(range=>range.includes('拆柜预报'))){calls.push(parsed.searchParams.getAll('ranges'));assert.ok(url.length<=2000);}
    return fetch(url,options);
  };
  h.upgrade();const preview=h.preview();assert.ok(calls.length>=4);
  for(const expectedRow of [expected[0],expected[19],expected.at(-1)]){
    const row=preview.result.rows.find(item=>item.containerNo===expectedRow.container);assert.ok(row);assert.equal(row.ordinaryP,expectedRow.p);assert.equal(row.selectedSourceId,h.api.config.spreadsheetId+':'+expectedRow.id);
  }
});
