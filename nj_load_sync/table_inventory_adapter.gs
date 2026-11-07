/* Warehouse 1.7: table-authored stock snapshots. No AI calls and no source-sheet writes. */
var WTCTableMode = (function () {
  'use strict';
  var VERSION = '1.7.0', ENABLED = 'WTC_TABLE_MODE_ENABLED', LAST_READ = 'WTC_TABLE_LAST_READ', LAST_ERROR = 'WTC_TABLE_LAST_ERROR';
  var CHUNK = 42000, MAX_CHUNKS = 40;
  var T = { state:'_WTC表格状态', stock:'WTC当前库位', changes:'WTC表格变化', issues:'WTC读取问题', closes:'WTC收工快照', closeDiff:'WTC收工差异', archive:'_WTC收工档案', forecast:'WTC表格预报', work:'WTC表格作业' };
  var H = {
    stock:['库位','仓点/货物标识','表内明确板数P','记录状态','来源单元格','标准容量参考','读取时间'],
    changes:['变化ID','发现时间','库位','仓点/货物标识','原记录P','新记录P','变化类型','说明','原位置','现位置','表格版本'],
    issues:['来源','库位/对象','问题','源单元格','检查时间'],
    closes:['收工快照ID','收工日期','实际读取时间','表内明确P小计','已记录条目','未知库位数','与上次收工变化数','比较说明','来源版本'],
    closeDiff:['收工快照ID','比较快照ID','收工日期','库位','仓点/货物标识','上次记录P','本次记录P','变化类型','说明','原单元格','现单元格'],
    archive:['快照ID','分片序号','分片总数','完整JSON校验','快照JSON'],
    forecast:['柜号/原标识','采用预报','预报日期','普通仓点预报P','特殊货参考P','整柜预报P','关联状态','来源','数据时效','最后成功读取（美东）'],
    work:['类型','业务日期','柜号/任务标识','作业状态','台口','来源','备注','数据时效','最后成功读取（美东）']
  };
  function B() { return WTCLoad.photoBridge(); }
  function core() { if(typeof WTCTableInventoryCore==='undefined')throw new Error('缺少1.7表格读取模块。');return WTCTableInventoryCore; }
  function props() { return PropertiesService.getScriptProperties(); }
  function enabled() { return props().getProperty(ENABLED)==='true'; }
  function now() { return new Date().toISOString(); }
  function localTime(value) { if(!value)return '';var date=new Date(value);return isNaN(date.getTime())?str(value):Utilities.formatDate(date,'America/New_York','yyyy-MM-dd HH:mm:ss')+' 美东'; }
  function str(v) { return String(v==null?'':v); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function hash(v) { return B().hash(v); }
  function cfg() { return B().config; }
  function configuredLocationId() { return cfg().locationSheetId; }
  function requireDeploymentConfig() { var c=cfg(); return {main:c.spreadsheetId,unload:c.unloadSourceId,location:configuredLocationId()}; }
  function book() { return B().book(); }
  function paused() { return B().paused(); }
  function ensureEnabled() { if(!enabled())throw new Error('请先由原安装账号启用1.7表格读取流程。'); }
  function withLock(fn) {
    var lock=LockService.getScriptLock();
    if(!lock.tryLock(100))return {ok:false,busy:true,message:'已有读取正在进行，本轮跳过；稍后自动检查。'};
    try{return fn();}finally{lock.releaseLock();}
  }
  function sourceSheet(bk) { var sh=bk.getSheets().filter(function(s){return s.getSheetId()===configuredLocationId();})[0];if(!sh||sh.getName()!=='库位表')throw new Error('原库位表页签或编号已变化，请核对来源后再读取。');return sh; }
  function readSource(bk) {
    var sh=sourceSheet(bk),nr=Math.max(sh.getLastRow(),1),nc=Math.max(sh.getLastColumn(),1);
    if(nr*nc>100000)throw new Error('库位表已超出本版读取范围，保留上次有效结果。');
    var range=sh.getRange(1,1,nr,nc),rows=range.getDisplayValues(),notes=range.getNotes(),at=now();
    var snapshot=core().parseSnapshot({rows:rows,notes:notes,sourceSheetId:configuredLocationId(),sourceSheetName:sh.getName(),capturedAt:at});
    snapshot.sourceHash=hash({rows:rows,notes:notes});snapshot.capturedAt=at;snapshot.rawRows=rows;snapshot.rawNotes=notes;
    return snapshot;
  }
  function requireValid(snapshot) { if(!snapshot||!snapshot.ok||!snapshot.complete)throw new Error('库位表结构或读取不完整，保留上次有效快照：'+((snapshot&&snapshot.issues)||[]).map(function(x){return x.message||x.code;}).join('；').slice(0,350)); }
  function decodeState(rows) {
    if(!rows.length||!(rows[0]||[])[1])return null;
    if(rows[0][1]!==VERSION)throw new Error('表格状态版本不符，未重置。');
    var count=Number((rows[2]||[])[1]),version=Number((rows[1]||[])[1]);
    if(!Number.isInteger(count)||count<1||count>MAX_CHUNKS)throw new Error('表格状态分片异常，未重置。');
    var raw=rows.slice(7,7+count).map(function(r){return str(r[1]);}).join('');
    if(hash(raw)!==(rows[4]||[])[1])throw new Error('表格状态校验失败，未重置。');
    var st=JSON.parse(raw);if(st.version!==version||st.schemaVersion!==VERSION||!st.snapshot)throw new Error('表格状态不完整，未重置。');return st;
  }
  function readState(bk) { var sh=bk.getSheetByName(T.state);return sh?decodeState(sh.getRange(1,1,7+MAX_CHUNKS,2).getValues()):null; }
  function readStateFresh() {
    var range="'"+T.state+"'!A1:B"+(7+MAX_CHUNKS);
    var response=UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(cfg().spreadsheetId)+'/values/'+encodeURIComponent(range)+'?valueRenderOption=UNFORMATTED_VALUE',{headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true});
    if(response.getResponseCode()<200||response.getResponseCode()>=300)throw new Error('新状态已提交，但回读失败；请稍后检查结果，勿重复登记收工。');
    return decodeState(JSON.parse(response.getContentText()).values||[]);
  }
  function cell(v) { if(v===null||v===undefined)return {};if(typeof v==='number')return {userEnteredValue:{numberValue:v}};if(typeof v==='boolean')return {userEnteredValue:{boolValue:v}};return {userEnteredValue:{stringValue:str(v)}}; }
  function update(sh,row,col,values) { return {updateCells:{range:{sheetId:sh.getSheetId(),startRowIndex:row-1,endRowIndex:row-1+values.length,startColumnIndex:col-1,endColumnIndex:col-1+values[0].length},rows:values.map(function(r){return{values:r.map(cell)};}),fields:'userEnteredValue'}}; }
  function append(sh,values) { return {appendCells:{sheetId:sh.getSheetId(),rows:values.map(function(r){return{values:r.map(cell)};}),fields:'userEnteredValue'}}; }
  function ensure(bk,name,headers,hidden) {
    var sh=bk.getSheetByName(name);if(!sh)sh=bk.insertSheet(name);
    if(headers){var existing=sh.getRange(1,1,1,headers.length).getDisplayValues()[0];if(existing.some(function(v){return v!=='';})&&existing.join('\u0001')!==headers.join('\u0001'))throw new Error(name+'已有不同内容，未覆盖。');sh.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8eef7');sh.setFrozenRows(1);}
    if(hidden&&!sh.isSheetHidden())sh.hideSheet();return sh;
  }
  function ensureAll(bk) { Object.keys(T).forEach(function(k){ensure(bk,T[k],H[k]||null,k==='state'||k==='archive');});SpreadsheetApp.flush(); }
  function sheets(bk) { var out={};Object.keys(T).forEach(function(k){out[k]=bk.getSheetByName(T[k]);if(!out[k])throw new Error('缺少表格流程输出页：'+T[k]);});return out; }
  function rewrite(sh,headers,rows) {
    var count=Math.max(rows.length,sh.getLastRow()-1),width=headers.length,out=rows.map(function(r){return r.concat(Array(Math.max(0,width-r.length)).fill(null)).slice(0,width);});
    while(out.length<count)out.push(Array(width).fill(null));var requests=[];
    if(count+1>sh.getMaxRows())requests.push({appendDimension:{sheetId:sh.getSheetId(),dimension:'ROWS',length:count+1-sh.getMaxRows()}});
    if(count)requests.push(update(sh,2,1,out));return requests;
  }
  function stateRequests(sh,st) {
    var raw=JSON.stringify(st),chunks=[];for(var i=0;i<raw.length;i+=CHUNK)chunks.push(raw.slice(i,i+CHUNK));
    if(chunks.length>MAX_CHUNKS)throw new Error('表格比较状态达到上限，请归档后再继续；保留原状态。');
    return [update(sh,1,1,[['schemaVersion',VERSION],['stateVersion',st.version],['chunkCount',chunks.length],['checkpointTime',now()],['stateHash',hash(raw)]]),update(sh,8,2,Array.from({length:MAX_CHUNKS},function(_,j){return[j<chunks.length?chunks[j]:null];}))];
  }
  function allowedBatch(bk,requests) {
    var allowed=Object.keys(sheets(bk)).map(function(k){return bk.getSheetByName(T[k]).getSheetId();});
    requests.forEach(function(r){var obj=r.updateCells||r.appendCells||r.appendDimension,id=obj&&(obj.sheetId||(obj.range||{}).sheetId);if(!obj||Object.keys(r).length!==1||allowed.indexOf(id)<0)throw new Error('表格模式拒绝写入来源或旧库存页。');});
    var response=UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(cfg().spreadsheetId)+':batchUpdate',{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},payload:JSON.stringify({requests:requests}),muteHttpExceptions:true});
    if(response.getResponseCode()<200||response.getResponseCode()>=300)throw new Error('表格结果提交失败：'+response.getResponseCode()+'；未显示为成功。');
  }
  function addresses(value) { return (Array.isArray(value)?value:[value]).filter(function(x){return x!=null;}).map(function(x){return typeof x==='string'?x:(x.a1||x.cell||(x.range?(x.sheetName?x.sheetName+'!':'')+x.range:JSON.stringify(x)));}).join(', '); }
  function inventoryRows(snapshot) {
    var locs={};(snapshot.locations||[]).forEach(function(l){locs[l.location]=l;});var used={};
    var rows=(snapshot.entries||[]).map(function(e){used[e.location]=true;var l=locs[e.location]||{},conflict=l.status==='conflict';return[e.location,e.cargoLabel||e.cargoKey,conflict?null:e.physicalP,(conflict?'记录冲突，待核对':e.physicalP==null?'板数待核对':'表内明确记录')+(l.available===false?'；不可用于分位':''),addresses(e.sourceCells),l.available===false?'不可用':l.capacitySlots==null?null:l.capacitySlots,localTime(snapshot.capturedAt)];});
    (snapshot.locations||[]).forEach(function(l){if(!used[l.location])rows.push([l.location,'',l.quantityKnown?l.recordedP:null,(l.status==='conflict'?'记录冲突，待核对':l.quantityKnown?'明确空位':'未填写/未知')+(l.available===false?'；不可用于分位':''),addresses(l.sourceCells),l.available===false?'不可用':l.capacitySlots==null?null:l.capacitySlots,localTime(snapshot.capturedAt)]);});return rows;
  }
  function issueRows(st) {
    var out=[],snap=st.lastAttempt||st.snapshot;
    (snap.issues||[]).forEach(function(i){out.push(['库位表',i.location||i.object||'',i.message||i.code||str(i),addresses(i.sourceCells||i.cell||[]),localTime(snap.capturedAt)]);});
    (((st.aux||{}).issues)||[]).forEach(function(i){out.push([i.source||'辅助表',i.location||i.object||'',i.message||i.code||str(i),addresses(i.sourceCells||i.cell||[]),localTime((st.aux||{}).observedAt)]);});return out;
  }
  function auxiliaryRows(st) {
    var aux=st.aux||{},forecast=[],work=[],fs=aux.forecast||{},us=aux.unload||{},ls=aux.loading||{};
    var fd=fs.data||{},fr=fd.rows||[],sourceById={};(fd.sources||[]).forEach(function(s){sourceById[s.sourceId]=s;});
    fr.forEach(function(r){
      var source=sourceById[r.selectedSourceId],stale=!!r.stale||!!(source&&source.stale)||(!source&&!!fs.stale),retained=(r.issues||[]).some(function(i){return i.retainedPrevious===true;});
      var checked=Object.prototype.hasOwnProperty.call(r,'lastSuccessAt')?r.lastSuccessAt:stale||retained?(source&&source.lastSuccessAt||fs.lastSuccessAt):(source&&(source.observedAt||source.lastSuccessAt)||fs.lastSuccessAt);
      var freshness=stale||retained?(checked?'保留历史，待重试':'未成功读取；数量待核对'):r.valid===false?'数量/关联待核对；预报仅供参考':'已读取；预报仅供参考';
      forecast.push([r.containerNo||r.key||'',r.sourceKind||'',r.businessDate||'',typeof r.ordinaryP==='number'?r.ordinaryP:null,typeof r.specialP==='number'?r.specialP:null,typeof r.totalP==='number'?r.totalP:null,r.status||r.resolutionStatus||'',r.selectedSourceTitle||'',freshness,localTime(checked)]);
    });
    var ud=us.data||{},ld=ls.data||{},pageById={};(ud.pages||[]).forEach(function(p){pageById[String(p.sheetId)]=p;});
    (ud.selected||ud.observations||[]).forEach(function(r){var page=pageById[String(r.sourceSheetId)],stale=!!r.stale||!!(page&&page.stale)||(!page&&r.stale==null&&!!us.stale),checked=page&&page.lastSuccessAt||r.observedAt||us.lastSuccessAt;work.push(['拆柜',r.businessDate||r.date||'',r.containerNo||r.rawId||r.reference||r.id||'',r.status||'',r.dock||'',addresses(r.sourceRef||r.sourceTab||''),r.note||r.message||'',stale?'保留历史，待重试':'已读取；仅作对照',localTime(checked)]);});
    (ld.records||[]).forEach(function(r){work.push(['装车',r.businessDate||r.date||'',r.taskId||r.reference||r.loadInfo||r.info||'',r.status||'',r.dock||'',addresses(r.sourceRefs||[]),r.info||r.note||r.message||'',ls.stale?'保留历史，待重试':'已读取；仅作对照',localTime(ls.lastSuccessAt)]);});
    return {forecast:forecast,work:work};
  }
  function projectionRequests(sh,st) { var aux=auxiliaryRows(st);return rewrite(sh.stock,H.stock,inventoryRows(st.snapshot)).concat(rewrite(sh.issues,H.issues,issueRows(st)),rewrite(sh.forecast,H.forecast,aux.forecast),rewrite(sh.work,H.work,aux.work)); }
  function commit(bk,before,st,extra) {
    var sh=sheets(bk);st.version=(before?before.version:0)+1;st.committedAt=now();
    allowedBatch(bk,stateRequests(sh.state,st).concat(projectionRequests(sh,st),extra||[]));
    var proof=readStateFresh();if(!proof||proof.version!==st.version||hash(proof)!==hash(st))throw new Error('提交结果尚未核验，请稍后刷新；未重复处理。');return proof;
  }
  function auxRead(bk,st,force) {
    if(typeof WTCTableSources==='undefined')return {changed:false};
    var old=st.aux||{},last=Date.parse(old.observedAt||'');if(!force&&last&&Date.now()-last<5*60*1000)return {changed:false};
    try{st.aux=WTCTableSources.read({book:bk,now:now(),timezone:cfg().timezone,prior:old,unloadSourceId:cfg().unloadSourceId});return {changed:true};}
    catch(e){st.aux=clone(old);st.aux.observedAt=now();st.aux.issues=[{source:'辅助来源',code:'SOURCE_READ_FAILED',message:B().clean(e.message,350)}];['forecast','unload','loading'].forEach(function(k){st.aux[k]=Object.assign({},st.aux[k]||{},{ok:false,complete:false,stale:true,checkedAt:st.aux.observedAt});var data=st.aux[k].data||{};['sources','pages','selected','observations'].forEach(function(name){(data[name]||[]).forEach(function(x){x.stale=true;});});});return {changed:true};}
  }
  function events(diff,snapshot,version) { return (diff.changes||[]).map(function(c,index){return['TC-'+hash([snapshot.sourceHash,version,index,c]).slice(0,24),localTime(snapshot.capturedAt),c.location,c.cargoLabel||c.cargoKey,c.beforeP,c.afterP,c.type,c.message||'表内记录变化，原因未注明',addresses(c.beforeSourceCells),addresses(c.sourceCells),version];}); }
  function lastRead(value) { props().setProperty(LAST_READ,value);props().deleteProperty(LAST_ERROR); }
  function guarded(fn) { try{return fn();}catch(e){props().setProperty(LAST_ERROR,B().clean(e.message,500));throw e;} }
  function sync(force) {
    ensureEnabled();if(paused())return {ok:false,paused:true,message:'表格读取已暂停。'};
    if(!B().owner())return {ok:false,message:'由原安装账号后台读取；你的表格修改已保存在来源表。'};
    return guarded(function(){return withLock(function(){
      if(paused())return {ok:false,paused:true,message:'表格读取已暂停。'};
      var bk=book(),before=readState(bk);if(!before)throw new Error('缺少已启用的表格状态，请核对升级结果。');var st=clone(before),snapshot;
      try{snapshot=readSource(bk);requireValid(snapshot);}catch(e){props().setProperty(LAST_ERROR,B().clean(e.message,500));return {ok:false,message:B().clean(e.message,500),retainedLastValid:true};}
      var diff=core().diffSnapshots(before.snapshot,snapshot),changed=before.snapshot.sourceHash!==snapshot.sourceHash;
      var aux=auxRead(bk,st,!!force),extra=[];
      if(changed){st.snapshot=snapshot;st.lastAttempt=null;st.lastChanges=diff.changes||[];st.lastChangedAt=diff.noOp?before.lastChangedAt:snapshot.capturedAt;st.lastReadAt=snapshot.capturedAt;var ev=events(diff,snapshot,before.version+1);if(ev.length)extra.push(append(sheets(bk).changes,ev));}
      if(paused())return {ok:false,paused:true,message:'表格读取已暂停，本轮未提交。'};
      if(changed||aux.changed){st.lastReadAt=snapshot.capturedAt;st=commit(bk,before,st,extra);}
      lastRead(snapshot.capturedAt);
      return {ok:true,changed:changed&&!diff.noOp,changes:(diff.changes||[]).length,version:st.version,message:changed&&!diff.noOp?'已读取表格并记录变化。':'表格读取成功，本次未发现库存记录变化。',portal:portal(st)};
    });});
  }
  function legacyBackup(bk) {
    var sh=bk.getSheetByName(cfg().sheets.state);if(!sh)return {present:false};var rows=sh.getRange(1,1,7+cfg().maxStateChunks,2).getValues(),count=Number((rows[2]||[])[1]);
    if(!count)return {present:true,empty:true};if(!Number.isInteger(count)||count<1||count>cfg().maxStateChunks)throw new Error('旧后台状态损坏，升级未继续。');
    var raw=rows.slice(7,7+count).map(function(r){return str(r[1]);}).join(''),check=(rows[4]||[])[1];if(hash(raw)!==check)throw new Error('旧后台状态校验失败，升级未继续。');
    return {present:true,sheetId:sh.getSheetId(),version:Number((rows[1]||[])[1]),stateHash:check,preservedAt:now(),note:'旧状态保留原页；不合入新表格库存。'};
  }
  function upgrade() {
    requireDeploymentConfig(); // Validate all public bindings before changing any properties or sheets.
    B().requireOwner();var p=props(),wasPaused=paused();
    try{return withLock(function(){
      p.setProperty(cfg().pauseProperty,'true');
      var bk=book(),snapshot=readSource(bk);requireValid(snapshot);var prior=readState(bk),already=enabled();
      if(already&&prior){requireValid(prior.snapshot);ensureTick();p.setProperty('WTC_TABLE_MODE_VERSION',VERSION);p.deleteProperty(LAST_ERROR);p.setProperty(cfg().pauseProperty,wasPaused?'true':'false');return {ok:true,noOp:true,message:'1.7表格流程已启用，原比较基准已保留。',menuAvailable:refreshMenuIfAvailable(),portal:portal(prior)};}
      var archive=legacyBackup(bk);
      // Once the source and legacy archive are verified, fail closed: old flows remain disabled even if a later commit fails.
      p.setProperty(ENABLED,'true');ensureAll(bk);ensureTick();
      var st={schemaVersion:VERSION,version:0,enabledAt:now(),sourceSheetId:configuredLocationId(),sourceSheetName:'库位表',legacyArchive:archive,snapshot:snapshot,lastReadAt:snapshot.capturedAt,lastChangedAt:'',lastChanges:[],lastClose:null,closeIndex:{},aux:{}};
      auxRead(bk,st,true);st=commit(bk,null,st,[]);
      p.setProperty('WTC_TABLE_MODE_VERSION',VERSION);lastRead(snapshot.capturedAt);p.setProperty(cfg().pauseProperty,wasPaused?'true':'false');
      return {ok:true,message:'1.7表格流程已启用；当前库位表已建立独立比较起点。'+(wasPaused?'当前仍暂停，可恢复读取。':''),menuAvailable:refreshMenuIfAvailable(),portal:portal(st)};
    });}catch(e){p.setProperty(cfg().pauseProperty,'true');p.setProperty(LAST_ERROR,B().clean(e.message,500));throw e;}
  }
  function refreshMenuIfAvailable() { try{menu();return true;}catch(e){console.log('表格读取流程已就绪；当前执行环境无法刷新表格菜单。');return false;} }
  function ensureTick() { var ticks=ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()==='WTCLoad_tick';});if(!ticks.length)ScriptApp.newTrigger('WTCLoad_tick').timeBased().everyMinutes(1).create();return {handler:'WTCLoad_tick',intervalMinutes:1,existingCount:ticks.length}; }
  function validDay(value) { var day=str(value);if(!/^\d{4}-\d{2}-\d{2}$/.test(day))return false;var date=new Date(day+'T12:00:00Z');return !isNaN(date.getTime())&&date.toISOString().slice(0,10)===day; }
  function closeDay(input) {
    ensureEnabled();B().requireOwner();if(paused())throw new Error('当前读取暂停，请恢复后保存收工快照。');input=input||{};
    if(!validDay(input.businessDate))throw new Error('请选择有效的收工日期。');
    if(input.businessDate>Utilities.formatDate(new Date(),'America/New_York','yyyy-MM-dd'))throw new Error('不能提前保存未来日期的收工快照。');
    return guarded(function(){return withLock(function(){
      if(paused())throw new Error('当前读取已暂停，未保存收工快照。');
      var bk=book(),before=readState(bk);if(!before)throw new Error('尚未建立表格比较起点。');var snapshot=readSource(bk);requireValid(snapshot);
      if(before.lastClose&&input.businessDate<before.lastClose.businessDate)throw new Error('收工日期早于上次收工，未替换当前比较基准。');
      if(input.expectedSourceHash!==before.snapshot.sourceHash||snapshot.sourceHash!==before.snapshot.sourceHash)throw new Error('库位表已变化，请先刷新核对后再保存收工快照。');
      var day=input.businessDate,key=day+'|'+snapshot.sourceHash,old=(before.closeIndex||{})[key];if(old)return {ok:true,noOp:true,message:'这版收工快照已保存，未重复登记。',closeId:old,portal:portal(before)};
      var st=clone(before),id='CLOSE-'+day.replace(/-/g,'')+'-'+hash(key).slice(0,16),diff=core().diffSnapshots(before.lastClose&&before.lastClose.snapshot,snapshot);
      var closed={id:id,businessDate:day,observedAt:snapshot.capturedAt,sourceHash:snapshot.sourceHash,snapshot:snapshot,changes:diff.changes||[],comparisonBasis:before.lastClose?before.lastClose.id:'首个收工快照；未推断出入库'};
      st.lastClose=closed;st.closeIndex=st.closeIndex||{};st.closeIndex[key]=id;st.lastReadAt=snapshot.capturedAt;
      var raw=JSON.stringify(closed),parts=[];for(var i=0;i<raw.length;i+=CHUNK)parts.push(raw.slice(i,i+CHUNK));var sh=sheets(bk),summary=snapshot.summary||{};
      var extra=[append(sh.closes,[[id,day,localTime(snapshot.capturedAt),summary.knownP==null?summary.totalKnownP:summary.knownP,summary.entryCount,summary.unknownLocationCount,(diff.changes||[]).length,before.lastClose?'比较两次收工表记录；变化原因待作业核实':'首个收工快照',before.version+1]]),append(sh.archive,parts.map(function(chunk,index){return[id,index+1,parts.length,hash(raw),chunk];}))];
      if(diff.changes.length)extra.push(append(sh.closeDiff,diff.changes.map(function(c){return[id,before.lastClose?before.lastClose.id:'',day,c.location,c.cargoLabel||c.cargoKey,c.beforeP,c.afterP,c.type,c.message||'表内记录变化，原因未注明',addresses(c.beforeSourceCells),addresses(c.sourceCells)];})));
      if(paused())throw new Error('当前读取已暂停，未保存收工快照。');
      st=commit(bk,before,st,extra);lastRead(snapshot.capturedAt);return {ok:true,message:'收工快照已保存，下一次按同一库位和货物标识比较。',closeId:id,portal:portal(st)};
    });});
  }
  function portal(st) {
    var bk=book();st=st||readState(bk);var snap=st&&st.snapshot,base='https://docs.google.com/spreadsheets/d/'+cfg().spreadsheetId+'/edit#gid=',urls={};['stock','changes','forecast','work','issues','closes','closeDiff'].forEach(function(k){var sh=bk.getSheetByName(T[k]);if(sh)urls[k]=base+sh.getSheetId();});
    return {enabled:enabled(),ready:!!snap,version:VERSION,isOwner:B().owner(),paused:paused(),sourceUrl:base+configuredLocationId(),viewUrls:urls,stateVersion:st?st.version:null,lastReadAt:props().getProperty(LAST_READ)||(st&&st.lastReadAt)||'',lastChangedAt:st&&st.lastChangedAt||'',lastError:props().getProperty(LAST_ERROR)||'',sourceHash:snap&&snap.sourceHash||'',summary:snap&&snap.summary||{},issues:snap&&snap.issues||[],changes:st&&st.lastChanges||[],lastClose:st&&st.lastClose?{id:st.lastClose.id,businessDate:st.lastClose.businessDate,observedAt:st.lastClose.observedAt}:null,aux:st&&st.aux||{},today:Utilities.formatDate(new Date(),'America/New_York','yyyy-MM-dd')};
  }
  function status() { return portal(); }
  function pause() { B().requireOwner();props().setProperty(cfg().pauseProperty,'true');return {ok:true,message:'表格读取已暂停。',portal:portal()}; }
  function resume() { B().requireOwner();ensureEnabled();var st=readState(book());if(!st||!st.snapshot)throw new Error('表格读取基准尚未建立，未恢复。');requireValid(st.snapshot);props().setProperty(cfg().pauseProperty,'false');return {ok:true,message:'表格读取已恢复，后台按原定时任务检查。',portal:portal(st)}; }
  function onEdit(event) { if(!enabled()||!event||!event.range||!event.source)return;var sourceId=event.source.getId(),sheetId=event.range.getSheet().getSheetId();if(sourceId===cfg().spreadsheetId&&sheetId===configuredLocationId())props().setProperty('WTC_TABLE_SOURCE_DIRTY',now());else if(sourceId===cfg().unloadSourceId||(sourceId===cfg().spreadsheetId&&event.range.getSheet().getName()===cfg().sourceSheet))props().setProperty('WTC_TABLE_AUX_DIRTY',now()); }
  function open(which) { var bk=book(),sh=which==='source'?sourceSheet(bk):bk.getSheetByName(T[which]);if(!sh)throw new Error('尚无对应结果页，请先读取表格。');bk.setActiveSheet(sh);return {ok:true}; }
  function menu() { SpreadsheetApp.getUi().createMenu('库位同步').addItem('打开库位工作台','WTCLoad_showTablePortal').addItem('立即读取表格','WTCLoad_syncTableInventory').addItem('打开库位表','WTCLoad_openTableSource').addItem('查看当前库位','WTCLoad_openCurrentLocations').addItem('查看表格变化','WTCLoad_openTableChanges').addItem('查看预报汇总','WTCLoad_openTableForecast').addItem('查看作业状态','WTCLoad_openTableWork').addItem('查看读取问题','WTCLoad_openTableIssues').addItem('查看收工快照','WTCLoad_openTableCloses').addItem('查看收工差异','WTCLoad_openTableCloseDiff').addSeparator().addItem('暂停读取','WTCLoad_pauseForMaintenance').addItem('恢复读取','WTCLoad_resumeAfterMaintenance').addToUi(); }
  function showPortal() { SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutput(WTCLoad_tablePortalHtml()).setTitle('库位表工作台')); }
  function legacyNotice() { return {ok:false,blocked:true,message:'已切换为直接读取库位表。请修改原表后刷新；旧照片、回单、装车和移库提交只保留历史，不再增减新库存。'}; }
  return {version:VERSION,enabled:enabled,upgrade:upgrade,sync:sync,status:status,menu:menu,showPortal:showPortal,closeDay:closeDay,open:open,legacyNotice:legacyNotice,pause:pause,resume:resume,onEdit:onEdit,_test:{decodeState:decodeState,inventoryRows:inventoryRows,auxiliaryRows:auxiliaryRows,events:events,allowedBatch:allowedBatch,readSource:readSource,validDay:validDay,T:T,H:H}};
}());
function WTCLoad_tableActionSummary_(result) { var p=result.portal||result,s=p.summary||{};console.log(JSON.stringify({ok:!!result.ok,version:WTCTableMode.version,mode:WTCTableMode.enabled()?'table':'legacy',paused:p.paused==null?WTCLoad.photoBridge().paused():p.paused,stateVersion:p.stateVersion==null?result.version:p.stateVersion,lastReadAt:p.lastReadAt||'',knownP:s.knownP==null?s.totalKnownP:s.knownP,unknownLocationCount:s.unknownLocationCount,message:result.message||''}));return result; }
function WTCLoad_upgradeProjectV17() { return WTCLoad_tableActionSummary_(WTCTableMode.upgrade()); }
function WTCLoad_showTablePortal() { return WTCTableMode.showPortal(); }
function WTCLoad_getTablePortal() { return WTCTableMode.status(); }
function WTCLoad_syncTableInventory() { return WTCLoad_tableActionSummary_(WTCTableMode.sync(true)); }
function WTCLoad_saveTableClose(input) { return WTCTableMode.closeDay(input); }
function WTCLoad_openTableSource() { return WTCTableMode.open('source'); }
function WTCLoad_openCurrentLocations() { return WTCTableMode.open('stock'); }
function WTCLoad_openTableChanges() { return WTCTableMode.open('changes'); }
function WTCLoad_openTableIssues() { return WTCTableMode.open('issues'); }
function WTCLoad_openTableCloses() { return WTCTableMode.open('closes'); }
function WTCLoad_openTableCloseDiff() { return WTCTableMode.open('closeDiff'); }
function WTCLoad_openTableForecast() { return WTCTableMode.open('forecast'); }
function WTCLoad_openTableWork() { return WTCTableMode.open('work'); }
