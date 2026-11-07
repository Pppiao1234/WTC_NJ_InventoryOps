'use strict';
// Independent 1.2 regression contract. The existing harness and production files are read only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const Load = require('./engine.js');

const harnessFile = __dirname + '/qa.adapter.test.js';
const harnessSource = fs.readFileSync(harnessFile, 'utf8');
const marker = '\nfunction moveInputsBeforeTime';
assert.ok(harnessSource.includes(marker), 'QA harness boundary changed; review the extraction before running');
const sandbox = { require: createRequire(harnessFile), __dirname, console, structuredClone, URL };
vm.createContext(sandbox);
vm.runInContext(harnessSource.slice(0, harnessSource.indexOf(marker)), sandbox, { filename: 'qa.harness.readonly.js' });
const harness = sandbox.harness;

function physical(h) { return h.state().inventory[0].physicalP; }
function uuidRow(h, id = 'task-1') { return h.source.data.findIndex(row => row[24] === id) + 1; }
function expectActual(h, expected) { assert.equal(h.state().tasks['task-1'].ledger.actual[0].physicalP, expected); }
function committedSix(h) {
  h.run();
  assert.equal(physical(h), 14);
  assert.equal(h.counts().ai, 1);
  assert.equal(h.counts().commits, 1);
  expectActual(h, 6);
}
function expectNoNewEffect(h, counts, expectedPhysical = 14) {
  assert.equal(physical(h), expectedPhysical);
  assert.equal(h.counts().ai, counts.ai, 'metadata alone must not call the inventory AI');
  assert.equal(h.counts().commits, counts.commits, 'metadata alone must not produce a stock transaction');
  assert.notEqual(h.state().tasks['task-1'].pending, true, 'same UUID metadata changes must not strand a valid task');
  expectActual(h, 6);
}
function setActualEightAndExpectOnlyTwo(h) {
  const before = h.counts();
  h.source.set(uuidRow(h), 21, 'C1:8');
  h.run();
  h.run();
  assert.equal(physical(h), 12);
  assert.equal(h.counts().ai, before.ai + 1);
  assert.equal(h.counts().commits, before.commits + 1);
  expectActual(h, 8);
}

test('identity 1.2: supplementing Info and reference on the same UUID does not become a new task', () => {
  const h = harness();
  committedSix(h);
  const counts = h.counts();
  h.source.set(2, 5, 'MGE1/CLT2 — Info补充：仓点细节已确认');
  h.source.set(2, 6, 'ref / 新补资料');
  h.run();
  expectNoNewEffect(h, counts);
  setActualEightAndExpectOnlyTwo(h);
});

test('identity 1.2: changing the displayed date keeps cumulative actual under the same UUID', () => {
  const h = harness();
  committedSix(h);
  const counts = h.counts();
  h.source.set(2, 1, '10/31');
  h.run();
  expectNoNewEffect(h, counts);
  setActualEightAndExpectOnlyTwo(h);
});

test('identity 1.2: moving a full row with its UUID and unchanged quantities has no new stock effect', () => {
  const h = harness();
  committedSix(h);
  const counts = h.counts();
  h.source.data.splice(1, 0, Array(25).fill(''));
  h.run();
  assert.equal(uuidRow(h), 3);
  expectNoNewEffect(h, counts);
  setActualEightAndExpectOnlyTwo(h);
});

test('identity 1.2: moving a blank-date row across inherited date sections preserves its UUID history', () => {
  const h = harness();
  const original = h.source.data[1];
  original[0] = '';
  h.source.data = [h.source.data[0], ['10/30'], original, ['10/31']];
  committedSix(h);
  const counts = h.counts();
  h.source.data.push(h.source.data.splice(2, 1)[0]);
  h.run();
  expectNoNewEffect(h, counts);
  setActualEightAndExpectOnlyTwo(h);
});

test('identity 1.2: metadata changed during initial AI review invalidates that snapshot before one successful deduction', () => {
  let calls = 0;
  let h;
  h = harness({ aiHook: ({ source, readState }) => {
    calls++;
    if (calls === 1) source.set(2, 5, 'MGE1/CLT2 / AI处理中补充Info');
    else {
      assert.equal(readState().inventory[0].physicalP, 20, 'the stale first AI approval must not have committed');
      assert.equal(h.counts().commits, 0);
    }
  } });
  h.run();
  h.run();
  assert.equal(calls, 2, 'the changed metadata must be reread and reviewed on the new snapshot');
  assert.equal(physical(h), 14);
  assert.equal(h.counts().commits, 1);
  expectActual(h, 6);
});

test('identity 1.2: metadata changed while reviewing actual 6 to 8 still adds only two after rereading', () => {
  let calls = 0;
  let h;
  h = harness({ aiHook: ({ source, readState }) => {
    calls++;
    if (calls === 2) source.set(2, 5, 'MGE1/CLT2 / 第二次审核补资料');
    if (calls === 3) {
      assert.equal(readState().inventory[0].physicalP, 14);
      assert.equal(h.counts().commits, 1, 'the stale cumulative update must not have committed');
    }
  } });
  committedSix(h);
  h.source.set(2, 21, 'C1:8');
  h.run();
  h.run();
  assert.equal(calls, 3);
  assert.equal(physical(h), 12);
  assert.equal(h.counts().commits, 2);
  expectActual(h, 8);
});

test('identity 1.2: copying A:X without the hidden UUID cannot automatically enroll or deduct again', () => {
  const h = harness();
  committedSix(h);
  const counts = h.counts();
  h.source.data.push(structuredClone(h.source.data[1].slice(0, 24)));
  h.run();
  assert.equal(h.source.getRange(3, 25).getValue(), '', 'an ID-less copy requires explicit task registration');
  assert.equal(physical(h), 14);
  assert.equal(h.counts().ai, counts.ai);
  assert.equal(h.counts().commits, counts.commits);
  assert.deepEqual(Object.keys(h.state().tasks), ['task-1']);
});

test('identity 1.2: cutting A:X while leaving the UUID behind cannot create a second task from the moved values', () => {
  const h = harness();
  committedSix(h);
  const counts = h.counts();
  const visible = structuredClone(h.source.data[1].slice(0, 24));
  for (let i = 0; i < 24; i++) h.source.data[1][i] = '';
  h.source.data.push(visible);
  h.run();
  assert.equal(h.source.getRange(2, 25).getValue(), 'task-1');
  assert.equal(h.source.getRange(3, 25).getValue(), '');
  assert.equal(physical(h), 14);
  assert.equal(h.counts().ai, counts.ai);
  assert.equal(h.counts().commits, counts.commits);
  assert.deepEqual(Object.keys(h.state().tasks), ['task-1']);
  expectActual(h, 6);
});

test('identity 1.2: accidentally clearing a committed row UUID does not auto-assign a replacement identity', () => {
  const h = harness();
  committedSix(h);
  const counts = h.counts();
  h.source.set(2, 25, '');
  h.run();
  assert.equal(h.source.getRange(2, 25).getValue(), '');
  assert.equal(physical(h), 14);
  assert.equal(h.counts().ai, counts.ai);
  assert.equal(h.counts().commits, counts.commits);
  assert.deepEqual(Object.keys(h.state().tasks), ['task-1']);
});

test('identity 1.2: duplicating the complete UUID-bearing row remains blocked', () => {
  const h = harness();
  committedSix(h);
  const counts = h.counts();
  h.source.data.push(structuredClone(h.source.data[1]));
  h.run();
  assert.equal(physical(h), 14);
  assert.equal(h.counts().ai, counts.ai);
  assert.equal(h.counts().commits, counts.commits);
  assert.equal(h.state().tasks['task-1'].pendingCode, 'DUPLICATE_ID');
  expectActual(h, 6);
});

function legacyHash(value) { return crypto.createHash('sha256').update(Load.stableStringify(value)).digest('hex'); }
function seedLegacy11(h) {
  const state = h.state();
  const sourceIdentity = legacyHash({ dateLabel: '10/30', destination: 'MGE1/CLT2', reference: 'ref' });
  state.inventory[0].physicalP = 14;
  state.inventory[0].occupiedSlots = 14;
  state.tasks['task-1'] = {
    sourceIdentity, sourceRow: 2,
    committedHash: legacyHash({ identity: sourceIdentity, status: '已结束', planned: 'C1:8', actual: 'C1:6' }),
    pending: false,
    ledger: { taskId: 'task-1', status: '已结束', baselineVersion: 'BASE-QA',
      actual: [{ inventoryId: 'i1', location: 'C1', destination: 'TEB4', shipmentId: '01003', physicalP: 6, releasedSlots: 6 }],
      planned: [], projectedRemaining: [] }
  };
  h.writeState(state);
}

test('identity 1.2: an existing 1.1 ledger survives metadata changes without replaying its actual six', () => {
  const h = harness();
  seedLegacy11(h);
  h.source.set(2, 5, 'MGE1/CLT2 / 升级后补充Info');
  h.source.set(2, 1, '10/31');
  h.run();
  h.run();
  expectNoNewEffect(h, { ai: 0, commits: 0 });
  setActualEightAndExpectOnlyTwo(h);
});

test('identity 1.2: upgrading an old ledger cannot swallow an actual increase made before the first new sync', () => {
  const h = harness();
  seedLegacy11(h);
  h.source.set(2, 5, 'MGE1/CLT2 / 升级前已补Info和实际');
  h.source.set(2, 1, '10/31');
  h.source.set(2, 21, 'C1:8');
  h.run();
  h.run();
  assert.equal(physical(h), 12, 'migration must retain the old six and post only the newly confirmed two');
  assert.equal(h.counts().ai, 1);
  assert.equal(h.counts().commits, 1);
  expectActual(h, 8);
});

test('identity 1.2: a legacy metadata-only IDENTITY_CHANGED pending task recovers without replaying actual', () => {
  const h = harness();
  seedLegacy11(h);
  const state = h.state();
  Object.assign(state.tasks['task-1'], { pending: true, pendingCode: 'IDENTITY_CHANGED', lastResult: '任务身份信息发生变化，需核实' });
  h.writeState(state);
  h.source.set(2, 5, 'MGE1/CLT2 / 旧版被误挡的Info补充');
  h.run();
  h.run();
  expectNoNewEffect(h, { ai: 0, commits: 0 });
  setActualEightAndExpectOnlyTwo(h);
});

test('identity 1.2: an unknown pasted UUID cannot silently authorize a physical deduction', () => {
  const h = harness({ noId: true });
  h.source.set(2, 25, 'unknown-pasted-uuid');
  h.run();
  assert.equal(physical(h), 20);
  assert.equal(h.counts().ai, 0);
  assert.equal(h.counts().commits, 0);
  assert.equal(h.state().tasks['unknown-pasted-uuid'].pendingCode, 'REGISTRATION_REQUIRED');
  assert.equal(h.state().tasks['unknown-pasted-uuid'].ledger, undefined);
});

test('identity 1.2: an existing task object with unconfirmed registration is still unknown', () => {
  const h = harness({ noId: true });
  h.source.set(2, 25, 'unconfirmed-uuid');
  const state = h.state();
  state.tasks['unconfirmed-uuid'] = { registration: { status: 'pending', method: 'fixture' } };
  h.writeState(state);
  h.run();
  assert.equal(physical(h), 20);
  assert.equal(h.counts().ai, 0);
  assert.equal(h.counts().commits, 0);
  assert.equal(h.state().tasks['unconfirmed-uuid'].pendingCode, 'REGISTRATION_REQUIRED');
  assert.equal(h.state().tasks['unconfirmed-uuid'].ledger, undefined);
});

test('identity 1.2: explicit new-task registration atomically clears copied actual before manual reentry can deduct', () => {
  const batches = [];
  const h = harness({ noId: true, batchHook: body => batches.push(body) });
  h.newTask();
  const id = h.source.getRange(2, 25).getValue();
  assert.ok(id);
  assert.equal(h.source.getRange(2, 21).getValue(), '');
  assert.equal(physical(h), 20);
  assert.equal(h.counts().ai, 0);
  const registration = h.state().tasks[id].registration;
  assert.equal(registration.status, 'confirmed');
  assert.equal(registration.method, 'explicit');
  assert.ok(registration.registeredAt);
  const sourceId = h.source.getSheetId(), stateId = h.sheets.get('_WTC状态').getSheetId();
  assert.ok(batches.some(body => body.requests.some(request => request.updateCells?.range.sheetId === stateId) &&
    body.requests.some(request => request.updateCells?.range.sheetId === sourceId && request.updateCells.range.startColumnIndex === 24) &&
    body.requests.some(request => request.updateCells?.range.sheetId === sourceId && request.updateCells.range.startColumnIndex === 20)),
  'the state registration, source UUID and actual reset must be in one Sheets transaction');
  h.run();
  assert.equal(physical(h), 20, 'the copied actual six must not survive task registration');
  assert.equal(h.counts().ai, 0);
  assert.equal(h.state().tasks[id].ledger, undefined);
  h.source.set(2, 21, 'C1:6');
  h.run();
  h.run();
  assert.equal(physical(h), 14);
  assert.equal(h.counts().ai, 1);
  assert.equal(h.counts().commits, 1);
  assert.equal(h.state().tasks[id].ledger.actual[0].physicalP, 6);
  h.run();
  assert.equal(physical(h), 14);
  assert.equal(h.counts().commits, 1);
});

test('identity 1.2: failed registration transaction preserves both source actual and unregistered state', () => {
  const h = harness({ noId: true, failRegistration: true });
  assert.throws(() => h.newTask(), /SHEETS_COMMIT_503/);
  assert.equal(h.source.getRange(2, 25).getValue(), '');
  assert.equal(h.source.getRange(2, 21).getValue(), 'C1:6');
  assert.deepEqual(Object.keys(h.state().tasks), []);
  assert.equal(physical(h), 20);
  assert.equal(h.state().version, 1);
  assert.equal(h.counts().ai, 0);
});
