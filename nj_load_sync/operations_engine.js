/* Warehouse actual receipts, physical moves and closing counts. Pure Apps Script V8 rules. */
var WTCInventoryCore = (function () {
  'use strict';
  var VERSION = '1.3.0';
  function copy(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function text(value) { return value == null ? '' : String(value).trim(); }
  function identity(value) { return text(value).replace(/\s+/g, ' ').toUpperCase(); }
  function stable(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().filter(function (key) { return value[key] !== undefined; }).map(function (key) { return JSON.stringify(key) + ':' + stable(value[key]); }).join(',') + '}';
  }
  function fail(code, message, details) { var error = new Error(message); error.code = code; error.details = details; throw error; }
  function issue(code, message, severity, details) { return Object.assign({ code: code, message: message, severity: severity || 'error' }, details || {}); }
  function integer(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
  function quantity(value, label) { if (!integer(value)) fail('INVALID_QUANTITY', (label || '实物板数') + '必须为已确认的非负整数。'); return value; }
  function date(value) {
    var raw = text(value), match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!match) fail('INVALID_BUSINESS_DATE', '业务日期需为 YYYY-MM-DD。');
    var check = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
    if (check.getUTCFullYear() !== +match[1] || check.getUTCMonth() !== +match[2] - 1 || check.getUTCDate() !== +match[3]) fail('INVALID_BUSINESS_DATE', '业务日期无效。');
    return raw;
  }
  function location(value) {
    var raw = identity(value).replace(/\s+/g, '');
    if (raw === 'OFFICE' || raw === '检查区') return '检查区';
    var match = /^([A-Z]{1,2})(#|\d+)$/.exec(raw);
    if (!match || (match[2] !== '#' && +match[2] < 1)) fail('INVALID_LOCATION', '库位格式无效：' + text(value));
    return match[1] + (match[2] === '#' ? '11' : String(+match[2]));
  }
  function scopedLocation(value, state, allowInspection) {
    var loc = location(value);
    if (loc === '检查区' && !allowInspection) fail('PRIVATE_SCOPE_EXCLUDED', '本版暂不处理 office／检查区及私仓归线。');
    var catalog = state.capacityCatalog || {}, known = Object.prototype.hasOwnProperty.call(catalog, loc) || state.inventory.some(function (row) { return location(row.location) === loc; });
    if (!known) fail('UNKNOWN_LOCATION', '库位不在已配置目录内：' + loc);
    return loc;
  }
  function key(row, useShipment) { return location(row.location) + '\u001f' + identity(row.destination) + (useShipment ? '\u001f' + text(row.shipmentId) : ''); }
  function total(inventory) { return inventory.reduce(function (sum, row) { return sum + row.physicalP; }, 0); }
  function stateCheck(state) {
    if (!state || !Array.isArray(state.inventory) || !state.baseline || state.baseline.confirmed !== true || !text(state.baseline.version)) fail('BASELINE_MISSING', '需要先确认当前库存基准。');
    if (!Number.isSafeInteger(state.version) || state.version < 0) fail('STATE_VERSION_INVALID', '库存状态版本无效。');
    var ids = {};
    state.inventory.forEach(function (row) {
      if (!text(row.inventoryId) || ids[row.inventoryId]) fail('INVENTORY_ID_INVALID', '库存记录ID缺失或重复。');
      ids[row.inventoryId] = true; location(row.location); quantity(row.physicalP);
    });
  }
  function privateItem(row) {
    var destination = identity(row.destination);
    return row.private === true || row.privateCargo === true || !!text(row.specialType) || (text(row.route) && text(row.route) !== 'ordinary') || /私仓|私人地址|自提|库内操作|^UPS$|^FEDEX$/.test(destination) || /^(?:NJ|NY|PA|CT|MA|CA|FL)\s*\d{5}(?:\D|$)/.test(destination);
  }
  function initialCloseDate(state) {
    var retained = text(state.initialClosedBusinessDate);
    if (retained) return retained;
    if (state.closedLocationDates) return '';
    var explicit = text(state.lastClosedBusinessDate);
    if (explicit) return explicit;
    var match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+收工后$/.exec(text(state.baseline.asOf));
    return match ? match[1] + '-' + ('0' + match[2]).slice(-2) + '-' + ('0' + match[3]).slice(-2) : '';
  }
  function closeDate(state, loc) {
    var initial = initialCloseDate(state), local = text((state.closedLocationDates || {})[loc]);
    return initial > local ? initial : local;
  }
  function notClosed(state, businessDate, locations) {
    var closed = (locations || []).filter(function (loc) { var boundary = closeDate(state, loc); return boundary && businessDate <= boundary; });
    if (closed.length) fail('CLOSED_DAY_REQUIRES_CORRECTION', '该业务日及库位已包含在已确认收工盘点内，不能再次直接入库或移库；需另行核对更正。', { closedLocations: closed });
  }
  function fingerprint(operation) {
    var semantic = copy(operation);
    if (semantic.type === 'receipt' && Array.isArray(semantic.semanticItems)) {
      semantic.items = semantic.semanticItems;
      delete semantic.semanticItems;
    }
    ['operationId', 'countId', 'sourceRef', 'observedAt', 'acceptDifferences', 'confirmed', 'reason'].forEach(function (name) { delete semantic[name]; });
    if (Array.isArray(semantic.items)) semantic.items = semantic.items.slice().sort(function (a, b) { return stable(a).localeCompare(stable(b)); });
    if (Array.isArray(semantic.counts)) semantic.counts = semantic.counts.slice().sort(function (a, b) { return stable(a).localeCompare(stable(b)); });
    if (Array.isArray(semantic.scopeLocations)) semantic.scopeLocations.sort();
    return stable(semantic);
  }
  function unpack(input, op, now) { return input && input.state ? input : { state: input, operation: op, now: now }; }
  function capacity(state, loc) {
    var entry = (state.capacityCatalog || {})[loc];
    if (entry && integer(entry.capacitySlots)) return entry.capacitySlots;
    var row = state.inventory.filter(function (item) { return location(item.location) === loc && integer(item.capacitySlots); })[0];
    return row ? row.capacitySlots : null;
  }
  function markLocations(state, locations) {
    state.catalogOverrides = state.catalogOverrides || {};
    locations.filter(function (loc, index, list) { return list.indexOf(loc) === index; }).forEach(function (loc) {
      var physical = state.inventory.filter(function (row) { return location(row.location) === loc; }).reduce(function (sum, row) { return sum + row.physicalP; }, 0);
      var status = physical ? '已确认有货' : '空位';
      var update = { location: loc, status: status, physicalP: physical, capacitySlots: capacity(state, loc), availableSlots: physical ? null : capacity(state, loc), basis: 'actual_operation' };
      state.catalogOverrides[loc] = update;
      state.capacityCatalog = state.capacityCatalog || {};
      state.capacityCatalog[loc] = Object.assign({}, state.capacityCatalog[loc] || {}, update);
    });
  }
  function quarantineOverbookedPlans(state, issues) {
    var totals = {}, inventory = {};
    state.inventory.forEach(function (row) { inventory[row.inventoryId] = row; });
    Object.keys(state.tasks || {}).forEach(function (id) {
      var ledger = state.tasks[id].ledger;
      (ledger && ledger.projectedRemaining || []).forEach(function (row) { totals[row.inventoryId] = (totals[row.inventoryId] || 0) + row.physicalP; });
    });
    var staleIds = Object.keys(totals).filter(function (id) { return !inventory[id] || totals[id] > inventory[id].physicalP; });
    if (!staleIds.length) return;
    Object.keys(state.tasks || {}).forEach(function (id) {
      var task = state.tasks[id], ledger = task.ledger;
      if (!ledger || !(ledger.projectedRemaining || []).some(function (row) { return staleIds.indexOf(row.inventoryId) >= 0; })) return;
      ledger.projectedRemaining = (ledger.projectedRemaining || []).filter(function (row) { return staleIds.indexOf(row.inventoryId) < 0; });
      if (state.baseline.appliedTasks && state.baseline.appliedTasks[id]) state.baseline.appliedTasks[id] = copy(ledger);
      task.pending = true; task.pendingCode = 'PHYSICAL_PLAN_REVIEW'; task.lastResult = '实际移库或盘点改变了原库位货量；对应装车预计释放已撤下，请核对预计库位。';
      issues.push(issue('LOADING_PLAN_REVIEW', task.lastResult, 'warning', { taskId: id, inventoryIds: staleIds.slice() }));
    });
  }
  function delta(row, amount) { return { inventoryId: row.inventoryId, location: row.location, destination: row.destination || null, shipmentId: row.shipmentId || null, containerNo: row.containerNo || row.sourceContainerNo || null, physicalP: amount }; }
  function recordId(prefix, operationId, index) { return prefix + encodeURIComponent(operationId) + '-' + String(index + 1); }
  function addLot(state, item, id, provenance) {
    if (state.inventory.some(function (row) { return row.inventoryId === id; })) fail('LOT_ID_COLLISION', '新增库存标识已存在，未覆盖旧记录。');
    var row = Object.assign({ inventoryId: id, location: item.location, destination: item.destination || null, shipmentId: item.shipmentId || null, physicalP: item.physicalP, occupiedSlots: item.physicalP === 0 ? 0 : null, slotBasis: item.physicalP === 0 ? 'explicit' : 'unknown', capacitySlots: capacity(state, item.location) }, provenance || {});
    state.inventory.push(row); return row;
  }
  function normalizeReceipt(state, operation) {
    var container = identity(operation.containerNo);
    if (!/^[A-Z]{4}\d{7}$/.test(container)) fail('CONTAINER_REQUIRED', '实拆回单需要完整实体柜号（四字母七数字）。');
    if (!text(operation.sourceRef)) fail('RECEIPT_SOURCE_REQUIRED', '实拆回单需要可追溯照片或扫描件来源。');
    if (!Array.isArray(operation.items) || !operation.items.length) fail('RECEIPT_EMPTY', '回单没有实拆条目。');
    var seen = {}, semanticItems = operation.items.map(function (row) {
      if (privateItem(row)) fail('PRIVATE_SCOPE_EXCLUDED', '本版暂不处理私仓／office 回单条目。');
      if (!Array.isArray(row.allocationIds || [])) fail('ALLOCATION_IDS_INVALID', '分配ID必须为数组。');
      var item = { destination: identity(row.destination), shipmentId: text(row.shipmentId), physicalP: quantity(row.physicalP), allocationIds: (row.allocationIds || []).map(text).sort() };
      if (row.locationOrder !== undefined) {
        if (!Array.isArray(row.locationOrder) || row.locationOrder.length < 2) fail('LOCATION_ORDER_INVALID', '顺序分位需要至少两个明确库位。');
        item.locationOrder = row.locationOrder.map(function (loc) { return scopedLocation(loc, state, false); });
        if (item.locationOrder.some(function (loc, index, list) { return list.indexOf(loc) !== index; })) fail('LOCATION_ORDER_INVALID', '顺序分位库位不能重复。');
      } else item.location = scopedLocation(row.location, state, false);
      if (!item.destination) fail('DESTINATION_REQUIRED', '每个实拆条目需标明仓点。');
      if (item.allocationIds.some(function (id) { return !id; })) fail('ALLOCATION_IDS_INVALID', '分配ID不能为空。');
      var token = (item.location || item.locationOrder.join('/')) + '\u001f' + item.destination + '\u001f' + item.shipmentId;
      if (seen[token]) fail('DUPLICATE_RECEIPT_ITEM', '同库位同货物的回单条目重复；请先合并实际板数。');
      seen[token] = true; return item;
    });
    semanticItems.sort(function (a, b) { return stable(a).localeCompare(stable(b)); });
    var normalized = { type: 'receipt', businessDate: date(operation.businessDate), containerNo: container, semanticItems: semanticItems, items: [] };
    var prior = (state.receipts || {})[container + '|' + normalized.businessDate];
    if (prior) { normalized.items = copy(prior.items || []); return normalized; }
    var allocationLookup = {}, addedByLocation = {};
    Object.keys(state.unloadTasks || {}).forEach(function (id) {
      var ledger = state.unloadTasks[id].ledger || state.unloadTasks[id];
      if (identity(ledger.containerNo) !== container && identity(id) !== container && !(ledger.publishedAllocations || []).some(function (row) { return identity(row.containerNo) === container; })) return;
      (ledger.publishedAllocations || []).forEach(function (row) { allocationLookup[row.allocationId] = row; });
    });
    semanticItems.forEach(function (source) {
      if (!source.locationOrder) {
        normalized.items.push(copy(source)); addedByLocation[source.location] = (addedByLocation[source.location] || 0) + source.physicalP; return;
      }
      source.allocationIds.forEach(function (id) { if (!allocationLookup[id]) fail('ALLOCATION_NOT_IN_CONTAINER', '顺序分位引用的分配ID不属于该柜。'); });
      var publishedSequence = source.allocationIds.length > 0, sourcePublications = [];
      if (publishedSequence) {
        source.allocationIds.forEach(function (id) {
          var published = allocationLookup[id], loc = location(published.location);
          if (source.locationOrder.indexOf(loc) < 0 || identity(published.destination) !== source.destination || (source.shipmentId && text(published.shipmentId) && text(published.shipmentId) !== source.shipmentId) || privateItem(published)) fail('SEQUENTIAL_PUBLICATION_MISMATCH', '顺序分位的纸位来源与仓点、票号或库位范围不符。');
          if (!integer(published.estimatedP) || !text(published.publicationId) || !text(published.revision)) fail('SEQUENTIAL_PUBLICATION_UNVERIFIED', '顺序分位缺少可核实的已发布补满额度或发布版本；未用后续库存倒推。');
          sourcePublications.push({ allocationId: id, publicationId: text(published.publicationId), revision: text(published.revision), location: loc, publishedEstimatedP: published.estimatedP });
        });
        if (source.locationOrder.some(function (loc) { return !sourcePublications.some(function (row) { return row.location === loc; }); })) fail('SEQUENTIAL_PUBLICATION_INCOMPLETE', '顺序分位没有覆盖每个标记库位的纸位来源；未用后续库存倒推。');
      } else if (Object.keys(allocationLookup).some(function (id) { var row = allocationLookup[id]; return identity(row.destination) === source.destination && source.locationOrder.indexOf(location(row.location)) >= 0; })) fail('SEQUENTIAL_PUBLISHED_BINDING_REQUIRED', '该组已有已发布纸位，需关联完整分配ID后按原约定额度分摊，不能改用后续库存倒推。');
      var remaining = source.physicalP;
      source.locationOrder.forEach(function (loc, index) {
        var p, basis;
        if (publishedSequence) {
          var quota = sourcePublications.filter(function (row) { return row.location === loc; }).reduce(function (sum, row) { return sum + row.publishedEstimatedP; }, 0);
          p = index === source.locationOrder.length - 1 ? remaining : Math.min(remaining, quota);
          basis = '按已发布纸位前序约定补满额度顺序分摊，余量续末位，非逐线实测；未用后续库存倒推';
        } else {
          var cap = capacity(state, loc);
          if (!integer(cap)) fail('SEQUENTIAL_CAPACITY_UNKNOWN', '顺序分位缺少库位名义容量，不能凭空拆分。');
          var current = state.inventory.filter(function (row) { return location(row.location) === loc; }).reduce(function (sum, row) { return sum + row.physicalP; }, 0);
          p = Math.min(remaining, Math.max(0, cap - current - (addedByLocation[loc] || 0)));
          basis = '未有发布纸位，按提交时账面实物与名义线容量顺序分摊，非逐线实测';
        }
        var allocationIds = source.allocationIds.filter(function (id) { return location(allocationLookup[id].location) === loc; });
        normalized.items.push({ location: loc, destination: source.destination, shipmentId: source.shipmentId, physicalP: p, allocationIds: allocationIds, allocationBasis: basis, sourceAllocationPublication: copy(sourcePublications), sourceLocationOrder: source.locationOrder.slice(), sourceGroupPhysicalP: source.physicalP });
        addedByLocation[loc] = (addedByLocation[loc] || 0) + p; remaining -= p;
      });
      if (remaining) fail('SEQUENTIAL_LOCATION_OVERFLOW', '所列顺序库位按账面余量不能容纳整组实拆量；未擅自另分库位。');
    });
    var items = normalized.items, duplicate = {};
    items.forEach(function (item) { var token = key(item, true); if (duplicate[token]) fail('DUPLICATE_RECEIPT_ITEM', '顺序分位与其他条目落在同一库位同货物，请先合并。'); duplicate[token] = true; });
    items.sort(function (a, b) { return key(a, true).localeCompare(key(b, true)); });
    return normalized;
  }
  function receiptEffect(state, operation, normalized, issues) {
    var receiptKey = normalized.containerNo + '|' + normalized.businessDate, receiptFingerprint = fingerprint(normalized), prior = (state.receipts || {})[receiptKey];
    if (prior) {
      if (prior.fingerprint === receiptFingerprint) return { noOp: true, existing: prior };
      fail('RECEIPT_ALREADY_POSTED', '同柜同业务日已有实拆入账，新的数量或库位不能再次叠加入库；需明确更正。');
    }
    notClosed(state, normalized.businessDate, normalized.items.map(function (item) { return item.location; }));
    var records = [], allocations = {}, allOrdinaryIds = [], claimed = {};
    Object.keys(state.unloadTasks || {}).forEach(function (taskId) {
      var task = state.unloadTasks[taskId], ledger = task.ledger || task;
      if (identity(ledger.containerNo) !== normalized.containerNo && identity(task.containerNo) !== normalized.containerNo && identity(taskId) !== normalized.containerNo && !(ledger.publishedAllocations || []).some(function (row) { return identity(row.containerNo) === normalized.containerNo; })) return;
      records.push(ledger);
      (ledger.publishedAllocations || []).forEach(function (row) {
        if (allocations[row.allocationId]) fail('PUBLISHED_ALLOCATION_DUPLICATE', '已发布分配ID重复，不能准确冲销估算。');
        allocations[row.allocationId] = row;
        if ((!row.route || row.route === 'ordinary') && !text(row.specialType) && location(row.location) !== '检查区') allOrdinaryIds.push(row.allocationId);
      });
    });
    normalized.items.forEach(function (item) {
      if (!item.allocationIds.length && allOrdinaryIds.length) {
        var matches = allOrdinaryIds.filter(function (id) {
          var row = allocations[id];
          return identity(row.destination) === item.destination && (!item.shipmentId || !text(row.shipmentId) || text(row.shipmentId) === item.shipmentId);
        });
        var distinctLocations = matches.map(function (id) { return location(allocations[id].location); }).filter(function (v, i, list) { return list.indexOf(v) === i; });
        if (distinctLocations.length > 1) matches = matches.filter(function (id) { return location(allocations[id].location) === item.location; });
        item.allocationIds = matches;
      }
      item.allocationIds.forEach(function (id) {
        var allocation = allocations[id];
        if (!allocation) fail('ALLOCATION_NOT_IN_CONTAINER', '回单分配ID不属于本柜已发布计划：' + id);
        if (allOrdinaryIds.indexOf(id) < 0) fail('PRIVATE_SCOPE_EXCLUDED', '本版不能冲销私仓或office条目的估算。');
        if (claimed[id]) fail('ALLOCATION_CLAIMED_TWICE', '同一已发布分配不能在回单中认领两次。');
        if (identity(allocation.destination) !== item.destination) fail('ALLOCATION_GOODS_MISMATCH', '回单仓点与已发布分配不符。');
        claimed[id] = true;
      });
      if (allOrdinaryIds.length && !item.allocationIds.length) fail('RECEIPT_ITEM_UNMATCHED', '回单条目无法关联本柜的原发布分组。');
    });
    var missing = allOrdinaryIds.filter(function (id) { return !claimed[id]; });
    if (missing.length) fail('INCOMPLETE_RECEIPT', '实拆回单缺少本柜普通仓点分组，未部分入库。', { missingAllocationIds: missing });
    if (!allOrdinaryIds.length) issues.push(issue('NO_PUBLISHED_ESTIMATE', '本柜无可冲销的普通仓点发布估算；仅按已核对回单实数入库。', 'warning'));
    // Fingerprint reflects caller's complete item facts, not inferred allocation IDs.
    var actualDeltas = [];
    normalized.items.forEach(function (item, index) {
      if (!item.physicalP) return;
      var row = addLot(state, item, recordId('WTC-R-', receiptKey, index), { containerNo: normalized.containerNo, sourceContainerNo: normalized.containerNo, receiptId: operation.operationId, receiptKey: receiptKey, sourceRef: text(operation.sourceRef), allocationIds: item.allocationIds.slice(), receivedBusinessDate: normalized.businessDate, allocationBasis: item.allocationBasis || '按回单标记库位', sourceAllocationPublication: item.sourceAllocationPublication || null, sourceLocationOrder: item.sourceLocationOrder || null, sourceGroupPhysicalP: item.sourceGroupPhysicalP == null ? null : item.sourceGroupPhysicalP });
      actualDeltas.push(delta(row, item.physicalP));
    });
    var cleared = Object.keys(claimed).sort();
    records.forEach(function (ledger) {
      ledger.reservations = (ledger.reservations || []).filter(function (row) { return cleared.indexOf(row.allocationId) < 0; });
      ledger.unresolved = (ledger.unresolved || []).filter(function (row) { return cleared.indexOf(row.allocationId) < 0; });
      ledger.postedAllocationIds = (ledger.postedAllocationIds || []).concat(cleared).filter(function (id, index, list) { return list.indexOf(id) === index; }).sort();
      ledger.ordinaryPhysicalPosted = allOrdinaryIds.every(function (id) { return ledger.postedAllocationIds.indexOf(id) >= 0; });
      ledger.physicalInventoryPosted = (ledger.publishedAllocations || []).every(function (row) { return ledger.postedAllocationIds.indexOf(row.allocationId) >= 0; });
      ledger.physicalReceiptIds = (ledger.physicalReceiptIds || []).concat(operation.operationId).filter(function (id, index, list) { return list.indexOf(id) === index; });
    });
    state.receipts = state.receipts || {};
    state.receipts[receiptKey] = { receiptKey: receiptKey, fingerprint: receiptFingerprint, operationId: operation.operationId, containerNo: normalized.containerNo, businessDate: normalized.businessDate, items: copy(normalized.items), postedAllocationIds: cleared, sourceRef: text(operation.sourceRef), physicalP: normalized.items.reduce(function (sum, item) { return sum + item.physicalP; }, 0) };
    markLocations(state, normalized.items.map(function (item) { return item.location; }));
    return { actualDeltas: actualDeltas, clearedAllocationIds: cleared, receiptKey: receiptKey };
  }
  function normalizeMove(state, operation) {
    var source = scopedLocation(operation.sourceLocation || operation.source, state, false), target = scopedLocation(operation.targetLocation || operation.target, state, false);
    if (source === target) fail('SAME_MOVE_LOCATION', '移库原位与目标位相同。');
    var p = quantity(operation.physicalP);
    if (!p) fail('EMPTY_MOVE', '实际移库板数必须大于0。');
    if (privateItem(operation)) fail('PRIVATE_SCOPE_EXCLUDED', '本版暂不处理私仓／office归线。');
    return { type: 'move', businessDate: date(operation.businessDate), sourceLocation: source, targetLocation: target, destination: identity(operation.destination), shipmentId: text(operation.shipmentId), sourceInventoryId: text(operation.sourceInventoryId), physicalP: p };
  }
  function moveEffect(state, operation, normalized) {
    notClosed(state, normalized.businessDate, [normalized.sourceLocation, normalized.targetLocation]);
    var target = (state.capacityCatalog || {})[normalized.targetLocation] || {};
    if (/不可用|禁用|封闭|unavailable|blocked/i.test(text(target.status))) fail('MOVE_TARGET_UNAVAILABLE', '移库目标库位目前标记不可用。');
    var candidates = state.inventory.filter(function (row) {
      return location(row.location) === normalized.sourceLocation && row.physicalP > 0 && (!normalized.destination || identity(row.destination) === normalized.destination) && (!normalized.shipmentId || text(row.shipmentId) === normalized.shipmentId) && (!normalized.sourceInventoryId || row.inventoryId === normalized.sourceInventoryId);
    }).sort(function (a, b) { return a.inventoryId.localeCompare(b.inventoryId); });
    if (!candidates.length) fail('MOVE_STOCK_NOT_FOUND', '找不到原库位对应货物。');
    var destinations = candidates.map(function (row) { return identity(row.destination); }).filter(function (dest, index, list) { return list.indexOf(dest) === index; });
    if (destinations.length !== 1) fail('MOVE_GOODS_AMBIGUOUS', '原库位存在多个仓点，请补仓点或票号。');
    if (candidates.some(privateItem)) fail('PRIVATE_SCOPE_EXCLUDED', '该批库存属于未接入的私仓货物。');
    if (candidates.reduce(function (sum, row) { return sum + row.physicalP; }, 0) < normalized.physicalP) fail('MOVE_INSUFFICIENT_STOCK', '移库板数超过原库位该货物实际库存。');
    var deltas = [], remaining = normalized.physicalP;
    candidates.forEach(function (row, index) {
      if (!remaining) return;
      var moved = Math.min(row.physicalP, remaining), old = copy(row);
      row.physicalP -= moved;
      if (!row.physicalP) { row.occupiedSlots = 0; row.slotBasis = 'explicit'; }
      else { row.occupiedSlots = null; row.slotBasis = 'unknown'; }
      deltas.push(delta(row, -moved));
      var inherited = copy(old);
      ['inventoryId', 'location', 'physicalP', 'occupiedSlots', 'slotBasis', 'capacitySlots', 'conservativeOccupiedSlots', 'conservativeBasis'].forEach(function (name) { delete inherited[name]; });
      inherited.sourceInventoryId = old.inventoryId; inherited.movementId = operation.operationId;
      var added = addLot(state, { location: normalized.targetLocation, destination: old.destination, shipmentId: old.shipmentId, physicalP: moved }, recordId('WTC-M-', operation.operationId, index), inherited);
      deltas.push(delta(added, moved)); remaining -= moved;
    });
    markLocations(state, [normalized.sourceLocation, normalized.targetLocation]);
    return { actualDeltas: deltas, clearedAllocationIds: [] };
  }
  function normalizeCount(state, operation) {
    var businessDate = date(operation.businessDate), scopes = operation.scopeLocations;
    if (!Array.isArray(scopes) || !scopes.length) fail('COUNT_SCOPE_REQUIRED', '盘点需要明确本次覆盖的库位清单。');
    scopes = scopes.map(function (loc) { return scopedLocation(loc, state, false); });
    if (scopes.some(function (loc, i) { return scopes.indexOf(loc) !== i; })) fail('DUPLICATE_COUNT_SCOPE', '盘点范围含重复库位。');
    if (!Array.isArray(operation.counts)) fail('COUNT_ROWS_REQUIRED', '盘点明细必须为数组。');
    var seen = {}, rows = operation.counts.map(function (row) {
      if (privateItem(row)) fail('PRIVATE_SCOPE_EXCLUDED', '本版盘点不覆盖私仓／office。');
      var item = { location: scopedLocation(row.location, state, false), destination: identity(row.destination), shipmentId: text(row.shipmentId), physicalP: quantity(row.physicalP) };
      if (scopes.indexOf(item.location) < 0) fail('COUNT_OUTSIDE_SCOPE', '盘点条目不在已声明范围：' + item.location);
      if (!item.destination && item.physicalP) fail('DESTINATION_REQUIRED', '有货盘点记录需要仓点。');
      var token = key(item, true);
      if (seen[token]) fail('DUPLICATE_COUNT_ITEM', '盘点同位同货重复记录。');
      seen[token] = true; return item;
    });
    scopes.forEach(function (loc) {
      var selected = rows.filter(function (row) { return row.location === loc; });
      if (selected.some(function (row) { return !row.destination; }) && selected.length > 1) fail('COUNT_EMPTY_MARKER_CONFLICT', '同库位不能同时声明空位与有货。');
    });
    rows.forEach(function (row) {
      if (row.shipmentId && rows.some(function (other) { return other !== row && other.location === row.location && other.destination === row.destination && !other.shipmentId; })) fail('COUNT_MIXED_DETAIL', '同库位同仓点不能混用票号明细与汇总数量。');
    });
    return { type: 'count', businessDate: businessDate, scopeLocations: scopes.sort(), counts: rows.sort(function (a, b) { return key(a, true).localeCompare(key(b, true)); }), completeScope: operation.completeScope === true };
  }
  function traceFor(state, row) {
    var traces = [];
    (state.operationJournal || []).forEach(function (entry) {
      if ((entry.actualDeltas || []).some(function (item) { return location(item.location) === row.location && (!row.destination || identity(item.destination) === row.destination) && (!row.shipmentId || text(item.shipmentId) === row.shipmentId); })) traces.push({ operationId: entry.operationId, type: entry.type, businessDate: entry.businessDate, recordedAt: entry.recordedAt, sourceRef: entry.sourceRef || '' });
    });
    Object.keys(state.tasks || {}).forEach(function (taskId) {
      var task = state.tasks[taskId], ledger = task.ledger;
      if (ledger && (ledger.actual || []).some(function (item) { return location(item.location) === row.location && (!row.destination || identity(item.destination) === row.destination) && (!row.shipmentId || text(item.shipmentId) === row.shipmentId); })) traces.push({ operationId: taskId, type: 'loading', status: ledger.status, sourceRow: task.sourceRow || null });
    });
    return traces;
  }
  function reconcile(input, operation) {
    var args = unpack(input, operation), state = args.state, op = args.operation || {}, issues = [], result = { ok: false, issues: issues, rows: [], summary: null };
    try {
      stateCheck(state); var normalized = normalizeCount(state, op), rows = [], consumed = {};
      normalized.counts.forEach(function (count) {
        if (!count.destination) return; // Explicit empty-line marker is expanded by complete-scope logic below.
        var expectedRows = state.inventory.filter(function (row) { return !privateItem(row) && location(row.location) === count.location && identity(row.destination) === count.destination && (!count.shipmentId || text(row.shipmentId) === count.shipmentId); });
        expectedRows.forEach(function (row) { consumed[row.inventoryId] = true; });
        rows.push({ location: count.location, destination: count.destination, shipmentId: count.shipmentId, expectedP: expectedRows.reduce(function (sum, row) { return sum + row.physicalP; }, 0), actualP: count.physicalP, inventoryIds: expectedRows.map(function (row) { return row.inventoryId; }) });
      });
      if (normalized.completeScope) {
        var missing = {};
        state.inventory.forEach(function (row) {
          if (privateItem(row) || normalized.scopeLocations.indexOf(location(row.location)) < 0 || consumed[row.inventoryId] || !row.physicalP) return;
          var useShipment = normalized.counts.some(function (count) { return count.location === location(row.location) && count.destination === identity(row.destination) && !!count.shipmentId; });
          var token = key(row, useShipment);
          if (!missing[token]) missing[token] = { location: location(row.location), destination: identity(row.destination), shipmentId: useShipment ? text(row.shipmentId) : '', expectedP: 0, actualP: 0, inventoryIds: [] };
          missing[token].expectedP += row.physicalP; missing[token].inventoryIds.push(row.inventoryId);
        });
        Object.keys(missing).forEach(function (token) { rows.push(missing[token]); });
      } else issues.push(issue('COUNT_SCOPE_INCOMPLETE', '当前仅预览已填写项目；缺失项目未按0，不能确认作为收工库存。', 'warning'));
      rows = rows.map(function (row) { row.differenceP = row.actualP - row.expectedP; row.trace = traceFor(state, row); return row; }).sort(function (a, b) { return key(a, true).localeCompare(key(b, true)); });
      var summary = rows.reduce(function (sum, row) { sum.expectedP += row.expectedP; sum.actualP += row.actualP; sum.differenceP += row.differenceP; if (row.differenceP) sum.differenceRows++; return sum; }, { expectedP: 0, actualP: 0, differenceP: 0, differenceRows: 0 });
      var allLocations = Object.keys(state.capacityCatalog || {}).filter(function (loc) { return location(loc) !== '检查区' && !privateItem(state.capacityCatalog[loc] || {}); });
      state.inventory.forEach(function (row) { var loc = location(row.location); if (loc !== '检查区' && !privateItem(row) && allLocations.indexOf(loc) < 0) allLocations.push(loc); });
      result.ok = true; result.rows = rows; result.summary = summary; result.scopeLocations = normalized.scopeLocations; result.fullWarehouseScope = allLocations.length > 0 && allLocations.every(function (loc) { return normalized.scopeLocations.indexOf(location(loc)) >= 0; }); result.stateVersion = state.version; result.inputFingerprint = fingerprint(normalized); result.normalized = normalized;
    } catch (error) { issues.push(issue(error.code || 'COUNT_INVALID', error.message, 'error', error.details)); }
    return result;
  }
  function countEffect(state, operation, normalized, report) {
    if (!normalized.completeScope) fail('COUNT_SCOPE_INCOMPLETE', '未明确完成本次库位范围的盘点，不能衔接次日库存。');
    if (report.summary.differenceRows && operation.acceptDifferences !== true) fail('COUNT_DIFFERENCES_REQUIRE_ACCEPTANCE', '盘点存在差异，需先查看差异并明确接受实盘结果，不能静默覆盖。');
    var prior = state.counts || {}, sameDate = Object.keys(prior).map(function (id) { return prior[id]; }).filter(function (item) { return item.businessDate === normalized.businessDate && (item.scopeLocations || []).some(function (loc) { return normalized.scopeLocations.indexOf(loc) >= 0; }); })[0];
    if (sameDate) {
      if (sameDate.fingerprint === fingerprint(normalized)) return { noOp: true, existing: sameDate };
      fail('COUNT_DAY_ALREADY_CLOSED', '该业务日已有确认收工盘点，新的版本需作为明确更正，不能再次覆盖。');
    }
    var closed = normalized.scopeLocations.filter(function (loc) { var boundary = closeDate(state, loc); return boundary && normalized.businessDate <= boundary; });
    if (closed.length) fail('COUNT_DATE_ALREADY_INCLUDED', '盘点业务日不晚于所声明库位已确认收工日，未重置基准。', { closedLocations: closed });
    var laterEntries = (state.operationJournal || []).filter(function (entry) { return text(entry.businessDate) > normalized.businessDate && (entry.actualDeltas || []).some(function (row) { return row.physicalP !== 0; }); });
    var laterFlow = laterEntries.filter(function (entry) { return entry.actualDeltas.some(function (row) { return row.physicalP !== 0 && normalized.scopeLocations.indexOf(location(row.location)) >= 0; }); });
    var unexplainedLaterPhysical = text(state.lastPhysicalBusinessDate) > normalized.businessDate && !laterEntries.some(function (entry) { return text(entry.businessDate) === text(state.lastPhysicalBusinessDate); });
    if (laterFlow.length || unexplainedLaterPhysical) fail('COUNT_LATER_FLOWS_PRESENT', '该收工盘点之后声明库位已有实际进出或移库流水，需先核对迟交盘点与后续流水，未覆盖次日库存。', { laterOperationIds: laterFlow.map(function (row) { return row.operationId; }), lastPhysicalBusinessDate: state.lastPhysicalBusinessDate || '' });
    var deltas = [];
    report.rows.forEach(function (summary, index) {
      var difference = summary.differenceP;
      if (!difference) return;
      var matches = state.inventory.filter(function (row) { return summary.inventoryIds.indexOf(row.inventoryId) >= 0; }).sort(function (a, b) { return a.inventoryId.localeCompare(b.inventoryId); });
      if (difference < 0) {
        var need = -difference;
        matches.forEach(function (row) {
          var reduction = Math.min(row.physicalP, need); if (!reduction) return;
          row.physicalP -= reduction; row.occupiedSlots = row.physicalP ? null : 0; row.slotBasis = row.physicalP ? 'unknown' : 'explicit';
          deltas.push(delta(row, -reduction)); need -= reduction;
        });
        if (need) fail('COUNT_REDUCTION_INCONSISTENT', '盘点减量无法对应原库存。');
      } else {
        var newRow = addLot(state, { location: summary.location, destination: summary.destination, shipmentId: summary.shipmentId, physicalP: difference }, recordId('WTC-C-', operation.countId || operation.operationId, index), { countId: operation.countId || operation.operationId, countBusinessDate: normalized.businessDate, sourceRef: text(operation.sourceRef), quantityBasis: 'confirmed_count_difference', containerNo: null });
        deltas.push(delta(newRow, difference));
      }
    });
    var previousVersion = state.baseline.version, baselineVersion = 'COUNT-' + normalized.businessDate.replace(/-/g, '') + '-' + encodeURIComponent(operation.countId || operation.operationId);
    state.baseline.previousVersion = previousVersion;
    state.initialClosedBusinessDate = initialCloseDate(state);
    state.baseline.version = baselineVersion; state.baseline.asOf = normalized.businessDate.replace(/-/g, '/') + (report.fullWarehouseScope ? ' 收工后' : ' 收工盘点（仅声明库位）'); state.baseline.scopeLocations = normalized.scopeLocations.slice(); state.baseline.fullWarehouseScope = report.fullWarehouseScope; state.baseline.sourceVersion = text(operation.sourceRef) || (operation.countId || operation.operationId);
    state.baseline.appliedTasks = copy(state.baseline.appliedTasks || {});
    Object.keys(state.tasks || {}).forEach(function (id) {
      var task = state.tasks[id];
      if (task.ledger) {
        task.ledger.baselineVersion = baselineVersion;
        state.baseline.appliedTasks[id] = copy(task.ledger);
      } else if (state.baseline.appliedTasks[id]) state.baseline.appliedTasks[id].baselineVersion = baselineVersion;
    });
    Object.keys(state.baseline.appliedTasks).forEach(function (id) { state.baseline.appliedTasks[id].baselineVersion = baselineVersion; });
    state.closedLocationDates = state.closedLocationDates || {};
    normalized.scopeLocations.forEach(function (loc) { state.closedLocationDates[loc] = normalized.businessDate; });
    if (report.fullWarehouseScope) state.lastClosedBusinessDate = normalized.businessDate;
    state.counts = state.counts || {};
    state.counts[operation.countId || operation.operationId] = { countId: operation.countId || operation.operationId, operationId: operation.operationId, businessDate: normalized.businessDate, fingerprint: fingerprint(normalized), scopeLocations: normalized.scopeLocations, previousBaselineVersion: previousVersion, baselineVersion: baselineVersion, report: copy(report), sourceRef: text(operation.sourceRef) };
    markLocations(state, normalized.scopeLocations);
    return { actualDeltas: deltas, clearedAllocationIds: [], report: report };
  }
  function computeOperation(input, operation, now) {
    var args = unpack(input, operation, now), original = args.state, op = copy(args.operation || {}), issues = [], result = { ok: false, blocked: true, noOp: false, issues: issues, nextState: copy(original), candidate: null, report: null };
    try {
      stateCheck(original);
      op.type = text(op.type); op.operationId = text(op.operationId || op.countId);
      if (!op.operationId) fail('OPERATION_ID_REQUIRED', '每笔操作需要稳定的唯一操作编号。');
      if (['receipt', 'move', 'count'].indexOf(op.type) < 0) fail('OPERATION_TYPE_INVALID', '仅支持实拆入库、实际移库和收工盘点。');
      var normalized = op.type === 'receipt' ? normalizeReceipt(original, op) : op.type === 'move' ? normalizeMove(original, op) : normalizeCount(original, op), fp = fingerprint(normalized), existing = (original.operations || {})[op.operationId];
      if (existing) {
        if (existing.fingerprint !== fp || existing.type !== op.type) fail('OPERATION_ID_CONFLICT', '同一操作编号内容已变化，未重复记账。');
        result.ok = true; result.blocked = false; result.noOp = true; result.existing = copy(existing); return result;
      }
      var next = copy(original), before = total(original.inventory), effect;
      if (op.type === 'receipt') effect = receiptEffect(next, op, normalized, issues);
      else if (op.type === 'move') effect = moveEffect(next, op, normalized);
      else {
        var report = reconcile({ state: original, operation: op });
        if (!report.ok) fail('COUNT_INVALID', report.issues.map(function (item) { return item.message; }).join('；'));
        result.report = report;
        effect = countEffect(next, op, normalized, report);
      }
      if (effect.noOp) { result.ok = true; result.blocked = false; result.noOp = true; result.existing = copy(effect.existing); return result; }
      if (op.type === 'move' || op.type === 'count') quarantineOverbookedPlans(next, issues);
      var after = total(next.inventory), deltaTotal = (effect.actualDeltas || []).reduce(function (sum, row) { return sum + row.physicalP; }, 0);
      if (after - before !== deltaTotal || (op.type === 'move' && after !== before)) fail('QUANTITY_CONSERVATION_FAILED', '实际库存与操作增减不一致，未提交。');
      next.version = original.version + 1; next.inventoryVersion = (original.inventoryVersion || 0) + 1;
      var recordedAt = text(args.now) || new Date().toISOString(); next.lastCommittedAt = recordedAt; next.lastCheckedAt = recordedAt;
      if ((effect.actualDeltas || []).some(function (row) { return row.physicalP !== 0; })) { next.lastPhysicalCommittedAt = recordedAt; next.lastPhysicalBusinessDate = normalized.businessDate; }
      var entry = { operationId: op.operationId, type: op.type, fingerprint: fp, businessDate: normalized.businessDate, containerNo: normalized.containerNo || null, recordedAt: recordedAt, sourceRef: text(op.sourceRef), actualDeltas: copy(effect.actualDeltas || []), clearedAllocationIds: copy(effect.clearedAllocationIds || []), sourceStateVersion: original.version, stateVersion: next.version, inventoryBeforeTotal: before, inventoryAfterTotal: after };
      next.operations = next.operations || {}; next.operations[op.operationId] = copy(entry);
      next.operationJournal = next.operationJournal || []; next.operationJournal.push(copy(entry));
      if (effect.receiptKey) next.receipts[effect.receiptKey].recordedAt = recordedAt;
      result.ok = true; result.blocked = false; result.nextState = next;
      result.candidate = { operationId: op.operationId, type: op.type, baselineVersion: original.baseline.version, sourceStateVersion: original.version, inventoryBeforeTotal: before, inventoryAfterTotal: after, actualDeltas: copy(effect.actualDeltas || []), clearedAllocationIds: copy(effect.clearedAllocationIds || []), report: op.type === 'count' ? copy(result.report) : null };
    } catch (error) { issues.push(issue(error.code || 'OPERATION_INVALID', error.message, 'error', error.details)); }
    return result;
  }
  return { VERSION: VERSION, computeOperation: computeOperation, reconcile: reconcile, stableStringify: stable, normalizeLocation: location };
}());
if (typeof module !== 'undefined' && module.exports) module.exports = WTCInventoryCore;
