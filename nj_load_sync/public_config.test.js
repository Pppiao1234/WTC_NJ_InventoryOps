'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const deploymentFiles=['engine.js','unload_engine.js','operations_engine.js','forecast_engine.js','loading_portal_core.js','photo_intake_core.js','table_inventory_core.js','adapter.gs','photo_adapter.gs','photo_ui.gs','table_source_reader.gs','table_inventory_adapter.gs','table_inventory_ui.gs'];
const valid={WTC_MAIN_SPREADSHEET_ID:'PUBLIC_TEST_MAIN_SPREADSHEET_001',WTC_UNLOAD_SPREADSHEET_ID:'PUBLIC_TEST_UNLOAD_SPREADSHEET_001',WTC_LOCATION_SHEET_ID:'101'};
function runtime(properties){
  const writes=[],external=[];const context={console};
  if(properties){
    const getProperties=()=>({getProperty:key=>properties[key]??null,setProperty(key,value){writes.push([key,value]);properties[key]=value;return this;},deleteProperty(key){writes.push([key]);delete properties[key];}});
    context.PropertiesService={getScriptProperties:getProperties,getUserProperties:getProperties};
    const forbidden=name=>()=>{external.push(name);throw new Error('Unexpected external service: '+name);};
    context.SpreadsheetApp={openById:forbidden('SpreadsheetApp.openById'),getActiveSpreadsheet:forbidden('SpreadsheetApp.getActiveSpreadsheet')};
    context.DriveApp={getFileById:forbidden('DriveApp.getFileById')};
    context.UrlFetchApp={fetch:forbidden('UrlFetchApp.fetch')};
  }
  vm.createContext(context);
  deploymentFiles.forEach(file=>vm.runInContext(fs.readFileSync(path.join(__dirname,file),'utf8'),context,{filename:file}));
  return {context,writes,external,config:context.WTCLoad.config};
}
test('all thirteen deployment source files load without Apps Script services',()=>{
  const r=runtime();assert.equal(r.context.WTCTableInventoryCore.VERSION,'1.7.0');
  assert.equal(typeof r.context.WTCTableMode.upgrade,'function');
});
test('unconfigured legacy install fails before property writes or external services',()=>{
  const r=runtime({});assert.throws(()=>r.context.WTCLoad_install(),/WTC_CONFIG_MISSING.*WTC_MAIN_SPREADSHEET_ID/);
  assert.deepEqual(r.writes,[]);assert.deepEqual(r.external,[]);
});
for(const key of Object.keys(valid))test('table upgrade requires '+key+' before any writes or external service',()=>{
  const properties={...valid};delete properties[key];const r=runtime(properties);
  assert.throws(()=>r.context.WTCTableMode.upgrade(),new RegExp('WTC_CONFIG_MISSING.*'+key));
  assert.deepEqual(r.writes,[]);assert.deepEqual(r.external,[]);
});
test('location sheet gid zero is valid while malformed or unsafe numbers are rejected',()=>{
  assert.equal(runtime({...valid,WTC_LOCATION_SHEET_ID:'0'}).config.locationSheetId,0);
  for(const value of ['', 'text', '-1', '1.5', 'Infinity', '9007199254740992'])assert.throws(()=>runtime({...valid,WTC_LOCATION_SHEET_ID:value}).config.locationSheetId,/WTC_CONFIG_MISSING/);
});
test('public deployment rejects placeholder IDs and full URLs',()=>{
  for(const value of ['YOUR_SPREADSHEET_ID_GOES_HERE','REPLACE_MAIN_SPREADSHEET_ID','https://docs.google.com/spreadsheets/d/demo/edit','short'])assert.throws(()=>runtime({...valid,WTC_MAIN_SPREADSHEET_ID:value}).config.spreadsheetId,/WTC_CONFIG_MISSING/);
});
test('deployment bindings are read lazily and legacy tasks have no customer defaults',()=>{
  const properties={...valid},r=runtime(properties);assert.deepEqual(Array.from(r.config.unloadTasks),[]);
  assert.equal(r.config.unloadSourceTab,'');assert.equal(r.config.locationSheetId,101);
  properties.WTC_LOCATION_SHEET_ID='102';assert.equal(r.config.locationSheetId,102);
  assert.equal(r.config.spreadsheetId,valid.WTC_MAIN_SPREADSHEET_ID);
});
test('table source reader reports an unconfigured map without opening any default workbook',()=>{
  const S=require('./table_source_reader.gs'),opened=[];
  const result=S.read({book:{getId:()=>valid.WTC_MAIN_SPREADSHEET_ID,getSheets:()=>[],getSheetByName:()=>null},now:'2026-11-07T00:00:00Z',openBook(id){opened.push(id);throw new Error('No fixture workbook');}});
  assert.equal(result.unload.ok,false);assert.match(JSON.stringify(result.unload.issues),/WTC_CONFIG_MISSING/);
  assert.deepEqual(opened,[]);assert.equal(result.physicalInventoryUnchanged,true);
});
