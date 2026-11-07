/* Shared-state unloading reservations. Estimates never become physical stock automatically. */
var WTCUnloadCore = (function () {
  'use strict';
  var VERSION = '1.0.0';
  var PHASES = { '未读取': 0, '未观测': 0, '未到': 0, '已到': 0, '在拆': 1, '拆空': 2 };
  var ROUTES = ['ordinary', 'special_direct', 'via_inspection'];
  var KINDS = ['planned_hold', 'inbound_estimate', 'inspection_estimate', 'final_destination_hold', 'unresolved_estimate'];
  function copy(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function text(value) { return value == null ? '' : String(value).trim(); }
  function stable(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().filter(function (key) { return value[key] !== undefined; }).map(function (key) { return JSON.stringify(key) + ':' + stable(value[key]); }).join(',') + '}';
  }
  function problem(code, message, severity, extra) { return Object.assign({ code: code, message: message, severity: severity || 'error' }, extra || {}); }
  function fail(code, message) { var error = new Error(message); error.code = code; throw error; }
  function location(value) {
    var raw = text(value).replace(/\s+/g, '').toUpperCase();
    if (!raw) return null;
    if (raw === '检查区' || raw === 'OFFICE') return '检查区';
    var match = /^([A-Z]{1,2})(#|\d+)$/.exec(raw);
    if (!match || (match[2] !== '#' && Number(match[2]) < 1)) fail('INVALID_LOCATION', '库位格式无效：' + text(value));
    return match[1] + (match[2] === '#' ? 11 : Number(match[2]));
  }
  function amount(value, field) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) value = Number(value);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('INVALID_ESTIMATE', field + '必须为已确认非负预估量或空白。');
    return value;
  }
  function published(value) { return value === true || text(value).toUpperCase() === 'TRUE' || text(value) === '已发布'; }
  function normalizeAllocations(input) {
    if (!Array.isArray(input.allocations) || !input.allocations.length) fail('MISSING_ALLOCATIONS', '没有已发布分位，不根据柜状态自动分配库位。');
    var ids = {}, allowed = Array.isArray(input.allowedLocations) ? input.allowedLocations.map(location) : null;
    return input.allocations.map(function (row) {
      var allocationId = text(row.allocationId), taskId = text(row.taskId), publicationId = text(row.publicationId), revision = text(row.revision);
      if (!allocationId || ids[allocationId]) fail('DUPLICATE_ALLOCATION', '分配条目标识缺失或重复。'); ids[allocationId] = true;
      if (taskId !== text(input.taskId) || publicationId !== text(input.publicationId) || revision !== text(input.revision)) fail('PUBLICATION_SCOPE_MISMATCH', '柜任务或发布版本与分位条目不一致。');
      if (!published(row.published)) fail('UNPUBLISHED_ALLOCATION', '分位尚未发布，不能形成执行占用。');
      var route = text(row.route), loc = location(row.location), finalLoc = location(row.finalLocation);
      if (ROUTES.indexOf(route) < 0) fail('INVALID_ROUTE', '卸柜路径只能为 ordinary、special_direct 或 via_inspection。');
      if (!loc) fail('MISSING_LOCATION', '发布纸单缺少起始库位。');
      if (route === 'via_inspection' && loc !== '检查区') fail('INVALID_INSPECTION_ROUTE', '经检查区分流的起始库位必须是检查区。');
      if (route !== 'via_inspection' && loc === '检查区') fail('INVALID_DIRECT_ROUTE', '普通或特殊直入路线不能把检查区作为最终库位。');
      if (finalLoc === '检查区') fail('INVALID_FINAL_LOCATION', '最终去向不能仍然写成检查区。');
      if (allowed && (allowed.indexOf(loc) < 0 || (finalLoc && allowed.indexOf(finalLoc) < 0))) fail('UNKNOWN_LOCATION', '发布库位不在允许清单中。');
      var container = text(row.containerNo).toUpperCase();
      if (input.containerNo && container !== text(input.containerNo).toUpperCase()) fail('CONTAINER_MISMATCH', '分位实体柜号与当前任务不一致。');
      return { publicationId: publicationId, revision: revision, allocationId: allocationId, taskId: taskId, containerNo: container,
        destination: text(row.destination), shipmentId: text(row.shipmentId), location: loc, route: route,
        estimatedP: amount(row.estimatedP, '预估实物板数'), estimatedSlots: amount(row.estimatedSlots, '预估占位'),
        finalLocation: finalLoc, specialType: text(row.specialType), published: true };
    }).sort(function (a, b) { return a.allocationId < b.allocationId ? -1 : a.allocationId > b.allocationId ? 1 : 0; });
  }
  function reservation(row, kind, loc, lock, targetKind) {
    return { allocationId: row.allocationId, taskId: row.taskId, location: loc, destination: row.destination, shipmentId: row.shipmentId,
      estimatedP: row.estimatedP, estimatedSlots: row.estimatedSlots, kind: kind, specialType: row.specialType,
      activeSpecialLock: !!lock, route: row.route, targetKind: targetKind || kind };
  }
  function computeUnloadEffect(input) {
    input = input || {};
    var issues = [], previous = copy(input.previous || null), taskId = text(input.taskId), status = text(input.status) || '未读取';
    var result = { version: VERSION, taskId: taskId, ok: false, blocked: true, changed: false, issues: issues,
      actualDeltas: [], nextLedger: previous, proposal: null };
    try {
      if (!taskId || !text(input.publicationId) || !text(input.revision)) fail('MISSING_PUBLICATION_IDENTITY', '任务及发布单号/版本不能为空。');
      if (!Object.prototype.hasOwnProperty.call(PHASES, status)) fail('UNKNOWN_UNLOAD_STATUS', '不认识的海柜状态：' + status);
      if (previous && previous.taskId !== taskId) fail('TASK_MISMATCH', '旧卸柜记录属于其他任务。');
      var rows = normalizeAllocations(input), fingerprint = stable(rows);
      if (previous && previous.publicationFingerprint !== fingerprint) fail('PUBLISHED_PLAN_CHANGED', '已发布纸单的库位、估数或版本发生变化；需显式重发审核，未静默改位。');
      var observed = PHASES[status], highest = Math.max(observed, previous ? Number(previous.highestPhase || 0) : 0);
      var regression = observed < highest, reservations = [], unresolved = [];
      if (regression) issues.push(problem('STATUS_REGRESSION', '柜状态回退；保留已拆阶段货物占用，不冲回库存。', 'warning'));
      if (status === '未读取' || status === '未观测') issues.push(problem('SOURCE_STATUS_UNOBSERVED', '尚未读取到海柜状态；仅保护已发布纸位预算，不声称已到或在拆。', 'warning'));
      rows.forEach(function (row) {
        if (highest === 0) {
          reservations.push(reservation(row, 'planned_hold', row.location, false, row.route === 'via_inspection' ? 'inspection_estimate' : 'inbound_estimate'));
          if (row.route === 'via_inspection' && row.finalLocation) reservations.push(reservation(row, 'planned_hold', row.finalLocation, false, 'final_destination_hold'));
          return;
        }
        if (row.route !== 'via_inspection') {
          reservations.push(reservation(row, 'inbound_estimate', row.location, row.route === 'special_direct' && highest === 1));
        } else {
          if (highest === 1) reservations.push(reservation(row, 'inspection_estimate', '检查区', false));
          if (row.finalLocation) reservations.push(reservation(row, 'final_destination_hold', row.finalLocation, false));
          if (highest === 2) {
            // A container being empty does not prove a special shipment reached its final line.
            var unknown = reservation(row, 'unresolved_estimate', null, false);
            reservations.push(unknown); unresolved.push(copy(unknown));
            issues.push(problem('FINAL_DESTINATION_UNCONFIRMED', '检查区阶段已结束，但特殊货实际数量及最终归线待确认，不能显示货物消失。', 'warning', { allocationId: row.allocationId }));
          }
        }
        if (row.estimatedP === null || row.estimatedSlots === null) issues.push(problem('UNKNOWN_ESTIMATED_OCCUPANCY', '有预估数量或占位未知，不能按0或一板一位补齐。', 'warning', { allocationId: row.allocationId }));
      });
      var next = { taskId: taskId, containerNo: rows[0].containerNo, status: status, observedStatus: status,
        publicationId: text(input.publicationId), revision: text(input.revision), publicationFingerprint: fingerprint,
        publishedAllocations: rows, highestPhase: highest, phase: highest === 0 ? 'not_started' : highest === 1 ? 'unloading' : 'emptied',
        statusRegression: regression, reservations: reservations, unresolved: unresolved,
        autoAllocationBlocked: regression || status === '未读取' || status === '未观测' || unresolved.length > 0 || reservations.some(function (r) { return r.estimatedP === null || r.estimatedSlots === null; }),
        physicalInventoryPosted: false };
      result.ok = true; result.blocked = false; result.changed = stable(previous) !== stable(next);
      result.nextLedger = next;
      result.proposal = { taskId: taskId, actualDeltas: [], nextLedger: copy(next) };
    } catch (error) { issues.push(problem(error.code || 'INVALID_UNLOAD_INPUT', error.message)); }
    return result;
  }
  function ledgerList(value) {
    var rows = Array.isArray(value) ? value : Object.keys(value || {}).map(function (key) { return value[key]; });
    return rows.map(function (row) { return row && row.ledger ? row.ledger : row; }).filter(Boolean);
  }
  function aggregateReservations(arg) {
    var context = arg && !Array.isArray(arg) && (arg.unloadTasks || arg.inventory || arg.loadingTasks || arg.capacities) ? arg : { unloadTasks: arg };
    var locations = {}, unresolved = [], issues = [], blocked = false;
    var knownEmpty = (context.knownEmptyLocations || []).map(location), scopeComplete = context.inventoryScopeComplete === true;
    function at(loc) {
      if (!locations[loc]) {
        var emptyKnown = scopeComplete || knownEmpty.indexOf(loc) >= 0;
        locations[loc] = { location: loc, actualOccupiedSlots: 0, conservativeOccupiedSlots: emptyKnown ? 0 : null, actualOccupancyKnown: emptyKnown,
          actualPhysicalP: emptyKnown ? 0 : null, hasInventoryRow: false,
          incomingEstimatedP: 0, incomingEstimatedSlots: 0, incomingQuantityKnown: true, incomingSlotsKnown: true,
          inspectionEstimatedP: 0, inspectionPlannedHoldP: 0, plannedHoldP: 0, plannedHoldSlots: 0, activeEstimatedP: 0, activeEstimatedSlots: 0, plannedHoldQuantityKnown: true, plannedHoldSlotsKnown: true, activeQuantityKnown: true, activeSlotsKnown: true, finalDestinationHoldP: 0, finalDestinationHoldSlots: 0, mediumTicketPByTask: {},
          plannedLoadingReleaseSlots: 0, plannedReleaseKnown: true, capacitySlots: null, catalogStatus: '', unavailable: false, blockedByCatalogFull: false, catalogProtectedSlots: null,
          activeSpecialTaskIds: [], specialConcurrencyConflict: false, usableProjectedSlots: null, conservativeProjectedSlots: null, reservations: [] };
      }
      return locations[loc];
    }
    (context.inventory || []).forEach(function (row) {
      var loc = location(row.location), target = at(loc), trusted = context.baselineConfirmed !== false;
      if (!target.hasInventoryRow) { target.hasInventoryRow = true; target.actualOccupancyKnown = trusted; target.conservativeOccupiedSlots = trusted ? 0 : null; target.actualPhysicalP = trusted ? 0 : null; }
      if (trusted && typeof row.occupiedSlots === 'number' && row.occupiedSlots >= 0) target.actualOccupiedSlots += row.occupiedSlots;
      else target.actualOccupancyKnown = false;
      if (target.conservativeOccupiedSlots !== null && typeof row.occupiedSlots === 'number' && row.occupiedSlots >= 0) target.conservativeOccupiedSlots += row.occupiedSlots;
      else if (target.conservativeOccupiedSlots !== null && typeof row.physicalP === 'number' && row.physicalP >= 0) target.conservativeOccupiedSlots += row.physicalP;
      else target.conservativeOccupiedSlots = null;
      if (target.actualPhysicalP !== null && typeof row.physicalP === 'number' && row.physicalP >= 0) target.actualPhysicalP += row.physicalP;
      else target.actualPhysicalP = null;
      if (typeof row.capacitySlots === 'number' && row.capacitySlots >= 0) {
        if (target.capacitySlots !== null && target.capacitySlots !== row.capacitySlots) { blocked = true; issues.push(problem('CONFLICTING_CAPACITY', '同库位存在不同容量上限。', 'error', { location: loc })); }
        target.capacitySlots = target.capacitySlots === null ? row.capacitySlots : Math.min(target.capacitySlots, row.capacitySlots);
      }
    });
    knownEmpty.forEach(function (loc) { at(loc); });
    var capacities = context.capacities || {};
    Object.keys(capacities).forEach(function (key) {
      var entry = capacities[key], detail = entry && typeof entry === 'object' ? entry : {}, cap = typeof entry === 'number' ? entry : detail.capacitySlots;
      var loc = location(key), target = at(loc), status = text(detail.status);
      if (typeof cap === 'number' && cap >= 0) {
        if (target.capacitySlots !== null && target.capacitySlots !== cap) { blocked = true; issues.push(problem('CONFLICTING_CAPACITY', '实际库存与库位目录容量不一致。', 'error', { location: loc })); }
        target.capacitySlots = target.capacitySlots === null ? cap : Math.min(target.capacitySlots, cap);
      }
      target.catalogStatus = status;
      if (['不可用', '停用', '×', '✕', 'X'].indexOf(status.toUpperCase()) >= 0) target.unavailable = true;
      if (['空位', '空', 'EMPTY'].indexOf(status.toUpperCase()) >= 0) {
        if (!target.hasInventoryRow) { target.actualOccupancyKnown = true; target.actualOccupiedSlots = 0; target.conservativeOccupiedSlots = 0; target.actualPhysicalP = 0; }
        else if (target.actualPhysicalP !== 0 || target.actualOccupiedSlots !== 0) { blocked = true; issues.push(problem('EMPTY_CATALOG_CONFLICT', '空位标记与现有实物库存冲突，未抹除库存。', 'error', { location: loc })); }
      }
      if (['满线', '满', '✓', '✔', 'FULL'].indexOf(status.toUpperCase()) >= 0) {
        // A full marker protects the lane but does not measure physical pallets or actual occupied slots.
        target.blockedByCatalogFull = true; target.catalogProtectedSlots = target.capacitySlots;
        if (target.capacitySlots !== null) target.conservativeOccupiedSlots = target.conservativeOccupiedSlots === null ? target.capacitySlots : Math.max(target.conservativeOccupiedSlots, target.capacitySlots);
      }
    });
    ledgerList(context.loadingTasks).forEach(function (ledger) {
      (ledger.projectedRemaining || []).forEach(function (row) { var target = at(location(row.location)); if (typeof row.releasedSlots === 'number' && row.releasedSlots >= 0) target.plannedLoadingReleaseSlots += row.releasedSlots; else target.plannedReleaseKnown = false; });
    });
    var seenUnload = Object.create(null);
    ledgerList(context.unloadTasks).forEach(function (ledger) {
      var ledgerId = text(ledger.taskId);
      if (!ledgerId) { blocked = true; issues.push(problem('MISSING_UNLOAD_TASK', '卸柜占用记录缺少柜任务标识。')); return; }
      if (seenUnload[ledgerId]) { if (seenUnload[ledgerId] !== stable(ledger)) { blocked = true; issues.push(problem('DUPLICATE_UNLOAD_TASK', '同柜任务存在不同占用记录，禁止重复计入。', 'error', { taskId: ledgerId })); } return; }
      seenUnload[ledgerId] = stable(ledger);
      if (ledger.autoAllocationBlocked) blocked = true;
      (ledger.reservations || []).forEach(function (row) {
        if (!row.location || row.kind === 'unresolved_estimate') { unresolved.push(copy(row)); blocked = true; return; }
        var target = at(location(row.location)); target.reservations.push(copy(row));
        if (typeof row.estimatedP === 'number') target.incomingEstimatedP += row.estimatedP; else target.incomingQuantityKnown = false;
        if (typeof row.estimatedSlots === 'number') target.incomingEstimatedSlots += row.estimatedSlots; else target.incomingSlotsKnown = false;
        if (row.kind === 'planned_hold') {
          if (typeof row.estimatedP === 'number') target.plannedHoldP += row.estimatedP; else target.plannedHoldQuantityKnown = false;
          if (typeof row.estimatedSlots === 'number') target.plannedHoldSlots += row.estimatedSlots; else target.plannedHoldSlotsKnown = false;
          if (row.targetKind === 'inspection_estimate' && typeof row.estimatedP === 'number') target.inspectionPlannedHoldP += row.estimatedP;
        } else {
          if (typeof row.estimatedP === 'number') target.activeEstimatedP += row.estimatedP; else target.activeQuantityKnown = false;
          if (typeof row.estimatedSlots === 'number') target.activeEstimatedSlots += row.estimatedSlots; else target.activeSlotsKnown = false;
        }
        if (row.kind === 'inspection_estimate' && typeof row.estimatedP === 'number') target.inspectionEstimatedP += row.estimatedP;
        if (row.route === 'special_direct' && /中票|medium|mid/i.test(row.specialType) && typeof row.estimatedP === 'number') target.mediumTicketPByTask[ledger.taskId] = (target.mediumTicketPByTask[ledger.taskId] || 0) + row.estimatedP;
        if (row.kind === 'final_destination_hold') { if (typeof row.estimatedP === 'number') target.finalDestinationHoldP += row.estimatedP; if (typeof row.estimatedSlots === 'number') target.finalDestinationHoldSlots += row.estimatedSlots; }
        if (row.activeSpecialLock && target.activeSpecialTaskIds.indexOf(ledger.taskId) < 0) target.activeSpecialTaskIds.push(ledger.taskId);
      });
    });
    Object.keys(locations).forEach(function (loc) {
      var row = locations[loc];
      row.activeSpecialTaskIds.sort(); row.specialConcurrencyConflict = row.activeSpecialTaskIds.length > 1;
      if (row.specialConcurrencyConflict) { blocked = true; issues.push(problem('SPECIAL_LINE_CONCURRENCY', '不同在拆柜同时占用同一特殊线，禁止继续自动分配。', 'error', { location: loc, taskIds: row.activeSpecialTaskIds })); }
      if (!row.actualOccupancyKnown) row.actualOccupiedSlots = null;
      if (!row.incomingQuantityKnown) row.incomingEstimatedP = null;
      if (!row.incomingSlotsKnown) row.incomingEstimatedSlots = null;
      if (!row.plannedReleaseKnown) row.plannedLoadingReleaseSlots = null;
      if (!row.plannedHoldQuantityKnown) row.plannedHoldP = null; if (!row.plannedHoldSlotsKnown) row.plannedHoldSlots = null;
      if (!row.activeQuantityKnown) row.activeEstimatedP = null; if (!row.activeSlotsKnown) row.activeEstimatedSlots = null;
      Object.keys(row.mediumTicketPByTask).forEach(function (taskId) { if (row.mediumTicketPByTask[taskId] > 20) { blocked = true; issues.push(problem('MEDIUM_SPECIAL_LINE_LIMIT', '同柜中票在同一特殊线的预估量超过20P。', 'error', { location: loc, taskId: taskId })); } });
      if (row.capacitySlots !== null && row.actualOccupiedSlots !== null && row.incomingEstimatedSlots !== null && row.plannedLoadingReleaseSlots !== null) row.usableProjectedSlots = row.capacitySlots - row.actualOccupiedSlots - row.incomingEstimatedSlots + row.plannedLoadingReleaseSlots;
      if (row.capacitySlots !== null && row.conservativeOccupiedSlots !== null && row.incomingEstimatedSlots !== null) row.conservativeProjectedSlots = row.capacitySlots - row.conservativeOccupiedSlots - row.incomingEstimatedSlots;
      if (row.blockedByCatalogFull) {
        row.usableProjectedSlots = 0; row.conservativeProjectedSlots = 0;
        if (row.reservations.length) { blocked = true; issues.push(problem('FULL_LOCATION_ASSIGNED', '已发布卸柜分配涉及标记满线的库位，不能据标记推造实际占位。', 'error', { location: loc })); }
      }
      if (row.unavailable) {
        row.usableProjectedSlots = 0; row.conservativeProjectedSlots = 0;
        if (row.reservations.length) { blocked = true; issues.push(problem('UNAVAILABLE_LOCATION', '已发布卸柜分配涉及不可用库位。', 'error', { location: loc })); }
      }
      if (row.reservations.length && (row.actualOccupiedSlots === null || row.incomingEstimatedSlots === null)) {
        var conservativeFits = row.conservativeProjectedSlots !== null && row.conservativeProjectedSlots >= 0;
        if (!conservativeFits) { blocked = true; issues.push(problem('LOCATION_OCCUPANCY_UNKNOWN', '实际占位或新增预占未知且无足够保守余量，不能按空位继续自动分配。', 'warning', { location: loc })); }
        else issues.push(problem('CAPACITY_CONSERVATIVE_ONLY', '叠放占位未知，但按保守上界扣除新增预占仍有容量；准确余位保持未知。', 'warning', { location: loc }));
      }
      if (row.usableProjectedSlots !== null && row.usableProjectedSlots < 0) { blocked = true; issues.push(problem('PROJECTED_CAPACITY_EXCEEDED', '当前库存与卸柜占用预留超过库位容量。', 'error', { location: loc })); }
    });
    var inspectionRow = locations['检查区'], incomingInspectionP = inspectionRow ? (inspectionRow.incomingQuantityKnown ? inspectionRow.inspectionEstimatedP + inspectionRow.inspectionPlannedHoldP : null) : 0;
    var currentInspectionP = inspectionRow ? inspectionRow.actualPhysicalP : (scopeComplete || knownEmpty.indexOf('检查区') >= 0 ? 0 : null);
    var totalInspectionP = currentInspectionP !== null && incomingInspectionP !== null ? currentInspectionP + incomingInspectionP : null;
    var lowerBound = incomingInspectionP === null ? 0 : incomingInspectionP;
    var inspection = { location: '检查区', estimatedP: incomingInspectionP, incomingEstimatedP: incomingInspectionP, currentPhysicalP: currentInspectionP, totalProjectedP: totalInspectionP,
      plannedHoldP: inspectionRow ? inspectionRow.inspectionPlannedHoldP : 0, activeEstimatedP: inspectionRow ? inspectionRow.inspectionEstimatedP : 0,
      standardP: 64, hardLimitP: 70, aboveStandard: totalInspectionP === null ? (lowerBound > 64 ? true : null) : totalInspectionP > 64,
      exceedsHardLimit: totalInspectionP === null ? (lowerBound > 70 ? true : null) : totalInspectionP > 70 };
    if (inspection.exceedsHardLimit) { blocked = true; issues.push(problem('INSPECTION_HARD_LIMIT', '检查区现存加新增预占超过70P硬上限。')); }
    else if (inspection.aboveStandard) issues.push(problem('INSPECTION_ABOVE_STANDARD', '检查区现存加新增预占超过64P标准位，未超过70P硬上限。', 'warning'));
    if (incomingInspectionP === null || (currentInspectionP === null && incomingInspectionP > 0)) { blocked = true; issues.push(problem('INSPECTION_OCCUPANCY_UNKNOWN', '检查区现存或新增预估量未知，不能按空位处理。')); }
    return { byLocation: locations, locations: Object.keys(locations).sort().map(function (key) { return locations[key]; }), inspection: inspection,
      unresolved: unresolved, issues: issues, autoAllocationBlocked: blocked, physicalInventoryUnchanged: true };
  }
  function validateProposal(candidate, effect) {
    var value = candidate && candidate.proposal ? candidate.proposal : candidate, errors = [];
    if (!effect || !effect.ok || effect.blocked || !effect.proposal) errors.push(problem('BLOCKED_EFFECT', '卸柜候选未通过固定规则。'));
    else if (stable(value) !== stable(effect.proposal)) errors.push(problem('PROPOSAL_MISMATCH', '卸柜候选与固定计算不一致。'));
    return { ok: errors.length === 0, errors: errors };
  }
  return { VERSION: VERSION, computeUnloadEffect: computeUnloadEffect, aggregateReservations: aggregateReservations,
    validateProposal: validateProposal, stableStringify: stable, normalizeLocation: location, RESERVATION_KINDS: KINDS.slice() };
}());
if (typeof module !== 'undefined' && module.exports) module.exports = WTCUnloadCore;
