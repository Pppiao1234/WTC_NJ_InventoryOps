'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('./unload_engine.js');
function row(extra = {}) {
  return { publicationId: 'PAPER-261030', revision: '1', allocationId: 'group-1', taskId: 'FCH260101-01',
    containerNo: 'DEMU1001004', destination: 'HEA2', shipmentId: '00001', location: 'C1', route: 'ordinary',
    estimatedP: 9, estimatedSlots: 9, finalLocation: '', specialType: '', published: true, ...extra };
}
function calculate(status, extra = {}, previous) {
  const allocations = Array.isArray(extra) ? extra : [row(extra)];
  return Core.computeUnloadEffect({ taskId: 'FCH260101-01', status, publicationId: 'PAPER-261030', revision: '1', allocations, previous });
}
function view(ledgers, extra = {}) { return Core.aggregateReservations({ unloadTasks: ledgers, knownEmptyLocations: ['C1', 'C2', '检查区'], capacities: { C1: 27, C2: 27, '检查区': 70 }, ...extra }); }

test('published paper protects a waiting position and active conversion does not double reserve', () => {
  const waiting = calculate('未到');
  assert.equal(waiting.ok, true);
  assert.equal(waiting.nextLedger.reservations[0].kind, 'planned_hold');
  assert.equal(view([waiting.nextLedger]).byLocation.C1.plannedHoldSlots, 9);
  assert.deepEqual(waiting.actualDeltas, []);
  const arrived = calculate('已到', {}, waiting.nextLedger);
  const active = calculate('在拆', {}, arrived.nextLedger);
  const empty = calculate('拆空', {}, active.nextLedger);
  for (const ledger of [waiting.nextLedger, arrived.nextLedger, active.nextLedger, empty.nextLedger]) assert.equal(view([ledger]).byLocation.C1.incomingEstimatedSlots, 9);
  assert.equal(view([active.nextLedger]).byLocation.C1.plannedHoldSlots, 0);
  assert.equal(view([active.nextLedger]).byLocation.C1.activeEstimatedSlots, 9);
  assert.equal(empty.nextLedger.physicalInventoryPosted, false);
});

test('unread source protects planned positions without claiming arrival', () => {
  const result = calculate('未读取');
  assert.equal(result.ok, true);
  assert.equal(result.nextLedger.observedStatus, '未读取');
  assert.equal(result.nextLedger.highestPhase, 0);
  assert.equal(result.nextLedger.reservations[0].kind, 'planned_hold');
  assert.equal(result.nextLedger.autoAllocationBlocked, true);
  assert.ok(result.issues.some(x => x.code === 'SOURCE_STATUS_UNOBSERVED'));
  assert.equal(calculate('').nextLedger.observedStatus, '未读取');
  assert.equal(calculate('随意状态').blocked, true);
});

test('repeated save yields identical ledger and no added quantity', () => {
  const first = calculate('在拆');
  const second = calculate('在拆', {}, first.nextLedger);
  assert.equal(second.changed, false);
  assert.deepEqual(second.nextLedger, first.nextLedger);
  assert.equal(view([second.nextLedger]).byLocation.C1.incomingEstimatedP, 9);
});

test('rollback from empty cannot delete goods or re-open a released inspection stage', () => {
  const allocation = { location: '检查区', route: 'via_inspection', estimatedP: 43, estimatedSlots: 43, specialType: '特殊' };
  const empty = calculate('拆空', allocation);
  const back = calculate('在拆', allocation, empty.nextLedger);
  assert.equal(back.nextLedger.highestPhase, 2);
  assert.equal(back.nextLedger.statusRegression, true);
  assert.equal(back.nextLedger.reservations.some(x => x.kind === 'inspection_estimate'), false);
  assert.equal(back.nextLedger.unresolved[0].estimatedP, 43);
  assert.ok(back.issues.some(x => x.code === 'STATUS_REGRESSION'));
});

test('inspection empty releases its stage but retains unconfirmed goods and destination hold', () => {
  const allocation = { location: '检查区', route: 'via_inspection', finalLocation: 'C2', estimatedP: 6.5, estimatedSlots: 6.5 };
  const active = calculate('在拆', allocation);
  const empty = calculate('拆空', allocation, active.nextLedger);
  const activeView = view([active.nextLedger]);
  const emptyView = view([empty.nextLedger]);
  assert.equal(activeView.inspection.estimatedP, 6.5);
  assert.equal(activeView.byLocation.C2.finalDestinationHoldP, 6.5);
  assert.equal(emptyView.inspection.estimatedP, 0);
  assert.equal(emptyView.byLocation.C2.finalDestinationHoldP, 6.5);
  assert.equal(emptyView.unresolved[0].location, null);
  assert.equal(emptyView.unresolved[0].estimatedP, 6.5);
  assert.equal(emptyView.autoAllocationBlocked, true);
});

test('inspection planned budget counts against 64 standard and 70 hard limit', () => {
  for (const [p, warning, hard] of [[43, false, false], [65, true, false], [71, true, true]]) {
    const result = calculate('未到', { location: '检查区', route: 'via_inspection', estimatedP: p, estimatedSlots: p });
    const budget = view([result.nextLedger]);
    assert.equal(budget.inspection.plannedHoldP, p);
    assert.equal(budget.inspection.totalProjectedP, p);
    assert.equal(budget.inspection.aboveStandard, warning);
    assert.equal(budget.inspection.exceedsHardLimit, hard);
    assert.equal(budget.autoAllocationBlocked, hard);
  }
});

test('published location, estimate, route and revision cannot change silently', () => {
  const first = calculate('未到');
  for (const changed of [{ location: 'C2' }, { estimatedP: 10 }, { estimatedSlots: 8 }, { route: 'special_direct' }, { finalLocation: 'C2' }]) {
    const next = calculate('在拆', changed, first.nextLedger);
    assert.equal(next.blocked, true);
    assert.ok(next.issues.some(x => x.code === 'PUBLISHED_PLAN_CHANGED'));
    assert.deepEqual(next.nextLedger, first.nextLedger);
  }
});

test('paper row reordering is not a new allocation', () => {
  const rows = [row(), row({ allocationId: 'group-2', location: 'C2', shipmentId: '00002' })];
  const first = calculate('在拆', rows);
  const next = calculate('在拆', [...rows].reverse(), first.nextLedger);
  assert.equal(next.changed, false);
});

test('decimal estimates and unknown slots stay estimates without one to one inference', () => {
  const result = calculate('在拆', { estimatedP: 6.5, estimatedSlots: null });
  const budget = view([result.nextLedger]);
  assert.equal(result.ok, true);
  assert.equal(result.nextLedger.reservations[0].estimatedP, 6.5);
  assert.equal(result.nextLedger.reservations[0].estimatedSlots, null);
  assert.equal(budget.byLocation.C1.incomingEstimatedSlots, null);
  assert.equal(budget.byLocation.C1.usableProjectedSlots, null);
  assert.deepEqual(result.actualDeltas, []);
});

test('later actual observations neither alter frozen paper nor create an automatic receipt', () => {
  const first = calculate('在拆');
  const empty = calculate('拆空', { actualP: 7, actualSlots: 4, actualConfirmed: true, actualFinalLocation: 'C2' }, first.nextLedger);
  assert.equal(empty.ok, true);
  assert.equal(empty.nextLedger.publishedAllocations[0].estimatedP, 9);
  assert.equal(empty.nextLedger.publishedAllocations[0].location, 'C1');
  assert.equal(empty.nextLedger.physicalInventoryPosted, false);
  assert.deepEqual(empty.actualDeltas, []);
});

test('malformed, unpublished, duplicate and mismatched task rows do not create new records', () => {
  for (const extra of [{ published: false }, { estimatedP: -1 }, { taskId: 'other' }, { route: 'guess' }, { location: '' }, { route: 'via_inspection', location: 'C1' }]) assert.equal(calculate('在拆', extra).blocked, true);
  assert.equal(calculate('在拆', [row(), row()]).blocked, true);
});

test('special direct concurrency locks only active containers and completed goods remain', () => {
  const a = calculate('在拆', { route: 'special_direct', estimatedP: 2, estimatedSlots: 2 });
  const bRows = [row({ taskId: 'cab-2', allocationId: 'cab2-group', route: 'special_direct', estimatedP: 2, estimatedSlots: 2 })];
  const b = Core.computeUnloadEffect({ taskId: 'cab-2', status: '在拆', publicationId: 'PAPER-261030', revision: '1', allocations: bRows });
  assert.equal(view([a.nextLedger, b.nextLedger]).byLocation.C1.specialConcurrencyConflict, true);
  const empty = calculate('拆空', { route: 'special_direct', estimatedP: 2, estimatedSlots: 2 }, a.nextLedger);
  const after = view([empty.nextLedger, b.nextLedger]);
  assert.equal(after.byLocation.C1.specialConcurrencyConflict, false);
  assert.equal(after.byLocation.C1.incomingEstimatedP, 4);
});

test('same container medium direct groups may share up to 20P without separate locks', () => {
  const groups = [row({ route: 'special_direct', estimatedP: 10, estimatedSlots: 10, specialType: '中票' }), row({ allocationId: 'group2', route: 'special_direct', estimatedP: 10, estimatedSlots: 10, specialType: '中票' })];
  const fit = calculate('在拆', groups);
  assert.equal(view([fit.nextLedger]).autoAllocationBlocked, false);
  const above = calculate('在拆', [groups[0], { ...groups[1], estimatedP: 11, estimatedSlots: 11 }]);
  assert.ok(view([above.nextLedger]).issues.some(x => x.code === 'MEDIUM_SPECIAL_LINE_LIMIT'));
});

test('full and unavailable catalog labels protect positions without fabricating actual occupied slots', () => {
  for (const status of ['满线', '不可用']) {
    const allocation = calculate('未到');
    const budget = Core.aggregateReservations({ capacities: { C1: { capacitySlots: 27, status } }, unloadTasks: [allocation.nextLedger] });
    assert.equal(budget.byLocation.C1.actualOccupiedSlots, null);
    assert.equal(budget.byLocation.C1.actualPhysicalP, null);
    assert.equal(budget.byLocation.C1.usableProjectedSlots, 0);
    assert.equal(budget.autoAllocationBlocked, true);
  }
});

test('capacity alone does not prove empty; an explicit empty marker does', () => {
  const allocation = calculate('未到');
  const unknown = Core.aggregateReservations({ capacities: { C1: 27 }, unloadTasks: [allocation.nextLedger] });
  assert.equal(unknown.byLocation.C1.actualOccupiedSlots, null);
  assert.equal(unknown.autoAllocationBlocked, true);
  const empty = Core.aggregateReservations({ capacities: { C1: { capacitySlots: 27, status: '空位' } }, unloadTasks: [allocation.nextLedger] });
  assert.equal(empty.byLocation.C1.actualOccupiedSlots, 0);
  assert.equal(empty.byLocation.C1.usableProjectedSlots, 18);
  assert.equal(empty.autoAllocationBlocked, false);
});

test('proposal validation rejects tampered estimates or discarded unresolved goods', () => {
  const effect = calculate('拆空', { route: 'via_inspection', location: '检查区' });
  assert.equal(Core.validateProposal(effect.proposal, effect).ok, true);
  const candidate = structuredClone(effect.proposal); candidate.nextLedger.reservations = [];
  assert.equal(Core.validateProposal(candidate, effect).ok, false);
  candidate.nextLedger.reservations = effect.proposal.nextLedger.reservations;
  candidate.actualDeltas = [{ physicalP: 9 }];
  assert.equal(Core.validateProposal(candidate, effect).ok, false);
});
