'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('./operations_engine.js');
const Load = require('./engine.js');
const NOW = '2026-10-30T18:00:00.000Z';
function copy(x) { return JSON.parse(JSON.stringify(x)); }
function state() {
  const locations = ['C1', 'C2', 'C4', 'D5', 'D9', 'D10', 'E2', 'E11', 'F1', 'F2', 'F6', 'G1', 'G3', 'G6', 'X6', 'Y1', 'Y5', '检查区'];
  const capacityCatalog = Object.fromEntries(locations.map(location => [location, { location, status: '空位', capacitySlots: location === '检查区' ? 70 : 27 }]));
  return { schemaVersion: 1, version: 27, inventoryVersion: 3, baseline: { confirmed: true, version: 'BASE-20261029', asOf: '2026/10/29 收工后', appliedTasks: {} }, inventory: locations.map(location => ({ inventoryId: 'EMPTY-' + location, location, destination: null, shipmentId: null, physicalP: 0, occupiedSlots: 0, slotBasis: 'explicit', capacitySlots: 27 })), capacityCatalog, tasks: {}, unloadTasks: {} };
}
function add(s, id, loc, dest, p, metadata) { const row = Object.assign({ inventoryId: id, location: loc, destination: dest, shipmentId: null, physicalP: p, occupiedSlots: null, slotBasis: 'unknown', capacitySlots: 27 }, metadata || {}); s.inventory.push(row); return row; }
function allocation(id, container, destination, loc, p) { return { allocationId: id, publicationId: 'PAPER-TEST', revision: '1', published: true, containerNo: container, destination, location: loc, shipmentId: '', estimatedP: p, estimatedSlots: p, route: 'ordinary', specialType: '' }; }
function publish(s, taskId, container, rows) { s.unloadTasks[taskId] = { ledger: { taskId, containerNo: container, publishedAllocations: copy(rows), reservations: rows.map(r => Object.assign({}, r, { kind: 'inbound_estimate' })), unresolved: [], physicalInventoryPosted: false } }; }
function receipt(container, items, extra) { return Object.assign({ operationId: 'R-' + container, type: 'receipt', containerNo: container, businessDate: '2026-10-30', sourceRef: 'photo://confirmed', items }, extra || {}); }
function compute(s, operation) { return Core.computeOperation({ state: s, operation, now: NOW }); }
function sum(s, loc, dest) { return s.inventory.filter(r => (!loc || r.location === loc) && (!dest || r.destination === dest)).reduce((n, r) => n + r.physicalP, 0); }
function error(result, code) { assert.equal(result.ok, false); assert.equal(result.blocked, true); assert(result.issues.some(i => i.code === code), JSON.stringify(result.issues)); }

test('real DEMU1001001 receipt posts 41P in ten groups and removes its 37P estimate', () => {
  const s = state(), container = 'DEMU1001001';
  const values = [['ABE8', 'F6', 5, 4], ['AVP1', 'G3', 11, 10], ['DCA6', 'G6', 1, 2], ['INC1', 'D10', 2, 2], ['ORF2', 'E11', 5, 4], ['RMN3', 'E2', 4, 4], ['SWF1', 'Y5', 1, 1], ['SWF2', 'D9', 4, 3], ['TEB9', 'C4', 5, 4], ['TOL3', 'D5', 3, 3]];
  publish(s, container, container, values.map((v, i) => allocation('A' + i, container, v[0], v[1], v[3])));
  const result = compute(s, receipt(container, values.map((v, i) => ({ destination: v[0], location: v[1], physicalP: v[2], allocationIds: ['A' + i] }))));
  assert(result.ok, JSON.stringify(result.issues)); assert.equal(sum(result.nextState), 41); assert.equal(result.candidate.actualDeltas.length, 10);
  assert.equal(result.nextState.unloadTasks[container].ledger.reservations.length, 0); assert.equal(result.nextState.version, 28);
  assert.equal(sum(s), 0); // Candidate calculation never mutates source state.
});

test('real DEMU1001005 receipt posts 37P and retains first-fill split as derived evidence', () => {
  const s = state(), container = 'DEMU1001005'; add(s, 'F1-OLD', 'F1', 'TEB4', 24);
  const rows = [allocation('AKR', container, 'AKR1', 'G1', 16), allocation('BNA', container, 'BNA2', 'Y1', 1), allocation('MDT', container, 'MDT1', 'X6', 1), allocation('TEB-A', container, 'TEB4', 'F1', 3), allocation('TEB-B', container, 'TEB4', 'F2', 12)]; publish(s, container, container, rows);
  const op = receipt(container, [{ location: 'G1', destination: 'AKR1', physicalP: 18, allocationIds: ['AKR'] }, { location: 'Y1', destination: 'BNA2', physicalP: 1, allocationIds: ['BNA'] }, { location: 'X6', destination: 'MDT1', physicalP: 1, allocationIds: ['MDT'] }, { locationOrder: ['F1', 'F2'], destination: 'TEB4', physicalP: 17, allocationIds: ['TEB-A', 'TEB-B'] }]);
  const result = compute(s, op); assert(result.ok, JSON.stringify(result.issues));
  assert.equal(result.candidate.inventoryAfterTotal - result.candidate.inventoryBeforeTotal, 37); assert.equal(sum(result.nextState, 'F1', 'TEB4'), 27); assert.equal(sum(result.nextState, 'F2', 'TEB4'), 14);
  const split = result.nextState.inventory.filter(r => r.receiptId === op.operationId && r.destination === 'TEB4'); assert.equal(split.length, 2); assert(split.every(r => r.occupiedSlots === null && /非逐线实测/.test(r.allocationBasis)));
});

test('historical first-fill receipt keeps paper quota 3 plus 14 after later loading emptied F1', () => {
  const s = state(), container = 'DEMU1001005'; add(s, 'F1-BEFORE-LOADING', 'F1', 'TEB4', 24);
  publish(s, container, container, [allocation('HIST-F1', container, 'TEB4', 'F1', 3), allocation('HIST-F2', container, 'TEB4', 'F2', 12)]);
  const loaded = Load.computeLoadingEffect({ taskId: 'LOAD-AFTER-UNLOAD', status: '已结束', actualText: 'F1 TEB4:24', plannedText: '', inventory: s.inventory, baseline: s.baseline, allowedLocations: Object.keys(s.capacityCatalog), otherTaskPlans: [], allowSameDestinationLots: true });
  assert(loaded.ok, JSON.stringify(loaded.issues)); s.inventory = loaded.inventoryAfter; s.tasks['LOAD-AFTER-UNLOAD'] = { ledger: loaded.nextLedger }; s.version++; s.inventoryVersion++;
  assert.equal(sum(s, 'F1', 'TEB4'), 0);
  const op = receipt(container, [{ locationOrder: ['F1', 'F2'], destination: 'TEB4', physicalP: 17, allocationIds: ['HIST-F1', 'HIST-F2'] }]);
  const result = compute(s, op); assert(result.ok, JSON.stringify(result.issues));
  const lots = result.nextState.inventory.filter(r => r.receiptId === op.operationId);
  assert.equal(lots.find(r => r.location === 'F1').physicalP, 3); assert.equal(lots.find(r => r.location === 'F2').physicalP, 14); assert.equal(sum(result.nextState), 17);
  assert(lots.every(r => r.occupiedSlots === null && /已发布纸位/.test(r.allocationBasis) && /非逐线实测/.test(r.allocationBasis)));
  assert(lots.every(r => r.sourceAllocationPublication.some(p => p.publicationId === 'PAPER-TEST' && p.revision === '1' && p.location === 'F1' && p.publishedEstimatedP === 3)));
  const replay = compute(result.nextState, Object.assign({}, op, { operationId: 'HIST-OTHER-PHOTO', sourceRef: 'photo://later-reupload' })); assert(replay.ok && replay.noOp); assert.deepEqual(replay.nextState.inventory, result.nextState.inventory);
});

test('a real receipt can use an FCH task alias without losing its container estimate', () => {
  const s = state(), container = 'DEMU1001004'; publish(s, 'FCH260101-01', container, [allocation('FCH-A', container, 'AKR1', 'G1', 1)]);
  const result = compute(s, receipt(container, [{ location: 'G1', destination: 'AKR1', physicalP: 2, allocationIds: ['FCH-A'] }]));
  assert(result.ok); assert.equal(result.nextState.unloadTasks['FCH260101-01'].ledger.reservations.length, 0); assert.equal(sum(result.nextState), 2);
});

test('a receipt needs evidence and cannot add stock into an already included business day', () => {
  const s = state(), base = receipt('DEMU1001001', [{ location: 'C1', destination: 'TEB9', physicalP: 1 }]);
  error(compute(s, Object.assign({}, base, { sourceRef: '' })), 'RECEIPT_SOURCE_REQUIRED');
  error(compute(s, Object.assign({}, base, { businessDate: '2026-10-29' })), 'CLOSED_DAY_REQUIRES_CORRECTION');
  assert.equal(sum(s), 0);
});

test('receipt source replacement and operation order do not duplicate the same physical delivery', () => {
  const s = state(), op = receipt('DEMU1001001', [{ location: 'C1', destination: 'TEB9', physicalP: 2 }, { location: 'C2', destination: 'ABE8', physicalP: 3 }]);
  const first = compute(s, op); assert(first.ok);
  const second = compute(first.nextState, Object.assign({}, op, { operationId: 'PHOTO-REUPLOAD', sourceRef: 'photo://replacement', items: op.items.slice().reverse() }));
  assert(second.ok); assert(second.noOp); assert.equal(sum(second.nextState), 5); assert.equal(second.nextState.version, first.nextState.version);
});

test('a partly supplied ordinary receipt cannot silently leave a second ordinary group unaccounted', () => {
  const s = state(), container = 'DEMU1001001'; publish(s, container, container, [allocation('A', container, 'TEB9', 'C1', 2), allocation('B', container, 'ABE8', 'C2', 3)]);
  const result = compute(s, receipt(container, [{ location: 'C1', destination: 'TEB9', physicalP: 2, allocationIds: ['A'] }])); error(result, 'INCOMPLETE_RECEIPT'); assert.equal(sum(result.nextState), 0);
});

test('ambiguous source goods and excessive move quantities never partly move inventory', () => {
  const s = state(); add(s, 'ONE', 'C1', 'TEB9', 3); add(s, 'TWO', 'C1', 'ABE8', 4);
  const op = { type: 'move', operationId: 'M1', businessDate: '2026-10-30', sourceLocation: 'C1', targetLocation: 'C2', physicalP: 2 };
  error(compute(s, op), 'MOVE_GOODS_AMBIGUOUS');
  error(compute(s, Object.assign({}, op, { destination: 'TEB9', physicalP: 4 })), 'MOVE_INSUFFICIENT_STOCK'); assert.equal(sum(s, 'C1'), 7); assert.equal(sum(s, 'C2'), 0);
});

test('a move inherits receipt origin on target lots while retaining zero source rows', () => {
  const s = state(); add(s, 'SOURCE', 'C1', 'TEB9', 4, { containerNo: 'DEMU1001001', receiptKey: 'DEMU1001001|2026-10-30', shipmentId: 'TICKET1' });
  const result = compute(s, { type: 'move', operationId: 'M-ALL', businessDate: '2026-10-30', sourceLocation: 'C1', targetLocation: 'C2', destination: 'TEB9', shipmentId: 'TICKET1', physicalP: 4 });
  assert(result.ok); const old = result.nextState.inventory.find(r => r.inventoryId === 'SOURCE'), moved = result.nextState.inventory.find(r => r.sourceInventoryId === 'SOURCE');
  assert.equal(old.location, 'C1'); assert.equal(old.physicalP, 0); assert.equal(moved.location, 'C2'); assert.equal(moved.containerNo, 'DEMU1001001'); assert.equal(moved.shipmentId, 'TICKET1'); assert.equal(sum(result.nextState), 4);
});

test('normal-lane close does not erase excluded private goods even on a mixed source line', () => {
  const s = state(); add(s, 'NORMAL', 'C1', 'TEB9', 5); add(s, 'PRIVATE', 'C1', 'UPS', 8);
  const op = { type: 'count', countId: 'COUNT-NORMAL', operationId: 'COUNT-NORMAL', businessDate: '2026-10-30', scopeLocations: ['C1'], counts: [{ location: 'C1', destination: 'TEB9', physicalP: 4 }], completeScope: true, acceptDifferences: true };
  const result = compute(s, op); assert(result.ok); assert.equal(sum(result.nextState, 'C1', 'UPS'), 8); assert.equal(sum(result.nextState, 'C1', 'TEB9'), 4);
});

test('a count can identify previously unrecorded normal goods with explicit count provenance', () => {
  const s = state(), op = { type: 'count', operationId: 'FOUND-COUNT', businessDate: '2026-10-30', scopeLocations: ['C1'], counts: [{ location: 'C1', destination: 'ABE8', physicalP: 3 }], completeScope: true, acceptDifferences: true, sourceRef: 'count://20261030' };
  const report = Core.reconcile({ state: s, operation: op }); assert(report.ok); assert.equal(report.summary.differenceP, 3);
  const result = compute(s, op); assert(result.ok); const row = result.nextState.inventory.find(r => r.physicalP === 3); assert.equal(row.quantityBasis, 'confirmed_count_difference'); assert.equal(row.containerNo, null); assert.equal(result.nextState.baseline.fullWarehouseScope, false);
});

test('loading keeps its cumulative difference after a partial closing count changes the baseline', () => {
  const s = state(); add(s, 'LOAD-LOT', 'C1', 'TEB9', 8);
  s.tasks.L = { ledger: { taskId: 'L', baselineVersion: s.baseline.version, actual: [{ inventoryId: 'LOAD-LOT', location: 'C1', destination: 'TEB9', shipmentId: null, physicalP: 6, releasedSlots: null }], planned: [], projectedRemaining: [], status: '已结束' } };
  const closed = compute(s, { type: 'count', operationId: 'CLOSE-C1', businessDate: '2026-10-30', scopeLocations: ['C1'], counts: [{ location: 'C1', destination: 'TEB9', physicalP: 8 }], completeScope: true, acceptDifferences: true }); assert(closed.ok);
  const next = closed.nextState;
  const replay = Load.computeLoadingEffect({ taskId: 'L', status: '已结束', actualText: 'C1 TEB9:6', plannedText: '', inventory: next.inventory, baseline: next.baseline, previous: next.tasks.L.ledger, allowedLocations: Object.keys(next.capacityCatalog), otherTaskPlans: [] }); assert(replay.ok, JSON.stringify(replay.issues)); assert.equal(replay.actualDeltas.length, 0);
  const more = Load.computeLoadingEffect({ taskId: 'L', status: '已结束', actualText: 'C1 TEB9:8', plannedText: '', inventory: next.inventory, baseline: next.baseline, previous: next.tasks.L.ledger, allowedLocations: Object.keys(next.capacityCatalog), otherTaskPlans: [], allowSameDestinationLots: true }); assert(more.ok, JSON.stringify(more.issues)); assert.equal(more.actualDeltas.reduce((n, r) => n + r.physicalP, 0), 2);
});

test('unscoped count rows, duplicate counts and private receipt claims are rejected', () => {
  const s = state(), op = { type: 'count', operationId: 'BAD-COUNT', businessDate: '2026-10-30', scopeLocations: ['C1'], counts: [{ location: 'C2', destination: 'TEB9', physicalP: 1 }], completeScope: true, acceptDifferences: true };
  error(compute(s, op), 'COUNT_OUTSIDE_SCOPE');
  error(compute(s, Object.assign({}, op, { counts: [{ location: 'C1', destination: 'TEB9', physicalP: 1 }, { location: 'C1', destination: 'TEB9', physicalP: 2 }] })), 'DUPLICATE_COUNT_ITEM');
  error(compute(s, receipt('DEMU1001001', [{ location: 'C1', destination: 'NJ 08550', physicalP: 2 }])), 'PRIVATE_SCOPE_EXCLUDED');
});

test('fallback last physical day protects a late count when old loading lacks detailed journal entries', () => {
  const s = state(); add(s, 'STOCK', 'C1', 'TEB9', 6); s.lastPhysicalBusinessDate = '2026-10-31';
  error(compute(s, { type: 'count', operationId: 'LATE', businessDate: '2026-10-30', scopeLocations: ['C1'], counts: [{ location: 'C1', destination: 'TEB9', physicalP: 4 }], completeScope: true, acceptDifferences: true }), 'COUNT_LATER_FLOWS_PRESENT');
});

test('a count preserves evidence linking differences to receipt, move and loading records', () => {
  const s = state(); add(s, 'SOURCE', 'C1', 'TEB9', 4);
  const moved = compute(s, { type: 'move', operationId: 'TRACE-M', businessDate: '2026-10-30', sourceLocation: 'C1', targetLocation: 'C2', destination: 'TEB9', physicalP: 2 }); assert(moved.ok);
  const report = Core.reconcile({ state: moved.nextState, operation: { type: 'count', businessDate: '2026-10-30', scopeLocations: ['C2'], counts: [{ location: 'C2', destination: 'TEB9', physicalP: 1 }], completeScope: true } });
  assert(report.ok); assert(report.rows[0].trace.some(item => item.operationId === 'TRACE-M')); assert.equal(report.rows[0].differenceP, -1);
});

test('moving stock cannot leave an impossible loading release on its original empty lane', () => {
  const s = state(); add(s, 'LOAD-RESERVED', 'C1', 'TEB9', 5);
  s.tasks.L = { ledger: { taskId: 'L', baselineVersion: s.baseline.version, actual: [], planned: [{ inventoryId: 'LOAD-RESERVED', location: 'C1', destination: 'TEB9', physicalP: 5 }], projectedRemaining: [{ inventoryId: 'LOAD-RESERVED', location: 'C1', destination: 'TEB9', physicalP: 5, releasedSlots: null }] } };
  const result = compute(s, { type: 'move', operationId: 'MOVE-RESERVED', businessDate: '2026-10-30', sourceLocation: 'C1', targetLocation: 'C2', destination: 'TEB9', physicalP: 5 });
  assert(result.ok); assert.equal(sum(result.nextState), 5); assert.equal(result.nextState.tasks.L.ledger.projectedRemaining.length, 0); assert.equal(result.nextState.tasks.L.pendingCode, 'PHYSICAL_PLAN_REVIEW'); assert(result.issues.some(item => item.code === 'LOADING_PLAN_REVIEW'));
});

test('count shortage preserves old loading cumulative while retiring its impossible remaining plan', () => {
  const s = state(); add(s, 'COUNT-RESERVED', 'C1', 'TEB9', 5);
  s.tasks.L = { ledger: { taskId: 'L', baselineVersion: s.baseline.version, actual: [{ inventoryId: 'COUNT-RESERVED', location: 'C1', destination: 'TEB9', physicalP: 2 }], planned: [{ inventoryId: 'COUNT-RESERVED', location: 'C1', destination: 'TEB9', physicalP: 7 }], projectedRemaining: [{ inventoryId: 'COUNT-RESERVED', location: 'C1', destination: 'TEB9', physicalP: 5, releasedSlots: null }] } };
  const result = compute(s, { type: 'count', operationId: 'COUNT-SHORT', businessDate: '2026-10-30', scopeLocations: ['C1'], counts: [{ location: 'C1', destination: 'TEB9', physicalP: 1 }], completeScope: true, acceptDifferences: true });
  assert(result.ok); assert.equal(result.nextState.tasks.L.ledger.actual[0].physicalP, 2); assert.equal(result.nextState.tasks.L.ledger.projectedRemaining.length, 0); assert.equal(result.nextState.baseline.appliedTasks.L.projectedRemaining.length, 0);
});
