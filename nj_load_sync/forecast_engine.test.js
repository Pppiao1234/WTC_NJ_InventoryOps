'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./forecast_engine');
const syntheticForecast = require('./fixtures/synthetic_forecast.js');
const seeds = [
  { taskId: 'FCH260101-01', containerNo: 'DEMU1001004', aliases: ['90004', '#90004', 'FCH260101-01', '1-01'] },
  { taskId: 'DEMU1001001', containerNo: 'DEMU1001001', aliases: ['01001'] },
  { taskId: 'DEMU1001005', containerNo: 'DEMU1001005', aliases: ['01005'] },
  { taskId: 'DEMU1001003', containerNo: 'DEMU1001003', aliases: ['01003'] },
  { taskId: 'DEMU1001002', containerNo: 'DEMU1001002', aliases: ['01002'] }
];
function matrix(id = '1001', rows = [['ABE8', 4], ['TEB9', 3]], extra = {}) {
  return F.parseForecast({ sheetId: 1, title: '10/30/26拆柜预报', anchorDate: '2026-10-30', observedAt: '2026-10-30T18:00:00Z', values: [['总计', '', 1], ['', '台口', '以星'], ['', '柜号', id], ...rows.map(row => ['', row[0], row[1]])], ...extra });
}
function registry(extra = {}) { return F.buildRegistry({ seeds, ...extra }); }

test('forecast parser distinguishes ordinary and special rows without copying totals', () => {
  const s = matrix('1001', [['ABE8', 4], ['TEB9', '3.5'], ['私', 7], ['存仓', 2], ['自提', 1], ['FEDEX', 2], ['UPS', 3], ['总计', 22.5]]);
  assert.equal(s.columns[0].ordinaryP, 7.5); assert.equal(s.columns[0].specialP, 15); assert.equal(s.columns[0].totalP, 22.5);
  assert.equal(s.columns[0].valid, true); assert.equal(s.physicalInventoryUnchanged, true);
});
test('blank and explicit zero matrix cells are zero for a complete container snapshot', () => {
  const s = matrix('1001', [['ABE8', ''], ['TEB9', 0]]); assert.equal(s.columns[0].valid, true); assert.equal(s.columns[0].ordinaryP, 0); assert.deepEqual(s.columns[0].items, []);
});
test('a wholly blank cabinet is unknown while an explicitly declared zero cabinet is valid', () => {
  const empty = matrix('1001', [['ABE8', ''], ['TEB9', null]]); assert.equal(empty.columns[0].valid, false); assert.equal(empty.columns[0].ordinaryP, null); assert.equal(empty.columns[0].totalP, null); assert(empty.columns[0].issues.some(x => x.code === 'FORECAST_EMPTY_CONTAINER'));
  const zero = matrix('1001', [['ABE8', ''], ['TEB9', null], ['总计', 0]]); assert.equal(zero.columns[0].valid, true); assert.equal(zero.columns[0].ordinaryP, 0);
});
test('declared forecast totals are checked without adding the total row twice', () => {
  const correct = matrix('1001', [['ABE8', 4], ['TEB9', 3], ['总计', 7]]); assert.equal(correct.columns[0].valid, true); assert.equal(correct.columns[0].totalP, 7);
  const mismatch = matrix('1001', [['ABE8', 4], ['总计', 7]]); assert.equal(mismatch.columns[0].valid, false); assert(mismatch.columns[0].issues.some(x => x.code === 'FORECAST_TOTAL_MISMATCH'));
});
test('invalid numeric data prevents that column from being used as a plan', () => {
  for (const value of [-1, '待确认', '3P', '=1+1', Infinity, NaN]) {
    const s = matrix('1001', [['ABE8', value]]); assert.equal(s.columns[0].valid, false); assert.equal(F.deduplicate({ sources: [s], registry: registry() }).totals.verifiedOrdinaryP, 0);
  }
});
test('duplicate warehouse rows are not silently added', () => {
  const s = matrix('1001', [['ABE8', 4], ['ABE8', 4]]); assert.equal(s.columns[0].valid, false); assert(s.columns[0].issues.some(x => x.code === 'FORECAST_DUPLICATE_DESTINATION'));
});
test('source fingerprints remain unchanged across scans, changedAt changes only with content', () => {
  const first = matrix(), second = matrix('1001', [['ABE8', 4], ['TEB9', 3]], { priorSource: first, observedAt: '2026-10-30T18:01:00Z' });
  assert.equal(first.contentFingerprint, second.contentFingerprint); assert.equal(second.changedAt, first.changedAt); assert.notEqual(second.observedAt, first.observedAt);
  const third = matrix('1001', [['ABE8', 5]], { priorSource: second, observedAt: '2026-10-30T18:02:00Z' }); assert.notEqual(third.contentFingerprint, second.contentFingerprint); assert.equal(third.changedAt, third.observedAt);
});
test('explicit source configuration supports renamed sheets and namespaces', () => {
  const s = matrix('1001', [['ABE8', 4]], { title: '系统导出', sourceId: 'book-2:0', kind: 'weekly', businessDate: '2026-11-02' });
  assert.equal(s.sourceId, 'book-2:0'); assert.equal(s.kind, 'weekly'); assert.equal(s.businessDate, '2026-11-02'); assert.equal(s.period.end, '2026-11-08'); assert.equal(s.valid, true);
});
test('unparseable header retains known prior identity as blocked instead of silently keeping old valid data', () => {
  const old = matrix(), broken = F.parseForecast({ sheetId: 1, title: old.title, anchorDate: '2026-10-30', observedAt: '2026-10-30T18:01:00Z', priorSource: old, values: [['bad header']] });
  assert.equal(broken.valid, false); assert.equal(broken.columns[0].rawId, '1001'); assert.equal(broken.columns[0].valid, false);
});
test('source date parser validates days and chooses nearest year at year transition', () => {
  assert.equal(F.parseBusinessDate('2026-10-30'), '2026-10-30'); assert.equal(F.parseBusinessDate('10/30/26拆柜预报', '2026-10-30'), '2026-10-30');
  assert.equal(F.parseBusinessDate('12/31', '2027-01-01'), '2026-12-31'); assert.equal(F.parseBusinessDate('1/2', '2026-12-30'), '2027-01-02');
  assert.equal(F.parseBusinessDate('2/30/26', '2026-10-30'), ''); assert.equal(F.parseBusinessDate('11/2', ''), '');
});
test('daily weekly monthly periods are recognized deterministically', () => {
  assert.equal(matrix().kind, 'daily');
  const week = matrix('1001', [['ABE8', 4]], { title: '11/2/26当周拆柜预报' }); assert.equal(week.kind, 'weekly'); assert.equal(week.period.end, '2026-11-08');
  const month = matrix('1001', [['ABE8', 4]], { title: '11月拆柜预报' }); assert.equal(month.kind, 'monthly'); assert.equal(month.period.start, '2026-11-01'); assert.equal(month.period.end, '2026-11-30');
});
test('registry includes publication receipt and explicit mappings while preserving legacy identity', () => {
  const r = registry({ publishedAllocations: [{ containerNo: 'ABCD1111111', taskId: 'ABCD1111111' }], receipts: { a: { containerNo: 'EFGH2222222' } }, mappings: [{ containerNo: 'ABCD1111111', alias: 'CUSTOM' }] });
  assert.equal(F.resolveIdentity('1-01', r).taskId, 'FCH260101-01'); assert.equal(F.resolveIdentity('CUSTOM', r).containerNo, 'ABCD1111111'); assert.equal(F.resolveIdentity('EFGH2222222', r).resolved, true);
});
test('multiline known map aliases resolve and never fabricate full container from FCH number', () => {
  const r = registry(); assert.equal(F.resolveIdentity('#90004\nFCH260101-01', r).containerNo, 'DEMU1001004'); assert.equal(F.resolveIdentity('FCH260101-99', r).resolved, false);
});
test('numeric suffix needs at least four digits and unique known container', () => {
  const r = registry(); assert.equal(F.resolveIdentity('1001', r).containerNo, 'DEMU1001001'); assert.equal(F.resolveIdentity('001', r).resolved, false); assert.equal(F.resolveIdentity('88888', r).resolved, false);
});
test('ambiguous aliases and suffixes remain pending even with a carrier label', () => {
  const r = registry({ mappings: [{ containerNo: 'ABCD9991001', alias: '01001', carrier: '万海' }] });
  assert.equal(F.resolveIdentity('1001', r).ambiguous, true); assert.equal(F.resolveIdentity('01001', r, '万海').ambiguous, true); assert(r.collisions.some(x => x.alias === '01001'));
});
test('full cabinet identities do not require preregistration but reject malformed fragments', () => {
  const r = registry(); assert.equal(F.resolveIdentity('DEMU 1001001', r).containerNo, 'DEMU1001001'); assert.equal(F.resolveIdentity('柜号 ABCD1111111', r).containerNo, 'ABCD1111111');
  assert.equal(F.resolveIdentity('ABCD11111112', r).resolved, false); assert.equal(F.resolveIdentity('XABCD1111111', r).resolved, false); assert.equal(F.resolveIdentity('ABCD1111111 / EFGH2222222', r).ambiguous, true);
});
test('daily whole-container snapshot wins without restoring warehouses from week/month', () => {
  const day = matrix('1001', [['ABE8', 4]]), week = matrix('1001', [['ABE8', 5], ['TEB9', 7]], { sheetId: 2, title: '11/2/26当周拆柜预报' }), month = matrix('1001', [['ABE8', 6], ['TEB9', 8]], { sheetId: 3, title: '11月拆柜预报' });
  const result = F.deduplicate({ sources: [month, week, day], registry: registry() }); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].ordinaryP, 4); assert.deepEqual(result.rows[0].items.map(x => x.destination), ['ABE8']); assert.equal(result.rows[0].provenance.length, 3); assert.equal(result.totals.verifiedOrdinaryP, 4); assert.equal(result.physicalInventoryUnchanged, true);
});
test('latest same-kind business date wins before source changedAt', () => {
  const old = matrix('1001', [['ABE8', 4]], { sheetId: 1, observedAt: '2026-11-01T20:00:00Z' }), newer = matrix('1001', [['ABE8', 6]], { sheetId: 2, title: '10/31/26拆柜预报', observedAt: '2026-10-31T10:00:00Z' });
  assert.equal(F.deduplicate({ sources: [old, newer], registry: registry() }).rows[0].ordinaryP, 6);
});
test('different warehouse mixes remain visible even when total pallets match', () => {
  const day = matrix('1001', [['ABE8', 4], ['TEB9', 3]]), month = matrix('1001', [['ABE8', 3], ['TEB9', 4]], { sheetId: 2, title: '11月拆柜预报' });
  const row = F.deduplicate({ sources: [day, month], registry: registry() }).rows[0];
  assert.equal(row.ordinaryP, 7); assert.equal(row.differences.length, 1); assert.equal(row.differences[0].ordinaryDifferenceP, 0); assert.equal(row.differences[0].warehouseMixChanged, true); assert.equal(row.differences[0].warehouseDifferences.length, 2);
});
test('registry duplicate canonical seeds cannot erase an older stable legacy task id', () => {
  const r = F.buildRegistry({ seeds: [seeds[0], { containerNo: seeds[0].containerNo, taskId: seeds[0].containerNo }] });
  assert.equal(F.resolveIdentity('DEMU1001004', r).taskId, 'FCH260101-01');
});
test('latest invalid column blocks rather than falling back to older good forecast', () => {
  const old = matrix('1001', [['ABE8', 4]], { sheetId: 1 }), newer = matrix('1001', [['ABE8', '待确认']], { sheetId: 2, title: '10/31/26拆柜预报' });
  const result = F.deduplicate({ sources: [old, newer], registry: registry() }); assert.equal(result.rows[0].valid, false); assert.equal(result.rows[0].eligible, false); assert.equal(result.totals.verifiedOrdinaryP, 0); assert.equal(result.rows[0].selectedSourceId, '2');
});
test('same-time equally ranked source disagreements are not resolved arbitrarily', () => {
  const a = matrix('1001', [['ABE8', 4]], { sheetId: 1 }), b = matrix('1001', [['ABE8', 6]], { sheetId: 2 });
  const result = F.deduplicate({ sources: [a, b], registry: registry() }); assert.equal(result.rows[0].valid, false); assert.equal(result.totals.verifiedOrdinaryP, 0);
});
test('same container repeated within one source is blocked instead of double counted', () => {
  const s = matrix(); s.columns.push({ ...s.columns[0], rawId: 'DEMU1001001', sourceColumn: 4 }); const result = F.deduplicate({ sources: [s], registry: registry() }); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].valid, false); assert.equal(result.totals.verifiedOrdinaryP, 0);
});
test('actual receipts and published plans are excluded separately from additional forecast plan', () => {
  const a = matrix('1001', [['ABE8', 4]], { sheetId: 1 }), b = matrix('1005', [['AKR1', 7]], { sheetId: 2 }), c = matrix('ABCD1111111', [['ABE8', 9]], { sheetId: 3 });
  const result = F.deduplicate({ sources: [a, b, c], registry: registry(), postedContainers: ['DEMU1001001'], publishedContainers: ['DEMU1001001', 'DEMU1001005'] });
  assert.equal(result.totals.excludedPostedP, 4); assert.equal(result.totals.alreadyPublishedP, 7); assert.equal(result.totals.verifiedOrdinaryP, 9); assert.equal(result.rows.filter(x => x.eligible).length, 1);
});
test('unresolved carrier plus exact tail provisional rows remain visibly unverified', () => {
  const a = matrix('0304', [['ABE8', 4]], { sheetId: 1 }), b = matrix('0304', [['ABE8', 5]], { sheetId: 2, title: '11月拆柜预报' }), c = matrix('0304', [['ABE8', 8]], { sheetId: 3 }); c.columns[0].carrier = '万海';
  const result = F.deduplicate({ sources: [a, b, c], registry: registry() }); assert.equal(result.rows.length, 2); assert(result.rows.every(x => !x.verified && !x.eligible)); assert.equal(result.totals.provisionalOrdinaryP, 12); assert.equal(result.totals.verifiedOrdinaryP, 0);
});
test('map detects header rows and observes real G column while ignoring status-only placeholders', () => {
  const values = [[], ['海柜状态', '未到', '拆空', '已到', '未到'], ['柜号', '1001', '1005', '88888']]; const map = F.discoverMap({ sheetId: 17, title: '10/31', anchorDate: '2026-10-30', values });
  assert.equal(map.valid, true); assert.equal(map.businessDate, '2026-10-31'); assert.equal(map.statusRow, 2); assert.equal(map.idRow, 3); assert.equal(map.observations.length, 3); assert.equal(map.observations[2].sourceColumn, 4);
});
test('map conflicting statuses on latest same-day cabinet do not choose a winner', () => {
  const rows = [{ rawId: '1001', status: '拆空', businessDate: '2026-10-30', sourceSheetId: 1, sourceColumn: 2 }, { rawId: '01001', status: '未到', businessDate: '2026-10-30', sourceSheetId: 2, sourceColumn: 3 }];
  const selected = F.selectObservations(rows, registry()); assert.equal(selected.length, 1); assert.equal(selected[0].conflict, true); assert.equal(selected[0].status, '待核查'); assert.equal(selected[0].eligible, false);
});
test('latest-day observation preserves full source history without conflating moved columns', () => {
  const selected = F.selectObservations([{ rawId: '1001', status: '已到', businessDate: '2026-10-30', sourceSheetId: 1, sourceColumn: 2 }, { rawId: '01001', status: '在拆', businessDate: '2026-10-31', sourceSheetId: 2, sourceColumn: 8 }], registry());
  assert.equal(selected.length, 1); assert.equal(selected[0].status, '在拆'); assert.equal(selected[0].sourceColumn, 8); assert.equal(selected[0].sourceObservations.length, 2);
});
test('invalid map headers or dates are isolated and produce no guessed observations', () => {
  const bad = F.discoverMap({ title: '10/31', anchorDate: '2026-10-30', values: [['柜号', '1001']] }); assert.equal(bad.valid, false); assert.deepEqual(bad.observations, []);
});
test('input structures remain untouched by registry parsing dedup and map selection', () => {
  const args = { sources: [matrix()], registry: registry(), postedContainers: [], publishedContainers: [], observations: [{ rawId: '1001', status: '在拆', businessDate: '2026-10-30' }] }, before = JSON.stringify(args); F.deduplicate(args); assert.equal(JSON.stringify(args), before);
});
test('generated forecast parses 114 columns, flags the blank cabinet, and finds the sixth map cabinet', () => {
  const fixture = syntheticForecast(seeds), sources = fixture.forecasts.map((source, index) => F.parseForecast({ ...source, sheetId: index + 1, anchorDate: fixture.capturedAt, observedAt: '2026-10-30T18:00:00Z' }));
  assert.deepEqual(sources.map(x => x.columns.length), [5, 31, 78]); assert(sources.every(x => x.valid)); assert(sources[0].columns.every(c => c.valid)); assert(sources[1].columns.every(c => c.valid));
  const empty = sources[2].columns.find(c => c.rawId === '69999'); assert.equal(empty.valid, false); assert.equal(empty.totalP, null);
  const map = F.discoverMap({ ...fixture.map, sheetId: 104, anchorDate: fixture.capturedAt }); assert.equal(map.observations.length, 6); assert.equal(map.observations[5].rawId, '88888');
  const result = F.deduplicate({ sources, registry: registry(), observations: map.observations, publishedContainers: seeds.map(x => x.containerNo) });
  assert(result.rows.some(x => x.containerNo === 'DEMU1001004' && x.taskId === 'FCH260101-01' && x.sourceKind === 'daily'));
  assert.equal(result.rows.filter(x => x.alreadyPublished).length, 5); assert.equal(result.observations.filter(x => !x.containerNo).length, 1);
});
