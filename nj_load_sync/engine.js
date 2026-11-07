/* Warehouse loading-state reconciliation. Pure JavaScript, compatible with Apps Script V8. */
var WTCLoadCore = (function () {
  'use strict';
  var VERSION = '1.0.0';
  var STATES = {
    '未靠台在等': 'waiting', '靠台在等': 'waiting', '未到': 'waiting', '未开始': 'waiting',
    '已开始': 'active', '在装': 'active',
    '已结束': 'finished', '已完成': 'finished', '装车完成': 'finished',
    '留台等货': 'holding', '留台': 'holding',
    '取消': 'cancelled', '已取消': 'cancelled'
  };
  function copy(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function text(x) { return x === null || x === undefined ? '' : String(x).trim(); }
  function identity(x) { return text(x).replace(/\s+/g, ' ').toUpperCase(); }
  function integer(x) { return typeof x === 'number' && Number.isFinite(x) && x >= 0 && Math.floor(x) === x; }
  function issue(code, message, extra, severity) {
    return Object.assign({ code: code, message: message, severity: severity || 'error' }, extra || {});
  }
  function fail(code, message) { var e = new Error(message); e.code = code; throw e; }
  function normalizeLocation(value, options) {
    var raw = identity(value).replace(/\s+/g, '');
    if (raw === 'OFFICE' || raw === '检查区') raw = '检查区';
    else {
      var m = /^([A-Z]{1,2})(#|\d+)$/.exec(raw);
      if (!m) fail('BAD_LOCATION', '库位格式不正确：' + text(value));
      var n = m[2] === '#' ? 11 : Number(m[2]);
      if (!Number.isSafeInteger(n) || n < 1) fail('BAD_LOCATION', '库位线号必须为正整数。');
      raw = m[1] + n;
      if (!options || !Array.isArray(options.allowedLocations)) {
        if (!/^[ABCDEFGMSTVWXYZ]$/.test(m[1])) fail('UNKNOWN_LOCATION', '库位区域未配置：' + m[1]);
        if (/^[STVWXYZ]$/.test(m[1]) && n > 11) fail('UNKNOWN_LOCATION', '短线线号未配置：' + raw);
      }
    }
    if (options && Array.isArray(options.allowedLocations)) {
      var allowed = options.allowedLocations.map(function (v) { return normalizeLocation(v); });
      if (allowed.indexOf(raw) < 0) fail('UNKNOWN_LOCATION', '库位不在允许清单内：' + raw);
    }
    return raw;
  }
  function entryKey(e) { return e.location + '\u001f' + identity(e.destination) + '\u001f' + text(e.shipmentId); }
  function normalizeEntries(entries, options) {
    var seen = Object.create(null);
    return entries.map(function (e) {
      var v = {
        location: normalizeLocation(e.location, options),
        physicalP: e.physicalP,
        destination: text(e.destination) || null,
        shipmentId: text(e.shipmentId) || null
      };
      if (!integer(v.physicalP)) fail('BAD_QUANTITY', '板数必须为非负整数。');
      if (e.releasedSlots !== undefined && e.releasedSlots !== null) {
        if (!integer(e.releasedSlots)) fail('BAD_SLOT_QUANTITY', '释放板位必须为非负整数。');
        if (e.releasedSlots > e.physicalP) fail('IMPOSSIBLE_SLOT_RELEASE', '装车释放的实际板位不能多于对应实物板数；重排或理论容量变更须另行登记。');
        v.releasedSlots = e.releasedSlots;
      }
      var key = entryKey(v);
      if (seen[key]) fail('DUPLICATE_ENTRY', '同库位、同货物重复填写：' + v.location);
      seen[key] = true;
      return v;
    });
  }
  function parseMap(value, options) {
    options = options || {};
    if (Array.isArray(value)) return { known: true, entries: normalizeEntries(value, options) };
    var raw = text(value);
    if (!raw) return { known: false, entries: [] };
    if (raw === '0') {
      var zeros = options.zeroEntries || (options.defaultLocation ? [{ location: options.defaultLocation }] : []);
      if (!zeros.length) fail('MISSING_ZERO_LOCATION', '填0时需有明确的预计库位，或写成 C1:0。');
      return { known: true, entries: normalizeEntries(zeros.map(function (v) {
        return Object.assign({}, v, { physicalP: 0, releasedSlots: 0 });
      }), options) };
    }
    var parts = raw.split(/[，,；;\n\r+]+/).map(function (v) { return v.trim(); }).filter(Boolean);
    if (!parts.length) fail('EMPTY_MAP', '装车明细中没有有效条目。');
    var entries = parts.map(function (part) {
      var m = /^([A-Za-z]{1,2}\s*(?:#|\d+)|检查区|office)(?:\s+(.+?))?\s*[:：=]\s*(\d+)\s*(?:[Pp]|板)?$/.exec(part);
      if (!m) fail('BAD_ENTRY', '无法完整识别条目，请使用 C1:8 或 Y2 HEA2:3：' + part);
      var goods = text(m[2]), at = goods.indexOf('@');
      var destination = at >= 0 ? text(goods.slice(0, at)) : goods;
      var shipment = at >= 0 ? text(goods.slice(at + 1)) : '';
      if (at >= 0 && !shipment) fail('BAD_SHIPMENT', '@后需要填写票号或分组标识。');
      return { location: m[1], physicalP: Number(m[3]), destination: destination || null, shipmentId: shipment || null };
    });
    return { known: true, entries: normalizeEntries(entries, options) };
  }
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort().filter(function (k) { return value[k] !== undefined; }).map(function (k) {
      return JSON.stringify(k) + ':' + stableStringify(value[k]);
    }).join(',') + '}';
  }
  function byId(list) {
    var result = Object.create(null);
    (list || []).forEach(function (e) {
      if (!e.inventoryId || result[e.inventoryId]) fail('BAD_LEDGER', '累计记录缺少唯一库存标识，或标识重复。');
      if (!integer(e.physicalP)) fail('BAD_LEDGER', '累计记录板数必须为非负整数。');
      if (e.releasedSlots !== undefined && e.releasedSlots !== null && !integer(e.releasedSlots)) fail('BAD_LEDGER', '累计释放板位格式不正确。');
      if (knownSlots(e.releasedSlots) && e.releasedSlots > e.physicalP) fail('BAD_LEDGER', '累计释放板位不能多于累计实物出库量。');
      result[e.inventoryId] = copy(e);
    });
    return result;
  }
  function knownSlots(value) { return integer(value); }
  function material(row, physicalP, releasedSlots) {
    return { inventoryId: row.inventoryId, location: row.location, destination: row.destination || null,
      shipmentId: row.shipmentId || null, physicalP: physicalP, releasedSlots: releasedSlots === undefined ? null : releasedSlots };
  }
  function computeLoadingEffect(input) {
    input = input || {};
    var issues = [], original = copy(input.inventory || []), inventory = copy(original), taskId = text(input.taskId);
    var baseline = input.baseline || {}, baselineVersion = text(baseline.version), state = STATES[text(input.status)];
    var previous = copy(input.previous || ((baseline.appliedTasks || {})[taskId]) || {});
    var result = { version: VERSION, taskId: taskId, status: text(input.status), baselineVersion: baselineVersion,
      ok: false, blocked: true, issues: issues, actualDeltas: [], planSlotDeltas: [], inventoryAfter: original,
      nextLedger: previous, proposal: null };
    function add(code, message, extra, severity) { issues.push(issue(code, message, extra, severity)); }
    if (!taskId) add('MISSING_TASK', '装车任务尚未建立唯一标识。');
    if (baseline.confirmed !== true || !baselineVersion) add('UNCONFIRMED_BASELINE', '缺少已确认库存基准及版本，禁止改动库存。');
    if (!Array.isArray(input.inventory)) add('MISSING_INVENTORY', '未提供当前库存明细。');
    if (!Array.isArray(input.allowedLocations) || !input.allowedLocations.length) add('MISSING_LOCATIONS', '未配置有效库位清单。');
    if (!Array.isArray(input.otherTaskPlans)) add('MISSING_RESERVATION_SCOPE', '缺少其他任务已生效的预计剩余量；没有其他任务时需明确提供空清单。');
    if (!state) add('UNKNOWN_STATUS', '装车状态未配置：' + text(input.status));
    if (previous.taskId && previous.taskId !== taskId) add('TASK_MISMATCH', '旧累计记录属于其他任务。');
    if (input.previous && Object.keys(input.previous).length && text(input.previous.baselineVersion) !== baselineVersion) {
      add('STALE_LEDGER_BASELINE', '旧任务累计所属库存基准与当前基准不同，需要先按已确认基准对齐，禁止重复扣减。');
    }
    var rows = Object.create(null), priorActual, priorPlanned, priorRemaining, plannedMap, actualMap;
    try {
      inventory.forEach(function (row) {
        if (!text(row.inventoryId) || rows[row.inventoryId]) fail('BAD_INVENTORY_ID', '库存标识缺失或重复。');
        row.inventoryId = text(row.inventoryId);
        row.location = normalizeLocation(row.location, { allowedLocations: input.allowedLocations });
        row.destination = text(row.destination) || null; row.shipmentId = text(row.shipmentId) || null;
        if (!integer(row.physicalP)) fail('BAD_INVENTORY_QUANTITY', '库存实物板数缺失或无效：' + row.inventoryId);
        if (row.occupiedSlots !== null && row.occupiedSlots !== undefined && !integer(row.occupiedSlots)) fail('BAD_OCCUPANCY', '占位数必须为已知非负整数或空值。');
        if (row.slotBasis === 'one_per_pallet' && knownSlots(row.occupiedSlots) && row.occupiedSlots !== row.physicalP) fail('OCCUPANCY_CONFLICT', '一板一位声明与占位记录不一致：' + row.inventoryId);
        if (row.slotBasis === 'one_per_pallet' && !knownSlots(row.occupiedSlots)) row.occupiedSlots = row.physicalP;
        rows[row.inventoryId] = row;
      });
      priorActual = byId(previous.actual || []); priorPlanned = byId(previous.planned || []);
      priorRemaining = Object.create(null);
      (previous.projectedRemaining || []).forEach(function (e) { priorRemaining[e.inventoryId] = e; });
      plannedMap = parseMap(input.plannedEntries === undefined ? input.plannedText : input.plannedEntries,
        { allowedLocations: input.allowedLocations });
      actualMap = parseMap(input.actualEntries === undefined ? input.actualText : input.actualEntries,
        { allowedLocations: input.allowedLocations, zeroEntries: plannedMap.entries });
    } catch (e) { add(e.code || 'INVALID_INPUT', e.message); return result; }
    if (issues.some(function (i) { return i.severity === 'error'; })) return result;

    function resolve(entries, kind) {
      var resolved = Object.create(null);
      entries.forEach(function (entry) {
        var dest = entry.destination || text(input.destination), shipment = entry.shipmentId || text(input.shipmentId);
        var candidates = inventory.filter(function (r) {
          return r.location === entry.location && (!dest || identity(r.destination) === identity(dest)) &&
            (!shipment || text(r.shipmentId) === shipment);
        });
        if (!candidates.length) { add('INVENTORY_NOT_FOUND', '找不到对应库存：' + entry.location, { kind: kind, location: entry.location, destination: dest || null, shipmentId: shipment || null }); return; }
        if (candidates.length > 1 && input.allowSameDestinationLots === true && dest) {
          // An explicit warehouse point permits bookkeeping across its lots. Retain the
          // already committed allocation before assigning only the new cumulative amount.
          // A new receipt must never move yesterday's loading quantity onto a new lot.
          if (knownSlots(entry.releasedSlots) && entry.releasedSlots > 0 &&
              !candidates.every(function (r) { return r.slotBasis === 'one_per_pallet'; })) {
            add('AMBIGUOUS_SLOT_ALLOCATION', '多批货的实测释放板位需逐批确认；可先记录实物板数。', { kind: kind, location: entry.location }); return;
          }
          if (knownSlots(entry.releasedSlots) && candidates.every(function (r) { return r.slotBasis === 'one_per_pallet'; }) && entry.releasedSlots !== entry.physicalP) {
            add('SLOT_BASIS_CONFLICT', '显式释放位数与当前一板一位声明不一致。', { kind: kind, location: entry.location }); return;
          }
          var ordered = candidates.slice().sort(function (a, b) {
            var at = text(a.receivedAt || a.createdAt), bt = text(b.receivedAt || b.createdAt);
            return at < bt ? -1 : at > bt ? 1 : a.inventoryId < b.inventoryId ? -1 : a.inventoryId > b.inventoryId ? 1 : 0;
          });
          var previousMap = kind === 'actual' ? priorActual : priorPlanned;
          var assigned = Object.create(null), remaining = entry.physicalP;
          function otherReserved(id) {
            return (input.otherTaskPlans || []).reduce(function (sum, task) {
              if (!task || task.taskId === taskId || !Array.isArray(task.projectedRemaining)) return sum;
              return sum + task.projectedRemaining.reduce(function (p, item) {
                return p + (item.inventoryId === id && integer(item.physicalP) ? item.physicalP : 0);
              }, 0);
            }, 0);
          }
          function limit(row) {
            var oldActual = priorActual[row.inventoryId] ? priorActual[row.inventoryId].physicalP : 0;
            return kind === 'actual' ? Math.max(0, row.physicalP - otherReserved(row.inventoryId)) :
              Math.max(0, row.physicalP + oldActual - otherReserved(row.inventoryId));
          }
          ordered.forEach(function (row) {
            var previousP = previousMap[row.inventoryId] ? previousMap[row.inventoryId].physicalP : 0;
            var retain = Math.min(remaining, kind === 'actual' ? previousP : Math.min(previousP, limit(row)));
            assigned[row.inventoryId] = retain; remaining -= retain;
          });
          ordered.forEach(function (row) {
            var oldActual = priorActual[row.inventoryId] ? priorActual[row.inventoryId].physicalP : 0;
            var available = kind === 'actual' ? limit(row) - Math.max(0, assigned[row.inventoryId] - oldActual) : limit(row) - assigned[row.inventoryId];
            var take = Math.min(remaining, Math.max(0, available));
            assigned[row.inventoryId] += take; remaining -= take;
          });
          if (remaining > 0) {
            add(kind === 'actual' ? 'INSUFFICIENT_PHYSICAL' : 'PLANNED_EXCEEDS_STOCK', '同仓点各批次可用数量不足：' + entry.location,
              { kind: kind, location: entry.location, destination: dest, missingPhysicalP: remaining }); return;
          }
          ordered.forEach(function (row) {
            var p = assigned[row.inventoryId];
            if (!p && !previousMap[row.inventoryId] && !priorActual[row.inventoryId]) return;
            if (resolved[row.inventoryId]) { add('DUPLICATE_INVENTORY', '同一批库存被重复填写：' + row.inventoryId, { kind: kind }); return; }
            var slots = row.slotBasis === 'one_per_pallet' ? p : p === 0 || entry.releasedSlots === 0 ? 0 : null;
            resolved[row.inventoryId] = material(row, p, slots);
          });
          return;
        }
        if (candidates.length !== 1) { add('AMBIGUOUS_INVENTORY', '该库位有多批货，请补仓点或货物标识：' + entry.location, { kind: kind, location: entry.location, candidateIds: candidates.map(function (r) { return r.inventoryId; }) }); return; }
        var row = candidates[0];
        if (resolved[row.inventoryId]) { add('DUPLICATE_INVENTORY', '同一批库存被重复填写：' + row.inventoryId, { kind: kind }); return; }
        if (row.slotBasis === 'one_per_pallet' && knownSlots(entry.releasedSlots) && entry.releasedSlots !== entry.physicalP) {
          add('SLOT_BASIS_CONFLICT', '显式释放位数与当前一板一位声明不一致。', { inventoryId: row.inventoryId }); return;
        }
        var slots = knownSlots(entry.releasedSlots) ? entry.releasedSlots : row.slotBasis === 'one_per_pallet' ? entry.physicalP : entry.physicalP === 0 ? 0 : null;
        resolved[row.inventoryId] = material(row, entry.physicalP, slots);
      });
      return resolved;
    }
    var newPlan = state === 'active' ? resolve(plannedMap.entries, 'planned') : Object.create(null);
    var newActual = actualMap.known ? resolve(actualMap.entries, 'actual') : copy(priorActual);
    if (state === 'active' && !plannedMap.known) {
      if (input.allowActualWithoutPlan === true && actualMap.known) add('PLAN_UNKNOWN_ACTUAL_RECORDED', '已按明确实际累计记账；预计未知，不额外计算预计释放。', {}, 'warning');
      else add('MISSING_PLANNED', '装车已开始，但缺少逐库位预计板数。');
    }
    if ((state === 'finished' || state === 'holding') && !actualMap.known) add('MISSING_ACTUAL', '装车已结束或留台等货，需要确认逐库位实际累计板数。');
    Object.keys(priorActual).forEach(function (id) {
      if (!rows[id]) add('PREVIOUS_INVENTORY_MISSING', '旧累计对应的库存行已缺失，需先恢复关联：' + id);
      if (actualMap.known && !newActual[id] && priorActual[id].physicalP > 0) add('ACTUAL_ENTRY_REMOVED', '旧实际累计的库位不能直接删掉；更正为0须明确填写并说明：' + id);
      if (!actualMap.known && priorActual[id].physicalP > 0 && (state === 'waiting' || state === 'cancelled')) {
        add('ACTUAL_PRESERVED', '状态回退或取消，保留已经确认的实际装车量。', { inventoryId: id }, 'warning');
      }
    });
    if (actualMap.known && (state === 'waiting' || state === 'cancelled')) {
      Object.keys(newActual).forEach(function (id) {
        if (newActual[id].physicalP > (priorActual[id] ? priorActual[id].physicalP : 0)) add('STATUS_ACTUAL_CONFLICT', '等待或取消状态出现新增实际装车量，需先核实状态。', { inventoryId: id });
      });
    }
    var otherReservations = Object.create(null), otherTaskIds = Object.create(null);
    (input.otherTaskPlans || []).forEach(function (task) {
      if (task.taskId === taskId) return;
      if (!text(task.taskId) || otherTaskIds[task.taskId] || !Array.isArray(task.projectedRemaining)) {
        add('BAD_RESERVATION', '其他任务的预计记录缺少唯一任务号或剩余量，或重复提供同一任务。'); return;
      }
      otherTaskIds[task.taskId] = true;
      var rem;
      try { rem = byId(task.projectedRemaining); } catch (e) { add(e.code || 'BAD_RESERVATION', e.message); return; }
      Object.keys(rem).forEach(function (id) {
        if (!rows[id]) { add('RESERVATION_INVENTORY_MISSING', '其他任务预计量对应的库存行不存在：' + id); return; }
        var sum = otherReservations[id] || { physicalP: 0, releasedSlots: 0, taskIds: [] };
        sum.physicalP += rem[id].physicalP;
        sum.releasedSlots = knownSlots(sum.releasedSlots) && knownSlots(rem[id].releasedSlots) ? sum.releasedSlots + rem[id].releasedSlots : null;
        sum.taskIds.push(task.taskId); otherReservations[id] = sum;
      });
    });
    var allIds = Object.keys(Object.assign({}, priorActual, priorPlanned, newActual, newPlan)).sort();
    var actualDeltas = [], planDeltas = [], projectedRemaining = [], idsWithUnknownSlots = [];
    allIds.forEach(function (id) {
      var row = rows[id]; if (!row) return;
      var oldA = priorActual[id] || material(row, 0, 0), nextA = newActual[id] || material(row, 0, 0);
      var oldP = priorPlanned[id] || material(row, 0, 0), nextP = newPlan[id] || material(row, 0, 0);
      var diff = nextA.physicalP - oldA.physicalP;
      if (diff < 0 && input.correctionConfirmed !== true) add('ACTUAL_DECREASE_NEEDS_CONFIRMATION', '实际累计减少需要明确核实并记录更正原因。', { inventoryId: id });
      if (diff < 0 && input.correctionConfirmed === true && !text(input.correctionReason)) add('MISSING_CORRECTION_REASON', '实际累计更正需要填写原因。', { inventoryId: id });
      if (diff > row.physicalP) add('INSUFFICIENT_PHYSICAL', '实际出库超过对应库存余量。', { inventoryId: id, available: row.physicalP, requested: diff });
      if (nextP.physicalP > row.physicalP + oldA.physicalP) add('PLANNED_EXCEEDS_STOCK', '预计出库超过该任务可对应的库存。', { inventoryId: id });
      if (nextA.physicalP > nextP.physicalP && state === 'active' && plannedMap.known) add('ACTUAL_EXCEEDS_PLAN', '实际累计大于当前预计总量，保留真实数量并提示核对。', { inventoryId: id }, 'warning');
      var releasedDiff = null;
      if (row.slotBasis === 'one_per_pallet') releasedDiff = diff;
      else if (knownSlots(nextA.releasedSlots) && knownSlots(oldA.releasedSlots)) releasedDiff = nextA.releasedSlots - oldA.releasedSlots;
      else if (diff === 0) releasedDiff = 0;
      if ((releasedDiff < 0 || (diff === 0 && releasedDiff !== 0)) && input.correctionConfirmed !== true) {
        add('SLOT_CORRECTION_NEEDS_CONFIRMATION', '累计释放板位发生更正，需要核实并记录原因。', { inventoryId: id });
      }
      if ((releasedDiff < 0 || (diff === 0 && releasedDiff !== 0)) && input.correctionConfirmed === true && !text(input.correctionReason)) {
        add('MISSING_CORRECTION_REASON', '释放板位更正需要填写原因。', { inventoryId: id });
      }
      if (diff !== 0 || releasedDiff !== 0) actualDeltas.push(material(row, diff, releasedDiff));
      var oldRemainP = Math.max(0, oldP.physicalP - oldA.physicalP);
      var newRemainP = Math.max(0, nextP.physicalP - nextA.physicalP);
      function remainingSlots(plan, actual, remainingP) {
        if (!remainingP) return 0;
        if (row.slotBasis === 'one_per_pallet') return remainingP;
        if (knownSlots(plan.releasedSlots) && knownSlots(actual.releasedSlots)) return Math.max(0, plan.releasedSlots - actual.releasedSlots);
        return null;
      }
      var oldRemainSlots = priorRemaining[id] ? priorRemaining[id].releasedSlots : remainingSlots(oldP, oldA, oldRemainP);
      var newRemainSlots = remainingSlots(nextP, nextA, newRemainP);
      projectedRemaining.push(material(row, newRemainP, newRemainSlots));
      var planDelta = knownSlots(oldRemainSlots) && knownSlots(newRemainSlots) ? newRemainSlots - oldRemainSlots : null;
      if (planDelta !== 0 || oldRemainP !== newRemainP) planDeltas.push(Object.assign(material(row, newRemainP - oldRemainP, planDelta), { previousRemainingSlots: oldRemainSlots, nextRemainingSlots: newRemainSlots }));
      row.physicalP -= diff;
      if (releasedDiff === null && diff !== 0) {
        if (knownSlots(row.occupiedSlots)) row.lastConfirmedOccupiedSlots = row.occupiedSlots;
        row.occupiedSlots = null; row.slotBasis = 'unknown'; idsWithUnknownSlots.push(id);
      } else if (knownSlots(row.occupiedSlots)) {
        row.occupiedSlots -= releasedDiff || 0;
        if (row.occupiedSlots < 0) add('INSUFFICIENT_OCCUPANCY', '释放板位超过已知占位，需要核实叠放或释放量。', { inventoryId: id });
      }
      if (newRemainP > 0 && newRemainSlots === null && idsWithUnknownSlots.indexOf(id) < 0) idsWithUnknownSlots.push(id);
      if (!knownSlots(row.occupiedSlots) && idsWithUnknownSlots.indexOf(id) < 0) idsWithUnknownSlots.push(id);
      if (knownSlots(newRemainSlots) && knownSlots(row.occupiedSlots) && newRemainSlots > row.occupiedSlots) add('PLANNED_RELEASE_EXCEEDS_OCCUPANCY', '预计剩余释放板位超过当前已知占位。', { inventoryId: id });
    });
    var ownRemaining = Object.create(null), reservationSummary = [];
    projectedRemaining.forEach(function (v) { ownRemaining[v.inventoryId] = v; });
    Object.keys(rows).sort().forEach(function (id) {
      var row = rows[id], other = otherReservations[id] || { physicalP: 0, releasedSlots: 0, taskIds: [] };
      var own = ownRemaining[id] || { physicalP: 0, releasedSlots: 0 };
      var totalP = other.physicalP + own.physicalP;
      var totalSlots = knownSlots(other.releasedSlots) && knownSlots(own.releasedSlots) ? other.releasedSlots + own.releasedSlots : null;
      if (totalP > row.physicalP) add('PLAN_OVERBOOKED', '多个装车任务预计装出的剩余总量超过现有实物，不能重复预留同一批货。', {
        inventoryId: id, availablePhysicalP: row.physicalP, reservedPhysicalP: totalP, otherTaskIds: other.taskIds
      });
      if (knownSlots(totalSlots) && knownSlots(row.occupiedSlots) && totalSlots > row.occupiedSlots) add('PLAN_CAPACITY_OVERBOOKED', '多个装车任务的预计释放板位超过当前已知占位。', { inventoryId: id });
      if (totalP > 0) reservationSummary.push({ inventoryId: id, physicalP: totalP, releasedSlots: totalSlots, otherTaskIds: other.taskIds });
    });
    result.reservationSummary = reservationSummary;
    if (idsWithUnknownSlots.length) add('CAPACITY_UNCERTAIN', '实物板数可记录，但叠放／释放板位依据不足；未知余量不计作可用空间。', { inventoryIds: idsWithUnknownSlots }, 'warning');
    result.actualKnown = actualMap.known;
    result.plannedKnown = plannedMap.known;
    result.capacityCertain = idsWithUnknownSlots.length === 0;
    if (issues.some(function (i) { return i.severity === 'error'; })) return result;
    inventory.forEach(function (row) {
      row.conservativeOccupiedSlots = knownSlots(row.occupiedSlots) ? row.occupiedSlots : row.physicalP;
      row.conservativeBasis = knownSlots(row.occupiedSlots) ? 'confirmed_occupancy' : 'one_pallet_upper_bound';
    });
    var nextLedger = { taskId: taskId, status: text(input.status), baselineVersion: baselineVersion,
      actual: Object.keys(newActual).sort().map(function (id) { return newActual[id]; }),
      planned: Object.keys(newPlan).sort().map(function (id) { return newPlan[id]; }),
      projectedRemaining: projectedRemaining.filter(function (v) { return v.physicalP !== 0 || v.releasedSlots !== 0; }) };
    result.ok = true; result.blocked = false; result.actualDeltas = actualDeltas; result.planSlotDeltas = planDeltas;
    result.inventoryAfter = inventory; result.nextLedger = nextLedger;
    result.proposal = { taskId: taskId, baselineVersion: baselineVersion, actualDeltas: actualDeltas,
      planSlotDeltas: planDeltas, inventoryAfter: inventory, nextLedger: nextLedger };
    return result;
  }
  function deterministicValidateProposal(candidate, effect) {
    var errors = [];
    if (!effect || effect.ok !== true || effect.blocked || !effect.proposal) errors.push(issue('BLOCKED_EFFECT', '当前变更没有通过业务校验，禁止提交。'));
    var payload = candidate && candidate.proposal ? candidate.proposal : candidate;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) errors.push(issue('BAD_PROPOSAL', '处理方案必须为结构化对象。'));
    if (!errors.length && stableStringify(payload) !== stableStringify(effect.proposal)) errors.push(issue('PROPOSAL_MISMATCH', '处理方案与已核算的任务、库存、容量差额不一致。'));
    return { ok: errors.length === 0, errors: errors };
  }
  var PROPOSAL_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['taskId', 'baselineVersion', 'actualDeltas', 'planSlotDeltas', 'inventoryAfter', 'nextLedger'],
    properties: {
      taskId: { type: 'string' }, baselineVersion: { type: 'string' },
      actualDeltas: { type: 'array', items: { type: 'object' } },
      planSlotDeltas: { type: 'array', items: { type: 'object' } },
      inventoryAfter: { type: 'array', items: { type: 'object' } }, nextLedger: { type: 'object' }
    }
  };
  return { VERSION: VERSION, parseMap: parseMap, parseCell: parseMap, normalizeLocation: normalizeLocation,
    computeLoadingEffect: computeLoadingEffect, buildExpectedEffect: computeLoadingEffect,
    deterministicValidateProposal: deterministicValidateProposal, validateProposal: deterministicValidateProposal,
    stableStringify: stableStringify, PROPOSAL_SCHEMA: PROPOSAL_SCHEMA };
}());
if (typeof module !== 'undefined' && module.exports) module.exports = WTCLoadCore;
