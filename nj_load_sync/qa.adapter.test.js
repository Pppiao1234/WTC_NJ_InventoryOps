'use strict';
// Independent QA: in-memory Apps Script/Sheets/OpenAI doubles; makes no network calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const Core = require('./engine.js');

function harness(options={}) {
  const sheets = new Map();
  let seq=1, aiCalls=0, commitCalls=0, failOnce=true;
  class Range {
    constructor(s,r,c,n=1,m=1){Object.assign(this,{s,r,c,n,m});}
    getValues(){return Array.from({length:this.n},(_,i)=>Array.from({length:this.m},(_,j)=>this.s.data[this.r+i-1]?.[this.c+j-1]??''));}
    getDisplayValues(){return this.getValues().map(r=>r.map(v=>String(v??'')));}
    getValue(){return this.getValues()[0][0];}
    getRow(){return this.r;} getColumn(){return this.c;} getNumRows(){return this.n;} getNumColumns(){return this.m;} getSheet(){return this.s;}
    setValues(vals){vals.forEach((r,i)=>r.forEach((v,j)=>this.s.set(this.r+i,this.c+j,v)));return this;}
    setValue(v){return this.setValues([[v]]);}
  }
  class Sheet {
    constructor(name,data=[]){this.name=name;this.id=seq++;this.data=data;this.maxRows=1000;this.maxColumns=49;sheets.set(name,this);}
    set(r,c,v){this.data[r-1]??=[];this.data[r-1][c-1]=v;}
    getRange(...a){return new Range(this,...a);}
    getDataRange(){return this.getRange(1,1,Math.max(1,this.getLastRow()),Math.max(1,this.getLastColumn()));}
    getLastRow(){let n=this.data.length;while(n>0&&!(this.data[n-1]||[]).some(v=>v!==''&&v!=null))n--;return n;}
    getLastColumn(){return Math.max(0,...this.data.map(r=>r.length));}
    getMaxColumns(){return this.maxColumns;} getMaxRows(){return this.maxRows;}
    getSheetId(){return this.id;} getName(){return this.name;}
  }
  const source=new Sheet('NJ装车接龙',[Array(25).fill(''),Array(25).fill('')]);
  [['日期',1],['装车信息',5],['关联标识',6],['台口',9],['状态',10]].forEach(([v,c])=>source.set(1,c,v));
  [['预计出库',20],['实际累计出库',21],['库位处理结果',23],['最近处理时间',24],['_WTC任务ID',25]].forEach(([v,c])=>source.set(1,c,v));
  source.set(2,1,'10/30');source.set(2,5,'MGE1/CLT2');source.set(2,6,'ref');source.set(2,9,'6');source.set(2,10,options.status||'已结束');
  source.set(2,20,options.planned??'C1:8');source.set(2,21,options.actual??'C1:6');source.set(2,25,options.noId?'':'task-1');
  new Sheet('_WTC设置',[['键','值','说明'],['AI_MODEL','qa-model'],['MAX_JOBS_PER_TICK','2'],['BASELINE_ASOF','2026-10-30T00:00:00-04:00'],['BASELINE_SOURCE_VERSION','qa-baseline'],['BASELINE_TASK_OFFSETS_JSON','{}']]);
  for(const name of ['_WTC库位基准','_WTC实时库存','_WTC任务流水','_WTC同步日志','WTC同步状态'])new Sheet(name,[['header']]);
  const stateSheet=new Sheet('_WTC状态');
  const initial={schemaVersion:1,version:1,inventoryVersion:1,baseline:{confirmed:options.baseline!==false,version:'BASE-QA',asOf:'2026-10-30T00:00:00-04:00',sourceVersion:'qa',appliedTasks:{}},inventory:[{inventoryId:'i1',location:'C1',destination:'TEB4',shipmentId:'01003',physicalP:20,occupiedSlots:20,slotBasis:'one_per_pallet',capacitySlots:27}],tasks:options.noId?{}:{'task-1':{registration:{status:'confirmed',method:'fixture'}}},lastCheckedAt:'',lastCommittedAt:'',lastError:''};
  function writeState(st){const text=JSON.stringify(st),chunks=text.match(/[\s\S]{1,42000}/g);stateSheet.data=[['schemaVersion',1],['stateVersion',st.version],['chunkCount',chunks.length],['checkpointTime','qa'],['stateHash',crypto.createHash('sha256').update(text).digest('hex')],[],[],...chunks.map(c=>[null,c])];}
  function readState(){return JSON.parse(stateSheet.data.slice(7,7+Number(stateSheet.data[2][1])).map(r=>r[1]??'').join(''));}
  writeState(initial);
  const cachedStateData=structuredClone(stateSheet.data);
  const realGetValues=Range.prototype.getValues;
  Range.prototype.getValues=function(){if(options.staleGasState&&this.s===stateSheet)return Array.from({length:this.n},(_,i)=>Array.from({length:this.m},(_,j)=>cachedStateData[this.r+i-1]?.[this.c+j-1]??''));return realGetValues.call(this);};
  const userProps=new Map([['WTC_LOAD_INSTALLER_ID',options.owner===false?'another-editor':'owner-marker']]);if(options.api!==false&&options.owner!==false)userProps.set('WTC_OPENAI_KEY','qa-key-never-network');
  const scriptProps=new Map([['WTC_MAIN_SPREADSHEET_ID','PUBLIC_TEST_MAIN_SPREADSHEET_001'],['WTC_UNLOAD_SPREADSHEET_ID','PUBLIC_TEST_UNLOAD_SPREADSHEET_001'],['WTC_LOCATION_SHEET_ID','101'],['WTC_LEGACY_UNLOAD_TASKS_JSON',JSON.stringify(require('./fixtures/synthetic_unload.js').seeds)],['WTC_LEGACY_UNLOAD_SOURCE_TAB','10/30'],['WTC_LOAD_OWNER_MARKER','owner-marker'],['WTC_LOAD_API_READY',String(options.api!==false)]]);
  const props=m=>({getProperty:k=>m.get(k)||null,setProperty:(k,v)=>{m.set(k,v);return props(m);}});
  const response=(code,body)=>({getResponseCode:()=>code,getContentText:()=>JSON.stringify(body)});
  const book={getSheetByName:n=>sheets.get(n),toast:()=>{}};
  function restValues(fullRange,formatted) {
    const split=fullRange.lastIndexOf('!');
    const name=fullRange.slice(0,split).replace(/^'|'$/g,'').replace(/''/g,"'");
    const a1=fullRange.slice(split+1),s=sheets.get(name);assert.ok(s,'Unknown mocked sheet '+name);
    const col=n=>[...n].reduce((a,c)=>a*26+c.charCodeAt(0)-64,0);
    let r=1,c=1,n=1,m=s.getLastColumn();
    if(a1!=='1:1'){
      const z=/^([A-Z]+)(\d+):([A-Z]+)(\d*)$/.exec(a1);assert.ok(z,'Unsupported mocked A1 '+a1);
      c=col(z[1]);r=Number(z[2]);m=col(z[3])-c+1;n=(z[4]?Number(z[4]):Math.max(r,s.getLastRow()))-r+1;
    }
    const rows=Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>{const v=s.data[r+i-1]?.[c+j-1]??'';return formatted?String(v):v;}));
    rows.forEach(row=>{while(row.length&&(row.at(-1)===''||row.at(-1)==null))row.pop();});
    while(rows.length&&!rows.at(-1).length)rows.pop();
    return {range:fullRange,majorDimension:'ROWS',values:rows};
  }
  const context={WTCLoadCore:Core,Date,JSON,console,
    SpreadsheetApp:{openById:()=>book,getActiveRange:()=>source.getRange(2,1),getActiveSpreadsheet:()=>book,getUi:()=>({ButtonSet:{OK_CANCEL:'OK_CANCEL'},Button:{OK:'OK'},prompt:()=>({getSelectedButton:()=> 'OK',getResponseText:()=>options.correctionReason??'QA现场核实后修正累计'})})},
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},
    PropertiesService:{getUserProperties:()=>props(userProps),getScriptProperties:()=>props(scriptProps)},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_algorithm,value)=>[...crypto.createHash('sha256').update(value).digest()],formatDate:d=>d.toISOString(),getUuid:()=>`qa-uuid-${seq++}`},
    ScriptApp:{getOAuthToken:()=> 'qa-oauth-never-network'},
    UrlFetchApp:{fetch:(url,opts)=>{
      if(opts.method==='get'){
        const parsed=new URL(url);
        if(parsed.pathname.endsWith('/values:batchGet')){
          if(options.beforeBatchGet)options.beforeBatchGet({source,readState,writeState});
          return response(200,{valueRanges:parsed.searchParams.getAll('ranges').map(r=>restValues(r,parsed.searchParams.get('valueRenderOption')==='FORMATTED_VALUE'))});
        }
        const fullRange=decodeURIComponent(parsed.pathname.split('/values/')[1]);
        return response(200,restValues(fullRange,parsed.searchParams.get('valueRenderOption')==='FORMATTED_VALUE'));
      }
      const body=JSON.parse(opts.payload);
      if(url==='https://api.openai.com/v1/responses'){
        aiCalls++;const facts=JSON.parse(body.input[1].content[0].text);
        const answer={decision:options.review?'review':'approve',taskId:facts.taskId,stateVersion:facts.stateVersion,inputHash:facts.inputHash,proposalHash:facts.proposalHash,reason:'QA local approval'};
        if(options.forge)answer[options.forge]='forged';
        if(options.aiHook)options.aiHook({source,readState,writeState,facts});
        return response(200,{status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(answer)}]}]});
      }
      assert.ok(url.startsWith('https://sheets.googleapis.com/'),'Unexpected mocked URL');
      if(options.batchHook)options.batchHook(body);
      if(options.failMaintenance&&failOnce&&body.requests.some(r=>r.appendCells?.rows?.some(row=>row.values?.some(v=>v.userEnteredValue?.stringValue==='MAINTENANCE_ARCHIVE')))){failOnce=false;return response(503,{error:'QA maintenance batch failure'});}
      if(options.failRegistration&&failOnce&&body.requests.some(r=>r.updateCells?.range.sheetId===stateSheet.id&&r.updateCells.rows.some(row=>row.values.some(v=>String(v.userEnteredValue?.stringValue||'').includes('"method":"explicit"'))))){failOnce=false;return response(503,{error:'QA registration batch failure'});}
      const isCommit=body.requests.some(r=>r.appendCells?.sheetId===sheets.get('_WTC任务流水').id);
      if(isCommit){commitCalls++;if(options.failCommit==='before'&&failOnce){failOnce=false;return response(503,{error:'QA commit failure'});}}
      const staged=new Map([...sheets.values()].map(s=>[s.id,structuredClone(s.data)]));
      const dimensions=new Map([...sheets.values()].map(s=>[s.id,{rows:s.maxRows,columns:s.maxColumns}]));
      function set(data,r,c,v){data[r]??=[];data[r][c]=v;}
      function decode(v){const x=v?.userEnteredValue;return x?(x.stringValue??x.numberValue??x.boolValue??''):'';}
      for(const req of body.requests){
        if(req.updateCells){const u=req.updateCells,d=staged.get(u.range.sheetId);assert.ok(d);assert.ok(u.range.endRowIndex<=dimensions.get(u.range.sheetId).rows,'Update exceeds row grid');u.rows.forEach((r,i)=>r.values.forEach((v,j)=>set(d,u.range.startRowIndex+i,u.range.startColumnIndex+j,decode(v))));}
        else if(req.appendCells){const a=req.appendCells,d=staged.get(a.sheetId);assert.ok(d);for(const r of a.rows)d.push(r.values.map(decode));dimensions.get(a.sheetId).rows=Math.max(dimensions.get(a.sheetId).rows,d.length);}
        else if(req.appendDimension){const a=req.appendDimension,d=dimensions.get(a.sheetId);d[a.dimension==='ROWS'?'rows':'columns']+=a.length;}
        else throw new Error('Unexpected mocked request '+JSON.stringify(req));
      }
      for(const s of sheets.values()){s.data=staged.get(s.id);s.maxRows=dimensions.get(s.id).rows;s.maxColumns=dimensions.get(s.id).columns;}
      if(isCommit&&options.failCommit==='after'&&failOnce){failOnce=false;throw new Error('QA response lost after atomic commit');}
      return response(200,{replies:[]});
    }}
  };
  vm.createContext(context);vm.runInContext(fs.readFileSync(__dirname+'/adapter.gs','utf8'),context,{filename:'adapter.gs'});
  return {run:()=>context.WTCLoad.sync(null,false),force:()=>context.WTCLoad.sync(2,true),correct:()=>context.WTCLoad.correction(),newTask:()=>context.WTCLoad.newTask(),confirmBaseline:()=>context.WTCLoad.confirmBaseline(),pause:()=>context.WTCLoad.pause(),resume:()=>context.WTCLoad.resume(),previewCleanup:()=>context.WTCLoad.previewCleanup(),cleanup:()=>context.WTCLoad.cleanup(),state:readState,writeState,source,sheets,counts:()=>({ai:aiCalls,commits:commitCalls})};
}

function moveInputsBeforeTime(source){
 const order=[0,1,2,3,4,5,6,7,8,9,19,20,22,23,10,11,12,13,14,15,16,17,18,21,24];
 source.data=source.data.map(row=>order.map(i=>row[i]??''));
}

test('QA no API is fail-closed and makes no AI request',()=>{const h=harness({api:false});h.run();assert.equal(h.state().inventory[0].physicalP,20);assert.equal(h.counts().ai,0);assert.equal(h.state().tasks['task-1'].pendingCode,'API_MISSING');});
test('QA no confirmed baseline never calls AI or deducts stock',()=>{const h=harness({baseline:false});h.run();assert.equal(h.state().inventory[0].physicalP,20);assert.equal(h.counts().ai,0);assert.equal(h.state().tasks['task-1'].pendingCode,'BASELINE_MISSING');});
test('QA live E free text does not defeat unique location resolution; repeat is idempotent',()=>{const h=harness();h.run();assert.equal(h.state().inventory[0].physicalP,14);assert.equal(h.counts().ai,1);h.run();assert.equal(h.state().inventory[0].physicalP,14);assert.equal(h.counts().ai,1);assert.equal(h.sheets.get('_WTC任务流水').getLastRow(),2);});
test('QA active planned release followed by finished 6 adjusts expected 8 by 2',()=>{const h=harness({status:'已开始',actual:''});h.run();assert.equal(h.state().inventory[0].physicalP,20);assert.equal(h.state().tasks['task-1'].ledger.projectedRemaining[0].releasedSlots,8);h.source.set(2,10,'已结束');h.source.set(2,21,'C1:6');h.run();assert.equal(h.state().inventory[0].physicalP,14);assert.equal(h.state().tasks['task-1'].ledger.projectedRemaining.length,0);});
for(const field of ['taskId','inputHash','proposalHash','stateVersion'])test('QA forged AI '+field+' never commits inventory',()=>{const h=harness({forge:field});h.run();assert.equal(h.state().inventory[0].physicalP,20);assert.equal(h.counts().commits,0);});
test('QA source changed during AI blocks stale commit',()=>{let once=true;const h=harness({aiHook:({source})=>{if(once){source.set(2,21,'C1:7');once=false;}}});h.run();assert.equal(h.state().inventory[0].physicalP,13);assert.equal(h.counts().commits,1);assert.equal(h.sheets.get('_WTC任务流水').getLastRow(),2);});
test('QA inventory state revision changed during AI blocks stale commit',()=>{let once=true;const h=harness({aiHook:({readState,writeState})=>{if(once){const st=readState();st.version++;st.inventoryVersion++;writeState(st);once=false;}}});h.run();assert.equal(h.state().inventory[0].physicalP,14);assert.equal(h.counts().commits,1);assert.equal(h.counts().ai,2);});
test('QA source sorting during AI relocates by UUID',()=>{let once=true;const h=harness({aiHook:({source})=>{if(once){source.data.splice(1,0,Array(25).fill(''));once=false;}}});h.run();assert.equal(h.state().inventory[0].physicalP,14);assert.equal(h.state().tasks['task-1'].sourceRow,3);assert.match(h.source.getRange(3,23).getValue(),/已处理/);assert.equal(h.source.getRange(2,23).getValue(),'');});
test('QA AI review does not repeatedly call for unchanged input',()=>{const h=harness({review:true});h.run();h.run();assert.equal(h.state().inventory[0].physicalP,20);assert.equal(h.counts().ai,1);});
test('QA atomic commit failure before applying never deducts stock',()=>{const h=harness({failCommit:'before'});h.run();assert.equal(h.state().inventory[0].physicalP,20);assert.equal(h.sheets.get('_WTC任务流水').getLastRow(),1);});
test('QA lost response after atomic commit cannot duplicate the deduction',()=>{const h=harness({failCommit:'after'});h.run();assert.equal(h.state().inventory[0].physicalP,14);h.run();assert.equal(h.state().inventory[0].physicalP,14);assert.equal(h.sheets.get('_WTC任务流水').getLastRow(),2);});
test('QA historical rows without new T/U or UUID are skipped',()=>{const h=harness({planned:'',actual:'',noId:true});h.run();assert.equal(h.counts().ai,0);assert.equal(Object.keys(h.state().tasks).length,0);assert.equal(h.state().inventory[0].physicalP,20);});
test('QA cumulative holding 8 to 12 adds only 4; status rollback keeps actual',()=>{const h=harness({status:'留台等货',actual:'C1:8'});h.run();assert.equal(h.state().inventory[0].physicalP,12);h.source.set(2,21,'C1:12');h.run();assert.equal(h.state().inventory[0].physicalP,8);h.source.set(2,10,'未到');h.source.set(2,21,'');h.run();assert.equal(h.state().inventory[0].physicalP,8);assert.equal(h.state().tasks['task-1'].ledger.actual[0].physicalP,12);});
test('QA decrease remains blocked until owner correction reason authorizes exact hash',()=>{const h=harness({status:'留台等货',actual:'C1:8'});h.run();h.source.set(2,21,'C1:6');h.run();assert.equal(h.state().inventory[0].physicalP,12);assert.equal(h.state().tasks['task-1'].pendingCode,'RULE_REVIEW');h.correct();assert.equal(h.state().inventory[0].physicalP,14);assert.equal(h.state().tasks['task-1'].ledger.actual[0].physicalP,6);assert.ok(h.sheets.get('_WTC同步日志').data.some(r=>r.includes('QA现场核实后修正累计')));});
test('QA unknown stacking records pallets but never invents released slots',()=>{const h=harness();const st=h.state();st.inventory[0].physicalP=28;st.inventory[0].occupiedSlots=27;st.inventory[0].slotBasis='unknown';h.writeState(st);h.run();assert.equal(h.state().inventory[0].physicalP,22);assert.equal(h.state().inventory[0].occupiedSlots,null);assert.equal(h.state().tasks['task-1'].ledger.actual[0].releasedSlots,null);});
test('QA different tasks cannot overbook the same source stock',()=>{const h=harness({status:'已开始',planned:'C1:12',actual:''});h.source.data.push([...h.source.data[1]]);h.source.set(3,6,'ref2');h.source.set(3,25,'task-2');const st=h.state();st.tasks['task-2']={registration:{status:'confirmed',method:'fixture'}};h.writeState(st);h.run();assert.equal(h.state().inventory[0].physicalP,20);assert.equal(h.state().tasks['task-1'].ledger.projectedRemaining[0].physicalP,12);assert.equal(h.state().tasks['task-2'].pendingCode,'RULE_REVIEW');assert.equal(h.state().tasks['task-2'].ledger,undefined);});
test('QA interleaved concurrent approvals for same source commit once',()=>{let once=true;const h=harness({aiHook:()=>{if(once){once=false;h.run();}}});h.run();assert.equal(h.state().inventory[0].physicalP,14);assert.equal(h.counts().commits,1);assert.equal(h.sheets.get('_WTC任务流水').getLastRow(),2);});
test('QA initial baseline checkpoint prevents deducting included actual again',()=>{const h=harness();const st=h.state();delete st.tasks['task-1'];st.inventory[0].physicalP=14;st.inventory[0].occupiedSlots=14;st.baseline.appliedTasks={'task-1':{taskId:'task-1',actual:[{inventoryId:'i1',location:'C1',destination:'TEB4',shipmentId:'01003',physicalP:6,releasedSlots:6}]}};h.writeState(st);h.run();assert.equal(h.state().inventory[0].physicalP,14);assert.equal(h.state().tasks['task-1'].ledger.actual[0].physicalP,6);});
test('QA non-installer manual sync cannot falsely clear global API-ready status',()=>{const h=harness({owner:false});const result=h.run();assert.equal(result.status.apiConfigured,true);assert.equal(h.state().version,1);assert.equal(h.source.getRange(2,23).getValue(),'');assert.equal(h.counts().ai,0);});
test('QA without key dashboard accurately says unconfigured',()=>{const h=harness({api:false});const result=h.run();assert.equal(result.status.apiConfigured,false);assert.ok(h.sheets.get('WTC同步状态').data.some(r=>r[0]==='AI连接'&&String(r[1]).includes('未配置')));});
test('QA inventory projection beyond default 1000 rows expands before atomic write',()=>{const h=harness({planned:'C1 TEB4:8',actual:'C1 TEB4:6'});const st=h.state();for(let i=2;i<=1201;i++)st.inventory.push({inventoryId:'i'+i,location:'C1',destination:'D'+i,physicalP:0,occupiedSlots:0,slotBasis:'one_per_pallet',capacitySlots:27});h.writeState(st);h.run();assert.equal(h.state().inventory[0].physicalP,14);assert.equal(h.sheets.get('_WTC实时库存').getLastRow(),1202);assert.ok(h.sheets.get('_WTC实时库存').getMaxRows()>=1202);});
test('QA growing append-only ledger and log retain records beyond 1000 rows',()=>{const h=harness();h.sheets.get('_WTC任务流水').data=Array.from({length:1000},()=>['previous']);h.sheets.get('_WTC同步日志').data=Array.from({length:1000},()=>['previous']);h.run();assert.equal(h.sheets.get('_WTC任务流水').getLastRow(),1001);assert.equal(h.sheets.get('_WTC同步日志').getLastRow(),1001);assert.deepEqual(h.sheets.get('_WTC同步日志').data.slice(1000).map(r=>r[1]),['OK']);assert.equal(h.state().inventory[0].physicalP,14);assert.equal(h.counts().ai,1);assert.equal(h.counts().commits,1);});
test('QA missing state chunk metadata never resets established stock',()=>{const h=harness();h.sheets.get('_WTC状态').set(3,2,0);assert.throws(()=>h.run(),/缺少分片数量/);assert.equal(h.counts().ai,0);assert.equal(h.source.getRange(2,23).getValue(),'');});
test('QA changed state bytes without matching digest are rejected',()=>{const h=harness();const s=h.sheets.get('_WTC状态');s.set(8,2,String(s.getRange(8,2).getValue()).replace('"physicalP":20','"physicalP":999'));assert.throws(()=>h.run(),/校验失败/);assert.equal(h.counts().ai,0);});
test('QA sync preserves original A:S fields and existing V data',()=>{const h=harness();h.source.set(2,22,1);const original=structuredClone(h.source.data[1].slice(0,19));h.run();assert.deepEqual(h.source.data[1].slice(0,19),original);assert.equal(h.source.getRange(2,22).getValue(),1);});
test('QA first baseline import beyond 1000 rows expands inventory grid atomically',()=>{const h=harness({baseline:false});const b=h.sheets.get('_WTC库位基准');for(let i=1;i<=1201;i++)b.data.push(['b'+i,'C1','D'+i,'000'+i,0,0,'one_per_pallet',27]);b.maxRows=1202;h.confirmBaseline();assert.equal(h.state().baseline.confirmed,true);assert.equal(h.state().inventory.length,1201);assert.equal(h.sheets.get('_WTC实时库存').getLastRow(),1202);assert.ok(h.sheets.get('_WTC实时库存').getMaxRows()>=1202);});
test('QA REST state reads ignore stale SpreadsheetApp cache over cumulative updates',()=>{const h=harness({staleGasState:true,status:'留台等货',actual:'C1:8'});h.run();h.source.set(2,21,'C1:12');h.run();assert.equal(h.state().inventory[0].physicalP,8);assert.equal(h.state().version,3);assert.equal(h.state().inventoryVersion,3);assert.equal(h.state().tasks['task-1'].ledger.actual[0].physicalP,12);assert.equal(h.counts().commits,2);});
test('QA multiple pending tasks monotonically advance state despite GAS cache',()=>{const h=harness({staleGasState:true,baseline:false});const st=h.state();for(let i=2;i<=3;i++){h.source.data.push([...h.source.data[1]]);h.source.set(i+1,25,'task-'+i);h.source.set(i+1,6,'ref'+i);st.tasks['task-'+i]={registration:{status:'confirmed',method:'fixture'}};}h.writeState(st);h.run();assert.equal(h.state().version,4);assert.equal(h.state().inventoryVersion,1);assert.equal(Object.keys(h.state().tasks).length,3);const audit=h.sheets.get('_WTC同步日志').data.slice(1);assert.deepEqual(audit.map(r=>r[5]),[2,3,4]);assert.deepEqual(audit.map(r=>r[1]),['WAIT','WAIT','WAIT']);assert.equal(h.counts().ai,0);assert.equal(h.counts().commits,0);});
test('QA header/data snapshot detects native column move before enrolling historical zero rows',()=>{let once=true;const h=harness({noId:true,beforeBatchGet:({source})=>{if(once){source.set(1,16,'靠台等时');source.set(1,17,'装车用时');source.set(2,16,0);source.set(2,17,0);moveInputsBeforeTime(source);once=false;}}});assert.throws(()=>h.run(),/位置已变化|正在移动/);assert.equal(h.source.getRange(2,25).getValue(),'');assert.equal(Object.keys(h.state().tasks).length,0);assert.equal(h.counts().ai,0);});
test('QA stable K:N layout uses native headers and preserves original timing columns',()=>{const h=harness();h.source.set(1,11,'到达时间');h.source.set(1,12,'开始时间');h.source.set(1,13,'结束时间');h.source.set(2,11,'12:01');h.source.set(2,12,'12:15');h.source.set(2,13,'13:45');moveInputsBeforeTime(h.source);h.run();assert.equal(h.state().inventory[0].physicalP,14);assert.match(h.source.getRange(2,13).getValue(),/已处理/);assert.deepEqual(h.source.getRange(2,15,1,3).getValues()[0],['12:01','12:15','13:45']);});
test('QA unconfirmed baseline never allocates a new UUID for valid user quantity',()=>{const h=harness({baseline:false,noId:true});h.run();assert.equal(h.source.getRange(2,25).getValue(),'');assert.equal(Object.keys(h.state().tasks).length,0);assert.match(h.source.getRange(2,23).getValue(),/缺少任务ID.*未自动扣库/);assert.equal(h.state().inventory[0].physicalP,20);assert.equal(h.counts().ai,0);});
test('QA malformed plain zero cannot enroll a new historical task',()=>{const h=harness({noId:true,planned:'0',actual:'0'});h.run();assert.equal(h.source.getRange(2,25).getValue(),'');assert.equal(h.counts().ai,0);assert.equal(Object.keys(h.state().tasks).length,0);});
test('QA existing blank UUID without ledger does not generate new pending records',()=>{const h=harness({planned:'',actual:''});h.run();assert.equal(h.state().version,1);assert.equal(Object.keys(h.state().tasks).length,1);assert.equal(h.state().tasks['task-1'].registration.status,'confirmed');assert.equal(h.state().tasks['task-1'].ledger,undefined);assert.notEqual(h.state().tasks['task-1'].pending,true);assert.equal(h.counts().ai,0);assert.equal(h.source.getRange(2,23).getValue(),'');});
test('QA maintenance pause after AI approval is a commit barrier',()=>{let once=true;const h=harness({aiHook:()=>{if(once){once=false;h.pause();}}});h.run();assert.equal(h.state().inventory[0].physicalP,20);assert.equal(h.counts().commits,0);assert.equal(h.state().version,1);assert.equal(h.state().inventoryVersion,1);assert.equal(h.sheets.get('_WTC同步日志').getLastRow(),1);assert.equal(h.run().status.paused,true);});
test('QA cleanup archives blank legacy pending task atomically before clearing source identifiers',()=>{const h=harness({planned:'',actual:''});const st=h.state();st.tasks['task-1']={registration:{status:'legacy_unconfirmed',method:'fixture'},pending:true,pendingCode:'BASELINE_MISSING',lastResult:'待基准'};h.writeState(st);h.source.set(2,23,'待基准旧结果');h.source.set(2,24,'2026/10/29 18:17');h.pause();const preview=h.previewCleanup();assert.equal(preview.count,1);assert.equal(h.source.getRange(2,25).getValue(),'task-1');h.cleanup();assert.equal(h.source.getRange(2,25).getValue(),'');assert.equal(h.source.getRange(2,23).getValue(),'');assert.equal(h.state().tasks['task-1'],undefined);const archive=h.sheets.get('_WTC同步日志').data.find(r=>r[1]==='MAINTENANCE_ARCHIVE');assert.ok(archive);const saved=JSON.parse(archive[4]);assert.equal(saved.previousResult,'待基准旧结果');assert.equal(saved.previousTime,'2026/10/29 18:17');assert.equal(saved.previousTask.lastResult,'待基准');assert.equal(saved.previousTask.registration.status,'legacy_unconfirmed');assert.equal(h.state().inventory[0].physicalP,20);assert.equal(h.sheets.get('_WTC任务流水').getLastRow(),1);});
test('QA cleanup rejects running mode and protects existing ledger task',()=>{const h=harness({planned:'',actual:''});assert.throws(()=>h.cleanup(),/先暂停/);const st=h.state();st.tasks['task-1']={ledger:{taskId:'task-1',baselineVersion:'BASE-QA',actual:[]}};h.writeState(st);h.pause();assert.equal(h.previewCleanup().count,0);h.cleanup();assert.equal(h.source.getRange(2,25).getValue(),'task-1');assert.ok(h.state().tasks['task-1'].ledger);});
test('QA cleanup protects baseline-included task even before first local ledger',()=>{const h=harness({planned:'',actual:''});const st=h.state();delete st.tasks['task-1'].registration;st.baseline.appliedTasks['task-1']={actual:[{inventoryId:'i1',physicalP:6,releasedSlots:6}]};h.writeState(st);h.pause();assert.equal(h.previewCleanup().count,0);assert.throws(()=>h.newTask(),/已.*基准|已有.*结算/);assert.equal(h.source.getRange(2,25).getValue(),'task-1');});
test('QA failed legacy cleanup batch preserves both archive and source-state transaction',()=>{const h=harness({planned:'',actual:'',failMaintenance:true});const st=h.state();st.tasks['task-1']={registration:{status:'legacy_unconfirmed',method:'fixture'},pending:true};h.writeState(st);h.source.set(2,23,'old');h.pause();assert.throws(()=>h.cleanup(),/SHEETS_COMMIT_503/);assert.equal(h.source.getRange(2,25).getValue(),'task-1');assert.equal(h.source.getRange(2,23).getValue(),'old');assert.equal(h.state().version,1);assert.equal(h.state().tasks['task-1'].registration.status,'legacy_unconfirmed');assert.equal(h.sheets.get('_WTC同步日志').getLastRow(),1);});
test('QA resume verifies unique headers before clearing maintenance flag',()=>{const h=harness();h.pause();h.source.set(1,26,'预计出库');assert.throws(()=>h.resume(),/缺失或重复/);assert.equal(h.run().status.paused,true);h.source.set(1,26,'');moveInputsBeforeTime(h.source);assert.equal(h.resume().status.paused,false);h.run();assert.equal(h.state().inventory[0].physicalP,14);});
test('QA cancelled task with both inputs cleared releases old plan but preserves actual',()=>{const h=harness({status:'已开始',planned:'C1:8',actual:'C1:2'});h.run();assert.equal(h.state().tasks['task-1'].ledger.projectedRemaining[0].physicalP,6);h.source.set(2,20,'');h.source.set(2,21,'');h.source.set(2,10,'取消');h.run();assert.equal(h.state().inventory[0].physicalP,18);assert.equal(h.state().tasks['task-1'].ledger.projectedRemaining.length,0);assert.equal(h.state().tasks['task-1'].ledger.actual[0].physicalP,2);});
