'use strict';
// Independent generated-client behavior checks. No browser session or network.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

class Element {
  constructor(tag='div',id=''){this.tagName=tag.toLowerCase();this.id=id;this.children=[];this.parentNode=null;this.className='';this.style={};this.disabled=false;this.checked=false;this._value='';this._text='';this.listeners={};}
  appendChild(child){if(child.parentNode)child.remove();this.children.push(child);child.parentNode=this;return child;}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}
  set textContent(text){this._text=String(text);this.children.forEach(c=>{c.parentNode=null;});this.children=[];}
  get textContent(){return this._text;}
  set innerHTML(_){throw Error('Do not insert business text as HTML');}
  set value(value){const raw=String(value);this._value=this.tagName==='select'&&this.children.some(c=>c.tagName==='option')&&!this.children.some(c=>c.value===raw)?'':raw;}
  get value(){return this._value;}
  addEventListener(name,fn){this.listeners[name]=fn;}
  matches(selector){return selector[0]==='.'?this.className.split(/\s+/).includes(selector.slice(1)):this.tagName===selector.toLowerCase();}
  querySelectorAll(selector){const selectors=selector.split(',').map(s=>s.trim()),out=[];const visit=n=>{for(const c of n.children){if(selectors.some(s=>c.matches(s)))out.push(c);visit(c);}};visit(this);return out;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}

function task(id='LOAD-A',extra={}){return {taskId:id,label:'TEB9 装车',reference:'REF-'+id,businessDate:'2026-10-30',revision:2,status:'已开始',bookedStatus:'已开始',bookedActualP:6,bookedActualKnown:true,bookedActualText:'C4 TEB9:6',bookedActualEntries:[{location:'C4',destination:'TEB9',physicalP:6}],bookedPlannedText:'',bookedPlannedEntries:[],savedPlannedEntries:[],lastResult:'已处理',...extra};}
function harness(tasks=[task()]){
  const host={};vm.createContext(host);vm.runInContext(fs.readFileSync(__dirname+'/adapter.gs','utf8'),host);
  const html=host.WTCLoad_loadingPortalHtml(),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const root=new Element(),byId={};
  for(const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)){const element=new Element(match[1],match[2]);byId[match[2]]=element;root.appendChild(element);}
  for(const id of ['loadStatus','plannedRows','addPlan','planTotal','savePlan','actualRows','addActual','actualTotal','saveActual','saveStatus','correctionPanel'])if(byId[id])byId.editor.appendChild(byId[id]);
  for(const id of ['correctionReason','correctActual'])if(byId[id])byId.correctionPanel.appendChild(byId[id]);
  const calls=[],storage=new Map(),intervals=[];
  // Each google.script.run access gets a fresh callback chain.
  const google={script:{}};Object.defineProperty(google.script,'run',{get(){let success,failure;let proxy;proxy=new Proxy({}, {get(_o,name){if(name==='withSuccessHandler')return fn=>{success=fn;return proxy;};if(name==='withFailureHandler')return fn=>{failure=fn;return proxy;};return input=>{calls.push({name,input,success,failure});};}});return proxy;}});
  const context={document:{getElementById:id=>byId[id],createElement:tag=>new Element(tag),querySelectorAll:selector=>root.querySelectorAll(selector)},google,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},setInterval:fn=>{intervals.push(fn);return intervals.length;},Date,Math,JSON,Number,console};
  vm.createContext(context);vm.runInContext(script,context,{filename:'loading-portal-client.js'});
  const h={html,script,context,byId,calls,storage,intervals,tasks,
    reply(value){const c=calls.shift();assert.ok(c,'expected queued client call');c.success(value);return c;},
    reject(message='network lost'){const c=calls.shift();assert.ok(c);c.failure({message});return c;},
    portal(extra={}){return {enabled:true,isOwner:true,tasks,requests:[],message:'ready',...extra};},
    select(id){byId.tasks.value=id;byId.tasks.listeners.change.call(byId.tasks);},
    click(id){byId[id].onclick();},
    fill(container,index,fields){const line=byId[container].children[index];for(const [key,value]of Object.entries(fields))line.querySelector('.'+key).value=value;}
  };
  assert.equal(calls[0].name,'WTCLoad_getLoadingPortal');h.reply(h.portal());if(tasks.length)h.select(tasks[0].taskId);return h;
}

test('portal UI: generated client parses and business labels stay text',()=>{
  const evil='<img src=x onerror=alert(1)>',h=harness([task('LOAD-A',{label:evil})]);
  assert.ok(h.byId.tasks.children.some(option=>option.textContent.includes(evil)));
  assert.ok(h.byId.booked.textContent.includes('已入账实际累计：6P'));
  assert.match(h.html,/已记6P，现在累计8P，只再扣2P/);
});

test('portal UI: actual multi-location submission sends real newline and fixed task revision',()=>{
  const h=harness();h.fill('actualRows',0,{quantity:'8'});h.click('addActual');h.fill('actualRows',1,{destination:'ABE8',location:'F6',quantity:'1'});h.click('saveActual');
  const call=h.calls[0];assert.equal(call.name,'WTCLoad_submitLoading');assert.equal(call.input.taskId,'LOAD-A');assert.equal(call.input.expectedRevision,2);assert.equal(call.input.actualText,'C4 TEB9:8\nF6 ABE8:1');assert.equal(call.input.kind,'actual');assert.ok(!Object.hasOwn(call.input,'plannedText'));assert.equal(h.byId.tasks.disabled,true);assert.equal(h.byId.saveActual.disabled,true);
});

test('portal UI: unknown blank P is blocked while explicit zero is submitted',()=>{
  const h=harness();h.fill('actualRows',0,{quantity:''});h.click('saveActual');assert.equal(h.calls.length,0);assert.match(h.byId.message.textContent,/未知不要当0/);
  h.fill('actualRows',0,{quantity:'0'});h.click('saveActual');assert.equal(h.calls[0].input.actualText,'C4 TEB9:0');
});

test('portal UI: negative and fractional P cannot reach the server',()=>{
  for(const p of ['-1','1.5','NaN']){const h=harness();h.fill('actualRows',0,{quantity:p});h.click('saveActual');assert.equal(h.calls.length,0);}
});

test('portal UI: repeat click and exact network retry reuse one request identity',()=>{
  const h=harness();h.fill('actualRows',0,{quantity:'8'});h.click('saveActual');const id=h.calls[0].input.requestId;h.click('saveActual');assert.equal(h.calls.length,1);h.reject();h.click('saveActual');assert.equal(h.calls[0].input.requestId,id);
  h.reject();h.fill('actualRows',0,{quantity:'9'});h.click('saveActual');assert.notEqual(h.calls[0].input.requestId,id);
});

test('portal UI: saving a plan does not include or change actual cumulative',()=>{
  const h=harness();h.fill('plannedRows',0,{destination:'TEB9',location:'C4',quantity:'12'});h.click('savePlan');assert.equal(h.calls[0].input.plannedText,'C4 TEB9:12');assert.equal(h.calls[0].input.kind,'plan');assert.ok(!Object.hasOwn(h.calls[0].input,'actualText'));
});

test('portal UI: queued 8P stays separate from booked 6P and locks quantity controls',()=>{
  const h=harness([task('LOAD-A',{pendingRequestId:'REQ-8',pendingRequest:{requestId:'REQ-8',kind:'actual',actualText:'C4 TEB9:8'}})]);
  assert.match(h.byId.booked.textContent,/已入账实际累计：6P/);assert.match(h.byId.pending.textContent,/尚未入账/);assert.match(h.byId.pending.textContent,/C4 TEB9:8/);assert.equal(h.byId.saveActual.disabled,true);assert.equal(h.byId.actualRows.children[0].querySelector('.quantity').value,'6');
});

test('portal UI: actual submitted from not-started changes visible portal status to started',()=>{
  const h=harness([task('LOAD-A',{status:'未开始',bookedStatus:'未开始',bookedActualP:0,bookedActualKnown:false,bookedActualText:'',bookedActualEntries:[]})]);h.fill('actualRows',0,{destination:'TEB9',location:'C4',quantity:'2'});h.click('saveActual');assert.equal(h.calls[0].input.status,'已开始');assert.equal(h.byId.loadStatus.value,'已开始');
});

test('portal UI: actual move remains available through integration with this-move quantity',()=>{
  const h=harness();assert.ok(h.byId.moveSubmit);for(const [id,value]of Object.entries({moveDestination:'TEB9',moveFrom:'C4',moveTo:'C5',moveP:'2',moveDate:'2026-10-30'}))h.byId[id].value=value;h.click('moveSubmit');assert.equal(h.calls[0].name,'WTCLoad_registerMove');assert.equal(h.calls[0].input.physicalP,2);assert.ok(h.calls[0].input.operationId);
});

test('portal UI: copying source information is not itself task creation or accounting submission',()=>{
  const h=harness();h.click('copySource');assert.equal(h.calls[0].name,'WTCLoad_getSelectedLoadingSnapshot');h.reply({label:'LOAD INFO',businessDate:'2026-10-30',reference:'REF',dock:'12',sourceSnapshot:true,message:'snapshot only'});assert.equal(h.calls.length,0);assert.equal(h.byId.newLabel.value,'LOAD INFO');assert.equal(h.byId.newReference.value,'REF');assert.equal(h.byId.actualRows.children[0].querySelector('.quantity').value,'6');
});

test('portal UI: searching cannot leave an active task hidden behind a blank selector',()=>{
  const h=harness([task('LOAD-A'),task('LOAD-B',{label:'OTHER'})]);h.byId.search.value='OTHER';h.byId.search.listeners.input();const selected=h.context.selected();assert.equal(selected?.taskId||'',h.byId.tasks.value,'the visible selector and submitted task must agree');
});

test('portal UI: a same-revision validation rejection preserves entered values for repair',()=>{
  const h=harness();h.fill('actualRows',0,{quantity:'8'});h.click('saveActual');h.reply({ok:false,message:'请补仓点资料',portal:h.portal()});
  assert.equal(h.byId.actualRows.children[0].querySelector('.quantity').value,'8');assert.equal(h.byId.saveActual.disabled,false);assert.match(h.byId.message.textContent,/请补仓点资料/);assert.match(h.byId.booked.textContent,/已入账实际累计：6P/);
});

test('portal UI: rejected submission can be reloaded without mislabelling it booked',()=>{
  const h=harness([task('LOAD-A',{failedRequest:{requestId:'BAD-8',kind:'actual',actualText:'C4 TEB9:8',status:'已开始',result:'数量需核对'},failedActualEntries:[{location:'C4',destination:'TEB9',physicalP:8}]})]);
  assert.match(h.byId.pending.textContent,/上次提交待补/);assert.match(h.byId.booked.textContent,/已入账实际累计：6P/);h.click('repairDraft');assert.equal(h.byId.actualRows.children[0].querySelector('.quantity').value,'8');assert.match(h.byId.message.textContent,/不是已入账数量/);
});

test('portal UI: revision conflict locks the old form but switching to another task uses fresh state',()=>{
  const a=task('LOAD-A'),b=task('LOAD-B',{label:'OTHER'}),h=harness([a,b]);h.fill('actualRows',0,{quantity:'8'});h.click('saveActual');h.reply({ok:false,message:'任务版本已变化，请刷新',portal:h.portal({tasks:[{...a,revision:3},b]})});assert.equal(h.byId.saveActual.disabled,true);h.select('LOAD-B');assert.equal(h.byId.saveActual.disabled,false);assert.equal(h.context.selected().taskId,'LOAD-B');
});

test('portal UI: a new task returned under a previous search is visibly selected',()=>{
  const h=harness([task('LOAD-A')]);h.byId.search.value='LOAD-A';h.byId.search.listeners.input();const fresh=task('LOAD-NEW',{label:'NEW'});h.context.acceptPortal(h.portal({tasks:[h.tasks[0],fresh]}),'LOAD-NEW');assert.equal(h.byId.search.value,'');assert.equal(h.byId.tasks.value,'LOAD-NEW');assert.equal(h.context.selected().taskId,'LOAD-NEW');
});
