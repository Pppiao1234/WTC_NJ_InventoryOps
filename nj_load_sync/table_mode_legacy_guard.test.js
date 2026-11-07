'use strict';
// Verifies retired RPCs cannot touch Sheets, Drive, AI, properties or old state.
// The source files run in a VM with every external operation trapped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function harness({moduleMissing=false, mode=true}={}) {
  const effects=[], routes=[], props=new Map([
    ['WTC_TABLE_MODE_ENABLED', mode?'true':'false'],
    ['WTC_PHOTO_INTAKE_ENABLED','true'], ['WTC_LOADING_PORTAL_ENABLED','true'],
    ['WTC_INVENTORY_OPS_ENABLED','true'], ['WTC_FORECAST_ENABLED','true'], ['WTC_UNLOAD_ENABLED','true']
  ]);
  const forbidden=(name)=>new Proxy(function(){effects.push(name);throw Error('Unexpected external operation: '+name);},{
    get(_target,key){return forbidden(name+'.'+String(key));}
  });
  const propertyStore={getProperty:key=>props.get(key)||null,setProperty:forbidden('properties.setProperty'),deleteProperty:forbidden('properties.deleteProperty')};
  const ctx={console:{log(){}},PropertiesService:{getScriptProperties:()=>propertyStore,getUserProperties:forbidden('userProperties')},
    SpreadsheetApp:forbidden('SpreadsheetApp'),DriveApp:forbidden('DriveApp'),UrlFetchApp:forbidden('UrlFetchApp'),LockService:forbidden('LockService'),ScriptApp:forbidden('ScriptApp'),Utilities:forbidden('Utilities'),HtmlService:forbidden('HtmlService'),WTCLoadCore:forbidden('WTCLoadCore')};
  if(!moduleMissing)ctx.WTCTableMode={};
  for(const name of ['sync','status','onEdit','menu','pause','resume','showPortal','open','legacyNotice']) {
    if(!moduleMissing)ctx.WTCTableMode[name]=argument=>{routes.push({name,argument});return {ok:name!=='legacyNotice',route:name,message:'表格模式；旧入口已停用。'};};
  }
  vm.createContext(ctx);
  let source=fs.readFileSync(path.join(__dirname,'adapter.gs'),'utf8');
  const anchor='return { tableModeEnabled:tableModeEnabled_, requireLegacyMode:requireLegacyMode_, tableModeApi:tableModeApi_, photoBridge:photoBridge_';
  assert.ok(source.includes(anchor));
  source=source.replace(anchor,'return { _guardTest:{ apiBatch:apiBatch_, stateRequests:stateRequests_, requireRunning:requireRunning_, ensureSheet:ensureSheet_, columns:columns_, ensureForecastTriggers:ensureForecastTriggers_, askAI:askAI_ }, tableModeEnabled:tableModeEnabled_, requireLegacyMode:requireLegacyMode_, tableModeApi:tableModeApi_, photoBridge:photoBridge_');
  vm.runInContext(source,ctx,{filename:'adapter.gs'});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'photo_adapter.gs'),'utf8'),ctx,{filename:'photo_adapter.gs'});
  return {ctx,effects,routes,props};
}
const retiredRpc=[
  'WTCLoad_upgradeLoadingPortal','WTCLoad_upgradeProjectV15','WTCLoad_createLoadingTask','WTCLoad_submitLoading','WTCLoad_syncLoadingPortal',
  'WTCLoad_upgradeForecast','WTCLoad_upgradeProjectV14','WTCLoad_syncForecastNow',
  'WTCLoad_upgradeInventoryOps','WTCLoad_syncInventoryOps','WTCLoad_registerMove','WTCLoad_previewNightCount','WTCLoad_confirmNightCount',
  'WTCLoad_install','WTCLoad_upgradeLoadingIdentity','WTCLoad_restoreSelectedTaskId','WTCLoad_moveSelectedTaskRow','WTCLoad_enableUnloadSync','WTCLoad_syncUnloadNow',
  'WTCLoad_saveApiKey','WTCLoad_confirmBaseline','WTCLoad_confirmCorrection','WTCLoad_newTaskForSelectedRow',
  'WTCLoad_previewEmptyRegistrations','WTCLoad_previewCleanup','WTCLoad_cleanupEmptyRegistrations',
  'WTCLoad_upgradeProjectV16','WTCLoad_uploadPhotos','WTCLoad_retryPhotoJob','WTCLoad_cancelPhotoJob','WTCLoad_previewPhotoCount','WTCLoad_adoptPhotoCount','WTCLoad_registerChatPhotoCandidate','WTCLoad_syncPhotoIntake'
];
for(const name of retiredRpc)test('table cutover: stale RPC '+name+' is rejected before any external operation',()=>{
  const h=harness();assert.equal(typeof h.ctx[name],'function');
  assert.throws(()=>h.ctx[name]({requestId:'stale-sidebar',files:[{dataBase64:'not-even-decoded'}]}),/TABLE_MODE_LEGACY_BLOCKED/);
  assert.deepEqual(h.effects,[]);assert.deepEqual(h.routes,[]);
});
const retiredExports=['upgradeLoadingPortal','upgradeProjectV15','createLoadingTask','submitLoading','syncLoadingPortal','upgradeForecast','upgradeProjectV14','syncForecast','forecastPreview','upgradeInventoryOps','syncInventoryOps','registerMove','previewNightCount','confirmNightCount','upgradeLoadingIdentity','restoreTaskId','moveTaskRow','syncUnload','enableUnload','install','saveKey','confirmBaseline','correction','newTask','previewCleanup','cleanup'];
test('table cutover: direct exported methods cannot bypass public RPC guards',()=>{
  const h=harness();for(const name of retiredExports)assert.throws(()=>h.ctx.WTCLoad[name]({}),/TABLE_MODE_LEGACY_BLOCKED/,name);assert.deepEqual(h.effects,[]);
});
test('table cutover: direct photo methods and photo bridge writers cannot bypass guards',()=>{
  const h=harness();for(const name of ['upgrade','upload','retry','cancel','requestPreview','requestAdoption','registerChat','sync','reconcile'])assert.throws(()=>h.ctx.WTCPhoto[name]({}),/TABLE_MODE_LEGACY_BLOCKED/,name);
  const bridge=h.ctx.WTCLoad.photoBridge();for(const name of ['requireRunning','apiBatch','stateRequests','ensureSheet','previewNightCount','confirmNightCount','syncInventoryOps','upgradeProjectV15','ensureForecastTriggers'])assert.throws(()=>bridge[name]({},true),/TABLE_MODE_LEGACY_BLOCKED/,name);
  assert.deepEqual(h.effects,[]);
});
test('table cutover: paused-write bypass and raw source column creation are blocked at the lowest layer',()=>{
  const h=harness(),gate=h.ctx.WTCLoad._guardTest;
  assert.throws(()=>gate.apiBatch([],true),/TABLE_MODE_LEGACY_BLOCKED/);
  assert.throws(()=>gate.stateRequests({}),/TABLE_MODE_LEGACY_BLOCKED/);
  assert.throws(()=>gate.columns({},true),/TABLE_MODE_LEGACY_BLOCKED/);
  assert.throws(()=>gate.askAI({}),/TABLE_MODE_LEGACY_BLOCKED/);
  assert.deepEqual(h.effects,[]);
});
const routed={WTCLoad_tick:'sync',WTCLoad_syncNow:'sync',WTCLoad_syncSelectedRow:'sync',WTCLoad_onEdit:'onEdit',WTCLoad_onUnloadEdit:'onEdit',WTCLoad_onOpen:'menu',WTCLoad_getStatus:'status',WTCLoad_pauseForMaintenance:'pause',WTCLoad_pause:'pause',WTCLoad_resumeAfterMaintenance:'resume',WTCLoad_resume:'resume',WTCLoad_showSidebar:'showPortal',WTCLoad_showLoadingPortal:'showPortal',WTCLoad_showPhotoPortal:'showPortal',WTCLoad_openContainerDataStatus:'showPortal',WTCLoad_openPhotoNightStatus:'showPortal',WTCLoad_openLoadingTasks:'showPortal',WTCLoad_openMoves:'showPortal',WTCLoad_openNightCount:'showPortal',WTCLoad_openContainerAliases:'showPortal',WTCLoad_openForecast:'open',WTCLoad_openBaseline:'showPortal',WTCLoad_openSettings:'showPortal'};
for(const [name,method] of Object.entries(routed))test('table cutover: '+name+' routes exclusively to '+method,()=>{
  const h=harness(),event={sentinel:'same event'};h.ctx[name](event);assert.equal(h.routes.length,1);assert.equal(h.routes[0].name,method);if(method==='onEdit')assert.equal(h.routes[0].argument,event);assert.deepEqual(h.effects,[]);
});
test('table cutover: retired status getters do not read old ledger or offer an upgrade',()=>{
  const h=harness();assert.equal(h.ctx.WTCPhoto.enabled(),false);
  for(const name of ['WTCLoad_getPhotoPortal','WTCLoad_getLoadingPortal','WTCLoad_getSelectedLoadingSnapshot']){const r=h.ctx[name]();assert.equal(r.enabled,false);assert.equal(r.tableMode,true);assert.match(r.message,/旧入口已停用/);}
  assert.deepEqual(h.effects,[]);
});
test('table cutover: absent or incomplete new module fails closed without any legacy fallback',()=>{
  const h=harness({moduleMissing:true});for(const name of Object.keys(routed))assert.throws(()=>h.ctx[name]({}),/TABLE_MODE_MODULE_MISSING/,name);
  for(const name of retiredRpc)assert.throws(()=>h.ctx[name]({}),/TABLE_MODE_LEGACY_BLOCKED/,name);
  assert.deepEqual(h.effects,[]);
});
test('table cutover: mode disabled retains legacy availability, without calling new module',()=>{
  const h=harness({mode:false});assert.equal(h.ctx.WTCPhoto.enabled(),true);assert.equal(h.ctx.WTCLoad.tableModeEnabled(),false);assert.doesNotThrow(()=>h.ctx.WTCLoad.requireLegacyMode());assert.deepEqual(h.routes,[]);
});
