/* Independent loading intake. Schedule row position is never an accounting identity. */
var WTCLoadingPortalCore = (function () {
  'use strict';
  var VERSION = '1.5.0';
  var STATES = ['未靠台在等', '靠台在等', '未到', '未开始', '已开始', '在装', '已结束', '已完成', '装车完成', '留台等货', '留台', '取消', '已取消'];
  var KINDS = ['plan', 'actual', 'status', 'correction'];
  function text(value) { return value == null ? '' : String(value).trim(); }
  function copy(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort().filter(function (key) { return value[key] !== undefined; }).map(function (key) { return JSON.stringify(key) + ':' + stableStringify(value[key]); }).join(',') + '}';
  }
  function fingerprint(value) { var raw = stableStringify(value), n = 2166136261; for (var i = 0; i < raw.length; i++) { n ^= raw.charCodeAt(i); n = Math.imul(n, 16777619); } return ('00000000' + (n >>> 0).toString(16)).slice(-8); }
  function issue(code, message, detail) { return Object.assign({ code: code, message: message, severity: 'error' }, detail || {}); }
  function failed(code, message, detail) { return { ok: false, noOp: false, issues: [issue(code, message, detail)] }; }
  function safeId(value) { var id = text(value); return id && id.length <= 160 && !/[\r\n\t\u001f]/.test(id) && ['__proto__', 'constructor', 'prototype'].indexOf(id) < 0 ? id : ''; }
  function identity(value) { return text(value).replace(/\s+/g, ' ').toUpperCase(); }
  function date(value) { var raw = text(value); if (!/^20\d{2}-\d{2}-\d{2}$/.test(raw)) return ''; var parsed = new Date(raw + 'T00:00:00Z'); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw ? raw : ''; }
  function core() { if (typeof WTCLoadCore !== 'undefined') return WTCLoadCore; if (typeof require === 'function') return require('./engine.js'); throw new Error('缺少 WTCLoadCore。'); }
  function portal(state) { return state && state.loadingPortal && state.loadingPortal.version === VERSION ? state.loadingPortal : null; }
  function mapText(entries) {
    var groups = {};
    (entries || []).forEach(function (entry) {
      var location = text(entry.location), destination = text(entry.destination), shipment = text(entry.shipmentId), key = location + '\u001f' + destination + '\u001f' + shipment;
      if (!groups[key]) groups[key] = { location: location, destination: destination, shipmentId: shipment, physicalP: 0 };
      groups[key].physicalP += Number(entry.physicalP) || 0;
    });
    return Object.keys(groups).sort().map(function (key) { var entry = groups[key]; return entry.location + (entry.destination || entry.shipmentId ? ' ' + entry.destination : '') + (entry.shipmentId ? '@' + entry.shipmentId : '') + ':' + entry.physicalP; }).join('；');
  }
  function ledgerEntries(entries) {
    var groups = {};
    (entries || []).forEach(function (entry) {
      var key = text(entry.location) + '\u001f' + text(entry.destination) + '\u001f' + text(entry.shipmentId), row = groups[key];
      if (!row) row = groups[key] = { location: entry.location, destination: entry.destination || null, shipmentId: entry.shipmentId || null, physicalP: 0, releasedSlots: 0 };
      row.physicalP += entry.physicalP;
      row.releasedSlots = Number.isInteger(row.releasedSlots) && Number.isInteger(entry.releasedSlots) ? row.releasedSlots + entry.releasedSlots : null;
    });
    return Object.keys(groups).sort().map(function (key) { return groups[key]; });
  }
  function canonicalMap(value, allowed, zeroEntries) {
    var parsed = core().parseMap(value, { allowedLocations: allowed, zeroEntries: zeroEntries || [] });
    return { known: parsed.known, entries: parsed.entries, text: parsed.known ? mapText(parsed.entries) : '' };
  }
  function committedLedger(state, taskId) { return (((state.tasks || {})[taskId] || {}).ledger) || (((state.baseline || {}).appliedTasks || {})[taskId]); }
  function explicitZero(value) { try { var parsed = core().parseMap(value); return parsed.known && parsed.entries.length > 0 && parsed.entries.every(function (entry) { return entry.physicalP === 0; }); } catch (error) { return false; } }
  function committedActual(state, task) {
    var ledger = committedLedger(state, task.taskId);
    if (ledger && (ledger.actual || []).length) return mapText(ledger.actual);
    return task.actualKnown === true && explicitZero(task.committedActualText) ? task.committedActualText : '';
  }
  function upgrade(args) {
    args = args || {}; var state = args.state || {}, next = copy(state), now = text(args.now), existing = portal(state);
    if (existing) return { ok: true, noOp: true, issues: [], nextState: next, report: { migratedTasks: 0, alreadyUpgraded: true } };
    if (state.loadingPortal) return failed('PORTAL_VERSION_REVIEW', '已有不同版本的装车集成记录，未覆盖。');
    next.tasks = next.tasks || {};
    var p = { version: VERSION, tasks: {}, requests: {}, creationRequests: {}, imports: {}, upgradedAt: now }, ids = {}, migrated = 0, unconfirmed = 0, reviews = [];
    Object.keys(state.tasks || {}).concat(Object.keys((state.baseline || {}).appliedTasks || {})).forEach(function (id) { ids[id] = true; });
    Object.keys(ids).sort().forEach(function (id) {
      if (!safeId(id)) { unconfirmed++; reviews.push({ taskId: id, code: 'INVALID_LEGACY_ID' }); return; }
      var old = (state.tasks || {})[id] || {}, offset = (((state.baseline || {}).appliedTasks || {})[id]), ledger = old.ledger || offset;
      var registered = old.registration && old.registration.status === 'confirmed';
      if (!ledger && !registered) { unconfirmed++; return; }
      var meta = old.sourceMetadata || {}, pending = old.pending || old.bindingReview, hasActual = ledger && Array.isArray(ledger.actual), hasPlan = ledger && Array.isArray(ledger.planned);
      var status = ledger && STATES.indexOf(text(ledger.status)) >= 0 ? text(ledger.status) : hasActual && ledger.actual.some(function (entry) { return entry.physicalP > 0; }) ? '已开始' : '未开始';
      var legacyReview = pending ? { pendingCode: old.pendingCode || (old.bindingReview ? 'SOURCE_BINDING_REVIEW' : 'LEGACY_PENDING'), message: old.lastResult || '旧接龙有未处理填写；未作为新的装车实数。' } : null;
      p.tasks[id] = { taskId: id, label: text(meta.info) || text(meta.reference) || id, businessDate: date(meta.dateLabel) || '', sourceDateLabel: text(meta.dateLabel), reference: text(meta.reference), dock: text(meta.dock), revision: 0, plannedText: hasPlan ? mapText(ledger.planned) : '', savedPlannedText: hasPlan ? mapText(ledger.planned) : '', bookedPlannedText: hasPlan ? mapText(ledger.planned) : '', actualText: hasActual ? mapText(ledger.actual) : '', committedActualText: hasActual ? mapText(ledger.actual) : '', actualKnown: !!(hasActual && ledger.actual.length), planNeedsReview: old.pendingCode === 'PHYSICAL_PLAN_REVIEW', status: status, pendingRequestId: '', lastRequestId: '', processingStatus: legacyReview ? 'review' : 'migrated', lastResult: legacyReview ? '已承接原已记累计；旧表未处理内容需在集成中核对提交。' : '已承接原已记累计；本次迁移未扣库存。', legacyImported: true, legacyReview: legacyReview, createdAt: now, updatedAt: now };
      if (legacyReview) reviews.push({ taskId: id, code: legacyReview.pendingCode });
      // Archive row-bound pending messages so the disabled legacy input cannot
      // look like a live automatic source. A physical-plan review stays active.
      if (next.tasks[id] && old.pendingCode !== 'PHYSICAL_PLAN_REVIEW') {
        next.tasks[id].legacyPortalMigration = { migratedAt: now, pending: !!old.pending, pendingCode: old.pendingCode || '', bindingReview: !!old.bindingReview, lastResult: old.lastResult || '' };
        next.tasks[id].pending = false; next.tasks[id].pendingHash = ''; next.tasks[id].pendingAccountingHash = ''; next.tasks[id].pendingCode = ''; next.tasks[id].bindingReview = false;
      }
      migrated++;
    });
    next.loadingPortal = p;
    return { ok: true, noOp: false, issues: [], nextState: next, report: { migratedTasks: migrated, unconfirmedLegacyTasks: unconfirmed, reviews: reviews, inventoryUnchanged: true } };
  }
  function createTask(args) {
    args = args || {}; var state = args.state || {}, p = portal(state), input = args.input || {}, id = safeId(input.taskId), requestId = safeId(input.requestId), now = text(args.now);
    if (!p) return failed('PORTAL_NOT_UPGRADED', '装车集成尚未升级。');
    if (!id || !requestId) return failed('CREATE_ID_REQUIRED', '需要稳定的任务编号和创建提交编号。');
    var businessDate = date(input.businessDate), label = text(input.label), reference = text(input.reference), dock = text(input.dock), importKey = text(input.importKey);
    if (!businessDate || !label) return failed('CREATE_FIELDS_REQUIRED', '请选择业务日期并填写可识别的装车说明。');
    if (label.length > 600 || reference.length > 300 || dock.length > 80 || importKey.length > 300) return failed('CREATE_FIELDS_LENGTH', '装车说明或关联信息过长。');
    if (importKey && (['__proto__', 'constructor', 'prototype'].indexOf(importKey) >= 0 || /[\r\n\t\u001f]/.test(importKey))) return failed('IMPORT_KEY_INVALID', '原始任务关联编号无效。');
    var payload = { businessDate: businessDate, label: label, reference: reference, dock: dock, importKey: importKey, newTripConfirmed: input.newTripConfirmed === true, newTripReason: text(input.newTripReason) }, inputHash = fingerprint(payload), previous = (p.creationRequests || {})[requestId];
    if (previous) {
      if (previous.inputHash !== inputHash || stableStringify(previous.payload) !== stableStringify(payload)) return failed('CREATE_REQUEST_REUSED', '同一创建编号已有不同内容，未新建任务。');
      return { ok: true, noOp: true, issues: [], nextState: copy(state), task: copy(p.tasks[previous.taskId]), report: { reusedTask: true } };
    }
    if (importKey && p.imports && p.imports[importKey]) {
      var imported = p.tasks[p.imports[importKey]];
      return { ok: true, noOp: true, issues: [], nextState: copy(state), task: copy(imported), report: { reusedImport: true } };
    }
    if (p.tasks[id] || (state.tasks || {})[id] || (((state.baseline || {}).appliedTasks || {})[id])) return failed('TASK_ID_EXISTS', '任务编号已存在，请打开原任务。');
    var key = businessDate + '|' + identity(reference || label), candidates = Object.keys(p.tasks).filter(function (keyId) { var task = p.tasks[keyId]; return (task.businessDate === businessDate || task.legacyImported && !task.businessDate) && identity(task.reference || task.label) === identity(reference || label) && ['取消', '已取消'].indexOf(task.status) < 0; });
    if (candidates.length && !(payload.newTripConfirmed && payload.newTripReason)) return failed('DUPLICATE_TASK_REVIEW', '同日已有相同装车号或说明，请选择原任务；确属另一车次时需明确确认。', { candidateTaskIds: candidates });
    var next = copy(state), target = next.loadingPortal;
    var task = { taskId: id, label: label, businessDate: businessDate, sourceDateLabel: businessDate, reference: reference, dock: dock, revision: 0, plannedText: '', savedPlannedText: '', bookedPlannedText: '', actualText: '', committedActualText: '', actualKnown: false, planNeedsReview: false, status: '未开始', pendingRequestId: '', lastRequestId: '', processingStatus: 'draft', lastResult: '独立装车任务已建立；尚未提交板数，未扣库存。', legacyImported: false, createdAt: now, updatedAt: now, duplicateKey: key, newTripReason: payload.newTripConfirmed ? payload.newTripReason : '' };
    target.tasks[id] = task; target.creationRequests = target.creationRequests || {}; target.creationRequests[requestId] = { taskId: id, inputHash: inputHash, payload: payload, createdAt: now };
    target.imports = target.imports || {}; if (importKey) target.imports[importKey] = id;
    next.tasks = next.tasks || {}; next.tasks[id] = { registration: { status: 'confirmed', method: 'loading_portal', registeredAt: now }, pending: false, lastResult: '独立装车任务已建立，等待提交。' };
    return { ok: true, noOp: false, issues: [], nextState: next, task: copy(task) };
  }
  function semantic(request) { return { taskId: request.taskId, status: request.status, plannedText: request.plannedText, actualText: request.actualText, correctionReason: request.correctionReason || '' }; }
  function submit(args) {
    args = args || {}; var state = args.state || {}, p = portal(state), input = args.input || {}, taskId = safeId(input.taskId), requestId = safeId(input.requestId), now = text(args.now), kind = text(input.kind);
    if (!p) return failed('PORTAL_NOT_UPGRADED', '装车集成尚未升级。');
    if (!taskId || !requestId || KINDS.indexOf(kind) < 0) return failed('SUBMISSION_ID_KIND', '需要原任务、稳定提交编号和明确的提交类型。');
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) return failed('REVISION_REQUIRED', '请重新打开任务后提交，不能省略版本号。');
    var task = p.tasks[taskId]; if (!task) return failed('PORTAL_TASK_NOT_FOUND', '找不到独立装车任务，未按接龙行号猜测。');
    var allowed = (state.inventory || []).map(function (row) { return row.location; }), given = { taskId: taskId, expectedRevision: input.expectedRevision, kind: kind }, plan, actual;
    if (Object.prototype.hasOwnProperty.call(input, 'status')) given.status = text(input.status);
    if (Object.prototype.hasOwnProperty.call(input, 'plannedText')) given.plannedText = text(input.plannedText);
    if (Object.prototype.hasOwnProperty.call(input, 'actualText')) given.actualText = text(input.actualText);
    if (Object.prototype.hasOwnProperty.call(input, 'correctionReason')) given.correctionReason = text(input.correctionReason);
    // Explicitly ignore a client correctionAuthorized flag. Only the trusted
    // owner adapter may stamp authorization after this queue operation succeeds.
    var original = (p.requests || {})[requestId], originalHash = fingerprint(given);
    if (original) {
      if (original.originalHash !== originalHash || stableStringify(original.originalPayload) !== stableStringify(given)) return failed('SUBMISSION_ID_REUSED', '相同提交编号已有不同内容，未覆盖原记录。');
      return { ok: true, noOp: true, issues: [], nextState: copy(state), task: copy(task), request: copy(original) };
    }
    if (input.expectedRevision !== task.revision) return failed('STALE_TASK_REVISION', '任务已有新提交，请刷新后按最新累计填写。', { currentRevision: task.revision });
    if (task.pendingRequestId) return failed('TASK_SUBMISSION_PENDING', '本任务上一份提交仍在处理，请等待结果后刷新。', { requestId: task.pendingRequestId });
    var status = given.status || task.status, reason = kind === 'correction' ? text(input.correctionReason) : '';
    if (STATES.indexOf(status) < 0) return failed('UNKNOWN_STATUS', '请选择明确的装车状态。');
    if (kind === 'correction' && !reason) return failed('CORRECTION_REASON_REQUIRED', '实际累计减少或改错需要明确更正原因。');
    if (kind === 'plan' && !Object.prototype.hasOwnProperty.call(input, 'plannedText')) return failed('PLAN_REQUIRED', '预计提交需填写逐库位预计量。');
    if ((kind === 'actual' || kind === 'correction') && !Object.prototype.hasOwnProperty.call(input, 'actualText')) return failed('ACTUAL_REQUIRED', '实际提交需填写逐库位当前累计量。');
    if (kind === 'plan' && Object.prototype.hasOwnProperty.call(input, 'actualText') && text(input.actualText) !== text(task.actualText)) return failed('WRONG_SUBMISSION_FIELD', '预计提交不能同时改变实际累计。');
    if ((kind === 'actual' || kind === 'correction') && Object.prototype.hasOwnProperty.call(input, 'plannedText') && text(input.plannedText) !== text(task.plannedText)) return failed('WRONG_SUBMISSION_FIELD', '实际提交不能同时改变预计量。');
    if (kind === 'status' && ((Object.prototype.hasOwnProperty.call(input, 'plannedText') && text(input.plannedText) !== text(task.plannedText)) || (Object.prototype.hasOwnProperty.call(input, 'actualText') && text(input.actualText) !== text(task.actualText)))) return failed('WRONG_SUBMISSION_FIELD', '状态提交不能夹带数量变化。');
    try {
      plan = canonicalMap(kind === 'plan' ? input.plannedText : task.plannedText, allowed);
      actual = canonicalMap(kind === 'actual' || kind === 'correction' ? input.actualText : task.actualText, allowed, plan.entries);
    } catch (error) { return failed(error.code || 'INPUT_INVALID', error.message); }
    if (kind === 'plan' && !plan.known) return failed('PLAN_UNKNOWN', '空白不是已确认预计量，请填明确库位和板数。');
    if ((kind === 'actual' || kind === 'correction') && !actual.known) return failed('ACTUAL_UNKNOWN', '实际空白代表未知，不能当作0提交；请填明确库位及当前累计量。');
    if (['已结束', '已完成', '装车完成', '留台等货', '留台'].indexOf(status) >= 0 && !actual.known) return failed('FINISHED_ACTUAL_UNKNOWN', '结束装车前需提交明确的实际累计，不能沿用预计量。');
    var request = { requestId: requestId, taskId: taskId, expectedRevision: input.expectedRevision, revision: task.revision + 1, kind: kind, plannedText: plan.text, actualText: actual.text, status: status, correctionReason: reason, correctionAuthorized: false, planInvalidatedAtSubmission: !!task.planNeedsReview || (((state.tasks || {})[taskId] || {}).pendingCode === 'PHYSICAL_PLAN_REVIEW'), previousTaskValues: { plannedText: task.plannedText, actualText: task.actualText, status: task.status }, originalPayload: given, originalHash: originalHash, createdAt: now, stage: 'pending', result: '' };
    request.inputHash = fingerprint(semantic(request));
    var last = task.lastRequestId && p.requests[task.lastRequestId];
    if (last && last.stage === 'processed' && stableStringify(semantic(last)) === stableStringify(semantic(request))) return { ok: true, noOp: true, issues: [], nextState: copy(state), task: copy(task), request: copy(last) };
    var next = copy(state), nextTask = next.loadingPortal.tasks[taskId];
    next.loadingPortal.requests[requestId] = request;
    nextTask.revision = request.revision; nextTask.plannedText = plan.text; nextTask.actualText = actual.text; nextTask.status = status; nextTask.pendingRequestId = requestId; nextTask.lastRequestId = requestId; nextTask.processingStatus = 'pending'; nextTask.lastResult = '已接收，待后台核查；尚未据此确认库存变化。'; nextTask.updatedAt = now;
    return { ok: true, noOp: false, issues: [], nextState: next, task: copy(nextTask), request: copy(request) };
  }
  function jobForCore(args) {
    args = args || {}; var state = args.state || {}, p = portal(state); if (!p) return failed('PORTAL_NOT_UPGRADED', '装车集成尚未升级。');
    var requestId = text(args.requestId), requests = Object.keys(p.requests || {}).map(function (id) { return p.requests[id]; }).filter(function (entry) { return entry.stage === 'pending' && (!requestId || entry.requestId === requestId); }).sort(function (a, b) { return text(a.createdAt).localeCompare(text(b.createdAt)) || a.requestId.localeCompare(b.requestId); });
    if (!requests.length) return { ok: true, noOp: true, issues: [], request: null, task: null, row: null, input: null };
    var request = requests[0], task = p.tasks[request.taskId];
    if (!task || task.pendingRequestId !== request.requestId || task.revision !== request.revision) return failed('PENDING_TASK_MISMATCH', '装车待办与任务当前版本不一致，未按行位置处理。');
    if (request.kind === 'correction' && request.correctionAuthorized !== true) return failed('CORRECTION_NOT_AUTHORIZED', '更正尚未由原安装者确认，未改库存。');
    var prior = (state.tasks || {})[task.taskId], row = { taskId: task.taskId, status: request.status, plannedText: request.plannedText, actualText: request.actualText, destination: task.label, sourceDateLabel: task.businessDate || task.sourceDateLabel || '', reference: task.reference, dock: task.dock, row: 0, requestId: request.requestId, inputHash: fingerprint({ request: request, revision: task.revision }), accountingHash: request.inputHash, contextHash: fingerprint({ label: task.label, businessDate: task.businessDate, reference: task.reference, dock: task.dock }) };
    var input = { taskId: task.taskId, status: request.status, plannedText: request.plannedText, actualText: request.actualText, destination: '', allowedLocations: (state.inventory || []).map(function (entry) { return entry.location; }), baseline: copy(state.baseline || {}), allowSameDestinationLots: args.allowSameDestinationLots === true, allowActualWithoutPlan: true, inventory: copy(state.inventory || []), previous: prior && prior.ledger ? copy(prior.ledger) : undefined, correctionConfirmed: request.kind === 'correction' && request.correctionAuthorized === true, correctionReason: request.correctionReason || '', otherTaskPlans: Object.keys(state.tasks || {}).filter(function (id) { return id !== task.taskId && state.tasks[id].ledger; }).map(function (id) { return { taskId: id, projectedRemaining: copy(state.tasks[id].ledger.projectedRemaining || []) }; }) };
    var committed = committedLedger(state, task.taskId), planInvalidated = !!task.planNeedsReview || request.planInvalidatedAtSubmission === true || !!(prior && prior.pendingCode === 'PHYSICAL_PLAN_REVIEW');
    // The other quantity is not part of this action. Re-read its authoritative
    // committed ledger rather than allowing a stale displayed draft (or a plan
    // invalidated by a physical move) to become an accidental new instruction.
    if (request.kind !== 'plan') input.plannedText = planInvalidated ? '' : task.savedPlannedText !== undefined ? task.savedPlannedText : committed ? mapText(committed.planned || []) : '';
    if (request.kind !== 'actual' && request.kind !== 'correction') input.actualText = committedActual(state, task);
    row.plannedText = input.plannedText; row.actualText = input.actualText;
    row.inputHash = fingerprint({ request: request, revision: task.revision, plannedText: input.plannedText, actualText: input.actualText, planInvalidated: planInvalidated });
    if (committed) {
      if (input.actualText && input.actualText === mapText(committed.actual || [])) input.actualEntries = ledgerEntries(committed.actual || []);
      if (input.plannedText && input.plannedText === mapText(committed.planned || [])) input.plannedEntries = ledgerEntries(committed.planned || []);
    }
    return { ok: true, noOp: false, issues: [], request: copy(request), task: copy(task), row: row, input: input, planInvalidated: planInvalidated };
  }
  function recordResult(args) {
    args = args || {}; var state = args.state || {}, p = portal(state), id = text(args.requestId), status = text(args.status), now = text(args.now);
    if (!p || !p.requests[id]) return failed('REQUEST_NOT_FOUND', '找不到原装车提交，未按行位置回写。');
    if (['processed', 'review', 'error'].indexOf(status) < 0) return failed('RESULT_STATUS', '装车结果阶段无效。');
    var request = p.requests[id], task = p.tasks[request.taskId];
    if (request.stage === 'processed') return { ok: true, noOp: true, issues: [], nextState: copy(state), task: copy(task), request: copy(request) };
    if (!task || task.pendingRequestId !== id || task.revision !== request.revision) return failed('RESULT_STALE', '结果已过期，不能覆盖新提交。');
    var next = copy(state), nextRequest = next.loadingPortal.requests[id], nextTask = next.loadingPortal.tasks[request.taskId];
    nextRequest.stage = status; nextRequest.result = text(args.message); nextRequest.processedAt = now;
    nextTask.pendingRequestId = ''; nextTask.processingStatus = status; nextTask.lastResult = text(args.message); nextTask.updatedAt = now;
    if (status !== 'processed') {
      var previous = request.previousTaskValues || {};
      nextTask.plannedText = text(previous.plannedText); nextTask.actualText = text(previous.actualText); nextTask.status = text(previous.status) || '未开始';
      nextTask.lastFailedRequestId = id;
    }
    var committed = committedLedger(next, request.taskId), invalidated = !!task.planNeedsReview || request.planInvalidatedAtSubmission === true || args.planInvalidated === true || (((next.tasks || {})[request.taskId] || {}).pendingCode === 'PHYSICAL_PLAN_REVIEW');
    if (status === 'processed' && request.kind === 'plan') { nextTask.savedPlannedText = request.plannedText; nextTask.planNeedsReview = false; }
    else nextTask.planNeedsReview = invalidated;
    nextTask.plannedText = text(nextTask.savedPlannedText); nextTask.bookedPlannedText = !nextTask.planNeedsReview && committed ? mapText(committed.planned || []) : '';
    if (status === 'processed' && (request.kind === 'actual' || request.kind === 'correction')) {
      nextTask.actualKnown = true;
      if ((!committed || !(committed.actual || []).length) && explicitZero(request.actualText)) nextTask.committedActualText = request.actualText;
    }
    nextTask.committedActualText = committedActual(next, nextTask); nextTask.actualText = nextTask.committedActualText;
    nextTask.actualKnown = nextTask.committedActualText !== '';
    if (committed) nextTask.status = text(committed.status) || nextTask.status;
    if (status === 'processed' && (request.kind === 'actual' || request.kind === 'correction')) {
      Object.keys(next.loadingPortal.requests || {}).forEach(function (key) {
        var prior = next.loadingPortal.requests[key];
        if (key !== id && prior.taskId === request.taskId && ['actual', 'correction'].indexOf(prior.kind) >= 0 && ['review', 'error'].indexOf(prior.stage) >= 0 && !prior.resolvedBy) { prior.resolvedBy = id; prior.resolvedAt = now; }
      });
    }
    // Stock/ledger effects are intentionally absent here. The trusted adapter
    // commits those together with this result in one shared-state batch.
    return { ok: true, noOp: false, issues: [], nextState: next, task: copy(nextTask), request: copy(nextRequest) };
  }
  function reconcileCommitted(args) {
    args = args || {}; var state = args.state || {}, p = portal(state); if (!p) return { ok: true, noOp: true, issues: [], nextState: copy(state), report: { changedTasks: 0 } };
    var next = copy(state), changed = 0, now = text(args.now);
    Object.keys(next.loadingPortal.tasks || {}).forEach(function (id) {
      var task = next.loadingPortal.tasks[id], before = stableStringify(task), ledger = committedLedger(next, id), physicalReview = (((next.tasks || {})[id] || {}).pendingCode === 'PHYSICAL_PLAN_REVIEW');
      if (physicalReview && !task.planNeedsReview) {
        task.planNeedsReview = true;
        var request = task.pendingRequestId && next.loadingPortal.requests[task.pendingRequestId];
        if (request && request.stage === 'pending' && request.kind === 'plan') {
          request.stage = 'review'; request.result = '提交预计后发生移库或盘点影响，原预计待重新确认。'; request.processedAt = now;
          task.pendingRequestId = ''; task.processingStatus = 'review'; task.lastResult = request.result; task.lastFailedRequestId = request.requestId;
        }
        if (!task.pendingRequestId) task.revision++;
      }
      task.bookedPlannedText = !task.planNeedsReview && ledger ? mapText(ledger.planned || []) : '';
      task.committedActualText = committedActual(next, task);
      task.actualKnown = task.committedActualText !== '';
      if (!task.pendingRequestId) { task.plannedText = text(task.savedPlannedText); task.actualText = task.committedActualText; if (ledger && STATES.indexOf(text(ledger.status)) >= 0) task.status = text(ledger.status); }
      if (stableStringify(task) !== before) { task.updatedAt = now || task.updatedAt; changed++; }
    });
    return { ok: true, noOp: changed === 0, issues: [], nextState: next, report: { changedTasks: changed } };
  }
  function unresolvedPhysicalRequests(args) {
    var state = args && args.state || args || {}, p = portal(state); if (!p) return [];
    return Object.keys(p.requests || {}).map(function (key) { return p.requests[key]; }).filter(function (request) {
      if (['actual', 'correction'].indexOf(request.kind) < 0 || ['pending', 'review', 'error'].indexOf(request.stage) < 0) return false;
      var resolved = request.resolvedBy && p.requests[request.resolvedBy];
      return !(resolved && resolved.taskId === request.taskId && resolved.stage === 'processed' && ['actual', 'correction'].indexOf(resolved.kind) >= 0);
    }).map(copy);
  }
  return { VERSION: VERSION, upgrade: upgrade, createTask: createTask, submit: submit, jobForCore: jobForCore, recordResult: recordResult, reconcileCommitted: reconcileCommitted, unresolvedPhysicalRequests: unresolvedPhysicalRequests, stableStringify: stableStringify, mapText: mapText };
}());
if (typeof module !== 'undefined' && module.exports) module.exports = WTCLoadingPortalCore;
