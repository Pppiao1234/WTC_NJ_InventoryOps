'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const S = require('./table_source_reader.gs');

class Sheet {
  constructor(id, name, values, hidden = false) { Object.assign(this, {id, name, values, hidden, reads: [], failure: null}); }
  getSheetId() { return this.id; }
  getName() { return this.name; }
  isSheetHidden() { return this.hidden; }
  getLastRow() { return this.values.length; }
  getLastColumn() { return Math.max(0, ...this.values.map(r => r.length)); }
  getMaxRows() { return Math.max(20, this.values.length); }
  getRange(row, col, height, width) {
    this.reads.push({row, col, height, width});
    if (this.failure) throw new Error(this.failure);
    assert(height > 0 && width > 0);
    return {getDisplayValues: () => Array.from({length: height}, (_, r) => Array.from({length: width}, (_, c) => String((this.values[row + r - 1] || [])[col + c - 1] ?? ''))),getValues: () => Array.from({length: height}, (_, r) => Array.from({length: width}, (_, c) => (this.values[row + r - 1] || [])[col + c - 1] ?? ''))};
  }
}
class Book {
  constructor(id, sheets) { Object.assign(this, {id, sheets}); }
  getId() { return this.id; }
  getSheets() { return this.sheets; }
  getSheetByName(name) { return this.sheets.find(s => s.name === name) || null; }
}
const configHeader = ['来源表ID', '来源页ID', '来源页名称', '类型', '业务日期', '启用', '说明'];
const aliasHeader = ['原标识', '完整柜号', '船公司', '启用', '说明'];
function forecast(id, title, p = 37, container = 'DEMU1001005') {
  return new Sheet(id, title, [['合计', '', ''], ['', '台口', ''], ['', '櫃號', container], ['', 'ABE8', p], ['', '总计', p]]);
}
function loading(rows = []) {
  const header = Array(25).fill('');
  Object.assign(header, {0: '日期', 1: 'Load 状态', 3: '司机信息', 4: '装车信息（格式：仓点+货物类型+调度备注号码+承运）', 5: 'XLX1', 6: '预装柜是否已提', 8: '台口', 9: '状态', 10: '预计出库', 11: '实际累计出库', 24: '_WTC任务ID'});
  return new Sheet(5, 'NJ装车接龙', [header, ...rows]);
}
function loadingRow(date = '11/06', info = 'Demo Operator 预装 ABE8 #1001NJ', id = 'job-1') {
  const row = Array(25).fill('');
  Object.assign(row, {0: date, 1: '预装（非当天）', 3: 'SECRET_DRIVER_PHONE', 4: info, 5: 'DEMO-REFERENCE-001', 6: '否', 8: '21', 9: '已开始', 10: '999', 11: '888', 24: id});
  return row;
}
function map(id = 20, title = '11/06', container = 'DEMU1001005', status = '拆空', hidden = false) {
  const rows = Array.from({length: 20}, () => ['', '']);
  rows[3] = ['开始时间', '8:57']; rows[4] = ['结束时间', '12:46']; rows[5] = ['海柜状态', status];
  rows[10] = ['台口', '21']; rows[14] = ['櫃號', container]; rows[15] = ['可能有的库内操作', ''];
  return new Sheet(id, title, rows, hidden);
}
function fixture(options = {}) {
  const forecastSheets = options.forecastSheets || [forecast(2, '11/06/26拆柜预报')];
  const config = new Sheet(1, 'WTC预报来源', [configHeader, ...forecastSheets.map(s => ['MAIN', s.id, s.name, /周/.test(s.name) ? '周' : /月/.test(s.name) ? '月' : '日', '', true, ''])]);
  const aliases = new Sheet(3, 'WTC柜号关联', [aliasHeader, ['1005', 'DEMU1001005', '', true, '']]);
  const load = options.loadingSheet || loading([loadingRow()]);
  const book = new Book('MAIN', [config, aliases, ...forecastSheets, load]);
  const mapBook = new Book('MAP', options.maps || [map()]);
  const args = {book, now: '2026-11-07T00:00:00Z', timezone: 'America/New_York', unloadSourceId: 'MAP', openBook(id) { if (id === 'MAP') return mapBook; if (id === 'MAIN') return book; throw new Error('Unavailable book'); }};
  return {book, mapBook, args, config, aliases, load, forecastSheets};
}

test('time uses the warehouse day, including UTC midnight and year transition', () => {
  assert.equal(S.dayAt('2026-11-07T00:00:00Z', 'America/New_York'), '2026-11-06');
  const chosen = S.chooseMapSheets([{title: '12/31', sheetId: 1, index: 0}, {title: '1/ 2', sheetId: 2, index: 1}], '2027-01-01');
  assert.deepEqual(chosen.selected.map(x => x.businessDate).sort(), ['2026-12-31', '2027-01-02']);
});

test('daily weekly monthly choose one container forecast and never subtract old receipts', () => {
  const f = fixture({forecastSheets: [forecast(2, '11/06/26拆柜预报', 37), forecast(6, '11/2/26当周拆柜预报', 41), forecast(7, '11月拆柜预报', 55)]});
  const result = S.read({...f.args, receipts: [{containerNo: 'DEMU1001005', p: 37}], postedContainers: ['DEMU1001005'], publishedContainers: ['DEMU1001005']});
  assert.equal(result.businessDate, '2026-11-06'); assert.equal(result.forecast.ok, true);
  assert.equal(result.forecast.data.rows.length, 1); const row = result.forecast.data.rows[0];
  assert.equal(row.ordinaryP, 37); assert.equal(row.sourceKind, 'daily'); assert.equal(row.provenance.length, 3);
  assert.equal(row.excludedPosted, false); assert.equal(row.alreadyPublished, false);
  assert.equal(result.forecast.data.totals.verifiedOrdinaryP, 37); assert.equal(result.physicalInventoryUnchanged, true);
  assert.equal(result.unload.data.selected[0].status, '拆空');
});

test('forecast new visible tabs autojoin while disabled sources remain disabled', () => {
  const f = fixture();
  f.book.sheets.push(forecast(66, '11/09/26拆柜预报', 10, 'DEMU1001003'));
  f.book.sheets.push(forecast(67, '11/10/26拆柜预报', 12, 'DEMU1001002'));
  f.config.values.push(['MAIN', 67, '11/10/26拆柜预报', '日', '', false, '']);
  const result = S.read(f.args);
  assert.equal(result.forecast.data.sources.length, 2);
  assert(result.forecast.data.rows.some(r => r.containerNo === 'DEMU1001003'));
  assert(!result.forecast.data.rows.some(r => r.containerNo === 'DEMU1001002'));
});

test('forecast failed source retains evidence and quantity but is stale and blocked', () => {
  const f = fixture(), first = S.read(f.args);
  f.forecastSheets[0].failure = 'Access denied';
  const next = S.read({...f.args, now: '2026-11-07T00:05:00Z', prior: first});
  assert.equal(next.forecast.ok, false); assert.equal(next.forecast.stale, true);
  assert.equal(next.forecast.lastSuccessAt, first.forecast.lastSuccessAt);
  assert.equal(next.forecast.data.rows[0].ordinaryP, 37); assert.equal(next.forecast.data.rows[0].valid, false);
  assert.deepEqual(next.forecast.data.sources[0].rawValues, first.forecast.data.sources[0].rawValues);
  assert(next.forecast.issues.some(i => i.code === 'FORECAST_SOURCE_READ' && i.retainedPrevious));
  assert.equal(next.loading.ok, true);
});

test('whole config read failure preserves the prior section and is not a zero forecast', () => {
  const f = fixture(), first = S.read(f.args); f.config.failure = 'Quota failure';
  const next = S.read({...f.args, prior: first});
  assert.equal(next.forecast.ok, false); assert.equal(next.forecast.data.rows[0].ordinaryP, 37);
  assert(next.forecast.issues.some(i => i.code === 'FORECAST_READ_FAILED' && i.retainedPrevious));
});

test('invalid forecast data is flagged and bounded sources are never truncated silently', () => {
  const f = fixture(), first = S.read(f.args);
  f.forecastSheets[0].values[3][2] = '待确认';
  const bad = S.read({...f.args, prior: first});
  assert.equal(bad.forecast.ok, false); assert.equal(bad.forecast.data.rows[0].ordinaryP, 37);
  f.forecastSheets[0].values = Array.from({length: 501}, () => []);
  const big = S.read({...f.args, prior: first});
  assert.equal(big.forecast.ok, false); assert(big.forecast.issues.some(i => /上限/.test(i.message)));
});

test('one blank container blocks that container without discarding other valid forecast columns', () => {
  const sheet = forecast(2, '11/06/26拆柜预报');
  sheet.values[2].push('DEMU1001002'); sheet.values[3].push(''); sheet.values[4].push('');
  const result = S.read(fixture({forecastSheets: [sheet]}).args);
  assert.equal(result.forecast.ok, false);
  assert.equal(result.forecast.data.rows.find(r => r.containerNo === 'DEMU1001005').valid, true);
  assert.equal(result.forecast.data.rows.find(r => r.containerNo === 'DEMU1001002').valid, false);
  assert.equal(result.forecast.data.rows.find(r => r.containerNo === 'DEMU1001002').ordinaryP, null);
  assert.equal(result.forecast.data.totals.verifiedOrdinaryP, 37);
  assert.equal(result.forecast.data.sources[0].stale, false); assert.equal(result.forecast.data.sources[0].partial, true);
  assert.equal(result.forecast.data.sources[0].lastSuccessAt,result.observedAt);
  assert.equal(result.forecast.data.rows.find(r => r.containerNo === 'DEMU1001005').lastSuccessAt,result.observedAt);
  assert.equal(result.forecast.data.rows.find(r => r.containerNo === 'DEMU1001002').lastSuccessAt,'');
});

test('partially invalid source has current read time while retained bad column keeps its prior successful time', () => {
  const f=fixture(),first=S.read(f.args);f.forecastSheets[0].values[3][2]='待核对';
  const next=S.read({...f.args,now:'2026-11-07T00:05:00Z',prior:first});
  assert.equal(next.forecast.data.sources[0].lastSuccessAt,next.observedAt);
  assert.equal(next.forecast.data.rows[0].stale,true);
  assert.equal(next.forecast.data.rows[0].lastSuccessAt,first.observedAt);
  assert.equal(next.forecast.data.rows[0].attemptedAt,next.observedAt);
});

test('map reads only bounded date pages, preferring visible duplicates over old hidden pages', () => {
  const old = Array.from({length: 450}, (_, i) => map(100 + i, '1/1/2025', '', '', true));
  const hiddenDuplicate = map(600, '11/6', 'DEMU1001002', '未到', true), current = map(), future = map(601, '11/ 11', 'DEMU1001003', '未到');
  const f = fixture({maps: [...old, hiddenDuplicate, current, future]}); const result = S.read(f.args);
  assert.equal(result.unload.ok, true); assert.equal(result.unload.data.pages.length, 2);
  assert(old.every(s => s.reads.length === 0)); assert.equal(hiddenDuplicate.reads.length, 0);
  assert.equal(current.reads.length, 1); assert.equal(current.reads[0].height, 20);
  assert.equal(result.unload.data.coverage.start, '2026-10-30'); assert.equal(result.unload.data.coverage.end, '2026-11-13');
});

test('map headers are located by labels, not fixed row offsets', () => {
  const m = map(); [m.values[5], m.values[8]] = [m.values[8], m.values[5]]; [m.values[14], m.values[18]] = [m.values[18], m.values[14]];
  const result = S.read(fixture({maps: [m]}).args), row = result.unload.data.selected[0];
  assert.equal(row.containerNo, 'DEMU1001005'); assert.equal(row.status, '拆空'); assert.equal(row.dock, '21');
  assert.equal(row.startTime, '8:57'); assert.equal(row.endTime, '12:46');
  assert.equal(row.sourceRef.range, 'B1:B20'); assert.equal(row.businessDate, '2026-11-06');
});

test('a hidden old-year page is excluded even without a same-date visible page', () => {
  const hidden = map(80, '11/7', 'OLD2025', '', true), f = fixture({maps: [hidden, map()]});
  const result = S.read(f.args);
  assert.equal(result.unload.ok, true); assert.equal(hidden.reads.length, 0);
  assert.equal(result.unload.data.coverage.hiddenPagesExcluded, 1);
});

test('map failed page preserves old evidence, empty readable map succeeds, no dated map fails', () => {
  const f = fixture(), first = S.read(f.args); f.mapBook.sheets[0].failure = 'Access denied';
  const failed = S.read({...f.args, prior: first});
  assert.equal(failed.unload.ok, false); assert.equal(failed.unload.data.observations[0].rawId, 'DEMU1001005');
  assert.equal(failed.unload.data.pages[0].stale, true); assert.equal(failed.unload.data.selected[0].eligible, false);
  const empty = S.read(fixture({maps: [map(20, '11/06', '')]}).args);
  assert.equal(empty.unload.ok, true); assert.deepEqual(empty.unload.data.selected, []);
  const absent = S.read(fixture({maps: []}).args); assert.equal(absent.unload.ok, false);
});

test('map page cap reports incomplete coverage instead of presenting it as complete', () => {
  const f = fixture({maps: [map(20), map(21), map(22)]}); const result = S.read({...f.args, maxMapSheets: 2});
  assert.equal(result.unload.ok, false); assert.equal(result.unload.data.coverage.omittedPages, 1);
  assert.equal(f.mapBook.sheets.filter(s => s.reads.length).length, 2);
  assert(result.unload.issues.some(i => i.code === 'UNLOAD_PAGE_LIMIT'));
});

test('unfinished records aging out or disappearing remain a bounded stale queue without historical rereads', () => {
  const historic = map(90, '10/30', 'DEMU1001002', '在拆'), f = fixture({maps: [historic, map()]});
  const first = S.read(f.args); assert.equal(first.unload.ok, true);
  const count = historic.reads.length;
  const next = S.read({...f.args, now: '2026-11-08T18:00:00Z', prior: first});
  const retained = next.unload.data.selected.find(r => r.containerNo === 'DEMU1001002');
  assert.equal(historic.reads.length, count); assert.equal(retained.stale, true); assert.equal(retained.eligible, false);
  assert.equal(retained.lastObservedStatus, '在拆'); assert.equal(next.unload.data.coverage.retainedPending, 1);
  assert.equal(next.unload.ok, false);
  const repeated = S.read({...f.args, now: '2026-11-09T18:00:00Z', prior: next});
  assert.equal(repeated.unload.data.selected.find(r => r.containerNo === 'DEMU1001002').lastObservedStatus, '在拆');
  const hundred = {...first, unload: {...first.unload, data: {...first.unload.data, selected: Array.from({length: 105}, (_, n) => ({rawId: 'OLD-'+n, businessDate: '2026-10-01', status: '未到'}))}}};
  const limited = S.read({...f.args, prior: hundred});
  assert.equal(limited.unload.data.coverage.retainedPending, 100); assert.equal(limited.unload.data.coverage.omittedPending, 5);
});

test('load reads omit driver data and do not extract quantities from descriptions or old actual columns', () => {
  const f = fixture({loadingSheet: loading([loadingRow('11/06', 'ABE8 14P #1001NJ')])}); const result = S.read(f.args), record = result.loading.data.records[0];
  assert.equal(result.loading.ok, true); assert.equal(record.info, 'ABE8 14P #1001NJ');
  assert.equal(record.key, 'TASK|job-1'); assert.equal(record.identityCertain, true);
  assert(!f.load.reads.some(r => r.row > 1 && r.col <= 4 && r.col + r.width > 4));
  assert(!f.load.reads.some(r => r.row > 1 && [11, 12].includes(r.col)));
  assert(!JSON.stringify(result).includes('SECRET_DRIVER_PHONE'));
  assert(!Object.hasOwn(record, 'p')); assert(!Object.hasOwn(record, 'actualP'));
});

test('moved rows, edited descriptions, and changed dates preserve stable load keys', () => {
  const a = S.parseLoadingRows({today: '2026-11-06', values: [{date: '11/06', info: 'ABE8 #1001NJ', taskId: 'job-1', sourceRow: 7000}]});
  const b = S.parseLoadingRows({today: '2026-11-06', values: [{date: '11/09', info: '预装 ABE8 #1001NJ 调度追加', taskId: 'job-1', sourceRow: 7400}]});
  assert.equal(a.records[0].key, b.records[0].key);
  const c = S.parseLoadingRows({today: '2026-11-06', values: [{date: '11/06', info: 'ABE8 #1001NJ', sourceRow: 7000}]});
  const d = S.parseLoadingRows({today: '2026-11-06', values: [{date: '11/09', info: '预装 ABE8 #1001NJ 调度追加', sourceRow: 7400}]});
  assert.equal(c.records[0].key, d.records[0].key); assert.equal(d.records[0].identityCertain, false);
});

test('identical load repeats consolidate but conflicting references stay visible', () => {
  const values = [{date: '11/06', info: 'ABE8 #1001NJ', reference: 'HV1', status: '已开始'}, {date: '11/09', info: 'ABE8 #1001NJ', reference: 'HV1', status: '已开始'}];
  const same = S.parseLoadingRows({today: '2026-11-06', values});
  assert.equal(same.records.length, 1); assert.deepEqual(same.records[0].businessDates, ['2026-11-06', '2026-11-09']);
  values[1].status = '已结束'; const conflict = S.parseLoadingRows({today: '2026-11-06', values});
  assert.equal(conflict.records.length, 2); assert(conflict.issues.some(i => i.code === 'LOADING_REFERENCE_CONFLICT'));
});

test('loading failure retains previous records and successful empty loading is distinguishable', () => {
  const f = fixture(), first = S.read(f.args); f.load.failure = 'Unavailable';
  const failed = S.read({...f.args, prior: first});
  assert.equal(failed.loading.ok, false); assert.equal(failed.loading.stale, true); assert.equal(failed.loading.data.records[0].key, first.loading.data.records[0].key); assert.equal(failed.loading.data.records[0].stale,true);
  const empty = S.read(fixture({loadingSheet: loading()}).args);
  assert.equal(empty.loading.ok, true); assert.equal(empty.loading.stale, false); assert.deepEqual(empty.loading.data.records, []);
});

test('native Date years and serial dates are preserved so historical November rows are not current jobs', () => {
  const historical = loadingRow(new Date('2025-11-06T05:00:00Z'), 'HISTORICAL #1NJ', 'old');
  const current = loadingRow(new Date('2026-11-06T05:00:00Z'), 'CURRENT #2NJ', 'new');
  const f = fixture({loadingSheet: loading([historical, current])}), result = S.read(f.args);
  assert.equal(result.loading.data.records.length, 1); assert.equal(result.loading.data.records[0].key, 'TASK|new');
  const serial = Math.floor((Date.UTC(2025,10,6)-Date.UTC(1899,11,30))/86400000);
  const records = S.parseLoadingRows({today:'2026-11-06',values:[{date:serial,info:'HISTORICAL'}]}).records;
  assert.equal(records.length, 0);
});

test('source diagnostics expose source, object, and exact spreadsheet addresses', () => {
  const f = fixture({loadingSheet:loading([loadingRow('#1002NJ')])});
  f.forecastSheets[0].values[3][2]=''; f.forecastSheets[0].values[4][2]='';
  const result=S.read(f.args),forecastIssue=result.issues.find(i=>i.code==='FORECAST_COLUMN_INVALID'),loadIssue=result.issues.find(i=>i.code==='LOADING_DATE');
  assert.equal(forecastIssue.source,'11/06/26拆柜预报'); assert.equal(forecastIssue.object,'DEMU1001005'); assert.deepEqual(forecastIssue.sourceCells,['11/06/26拆柜预报!C1:C5']);
  assert.equal(loadIssue.source,'NJ装车接龙'); assert.equal(loadIssue.object,'第2行'); assert.deepEqual(loadIssue.sourceCells,['NJ装车接龙!A2']);
});

test('module has no network, AI, property mutation, or spreadsheet write path', () => {
  const source = fs.readFileSync(require.resolve('./table_source_reader.gs'), 'utf8');
  assert(!/UrlFetchApp|OpenAI|setValue\(|setValues\(|setProperty\(|deleteRow\(|insertRow\(/.test(source));
});
