'use strict';
// Generated photo client behavior. No browser, network or real inventory calls.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

class Element {
  constructor(tag='div',id=''){this.tagName=tag.toLowerCase();this.id=id;this.children=[];this.parentNode=null;this.className='';this.style={};this.disabled=false;this.checked=false;this.files=[];this._value='';this._text='';this.listeners={};}
  appendChild(child){if(child.parentNode)child.remove();this.children.push(child);child.parentNode=this;return child;}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}
  set textContent(value){this._text=String(value);this.children.forEach(c=>{c.parentNode=null;});this.children=[];}
  get textContent(){return this._text;}
  set innerHTML(_){throw Error('Business data must never be inserted as HTML');}
  set value(value){this._value=String(value);if(['files','retryFiles'].includes(this.id)&&value==='')this.files=[];}
  get value(){return this._value;}
  addEventListener(name,fn){this.listeners[name]=fn;}
  querySelectorAll(selector){const tags=selector.split(',').map(s=>s.trim().toLowerCase()),out=[];const visit=n=>{for(const child of n.children){if(tags.includes(child.tagName))out.push(child);visit(child);}};visit(this);return out;}
}
function job(extra={}){return {jobId:'PHOTO-JOB-A',kind:'receipt',revision:4,businessDate:'2026-10-30',containerNo:'DEMU1001001',stage:'review',stageLabel:'待补资料',actualP:null,items:[],scopeLocations:[],issues:['请补清楚板数'],result:'尚未入账',...extra};}
function countJob(extra={}){return job({jobId:'COUNT-JOB-A',kind:'count',stage:'ready',stageLabel:'待确认范围',containerNo:'',actualP:7,scopeLocations:['F6','F7'],items:[{destination:'ABE8',location:'F6',physicalP:7,quantityBasis:'actual'},{destination:'',location:'F7',physicalP:0,quantityBasis:'actual'}],issues:[],...extra});}
function file(extra={}){return {name:'receipt.jpg',type:'image/jpeg',size:4,lastModified:1,data:'YWJjZA==',...extra};}
function harness(jobs=[job()],overrides={}){
  const host={};vm.createContext(host);vm.runInContext(fs.readFileSync(__dirname+'/photo_ui.gs','utf8'),host);const html=host.WTCLoad_photoPortalHtml(),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const root=new Element(),byId={};for(const m of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)){const node=new Element(m[1],m[2]);byId[m[2]]=node;root.appendChild(node);}
  const calls=[],storage=new Map(),intervals=[],reads=[];const google={script:{}};
  Object.defineProperty(google.script,'run',{get(){let success,failure,proxy;proxy=new Proxy({}, {get(_o,name){if(name==='withSuccessHandler')return fn=>{success=fn;return proxy;};if(name==='withFailureHandler')return fn=>{failure=fn;return proxy;};return input=>{calls.push({name,input,success,failure});};}});return proxy;}});
  class Reader {readAsDataURL(file){reads.push(file);if(file.fail){this.onerror();return;}this.result='data:'+file.type+';base64,'+file.data;this.onload();}}
  const context={document:{getElementById:id=>byId[id],createElement:tag=>new Element(tag),querySelectorAll:selector=>root.querySelectorAll(selector)},google,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},setInterval:(fn,delay)=>{intervals.push({fn,delay});return intervals.length;},FileReader:Reader,Date,Math,JSON,Number,Promise,console};
  vm.createContext(context);vm.runInContext(script,context,{filename:'photo-client.js'});
  const h={html,script,context,root,byId,calls,storage,intervals,reads,jobs,
    portal(extra={}){return {enabled:true,paused:false,isOwner:true,jobs,containers:[],counts:[],message:'ready',...overrides,...extra};},
    reply(value){const call=calls.shift();assert.ok(call,'expected a pending API call');call.success(value);return call;},
    reject(message='network lost'){const call=calls.shift();assert.ok(call);call.failure({message});return call;},
    click(id){return byId[id].onclick();},select(id){byId.jobs.value=id;byId.jobs.listeners.change.call(byId.jobs);},
    photos(files){byId.files.files=files;byId.files.listeners.change();},replacementPhotos(files){byId.retryFiles.files=files;byId.retryFiles.listeners.change();}
  };
  assert.equal(calls[0].name,'WTCLoad_getPhotoPortal');h.reply(h.portal());return h;
}

test('photo UI: generated HTML parses, receipt and count types are explained accurately',()=>{
  const h=harness();assert.match(h.html,/夜盘先生成差异/);assert.match(h.html,/结果回到本面板/);assert.match(h.html,/印刷理论板数不当作实拆/);assert.equal(h.byId.kind.value,'receipt');assert.equal(h.intervals[0].delay,10000);
});

test('photo UI: valid upload sends image payload and leaves unknown date or cab blank',async()=>{
  const h=harness();h.photos([file()]);await h.click('upload');assert.equal(h.calls[0].name,'WTCLoad_uploadPhotos');const input=h.calls[0].input;assert.equal(input.businessDate,'');assert.equal(input.containerNo,'');assert.equal(input.kind,'receipt');assert.equal(input.files[0].dataBase64,'YWJjZA==');assert.ok(input.requestId);assert.equal(h.byId.upload.disabled,true);
});

test('photo UI: uploads remain receivable while paused, processing is clearly waiting',async()=>{
  const h=harness([], {paused:true});assert.match(h.byId.system.textContent,/照片仍可接收/);assert.equal(h.byId.upload.disabled,false);assert.equal(h.byId.process.disabled,true);assert.equal(h.byId.resume.style.display,'');h.photos([file()]);await h.click('upload');assert.equal(h.calls[0].name,'WTCLoad_uploadPhotos');
});

test('photo UI: client rejects empty, unsupported, excessive count, oversized or empty files',async()=>{
  const cases=[[],[file({type:'image/heic'})],Array.from({length:9},()=>file()),[file({size:8*1024*1024+1})],[file({size:0})],Array.from({length:3},()=>file({size:7*1024*1024}))];
  for(const files of cases){const h=harness();h.photos(files);await h.click('upload');assert.equal(h.calls.length,0);assert.equal(h.reads.length,0);assert.equal(h.byId.upload.disabled,false);assert.equal(h.byId.message.className,'box bad');}
});

test('photo UI: file read failure preserves selection and creates no upload request',async()=>{
  const h=harness();h.photos([file({fail:true})]);await h.click('upload');assert.equal(h.calls.length,0);assert.equal(h.byId.files.files.length,1);assert.match(h.byId.message.textContent,/无法读取照片/);
});

test('photo UI: double click is suppressed; exact retry reuses request ID without storing image bytes',async()=>{
  const h=harness();h.photos([file()]);await h.click('upload');const id=h.calls[0].input.requestId;await h.click('upload');assert.equal(h.calls.length,1);h.reject();await h.click('upload');assert.equal(h.calls[0].input.requestId,id);for(const text of h.storage.values()){assert.ok(!text.includes('YWJjZA=='));assert.ok(!text.includes('dataBase64'));}
});

test('photo UI: modifying upload metadata or image content generates a different request ID',async()=>{
  const h=harness();h.photos([file()]);await h.click('upload');const first=h.calls[0].input.requestId;h.reject();h.byId.businessDate.value='2026-10-30';await h.click('upload');const second=h.calls[0].input.requestId;assert.notEqual(first,second);h.reject();h.photos([file({data:'ZGlmZmVyZW50'})]);await h.click('upload');assert.notEqual(h.calls[0].input.requestId,second);
});

test('photo UI: successful upload selects the returned job and refreshes, not falsely marks posted',async()=>{
  const h=harness([]);h.photos([file()]);await h.click('upload');h.reply({ok:true,job:{jobId:'NEW-JOB'},message:'已接收，等待识别'});assert.equal(h.calls[0].name,'WTCLoad_getPhotoPortal');assert.equal(h.byId.files.files.length,0);h.reply(h.portal({jobs:[job({jobId:'NEW-JOB',stage:'uploaded',stageLabel:'已接收'})]}));assert.equal(h.context.current().jobId,'NEW-JOB');assert.match(h.byId.jobStatus.textContent,/尚未完成正式入账/);assert.doesNotMatch(h.byId.jobStatus.textContent,/已正式入账/);
});

test('photo UI: night upload never carries stale receipt container metadata',async()=>{
  const h=harness();h.byId.kind.value='count';h.byId.kind.listeners.change();h.byId.containerNo.value='DEMU1001001';h.photos([file()]);await h.click('upload');assert.equal(h.calls[0].input.kind,'count');assert.equal(h.calls[0].input.containerNo,'');assert.equal(h.byId.containerField.style.display,'none');
});

test('photo UI: night preview requires an explicit scope completeness action',()=>{
  const h=harness([countJob()]);assert.match(h.byId.scope.textContent,/F6、F7/);h.click('preview');assert.equal(h.calls.length,0);assert.match(h.byId.message.textContent,/勾选/);h.byId.completeScope.checked=true;h.click('preview');const input=h.calls[0].input;assert.equal(h.calls[0].name,'WTCLoad_previewPhotoCount');assert.equal(input.jobId,'COUNT-JOB-A');assert.equal(input.expectedRevision,4);assert.equal(input.completeScopeConfirmed,true);assert.ok(!Object.hasOwn(input,'acceptDifferences'));
});

test('photo UI: adoption sends displayed job, revision and exact preview token only after preview',()=>{
  const h=harness([countJob({stage:'previewed',stageLabel:'差异已生成，待采用',previewToken:'TOKEN-41',previewReport:{summary:{differenceRows:1},rows:[{location:'F6',destination:'ABE8',expectedP:5,actualP:7,differenceP:2}]}})]);assert.match(h.byId.previewReport.textContent,/账面 5P/);assert.match(h.byId.previewReport.textContent,/尚未采用/);h.click('adopt');assert.equal(h.calls[0].name,'WTCLoad_adoptPhotoCount');assert.equal(h.calls[0].input.previewToken,'TOKEN-41');assert.equal(h.calls[0].input.expectedRevision,4);assert.equal(h.calls[0].input.jobId,'COUNT-JOB-A');
});

test('photo UI: unavailable preview token cannot be bypassed by pressing adoption',()=>{
  for(const state of [countJob(),countJob({stage:'previewed',previewToken:''})]){const h=harness([state]);assert.equal(h.byId.adopt.disabled,true);h.click('adopt');assert.equal(h.calls.length,0);assert.match(h.byId.message.textContent,/有效的盘点差异/);}
});

test('photo UI: retry edits metadata on the same job rather than creating a new receipt',()=>{
  const h=harness();h.byId.retryDate.value='2026-10-30';h.byId.retryContainer.value='j x';h.click('retry');assert.equal(h.calls.length,0);h.byId.retryContainer.value='d e m u1001001';h.click('retry');assert.equal(h.calls.length,0);h.byId.retryContainer.value='demu1001001';h.byId.retryText.value='原图手写合计41P';h.click('retry');assert.equal(h.calls[0].name,'WTCLoad_retryPhotoJob');assert.equal(h.calls[0].input.jobId,'PHOTO-JOB-A');assert.equal(h.calls[0].input.expectedRevision,4);assert.equal(h.calls[0].input.containerNo,'DEMU1001001');assert.equal(h.calls[0].input.clarification,'原图手写合计41P');
});

test('photo UI: authoritative posted or adopted status has no retry or adoption action',()=>{
  for(const record of [job({stage:'posted',stageLabel:'已入账',actualP:41}),countJob({stage:'adopted',stageLabel:'已采用'})]){const h=harness([record]);assert.equal(h.byId.retryPanel.style.display,'none');assert.equal(h.byId.adoptPanel.style.display,'none');assert.equal(h.byId.retry.disabled,true);h.click('retry');assert.equal(h.calls.length,0);assert.match(h.byId.jobStatus.textContent,/已正式/);}
});

test('photo UI: pending polling is global, stops for final jobs and never calls a posting method',()=>{
  const h=harness([job({stage:'uploaded'}),job({jobId:'DONE',stage:'posted'})]);h.select('DONE');h.intervals[0].fn();assert.equal(h.calls[0].name,'WTCLoad_getPhotoPortal');h.reply(h.portal({jobs:[job({stage:'posted'}),job({jobId:'DONE',stage:'posted'})]}));h.intervals[0].fn();assert.equal(h.calls.length,0);
});

test('photo UI: searched-out selection cannot submit a hidden job',()=>{
  const h=harness([job(),job({jobId:'OTHER',containerNo:'DEMU1001003'})]);h.byId.search.value='DEMU1001003';h.byId.search.listeners.input();assert.equal(h.context.current(),undefined);assert.equal(h.byId.jobs.value,'');h.click('retry');assert.equal(h.calls.length,0);assert.match(h.byId.message.textContent,/选择处理记录/);
});

test('photo UI: business text and issue payloads are rendered as plain text',()=>{
  const evil='<img src=x onerror=alert(1)>',h=harness([job({result:evil,issues:[{message:evil}],items:[{destination:evil,location:'F6',physicalP:null,quantityBasis:'unknown'}]})],{containers:[{containerNo:evil,result:evil}],counts:[{countId:evil,result:evil}]});assert.equal(h.byId.jobResult.textContent,evil);assert.equal(h.byId.issues.textContent,evil);assert.ok(h.byId.containers.children[0].textContent.includes(evil));assert.equal(h.byId.items.children[0].children[1].children[0].textContent,evil);assert.match(h.byId.items.children[0].children[1].children[2].textContent,/未识别/);
});

test('photo UI: explicit zero is visible but unknown actual total is not displayed as zero',()=>{
  const h=harness([countJob({actualP:null})]);assert.match(h.byId.jobStatus.textContent,/识别板数：未确认/);assert.equal(h.byId.items.children[0].children[2].children[2].textContent,'0');assert.doesNotMatch(h.byId.jobStatus.textContent,/识别板数：0P/);
});

test('photo UI: stale action rejection requires refresh and retains no false completed label',()=>{
  const h=harness([countJob()]);h.byId.completeScope.checked=true;h.click('preview');h.reply({ok:false,message:'记录版本已变化，请刷新'});assert.equal(h.byId.preview.disabled,true);assert.equal(h.byId.adopt.disabled,true);assert.match(h.byId.message.textContent,/版本已变化/);h.click('refresh');h.reply(h.portal({jobs:[countJob({revision:5})]}));assert.equal(h.byId.preview.disabled,false);assert.equal(h.byId.completeScope.checked,false);
});

test('photo UI: missing upgrade blocks upload and explains the required setup',async()=>{
  const h=harness([], {enabled:false});assert.equal(h.byId.upload.disabled,true);assert.match(h.byId.system.textContent,/1.6升级/);h.photos([file()]);await h.click('upload');assert.equal(h.calls.length,0);assert.match(h.byId.message.textContent,/先完成/);
});

test('photo UI: shared users see result entry but not owner-only maintenance buttons',()=>{
  const h=harness([], {isOwner:false,paused:true});assert.equal(h.byId.resume.style.display,'none');assert.equal(h.byId.process.style.display,'none');assert.equal(h.byId.upload.disabled,false);
});

test('photo UI: photo source links are restricted to known HTTPS file hosts',()=>{
  const h=harness([job({sourceRefs:['https://drive.google.com/file/d/PHOTO/view','https://chatgpt.com/library?file_id=PHOTO','javascript:alert(1)','https://drive.google.com.attacker.example/payload']})]);assert.equal(h.byId.sourceRefs.children[0].children[0].href,'https://drive.google.com/file/d/PHOTO/view');assert.equal(h.byId.sourceRefs.children[1].children[0].target,'_blank');assert.equal(h.byId.sourceRefs.children[2].children.length,0);assert.equal(h.byId.sourceRefs.children[3].children.length,0);
});

test('photo UI: a blank scope cannot become a complete night count merely by checking the box',()=>{
  const h=harness([countJob({scopeLocations:[]})]);h.byId.completeScope.checked=true;h.click('preview');assert.equal(h.calls.length,0);assert.match(h.byId.message.textContent,/明确的覆盖库位/);
});

test('photo UI: replacement photos stay on the original job and exact network retry retains identity',async()=>{
  const h=harness();h.replacementPhotos([file({name:'clear.jpg',data:'Y2xlYXI='})]);await h.click('retry');const first=h.calls[0].input;assert.equal(h.calls[0].name,'WTCLoad_retryPhotoJob');assert.equal(first.jobId,'PHOTO-JOB-A');assert.equal(first.files[0].name,'clear.jpg');assert.equal(first.files[0].dataBase64,'Y2xlYXI=');assert.ok(first.requestId);h.reject();await h.click('retry');assert.equal(h.calls[0].input.requestId,first.requestId);assert.equal(h.calls[0].input.jobId,first.jobId);h.reject();h.replacementPhotos([file({name:'clear.jpg',data:'bW9yZS1jbGVhcg=='})]);await h.click('retry');assert.notEqual(h.calls[0].input.requestId,first.requestId);
});

test('photo UI: unsupported replacement photos do not reach the retry endpoint',async()=>{
  const h=harness();h.replacementPhotos([file({type:'image/heic'})]);await h.click('retry');assert.equal(h.calls.length,0);assert.match(h.byId.message.textContent,/仅支持/);
});

test('photo UI: switching jobs clears replacement photos so the wrong cab cannot inherit them',()=>{
  const h=harness([job(),job({jobId:'JOB-B',containerNo:'DEMU1001003'})]);h.replacementPhotos([file()]);h.select('JOB-B');assert.equal(h.byId.retryFiles.files.length,0);assert.match(h.byId.retryPhotoList.textContent,/保留原照片/);
});

test('photo UI: adopted night report is clearly historical rather than still awaiting adoption',()=>{
  const h=harness([countJob({stage:'adopted',previewReport:{summary:{differenceRows:1},rows:[{location:'F6',destination:'ABE8',expectedP:5,actualP:7,differenceP:2}]}})]);assert.match(h.byId.previewReport.textContent,/采用时保存/);assert.doesNotMatch(h.byId.previewReport.textContent,/尚未采用/);assert.equal(h.byId.adoptPanel.style.display,'none');
});

test('photo UI: a recognized night count can be corrected before or after preview on the same job',async()=>{
  for(const stage of ['ready','previewed']){const h=harness([countJob({stage,previewToken:stage==='previewed'?'OLD-PREVIEW':undefined})]);assert.equal(h.byId.retryPanel.style.display,'');assert.equal(h.byId.retry.disabled,false);assert.equal(h.byId.retryText.disabled,false);h.byId.retryText.value='F6应为8P，原识别7P有误';await h.click('retry');assert.equal(h.calls[0].name,'WTCLoad_retryPhotoJob');assert.equal(h.calls[0].input.jobId,'COUNT-JOB-A');assert.equal(h.calls[0].input.expectedRevision,4);assert.ok(!Object.hasOwn(h.calls[0].input,'previewToken'));h.reply({ok:true,portal:h.portal({jobs:[countJob({stage:'uploaded',revision:5,previewToken:null,previewReport:null})]}),message:'已重新识别，旧预览失效'});assert.equal(h.byId.adoptPanel.style.display,'none');assert.equal(h.byId.adopt.disabled,true);}
});

test('photo UI: an unposted receipt marked retryable is not permanently locked as posting',async()=>{
  const h=harness([job({stage:'posting',stageLabel:'待核查，可补正',canRetry:true})]);assert.equal(h.byId.retryPanel.style.display,'');assert.equal(h.byId.retry.disabled,false);assert.equal(h.byId.retryFiles.disabled,false);h.byId.retryText.value='补充正确柜号与板数';await h.click('retry');assert.equal(h.calls[0].name,'WTCLoad_retryPhotoJob');assert.equal(h.calls[0].input.jobId,'PHOTO-JOB-A');
});

test('photo UI: active posting without explicit retry permission stays locked',async()=>{
  const h=harness([job({stage:'posting',canRetry:false})]);assert.equal(h.byId.retryPanel.style.display,'none');assert.equal(h.byId.retry.disabled,true);await h.click('retry');assert.equal(h.calls.length,0);assert.match(h.byId.message.textContent,/正在处理/);
});

test('photo UI: resolved or adopted records cannot be reopened by retry flags',async()=>{
  for(const state of [countJob({stage:'adopted',canRetry:true}),job({stage:'posted',canRetry:true}),job({stage:'review',canRetry:true,resolvedBy:'PHOTO-JOB-FINAL'})]){const h=harness([state]);assert.equal(h.byId.retryPanel.style.display,'none');assert.equal(h.byId.retry.disabled,true);await h.click('retry');assert.equal(h.calls.length,0);}
});

test('photo UI: only unmaterialized early jobs expose mistaken-upload cancellation with revision',()=>{
  for(const stage of ['uploaded','review','error','ready']){const h=harness([job({stage,materialized:false})]);assert.equal(h.byId.cancelPanel.style.display,'');assert.equal(h.byId.cancelJob.disabled,false);h.click('cancelJob');assert.equal(h.calls[0].name,'WTCLoad_cancelPhotoJob');assert.equal(h.calls[0].input.jobId,'PHOTO-JOB-A');assert.equal(h.calls[0].input.expectedRevision,4);assert.deepEqual(Object.keys(h.calls[0].input).sort(),['expectedRevision','jobId']);}
  for(const state of [job({stage:'ready',materialized:true}),job({stage:'review',resolvedBy:'FINAL'}),job({stage:'posting'}),countJob({stage:'previewed',previewToken:'TOKEN'}),countJob({stage:'adopted'}),job({stage:'posted'}),job({stage:'recognizing'})]){const h=harness([state]);assert.equal(h.byId.cancelPanel.style.display,'none');assert.equal(h.byId.cancelJob.disabled,true);h.click('cancelJob');assert.equal(h.calls.length,0);}
});

test('photo UI: cancelled jobs stop polling, cannot retry and are never labelled posted',async()=>{
  const h=harness([job({stage:'cancelled',stageLabel:'已撤销',canRetry:true})]);assert.equal(h.byId.retryPanel.style.display,'none');assert.equal(h.byId.cancelPanel.style.display,'none');assert.equal(h.byId.retry.disabled,true);h.intervals[0].fn();assert.equal(h.calls.length,0);await h.click('retry');assert.equal(h.calls.length,0);assert.match(h.byId.jobStatus.textContent,/撤销未改变库存/);assert.doesNotMatch(h.byId.jobStatus.textContent,/已正式入账/);
});
