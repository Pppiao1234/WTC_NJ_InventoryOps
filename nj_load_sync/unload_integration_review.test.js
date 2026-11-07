'use strict';
// Independent integration review. No network or Google Sheet writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const Load = require('./engine.js');
const Unload = require('./unload_engine.js');

const copy = value => structuredClone(value);
function allocation(taskId, extra = {}) {
  return { publicationId: 'paper-1', revision: '1', allocationId: taskId + '-group-1', taskId,
    containerNo: 'CN-' + taskId, destination: 'TEB9', shipmentId: '01003', location: 'C1',
    route: 'ordinary', estimatedP: 6, estimatedSlots: 6, finalLocation: '', specialType: '', published: true, ...extra };
}
function unload(taskId, status = '在拆', extra = {}, previous) {
  const allocations = Array.isArray(extra) ? extra : [allocation(taskId, extra)];
  const result = Unload.computeUnloadEffect({ taskId, status, publicationId: 'paper-1', revision: '1', allocations, previous });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.actualDeltas, [], 'state observations must not manufacture receipts');
  return result;
}
function inventory(extra = {}) {
  return [{ inventoryId: 'stock-1', location: 'C1', destination: 'TEB9', shipmentId: '01003',
    physicalP: 20, occupiedSlots: 20, slotBasis: 'one_per_pallet', capacitySlots: 27, ...extra }];
}
function loading(extra = {}) {
  return Load.computeLoadingEffect({ taskId: 'truck-1', status: '已开始', plannedText: 'C1:8', actualText: '',
    destination: 'TEB9', allowedLocations: ['C1', 'C2', '检查区'], baseline: { confirmed: true, version: 'b1', appliedTasks: {} },
    inventory: inventory(), otherTaskPlans: [], ...extra });
}

test('integration: forecast release and incoming reservation share one capacity without creating physical stock', () => {
  const incoming = unload('cab-1');
  const activeTruck = loading();
  assert.equal(activeTruck.ok, true);
  const initialInventory = copy(activeTruck.inventoryAfter);
  const context = { inventory: activeTruck.inventoryAfter, loadingTasks: { truck: { ledger: activeTruck.nextLedger } },
    unloadTasks: { cab: { ledger: incoming.nextLedger } }, capacities: { C1: 27 } };
  const planned = Unload.aggregateReservations(context);
  assert.equal(planned.byLocation.C1.actualOccupiedSlots, 20);
  assert.equal(planned.byLocation.C1.incomingEstimatedSlots, 6);
  assert.equal(planned.byLocation.C1.plannedLoadingReleaseSlots, 8);
  assert.equal(planned.byLocation.C1.usableProjectedSlots, 9);
  assert.deepEqual(context.inventory, initialInventory);
  const finishedTruck = loading({ status: '已结束', actualText: 'C1:6', inventory: activeTruck.inventoryAfter, previous: activeTruck.nextLedger });
  assert.equal(finishedTruck.ok, true);
  const finished = Unload.aggregateReservations({ ...context, inventory: finishedTruck.inventoryAfter,
    loadingTasks: { truck: { ledger: finishedTruck.nextLedger } } });
  assert.equal(finished.byLocation.C1.usableProjectedSlots, 7, '8 forecast followed by 6 actual gives back 2 capacity');
  assert.equal(finishedTruck.inventoryAfter[0].physicalP, 14, 'incoming estimate did not replenish the source stock');
  const replay = unload('cab-1', '在拆', {}, incoming.nextLedger);
  assert.equal(replay.changed, false);
  assert.equal(Unload.aggregateReservations({ ...context, inventory: finishedTruck.inventoryAfter,
    unloadTasks: { cab: { ledger: replay.nextLedger } }, loadingTasks: {} }).byLocation.C1.usableProjectedSlots, 7);
});

test('integration: planned, active and emptied ordinary groups never reserve twice or disappear', () => {
  const waiting = unload('cab-1', '未到');
  const waitingView = Unload.aggregateReservations({ inventory: inventory(), unloadTasks: [waiting.nextLedger] });
  assert.equal(waitingView.byLocation.C1.incomingEstimatedSlots, 6, 'published paper keeps its promised space before work starts');
  assert.equal(waitingView.byLocation.C1.usableProjectedSlots, 1);
  assert.deepEqual(waiting.actualDeltas, []);
  const active = unload('cab-1', '在拆', {}, waiting.nextLedger);
  const emptied = unload('cab-1', '拆空', {}, active.nextLedger);
  const view = Unload.aggregateReservations({ inventory: inventory(), unloadTasks: [emptied.nextLedger] });
  assert.equal(view.byLocation.C1.incomingEstimatedP, 6);
  assert.equal(view.byLocation.C1.incomingEstimatedSlots, 6);
  assert.equal(view.byLocation.C1.usableProjectedSlots, 1);
  assert.equal(emptied.nextLedger.physicalInventoryPosted, false);
});

test('integration: two normal cargo groups from different containers can share a line', () => {
  const a = unload('cab-a', '在拆', { estimatedP: 3, estimatedSlots: 3 });
  const b = unload('cab-b', '在拆', { estimatedP: 2, estimatedSlots: 2, shipmentId: '00017' });
  const view = Unload.aggregateReservations({ inventory: inventory(), unloadTasks: [a.nextLedger, b.nextLedger] });
  assert.equal(view.byLocation.C1.incomingEstimatedP, 5);
  assert.equal(view.byLocation.C1.usableProjectedSlots, 2);
  assert.equal(view.byLocation.C1.specialConcurrencyConflict, false);
  assert.equal(view.autoAllocationBlocked, false);
});

test('integration: different active special containers cannot share a direct line even when capacity fits', () => {
  const a = unload('cab-a', '在拆', { route: 'special_direct', estimatedP: 2, estimatedSlots: 2, specialType: 'special' });
  const b = unload('cab-b', '在拆', { route: 'special_direct', estimatedP: 2, estimatedSlots: 2, specialType: 'special' });
  const view = Unload.aggregateReservations({ inventory: inventory(), unloadTasks: [a.nextLedger, b.nextLedger] });
  assert.equal(view.byLocation.C1.usableProjectedSlots, 3);
  assert.equal(view.byLocation.C1.specialConcurrencyConflict, true);
  assert.equal(view.autoAllocationBlocked, true);
  assert.ok(view.issues.some(issue => issue.code === 'SPECIAL_LINE_CONCURRENCY'));
});

test('integration: unknown stacking does not release planned pallet count as usable slots', () => {
  const stock = inventory({ occupiedSlots: null, slotBasis: 'unknown' });
  const truck = loading({ inventory: stock });
  assert.equal(truck.ok, true);
  const view = Unload.aggregateReservations({ inventory: truck.inventoryAfter,
    loadingTasks: [{ ledger: truck.nextLedger }], unloadTasks: [unload('cab-1').nextLedger] });
  assert.equal(view.byLocation.C1.plannedLoadingReleaseSlots, null);
  assert.equal(view.byLocation.C1.actualOccupiedSlots, null);
  assert.equal(view.byLocation.C1.usableProjectedSlots, null);
  assert.equal(view.byLocation.C1.conservativeOccupiedSlots, 20);
});

test('integration: multiple physical rows in one lane count its capacity once', () => {
  const stock = inventory({ physicalP: 15, occupiedSlots: 15 });
  stock.push({ ...stock[0], inventoryId: 'stock-2', shipmentId: '00100', physicalP: 5, occupiedSlots: 5 });
  const view = Unload.aggregateReservations({ inventory: stock, unloadTasks: [unload('cab-1').nextLedger] });
  assert.equal(view.byLocation.C1.actualOccupiedSlots, 20);
  assert.equal(view.byLocation.C1.capacitySlots, 27);
  assert.equal(view.byLocation.C1.usableProjectedSlots, 1);
});

test('integration: unload estimates never become loadable inventory', () => {
  const incoming = unload('cab-1', '拆空');
  const result = loading({ inventory: [], status: '已结束', actualText: 'C1:1' });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.code === 'INVENTORY_NOT_FOUND'));
  assert.deepEqual(result.inventoryAfter, []);
  assert.equal(incoming.nextLedger.physicalInventoryPosted, false);
});

test('integration: emptying a special container frees inspection but retains its unconfirmed cargo', () => {
  const group = { location: '检查区', route: 'via_inspection', estimatedP: 43, estimatedSlots: 43, specialType: 'special' };
  const active = unload('cab-1', '在拆', group);
  const emptied = unload('cab-1', '拆空', group, active.nextLedger);
  const activeView = Unload.aggregateReservations([active.nextLedger]);
  const emptiedView = Unload.aggregateReservations([emptied.nextLedger]);
  assert.equal(activeView.inspection.estimatedP, 43);
  assert.equal(emptiedView.inspection.estimatedP, 0);
  assert.equal(emptiedView.unresolved.reduce((sum, row) => sum + row.estimatedP, 0), 43);
  assert.equal(emptiedView.autoAllocationBlocked, true);
  assert.ok(emptiedView.unresolved.every(row => row.location === null));
});

test('integration: an unrecorded lane is unknown, and a capacity catalog alone does not prove it empty', () => {
  const incoming = unload('cab-1', '在拆', { location: 'C2' });
  const view = Unload.aggregateReservations({ inventory: inventory(), unloadTasks: [incoming.nextLedger], capacities: { C1: 27, C2: 27 } });
  assert.equal(view.byLocation.C2.actualOccupiedSlots, null);
  assert.equal(view.byLocation.C2.usableProjectedSlots, null);
  assert.equal(view.autoAllocationBlocked, true);
});

test('integration: inspection hard limit includes its existing physical stock and incoming group', () => {
  const incoming = unload('cab-1', '在拆', { location: '检查区', route: 'via_inspection', estimatedP: 43, estimatedSlots: 43 });
  const stock = [{ inventoryId: 'inspection-stock', location: '检查区', physicalP: 28, occupiedSlots: 28, slotBasis: 'one_per_pallet' }];
  const view = Unload.aggregateReservations({ inventory: stock, unloadTasks: [incoming.nextLedger] });
  assert.equal(view.autoAllocationBlocked, true);
  assert.equal(view.inspection.exceedsHardLimit, true, '28 already present plus 43 incoming exceeds 70 even without a capacity catalog');
});

test('integration: legacy unknown stacking does not block a different confirmed line', () => {
  const stock = inventory();
  for (const [location, destination, physicalP, capacitySlots] of [['F5', 'ABE8', 30, 27], ['E6', 'RDU2', 28, 27], ['C8', 'BWI4', 28, 27], ['Y7', 'MEM1', 13, 10]]) {
    stock.push({ inventoryId: 'stock-' + location, location, destination, physicalP, occupiedSlots: null, slotBasis: 'unknown', capacitySlots });
  }
  const view = Unload.aggregateReservations({ inventory: stock, unloadTasks: [unload('cab-1').nextLedger] });
  assert.equal(view.byLocation.C1.usableProjectedSlots, 1);
  assert.equal(view.autoAllocationBlocked, false, 'unknown lawful stacking on unrelated lines is not proof this allocation conflicts');
  for (const location of ['F5', 'E6', 'C8', 'Y7']) {
    assert.equal(view.byLocation[location].actualOccupiedSlots, null);
    assert.equal(view.byLocation[location].usableProjectedSlots, null);
    assert.ok(view.byLocation[location].conservativeProjectedSlots < 0);
  }
});

test('integration: capacity sources cannot silently override one another', () => {
  const view = Unload.aggregateReservations({ inventory: inventory(), capacities: { C1: 54 }, unloadTasks: [unload('cab-1').nextLedger] });
  assert.equal(view.autoAllocationBlocked, true);
  assert.ok(view.issues.some(issue => issue.code === 'CONFLICTING_CAPACITY'));
});

test('integration: the same container ledger cannot be counted twice as two valid cargo groups', () => {
  const ledger = unload('cab-1').nextLedger;
  const view = Unload.aggregateReservations({ inventory: inventory({ physicalP: 10, occupiedSlots: 10 }), unloadTasks: [ledger, copy(ledger)] });
  assert.ok(view.byLocation.C1.incomingEstimatedP === 6 || view.autoAllocationBlocked === true,
    'duplicate task ledgers must be deduplicated or explicitly rejected, never accepted twice');
});

test('integration: a known physical upper bound can permit a conservative allocation without pretending slots are measured', () => {
  const stock = inventory({ physicalP: 10, occupiedSlots: null, slotBasis: 'unknown' });
  const view = Unload.aggregateReservations({ inventory: stock, unloadTasks: [unload('cab-1').nextLedger] });
  assert.equal(view.byLocation.C1.actualOccupiedSlots, null);
  assert.equal(view.byLocation.C1.usableProjectedSlots, null);
  assert.equal(view.byLocation.C1.conservativeProjectedSlots, 11);
  assert.equal(view.autoAllocationBlocked, false, 'a conservative 10+6 upper bound fits 27, even though measured occupied slots are unknown');
});

test('integration: all prestart observations keep paper reservations separate from active estimates', () => {
  for (const status of ['未到', '已到', '未观测', '']) {
    const planned = unload('cab-1', status);
    const stock = inventory(), snapshot = copy(stock);
    const view = Unload.aggregateReservations({ inventory: stock, unloadTasks: [planned.nextLedger] });
    assert.equal(view.byLocation.C1.plannedHoldSlots, 6);
    assert.equal(view.byLocation.C1.activeEstimatedSlots, 0);
    assert.equal(view.byLocation.C1.actualOccupiedSlots, 20);
    assert.deepEqual(stock, snapshot);
    const started = unload('cab-1', '在拆', {}, planned.nextLedger);
    const activeView = Unload.aggregateReservations({ inventory: stock, unloadTasks: [started.nextLedger] });
    assert.equal(activeView.byLocation.C1.plannedHoldSlots, 0);
    assert.equal(activeView.byLocation.C1.activeEstimatedSlots, 6);
    assert.equal(activeView.byLocation.C1.incomingEstimatedSlots, 6);
  }
});

test('integration: inspection paper hold changes phase once and is released only after emptying', () => {
  const group = { location: '检查区', route: 'via_inspection', estimatedP: 43, estimatedSlots: 43 };
  const stock = [{ inventoryId: 'inspection-empty', location: '检查区', physicalP: 0, occupiedSlots: 0, slotBasis: 'one_per_pallet', capacitySlots: 70 }];
  const planned = unload('cab-1', '未到', group);
  const active = unload('cab-1', '在拆', group, planned.nextLedger);
  const emptied = unload('cab-1', '拆空', group, active.nextLedger);
  for (const ledger of [planned.nextLedger, active.nextLedger]) {
    const view = Unload.aggregateReservations({ inventory: stock, unloadTasks: [ledger] });
    assert.equal(view.inspection.totalProjectedP, 43);
    assert.equal(view.byLocation['检查区'].usableProjectedSlots, 27);
    assert.equal(view.autoAllocationBlocked, false);
  }
  const finalView = Unload.aggregateReservations({ inventory: stock, unloadTasks: [emptied.nextLedger] });
  assert.equal(finalView.inspection.totalProjectedP, 0);
  assert.equal(finalView.byLocation['检查区'].usableProjectedSlots, 70);
  assert.equal(finalView.unresolved[0].estimatedP, 43);
  assert.equal(finalView.autoAllocationBlocked, true);
  assert.equal(stock[0].physicalP, 0);
});

test('integration: a full-line label protects capacity without inventing measured pallets or occupancy', () => {
  const absent = Unload.aggregateReservations({ inventory: [], capacities: { C2: { capacitySlots: 27, status: '满线' } } });
  assert.equal(absent.byLocation.C2.actualOccupiedSlots, null);
  assert.equal(absent.byLocation.C2.actualPhysicalP, null);
  assert.equal(absent.byLocation.C2.usableProjectedSlots, 0);
  assert.equal(absent.byLocation.C2.catalogProtectedSlots, 27);
  const stock = inventory({ physicalP: 5, occupiedSlots: 5 });
  const present = Unload.aggregateReservations({ inventory: stock, capacities: { C1: { capacitySlots: 27, status: '满线' } },
    unloadTasks: [unload('cab-1').nextLedger] });
  assert.equal(present.byLocation.C1.actualOccupiedSlots, 5);
  assert.equal(present.byLocation.C1.actualPhysicalP, 5);
  assert.equal(present.byLocation.C1.usableProjectedSlots, 0);
  assert.equal(present.autoAllocationBlocked, true);
  assert.equal(stock[0].physicalP, 5);
});
