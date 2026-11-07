/* v1.7 auxiliary table reads. Planning and job states never modify physical stock. */
var WTCTableSources = (function () {
  'use strict';
  var VERSION = '1.7.0';
  function mapSpreadsheetId(options) {
    var value=text(options.unloadSourceId);
    if(!value && typeof PropertiesService!=='undefined') value=text(PropertiesService.getScriptProperties().getProperty('WTC_UNLOAD_SPREADSHEET_ID'));
    if(!value || /^(?:YOUR|REPLACE|EXAMPLE|INSERT|PASTE)[_-]/i.test(value)) throw new Error('WTC_CONFIG_MISSING: 请配置 WTC_UNLOAD_SPREADSHEET_ID 或显式传入 unloadSourceId；未读取任何默认外部表。');
    return value;
  }
  function text(v) { return String(v == null ? '' : v).trim(); }
  function copy(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function core() {
    if (typeof WTCForecastCore !== 'undefined') return WTCForecastCore;
    if (typeof require === 'function') return require('./forecast_engine.js');
    throw new Error('缺少表格预报规则模块。');
  }
  function issue(code, message, extra) { return Object.assign({code:code,message:message},extra || {}); }
  function errorText(e) { return text(e && e.message || e).replace(/sk-[A-Za-z0-9_-]+/g,'[已隐藏密钥]').slice(0,250); }
  function truth(v) { return v === true || /^(?:TRUE|1|是|启用|已确认)$/i.test(text(v)); }
  function dayAt(now, timezone) {
    var date = new Date(now);
    if (!Number.isFinite(date.getTime())) throw new Error('读取时间无效。');
    if (typeof Utilities !== 'undefined') return Utilities.formatDate(date,timezone,'yyyy-MM-dd');
    var parts = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date), out={};
    parts.forEach(function(p){out[p.type]=p.value;});return out.year+'-'+out.month+'-'+out.day;
  }
  function addDays(day, count) { return new Date(Date.parse(day+'T00:00:00Z') + count * 86400000).toISOString().slice(0,10); }
  function dateLabel(name, today) {
    var compact=text(name).replace(/\s+/g,'');
    if (!/^(?:20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[/.]\d{1,2}(?:[/.](?:\d{2}|20\d{2}))?|(?:20\d{2}年)?\d{1,2}月\d{1,2}日?)$/.test(compact)) return '';
    return core().parseBusinessDate(compact,today);
  }
  function metadata(book) { return book.getSheets().map(function(sh,index){return {sheet:sh,sheetId:sh.getSheetId(),title:sh.getName(),hidden:sh.isSheetHidden(),index:index};}); }
  function sheetById(book,id) { return book.getSheets().filter(function(sh){return String(sh.getSheetId())===String(id);})[0] || null; }
  function rows(sh, maxRows, maxCols) {
    var height=sh.getLastRow(),width=sh.getLastColumn();
    if(height>maxRows || width>maxCols) throw new Error('来源超过读取上限，未使用截断数据：'+sh.getName());
    return height&&width?sh.getRange(1,1,height,width).getDisplayValues():[];
  }
  function labelledTable(book,name,headers,maxRows) {
    var sh=book.getSheetByName(name);if(!sh)throw new Error('找不到来源表：'+name);
    var values=rows(sh,maxRows,40),head=values[0]||[];
    if(!headers.every(function(h,i){return text(head[i])===h;}))throw new Error(name+'表头变化，未猜测字段。');
    return values.slice(1);
  }
  function sourceRef(bookId,title,range) { return {spreadsheetId:bookId,sheetName:title,range:range}; }
  function section(ok,data,issues,observedAt,prior) {
    return {ok:!!ok,complete:!!ok,stale:!ok,checkedAt:observedAt,lastSuccessAt:ok?observedAt:(prior&&prior.lastSuccessAt||''),data:data,issues:issues||[]};
  }
  function failed(name,error,observedAt,prior) {
    var data=copy(prior&&prior.data)||null;
    if(data)['sources','pages','selected','observations','records'].forEach(function(key){(data[key]||[]).forEach(function(row){row.stale=true;});});
    return section(false,data,[issue(name+'_READ_FAILED',errorText(error),{retainedPrevious:!!(prior&&prior.data)})],observedAt,prior);
  }
  function readAliases(book) {
    return labelledTable(book,'WTC柜号关联',['原标识','完整柜号','船公司','启用','说明'],1200).filter(function(row){return truth(row[3]);}).map(function(row){return {rawId:text(row[0]),containerNo:text(row[1]),carrier:text(row[2]),enabled:true,confirmed:true};});
  }
  function forecastSpecs(book, today) {
    var configured=labelledTable(book,'WTC预报来源',['来源表ID','来源页ID','来源页名称','类型','业务日期','启用','说明'],600), id=text(book.getId()), available=metadata(book), byId={}, specs={}, disabled={}, problems=[];
    available.forEach(function(s){byId[String(s.sheetId)]=s;});
    configured.forEach(function(row,index){
      if(!row.some(function(x){return text(x);}))return;
      var sourceBook=text(row[0])||id,sheetId=text(row[1]),key=sourceBook+':'+sheetId;
      if(!truth(row[5])){disabled[key]=true;return;}
      var kind=({'日':'daily','周':'weekly','月':'monthly'})[text(row[3])]||text(row[3]).toLowerCase();
      if(!sheetId||!text(row[2])||! /^(daily|weekly|monthly)$/.test(kind)){problems.push(issue('FORECAST_SOURCE_CONFIG','预报来源缺少页ID、名称或日周月类型。',{row:index+2}));return;}
      if(specs[key]){problems.push(issue('FORECAST_CONFIG_DUPLICATE','同一来源被重复配置，未重复读取。',{sourceId:key}));return;}
      specs[key]={spreadsheetId:sourceBook,sheetId:sheetId,title:sourceBook===id&&byId[sheetId]?byId[sheetId].title:text(row[2]),kind:kind,businessDate:text(row[4]),configured:true};
    });
    var start=addDays(today,-14),end=addDays(today,45);
    available.forEach(function(s){
      var key=id+':'+s.sheetId;if(s.hidden||specs[key]||disabled[key]||!/拆柜预报|拆櫃預報/.test(s.title))return;
      var kind=/周|週/.test(s.title)?'weekly':/^\s*(?:20\d{2}年)?\d{1,2}月/.test(s.title)?'monthly':'daily';
      var period=core().parseForecast({title:s.title,kind:kind,anchorDate:today,values:[]});
      if(!period.businessDate||period.period.end<start||period.businessDate>end)return;
      specs[key]={spreadsheetId:id,sheetId:String(s.sheetId),title:s.title,kind:kind,businessDate:'',configured:false};
    });
    var result=Object.keys(specs).sort().map(function(k){return specs[k];});
    if(result.length>20)throw new Error('启用预报来源超过20页，保留旧快照；需缩小启用来源。');
    return {specs:result,issues:problems,coverage:{configuredAndRecentAutoDiscovery:true,autoDiscoveryStart:start,autoDiscoveryEnd:end,autoDiscoveryNames:'可见页，页名含拆柜预报/拆櫃預報且可识别日、周或月日期',configuredDates:'按启用配置保留，不因自动发现窗口而删除',sourceCount:result.length,maxSources:20,maxRowsPerSource:500,maxColumnsPerSource:120}};
  }
  function readForecast(options, book, today, observedAt, aliases, aliasProblems, prior) {
    var planned=forecastSpecs(book,today), problems=planned.issues.concat(aliasProblems), sources=[], seeds=[], oldSources={}, cache={};
    cache[text(book.getId())]=book;(prior&&prior.data&&prior.data.sources||[]).forEach(function(s){oldSources[s.sourceId]=s;});
    var open=options.openBook||function(id){return SpreadsheetApp.openById(id);};
    planned.specs.forEach(function(spec){
      var id=spec.spreadsheetId+':'+spec.sheetId,previous=oldSources[id],source;
      try{
        var sourceBook=cache[spec.spreadsheetId]||(cache[spec.spreadsheetId]=open(spec.spreadsheetId));
        var sh=sheetById(sourceBook,spec.sheetId);if(!sh)throw new Error('预报来源页ID已不存在：'+spec.sheetId);
        var values=rows(sh,500,120);
        source=core().parseForecast({sourceId:id,sheetId:spec.sheetId,title:sh.getName(),kind:spec.kind,businessDate:spec.businessDate,anchorDate:today,observedAt:observedAt,priorSource:previous,values:values});
        if(!source.valid)throw new Error((source.issues||[]).map(function(i){return i.message;}).join('；')||'预报格式不完整。');
        var invalidColumns=0;
        source.columns=source.columns.map(function(column){
          if(column.valid){column.stale=false;column.observedAt=observedAt;column.lastSuccessAt=observedAt;return column;}invalidColumns++;
          var candidates=((previous&&previous.columns)||[]).filter(function(old){return core().normalizeId(old.rawId)===core().normalizeId(column.rawId)&&text(old.carrier)===text(column.carrier);});
          var problem=issue('FORECAST_COLUMN_INVALID',column.issues.map(function(i){return i.message;}).join('；'),{sourceId:id,rawId:column.rawId,sourceColumn:column.sourceColumn,retainedPrevious:candidates.length===1});problems.push(problem);
          if(candidates.length===1){var saved=copy(candidates[0]);saved.sourceColumn=column.sourceColumn;saved.valid=false;saved.stale=true;saved.lastSuccessAt=saved.lastSuccessAt||(candidates[0].valid!==false&&(previous.lastSuccessAt||previous.observedAt))||'';saved.issues=column.issues.concat([problem]);saved.attemptedAt=observedAt;return saved;}
          column.stale=true;column.lastSuccessAt='';column.attemptedAt=observedAt;column.issues=column.issues.concat([problem]);return column;
        });
        source.spreadsheetId=spec.spreadsheetId;source.nativeSheetId=spec.sheetId;source.stale=false;source.partial=invalidColumns>0;source.sourceRef=sourceRef(spec.spreadsheetId,sh.getName(),'A1:'+columnLetter(sh.getLastColumn())+sh.getLastRow());
        source.rawValues=values;source.lastSuccessAt=observedAt;
      }catch(error){
        var problem=issue('FORECAST_SOURCE_READ',errorText(error),{sourceId:id,retainedPrevious:!!previous});problems.push(problem);
        source=previous?copy(previous):source||core().parseForecast({sourceId:id,sheetId:spec.sheetId,title:spec.title,kind:spec.kind,businessDate:spec.businessDate,anchorDate:today,observedAt:observedAt,values:[]});
        source.valid=false;source.stale=true;source.attemptedAt=observedAt;source.issues=(source.issues||[]).concat([problem]);source.spreadsheetId=spec.spreadsheetId;source.nativeSheetId=spec.sheetId;
      }
      (source.columns||[]).forEach(function(c){var full=core().normalizeContainer(c.rawId);if(full)seeds.push({containerNo:full,carrier:c.carrier});});sources.push(source);
    });
    if(!planned.specs.length)problems.push(issue('FORECAST_NO_SOURCES','没有启用或可识别的日周月预报来源；不能认为待到货为0。'));
    var registry=core().buildRegistry({mappings:aliases,seeds:seeds});problems=problems.concat(registry.issues||[]);
    var result=core().deduplicate({sources:sources,registry:registry,postedContainers:[],publishedContainers:[]});
    result.rows.forEach(function(row){row.quantityBasis='预报参考，不作实物库存';});
    return section(problems.length===0,{sources:sources,registry:registry,rows:result.rows,totals:result.totals,observations:[],coverage:planned.coverage,quantityBasis:'预报参考，不作实物库存；未以旧实拆账扣减'},problems,observedAt,prior);
  }
  function columnLetter(n){var out='';while(n){n--;out=String.fromCharCode(65+n%26)+out;n=Math.floor(n/26);}return out;}
  function forecastRowTimes(result,sources){
    (result.rows||[]).forEach(function(row){
      var source=(sources||[]).filter(function(s){return s.sourceId===row.selectedSourceId;})[0]||{},chosen=(row.provenance||[])[0]||{},column=(source.columns||[]).filter(function(c){return c.sourceColumn===chosen.sourceColumn;})[0]||{};
      row.stale=!!source.stale||!!column.stale||row.valid===false;
      row.lastSuccessAt=column.lastSuccessAt||(!row.stale?source.lastSuccessAt:'')||'';
      row.attemptedAt=column.attemptedAt||source.attemptedAt||source.observedAt||'';
    });
  }
  function chooseMapSheets(sheets,today,options) {
    options=options||{};var past=Math.max(0,Math.min(31,Number(options.lookbackDays==null?7:options.lookbackDays))),future=Math.max(0,Math.min(31,Number(options.futureDays==null?7:options.futureDays))),max=Math.max(1,Math.min(30,Number(options.maxMapSheets)||20)),start=addDays(today,-past),end=addDays(today,future),candidates=[],byDay={};
    sheets.forEach(function(s){if(s.hidden)return;var day=dateLabel(s.title,today);if(!day||day<start||day>end)return;var entry=Object.assign({},s,{businessDate:day});if(!byDay[day])byDay[day]=[];byDay[day].push(entry);});
    Object.keys(byDay).forEach(function(day){var group=byDay[day],visible=group.filter(function(s){return !s.hidden;});candidates=candidates.concat(visible.length?visible:group);});
    candidates.sort(function(a,b){return Math.abs(Date.parse(a.businessDate)-Date.parse(today))-Math.abs(Date.parse(b.businessDate)-Date.parse(today))||text(b.businessDate).localeCompare(text(a.businessDate))||a.index-b.index;});
    return {selected:candidates.slice(0,max),omitted:candidates.slice(max).map(function(s){return {sheetId:s.sheetId,title:s.title,businessDate:s.businessDate};}),coverage:{start:start,end:end,lookbackDays:past,futureDays:future,maxPages:max,selectedPages:Math.min(candidates.length,max),omittedPages:Math.max(0,candidates.length-max),hiddenPagesExcluded:sheets.filter(function(s){return s.hidden;}).length,hiddenPageRule:'隐藏页视为历史档案，不将无年份页名套用为今年日期',historicalPagesOutsideWindow:'未逐页读取；窗口之外不报告已完成或已清零'}};
  }
  function mapFieldRows(values) {
    var fields={},labels={'台口':'dock','开始时间':'startTime','開始時間':'startTime','结束时间':'endTime','結束時間':'endTime','提柜日期':'pickupDate','提櫃日期':'pickupDate'};
    values.slice(0,20).forEach(function(row,index){var key=text(row[0]).replace(/[:：\s]/g,''),field=labels[key];if(field&&fields[field]===undefined)fields[field]=index;});return fields;
  }
  function readUnload(options,book,today,observedAt,registry,prior) {
    var mapId=mapSpreadsheetId(options),open=options.openBook||function(id){return SpreadsheetApp.openById(id);},mapBook=open(mapId),chosen=chooseMapSheets(metadata(mapBook),today,options),pages=[],observations=[],problems=[],old={};
    (prior&&prior.data&&prior.data.pages||[]).forEach(function(p){old[String(p.sheetId)]=p;});
    chosen.selected.forEach(function(spec){
      var page,values;
      try{
        var width=spec.sheet.getLastColumn();if(width>80)throw new Error('地图超过80列读取上限。');
        values=spec.sheet.getRange(1,1,Math.min(20,spec.sheet.getMaxRows()),Math.max(1,width)).getDisplayValues();
        var parsed=core().discoverMap({values:values,title:spec.title,sheetId:spec.sheetId,businessDate:spec.businessDate,anchorDate:today});if(!parsed.valid)throw new Error(parsed.issues.map(function(i){return i.message;}).join('；'));
        var fields=mapFieldRows(values);
        parsed.observations.forEach(function(r){Object.keys(fields).forEach(function(k){r[k]=text((values[fields[k]]||[])[r.sourceColumn-1]);});r.sourceRef=sourceRef(mapId,spec.title,columnLetter(r.sourceColumn)+'1:'+columnLetter(r.sourceColumn)+'20');r.observedAt=observedAt;r.stale=false;});
        page={sheetId:spec.sheetId,title:spec.title,businessDate:spec.businessDate,stale:false,lastSuccessAt:observedAt,observations:parsed.observations,rawValues:values};
      }catch(error){
        var previous=old[String(spec.sheetId)],problem=issue('UNLOAD_PAGE_READ',errorText(error),{sheetId:spec.sheetId,title:spec.title,retainedPrevious:!!previous});problems.push(problem);
        page=previous?copy(previous):{sheetId:spec.sheetId,title:spec.title,businessDate:spec.businessDate,observations:[]};page.stale=true;page.attemptedAt=observedAt;if(values)page.attemptedRawValues=values;
        page.observations.forEach(function(r){r.stale=true;r.valid=false;r.issues=(r.issues||[]).concat([problem]);});
      }
      pages.push(page);observations=observations.concat(page.observations||[]);
    });
    if(!pages.length)problems.push(issue('UNLOAD_NO_PAGES','近期窗口内未找到日期地图页；不能认为没有海柜。',{coverage:chosen.coverage}));
    if(chosen.omitted.length)problems.push(issue('UNLOAD_PAGE_LIMIT','地图页超过窗口读取上限，覆盖范围不完整。',{omitted:chosen.omitted}));
    var selected=core().selectObservations(observations,registry), current={}, retained=[], maxPending=100;
    function observationKey(r){return r.containerNo?'CONTAINER|'+r.containerNo:'RAW|'+core().normalizeId(r.rawId);}
    selected.forEach(function(r){current[observationKey(r)]=true;if(r.conflict||(r.valid===false&&!r.stale))problems.push(issue('UNLOAD_RECORD_CONFLICT','拆柜状态冲突或无法识别，保留来源待核对。',{containerNo:r.containerNo||'',rawId:r.rawId,sourceTab:r.sourceTab}));});
    // Keep an explicit bounded queue for unfinished jobs that disappear or age out of the read window.
    // These are old evidence, not fresh map observations; no extra historical page reads are made.
    ((prior&&prior.data&&prior.data.selected)||[]).forEach(function(r){
      var key=observationKey(r), originalStatus=r.lastObservedStatus||r.status;
      if(current[key]||originalStatus==='拆空')return;
      current[key]=true;
      var saved=copy(r);delete saved.sourceObservations;
      saved.lastObservedStatus=originalStatus;saved.status='未重新读取·原状态：'+originalStatus;
      saved.stale=true;saved.valid=false;saved.eligible=false;saved.retainedPending=true;
      saved.issues=(saved.issues||[]).filter(function(i){return i.code!=='UNLOAD_PENDING_RETAINED';}).slice(0,10).concat([issue('UNLOAD_PENDING_RETAINED','此前未完成柜已不在本次有效读取结果中，保留旧记录待核对。')]);
      retained.push(saved);
    });
    retained.sort(function(a,b){return text(b.businessDate).localeCompare(text(a.businessDate))||observationKey(a).localeCompare(observationKey(b));});
    if(retained.length){
      problems.push(issue('UNLOAD_PENDING_RETAINED','保留了未重新读取的历史未完成柜，状态未当作最新结果。',{retainedCount:Math.min(retained.length,maxPending),omittedCount:Math.max(0,retained.length-maxPending)}));
      selected=selected.concat(retained.slice(0,maxPending));observations=observations.concat(retained.slice(0,maxPending));
    }
    chosen.coverage.maxRetainedPending=maxPending;chosen.coverage.retainedPending=Math.min(retained.length,maxPending);chosen.coverage.omittedPending=Math.max(0,retained.length-maxPending);chosen.coverage.retainedPendingRule='仅保留历史未完成摘要，标记过期；窗口之外未重新读取';
    return section(problems.length===0,{pages:pages,observations:observations,selected:selected,coverage:chosen.coverage,sourceSpreadsheetId:mapId,quantityBasis:'拆柜状态仅供对照，不自动增加库存'},problems,observedAt,prior);
  }
  function normalizeInfo(value){return text(value).toUpperCase().replace(/\s+/g,' ');}
  function loadingDateValue(value,timezone) {
    if(Object.prototype.toString.call(value)==='[object Date]')return dayAt(value,timezone||'America/New_York');
    // Unformatted numeric dates are Sheets serial days. Fractions below 1 are times, not dates.
    if(typeof value==='number'&&value>=36526&&value<73051)return new Date(Date.UTC(1899,11,30)+Math.floor(value)*86400000).toISOString().slice(0,10);
    return text(value);
  }
  function parseLoadingRows(args) {
    args=args||{};var values=args.values||[],today=args.today,start=addDays(today,-Math.max(0,Math.min(31,Number(args.lookbackDays==null?7:args.lookbackDays)))),end=addDays(today,Math.max(0,Math.min(31,Number(args.futureDays==null?7:args.futureDays)))),currentDay='',records=[],groups={},problems=[];
    values.forEach(function(row,index){
      var dateValue=loadingDateValue(row.date,args.timezone);if(dateValue){var d=core().parseBusinessDate(dateValue,today);currentDay=d||'';if(!d&&text(row.info))problems.push(issue('LOADING_DATE','日期列中不是有效日期，保留原记录待核对。',{sourceRow:row.sourceRow||index+2,rawValue:dateValue}));}
      var info=text(row.info),reference=text(row.reference),status=text(row.status);if(!info&&!reference)return;
      if(currentDay&&(currentDay<start||currentDay>end))return;
      var dispatch=[],match,pattern=/#\s*([A-Z0-9]+(?:-[A-Z0-9]+)*)/ig;while((match=pattern.exec(info)))if(dispatch.indexOf(match[1].toUpperCase())<0)dispatch.push(match[1].toUpperCase());dispatch.sort();
      var id=text(row.taskId),basis=id?'任务编号':dispatch.length?'调度参考号':reference?'柜/车参考号':'装车描述（临时关联）',key=id?'TASK|'+id:dispatch.length?'DISPATCH|'+dispatch.join('|'):reference?'REFERENCE|'+normalizeInfo(reference):'DESCRIPTION|'+normalizeInfo(info);
      var record={key:key,identityBasis:basis,identityCertain:!!id,businessDate:currentDay,reference:reference,dispatchReferences:dispatch,info:info,loadType:text(row.loadType),dock:text(row.dock),status:status,pickedUp:text(row.pickedUp),sourceRows:[row.sourceRow||index+2],sourceRefs:[sourceRef(args.spreadsheetId,args.sheetName||'NJ装车接龙','A'+(row.sourceRow||index+2)+':J'+(row.sourceRow||index+2))],issues:[],quantityBasis:'作业状态参考；未根据状态或描述数字增减库存'};
      if(!currentDay)record.issues.push(issue('LOADING_DATE_UNKNOWN','所属日期未明确，保留原记录待核对。'));
      if(!id)record.issues.push(issue('LOADING_ID_PROVISIONAL','按现有参考标识暂时关联；描述变化不认定新实物操作。'));
      if(!groups[key])groups[key]=[];groups[key].push(record);
    });
    Object.keys(groups).sort().forEach(function(key){
      var group=groups[key],signatures={};group.forEach(function(record){var sig=core().stable({info:normalizeInfo(record.info),reference:normalizeInfo(record.reference),status:record.status,dock:record.dock,pickedUp:record.pickedUp});if(!signatures[sig])signatures[sig]=record;else{signatures[sig].sourceRows=signatures[sig].sourceRows.concat(record.sourceRows);signatures[sig].sourceRefs=signatures[sig].sourceRefs.concat(record.sourceRefs);signatures[sig].businessDates=(signatures[sig].businessDates||[signatures[sig].businessDate]).concat([record.businessDate]).filter(function(v,i,a){return a.indexOf(v)===i;});}});
      var distinct=Object.keys(signatures).map(function(s){return signatures[s];});if(distinct.length>1){var conflict=issue('LOADING_REFERENCE_CONFLICT','同一参考标识有不同内容或状态，保留各条参考，不推断多次装车。',{key:key});problems.push(conflict);distinct.forEach(function(r){r.issues.push(conflict);r.identityCertain=false;});}records=records.concat(distinct);
    });
    return {records:records,issues:problems,coverage:{start:start,end:end,readRows:values.length,undatedIncluded:true},quantityBasis:'装车状态只作对照，实际库存以手改库位表为准'};
  }
  function readLoading(options,book,today,observedAt,prior) {
    var sh=book.getSheetByName('NJ装车接龙');if(!sh)throw new Error('找不到NJ装车接龙。');var height=sh.getLastRow(),width=sh.getLastColumn();if(height>15000||width>100)throw new Error('装车接龙超过读取上限，未使用截断数据。');
    var header=height?sh.getRange(1,1,1,width).getDisplayValues()[0]:[],columns={},names={date:'日期',loadType:'Load 状态',pickedUp:'预装柜是否已提',dock:'台口',status:'状态',taskId:'_WTC任务ID'};
    Object.keys(names).forEach(function(k){var matches=[];header.forEach(function(v,i){if(text(v)===names[k])matches.push(i+1);});if(matches.length>1)throw new Error('装车表头重复：'+names[k]);if(matches.length)columns[k]=matches[0];});
    var infoMatches=[];header.forEach(function(v,i){if(/^装车信息/.test(text(v)))infoMatches.push(i+1);});if(infoMatches.length!==1)throw new Error('装车信息表头无法唯一识别。');columns.info=infoMatches[0];
    if(!columns.date||!columns.status||!columns.dock)throw new Error('装车日期、状态或台口表头缺失。');
    // Column F is the existing reference column. Its current header is a destination name, not a stable field label.
    columns.reference=6;
    if(Object.keys(columns).some(function(k){return columns[k]===4;}))throw new Error('识别字段落在司机信息列D，未读取个人信息。');
    var byField={};Object.keys(columns).forEach(function(k){byField[k]=height>1?(k==='date'?sh.getRange(2,columns[k],height-1,1).getValues():sh.getRange(2,columns[k],height-1,1).getDisplayValues()):[];});
    var values=[];for(var n=0;n<Math.max(0,height-1);n++){var row={sourceRow:n+2};Object.keys(columns).forEach(function(k){row[k]=(byField[k][n]||[])[0]||'';});values.push(row);}
    var data=parseLoadingRows({values:values,today:today,timezone:options.timezone||'America/New_York',lookbackDays:options.lookbackDays,futureDays:options.futureDays,spreadsheetId:book.getId(),sheetName:sh.getName()});data.coverage.sourceLastRow=height;data.coverage.columnsRead=columns;data.coverage.dateYearRule='读取原生日期年份，日期显示省略年份时也不重设为今年';data.sourceSheetId=sh.getSheetId();
    return section(true,data,data.issues,observedAt,prior);
  }
  function locateIssues(name,value) {
    var data=value.data||{};
    value.issues=(value.issues||[]).map(function(original){
      var i=Object.assign({},original),source='',object=i.rawId||i.containerNo||i.key||'',cells=[];
      if(name==='forecast'){
        var match=(data.sources||[]).filter(function(s){return s.sourceId===i.sourceId;})[0];
        source=i.code==='ALIAS_READ_FAILED'?'WTC柜号关联':match?match.title:'WTC预报来源';
        if(i.sourceColumn)cells=[source+'!'+columnLetter(i.sourceColumn)+'1:'+columnLetter(i.sourceColumn)+(match&&match.rawValues&&match.rawValues.length||500)];
        else if(i.row)cells=[source+'!A'+i.row+':G'+i.row];else if(match&&match.sourceRef)cells=[source+'!'+match.sourceRef.range];
      }else if(name==='unload'){
        source='拆柜地图';object=object||i.title||i.sourceTab||'读取覆盖范围';
        if(i.title||i.sourceTab)cells=[(i.title||i.sourceTab)+'!A1:CB20'];
      }else{
        source='NJ装车接龙';object=object||(i.sourceRow?'第'+i.sourceRow+'行':'读取范围');
        if(i.sourceRow)cells=[source+'!A'+i.sourceRow];
        else if(i.key){(data.records||[]).filter(function(r){return r.key===i.key;}).forEach(function(r){(r.sourceRows||[]).forEach(function(n){cells.push(source+'!E'+n+':J'+n);});});}
      }
      i.source=i.source||source;i.object=i.object||object;i.sourceCells=i.sourceCells||cells;return i;
    });
    if(name==='loading'&&value.data)value.data.issues=value.issues;
    return value;
  }
  function read(options) {
    options=options||{};var book=options.book;if(!book)throw new Error('必须提供主数据表。');var observedAt=new Date(options.now||new Date()).toISOString(),timezone=options.timezone||'America/New_York',today=dayAt(observedAt,timezone),prior=options.prior||{},aliases=[],aliasProblems=[];
    try{aliases=readAliases(book);}catch(error){aliasProblems=[issue('ALIAS_READ_FAILED',errorText(error))];}
    var forecast,unload,loading,registry=core().buildRegistry({mappings:aliases});
    try{forecast=readForecast(options,book,today,observedAt,aliases,aliasProblems,prior.forecast);registry=forecast.data.registry;}catch(error){forecast=failed('FORECAST',error,observedAt,prior.forecast);}
    try{unload=readUnload(options,book,today,observedAt,registry,prior.unload);}catch(error){unload=failed('UNLOAD',error,observedAt,prior.unload);}
    try{loading=readLoading(options,book,today,observedAt,prior.loading);}catch(error){loading=failed('LOADING',error,observedAt,prior.loading);}
    // Attach current map observations only when available. No old receipt, publication or inventory ledger is consulted.
    if(forecast.data&&forecast.data.sources&&forecast.data.registry){var result=core().deduplicate({sources:forecast.data.sources,registry:forecast.data.registry,observations:unload.data&&unload.data.observations||[],postedContainers:[],publishedContainers:[]});forecastRowTimes(result,forecast.data.sources);forecast.data.rows=result.rows;forecast.data.totals=result.totals;forecast.data.observations=result.observations;forecast.data.rows.forEach(function(r){r.quantityBasis='预报参考，不作实物库存';});}
    locateIssues('forecast',forecast);locateIssues('unload',unload);locateIssues('loading',loading);
    return {version:VERSION,observedAt:observedAt,businessDate:today,timezone:timezone,forecast:forecast,unload:unload,loading:loading,issues:[].concat(forecast.issues||[],unload.issues||[],loading.issues||[]),physicalInventoryUnchanged:true};
  }
  return {VERSION:VERSION,read:read,chooseMapSheets:chooseMapSheets,parseLoadingRows:parseLoadingRows,dayAt:dayAt};
}());
if(typeof module!=='undefined'&&module.exports)module.exports=WTCTableSources;
