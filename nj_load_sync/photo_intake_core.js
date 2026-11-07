/* Photo intake owns evidence and workflow only; physical stock is changed by WTCInventoryCore. */
var WTCPhotoCore = (function () {
  'use strict';
  var VERSION = '1.6.0';
  var LABELS = { uploaded: '已接收', recognizing: '识别中', review: '待补资料', ready: '待处理', posting: '待入账', posted: '已入账', preview_requested: '差异生成中', previewed: '差异已生成，待采用', adopt_requested: '采用处理中', adopted: '已采用', error: '处理失败', cancelled: '已撤销（未改库存）' };
  function text(value) { return value == null ? '' : String(value).trim(); }
  function copy(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function stable(value) { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'; return '{' + Object.keys(value).sort().filter(function (key) { return value[key] !== undefined; }).map(function (key) { return JSON.stringify(key) + ':' + stable(value[key]); }).join(',') + '}'; }
  function safeId(value) { var id = text(value); return id && id.length <= 160 && !/[\r\n\t\u001f]/.test(id) && ['__proto__', 'constructor', 'prototype'].indexOf(id) < 0 ? id : ''; }
  function identity(value) { return text(value).replace(/\s+/g, ' ').toUpperCase(); }
  function isoDate(value) { var v = text(value); if (!/^20\d{2}-\d{2}-\d{2}$/.test(v)) return ''; var d = new Date(v + 'T00:00:00Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : ''; }
  function fullContainer(value) { var v = identity(value); return /^[A-Z]{4}\d{7}$/.test(v) ? v : ''; }
  function location(value) { var v = identity(value); return /^[A-Z]{1,2}[1-9][0-9]*$/.test(v) ? v : ''; }
  function nonnegative(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
  function unique(list) { return list.filter(function (v, i) { return list.indexOf(v) === i; }); }
  function issue(code, message, detail) { return Object.assign({ code: code, message: message, severity: 'error' }, detail || {}); }
  function fail(code, message, state, detail) { var r = { ok: false, noOp: false, issues: [issue(code, message, detail)] }; if (state) r.nextState = copy(state); return r; }
  function ok(next, job, noOp, issues) { return { ok: true, noOp: !!noOp, nextState: next, job: copy(job), issues: issues || [] }; }
  function portal(state) { return state && state.photoIntake && state.photoIntake.version === VERSION ? state.photoIntake : null; }
  function getCore() { if (typeof WTCInventoryCore !== 'undefined') return WTCInventoryCore; if (typeof require === 'function') return require('./operations_engine.js'); throw Error('缺少 WTCInventoryCore。'); }
  function stageLabel(job) { if (job && job.resolvedBy) return '已有后续入账记录'; if (job && job.stage === 'ready') return job.kind === 'count' ? '待确认盘点范围' : '待入账'; return LABELS[job && job.stage] || text(job && job.stage); }
  function touch(job, now) { job.revision++; job.updatedAt = text(now); job.stageLabel = stageLabel(job); }
  function terminal(job) { return job && ['posted', 'adopted', 'cancelled'].indexOf(job.stage) >= 0; }
  function resolvedReceipt(state, job) {
    var p = portal(state), target = p && p.jobs[text(job && job.resolvedBy)], receipt = job && (state.receipts || {})[job.containerNo + '|' + job.businessDate];
    return !!(job && job.kind === 'receipt' && fullContainer(job.containerNo) && isoDate(job.businessDate) && target && target !== job && target.kind === 'receipt' && target.stage === 'posted' && target.containerNo === job.containerNo && target.businessDate === job.businessDate && receipt && receipt.operationId === target.operationId && (state.operations || {})[target.operationId] && state.operations[target.operationId].type === 'receipt');
  }
  function changedJob(args) {
    var state = args.state || {}, p = portal(state), input = args.input || args;
    if (!p) return { error: fail('PHOTO_NOT_UPGRADED', '照片入口尚未升级。', state) };
    var id = safeId(input.jobId || args.jobId), job = p.jobs[id];
    if (!job) return { error: fail('PHOTO_JOB_NOT_FOUND', '找不到原照片记录，请刷新后选择。', state) };
    var revision = input.expectedRevision !== undefined ? input.expectedRevision : args.expectedRevision;
    if (!Number.isInteger(revision) || revision !== job.revision) return { error: fail('PHOTO_STALE_REVISION', '照片记录已有新结果，请刷新后继续。', state, { currentRevision: job.revision }) };
    return { state: state, input: input, job: job, id: id };
  }
  function upgrade(args) {
    args = args || {}; var state = args.state || {}, next = copy(state);
    if (portal(state)) return ok(next, null, true);
    if (state.photoIntake) return fail('PHOTO_VERSION_REVIEW', '已有其他版本照片记录，未覆盖。', state);
    next.photoIntake = { version: VERSION, jobs: {}, requestIndex: {}, imageIndex: {}, upgradedAt: text(args.now) };
    return ok(next, null, false);
  }
  function register(args) {
    args = args || {}; var state = args.state || {}, p = portal(state), input = args.input || {}, id = safeId(input.jobId), rid = safeId(input.requestId);
    if (!p) return fail('PHOTO_NOT_UPGRADED', '照片入口尚未升级。', state);
    if (!id || !rid || ['receipt', 'count'].indexOf(input.kind) < 0) return fail('PHOTO_ID_KIND_REQUIRED', '需要稳定的照片编号、提交编号和照片类型。', state);
    if (input.businessDate && !isoDate(input.businessDate)) return fail('PHOTO_DATE_INVALID', '业务日期需为完整年月日，不能使用上传时间代替。', state);
    if (input.containerNo && !fullContainer(input.containerNo)) return fail('PHOTO_CONTAINER_INVALID', '柜号需要四字母七数字完整号码。', state);
    var images = Array.isArray(input.images) ? input.images.map(function (image) { return { fileId: text(image.fileId), sha256: text(image.sha256).toLowerCase(), mimeType: text(image.mimeType), name: text(image.name), url: text(image.url) }; }) : [];
    if (images.length > 8 || images.some(function (image) { return !image.fileId || !/^[a-f0-9]{64}$/.test(image.sha256) || ['image/jpeg', 'image/png', 'image/webp'].indexOf(image.mimeType) < 0; })) return fail('PHOTO_IMAGE_INVALID', '照片文件信息无效或超过8张。', state);
    if (unique(images.map(function (image) { return image.sha256; })).length !== images.length) return fail('PHOTO_IMAGE_REPEATED', '这次选择中有重复图片，请只保留一份。', state);
    var refs = unique((Array.isArray(input.sourceRefs) ? input.sourceRefs : []).map(text).concat(images.map(function (image) { return image.url; })).filter(Boolean));
    if (!images.length && (input.source !== 'chatgpt' || !refs.length)) return fail('PHOTO_SOURCE_REQUIRED', '请上传照片，或提供聊天已识别资料的原图依据。', state);
    if (refs.some(function (ref) { return ref.length > 2000; }) || refs.length > 24 || text(input.clarification).length > 4000) return fail('PHOTO_INPUT_LENGTH', '照片说明或来源过长。', state);
    var semantic = { kind: input.kind, source: input.source === 'chatgpt' ? 'chatgpt' : 'upload', businessDate: isoDate(input.businessDate), containerNo: fullContainer(input.containerNo), hashes: images.map(function (image) { return image.sha256; }).sort(), sourceRefs: refs.slice().sort(), clarification: text(input.clarification) }, signature = stable(semantic), prior = (p.requestIndex || {})[rid];
    if (prior) { if (prior.signature !== signature) return fail('PHOTO_REQUEST_REUSED', '相同照片提交编号已有不同内容，未覆盖。', state); return ok(copy(state), p.jobs[prior.jobId], true); }
    if (p.jobs[id]) return fail('PHOTO_JOB_EXISTS', '照片编号已存在，请打开原记录。', state);
    var previousIds = unique(images.map(function (image) { return (p.imageIndex || {})[image.sha256]; }).filter(Boolean));
    if (previousIds.length) {
      var old = previousIds.length === 1 && p.jobs[previousIds[0]], allSame = old && images.every(function (image) { return (p.imageIndex || {})[image.sha256] === old.jobId; });
      if (!old || !allSame || old.kind !== input.kind || (semantic.businessDate && old.businessDate && semantic.businessDate !== old.businessDate) || (semantic.containerNo && old.containerNo && semantic.containerNo !== old.containerNo)) return fail('PHOTO_DUPLICATE_REVIEW', '图片已在原记录中，不能改日期或类型再入账；请补充原记录。', state, { jobIds: previousIds });
      var reused = copy(state); reused.photoIntake.requestIndex[rid] = { signature: signature, jobId: old.jobId }; return ok(reused, old, false, [issue('PHOTO_REUSED', '相同照片已接收，沿用原记录，不重复入库。', { severity: 'info' })]);
    }
    var next = copy(state), job = { jobId: id, operationId: id, requestId: rid, kind: semantic.kind, source: semantic.source, businessDate: semantic.businessDate, containerNo: semantic.containerNo, providedBusinessDate: semantic.businessDate, providedContainerNo: semantic.containerNo, images: images, sourceRefs: refs, clarification: semantic.clarification, stage: 'uploaded', stageLabel: '已接收', revision: 1, extraction: null, issues: [], result: '照片已接收，等待AI识别；尚未改变库存。', receivedAt: text(args.now), updatedAt: text(args.now), completeScopeConfirmed: false, preview: null, adoptionRequested: false };
    next.photoIntake.jobs[id] = job; next.photoIntake.requestIndex[rid] = { signature: signature, jobId: id }; images.forEach(function (image) { next.photoIntake.imageIndex[image.sha256] = id; }); return ok(next, job, false);
  }
  function normalizedExtraction(job, raw, state) {
    var issues = [], out = { kind: job.kind, businessDate: '', containerNo: '', allRowsRead: false, items: [], scopeLocations: [], explicitEmptyLocations: [], scopeComplete: false, totalP: null, summary: '' };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { extraction: out, issues: [issue('PHOTO_EXTRACTION_INVALID', '识别结果无效，未按空单处理。')] };
    if (raw.kind !== job.kind) issues.push(issue('PHOTO_KIND_CONFLICT', '图片内容与选择的回单/夜盘类型不一致。'));
    var suppliedDate = job.providedBusinessDate || '', readDate = isoDate(raw.businessDate);
    if (text(raw.businessDate) && !readDate) issues.push(issue('PHOTO_DATE_UNCERTAIN', '照片业务日期无法确定，请补充完整年月日。'));
    if (suppliedDate && readDate && suppliedDate !== readDate) issues.push(issue('PHOTO_DATE_CONFLICT', '填写日期与照片日期不一致，请核对。'));
    out.businessDate = suppliedDate || readDate; if (!out.businessDate) issues.push(issue('PHOTO_DATE_REQUIRED', '未识别到收工/作业日期，请补充一次完整日期。'));
    var suppliedContainer = job.providedContainerNo || '', readContainer = fullContainer(raw.containerNo);
    if (job.kind === 'receipt') {
      if (text(raw.containerNo) && !readContainer) issues.push(issue('PHOTO_CONTAINER_UNCERTAIN', '照片柜号不完整或不清楚，请补充完整柜号。'));
      if (suppliedContainer && readContainer && suppliedContainer !== readContainer) issues.push(issue('PHOTO_CONTAINER_CONFLICT', '填写柜号与照片柜号不一致，请核对。'));
      out.containerNo = suppliedContainer || readContainer; if (!out.containerNo) issues.push(issue('PHOTO_CONTAINER_REQUIRED', '未确认完整海柜号，未凭尾号入库。'));
    }
    out.allRowsRead = raw.allRowsRead === true; if (!out.allRowsRead) issues.push(issue('PHOTO_INCOMPLETE', '图片未完整识别，请补清晰照片或缺失部分。'));
    var emptyCount = job.kind === 'count' && Array.isArray(raw.explicitEmptyLocations) && raw.explicitEmptyLocations.length > 0;
    if (!Array.isArray(raw.items) || (!raw.items.length && !emptyCount) || raw.items.length > 700) issues.push(issue('PHOTO_ITEMS_REQUIRED', '没有完整可读的实际明细。'));
    var seen = {}, known = Object.assign({}, state.capacityCatalog || {}); (state.inventory || []).forEach(function (row) { known[identity(row.location)] = true; });
    (Array.isArray(raw.items) ? raw.items.slice(0, 701) : []).forEach(function (item, index) {
      item = item || {}; var loc = location(item.location), order = Array.isArray(item.locationOrder) ? item.locationOrder.map(location) : [], dest = identity(item.destination), p = item.physicalP, shipment = text(item.shipmentId), basis = text(item.quantityBasis), token;
      if (!order.length && /[/、,，]/.test(text(item.location))) { order = text(item.location).split(/[/、,，]/).map(location); loc = ''; }
      if (order.length && order.length < 2) issues.push(issue('PHOTO_LOCATION_ORDER_INVALID', '顺序分位需至少两个明确库位。', { row: index + 1 }));
      if (order.length && loc) issues.push(issue('PHOTO_LOCATION_CONFLICT', '同条明细不能同时填写单库位和顺序库位。', { row: index + 1 }));
      if ((!loc && !order.length) || order.some(function (value) { return !value; }) || unique(order).length !== order.length) issues.push(issue('PHOTO_LOCATION_REQUIRED', '存在无法确认的实际库位。', { row: index + 1 }));
      var locs = order.length ? order : [loc];
      if (locs.some(function (value) { return value && !Object.prototype.hasOwnProperty.call(known, value); })) issues.push(issue('PHOTO_LOCATION_UNKNOWN', '识别库位不在当前库位目录，请核对。', { row: index + 1 }));
      if (job.kind === 'count' && order.length) issues.push(issue('PHOTO_COUNT_SPLIT_REQUIRED', '夜盘需要各库位实际板数，不能用F1/F2合计直接清账。', { row: index + 1 }));
      if (!nonnegative(p)) issues.push(issue('PHOTO_QUANTITY_UNKNOWN', '存在未看清的实际板数，未猜成0或标准容量。', { row: index + 1 }));
      if (basis !== 'actual') issues.push(issue('PHOTO_ACTUAL_REQUIRED', '理论板数、满线符号或未知数量不能代替实际板数。', { row: index + 1 }));
      if ((!dest && !(job.kind === 'count' && p === 0)) || (dest && !/^[A-Z][A-Z0-9()_\/-]*$/.test(dest))) issues.push(issue('PHOTO_DESTINATION_REQUIRED', '存在无法确认的仓点。', { row: index + 1 }));
      if (/office|inspection|检查区|私仓|私人|自提|UPS|FEDEX/i.test([dest, text(item.location)].join(' '))) issues.push(issue('PHOTO_PRIVATE_EXCLUDED', '本版不处理私仓或office归线，请提供普通仓点部分。', { row: index + 1 }));
      if (shipment.length > 400 || text(item.note).length > 1200) issues.push(issue('PHOTO_ITEM_LENGTH', '单条识别说明过长。', { row: index + 1 }));
      token = [loc || order.join('/'), dest, shipment].join('|'); if (seen[token]) issues.push(issue('PHOTO_OVERLAPPING_ROWS', '图片有重复或重叠的同一货物明细，未相加；请核对。', { row: index + 1 })); seen[token] = true;
      out.items.push({ destination: dest, location: loc, locationOrder: order, shipmentId: shipment, physicalP: nonnegative(p) ? p : null, quantityBasis: basis, note: text(item.note) });
    });
    out.summary = text(raw.summary).slice(0, 2000); out.scopeComplete = raw.scopeComplete === true;
    if (Array.isArray(raw.issues)) raw.issues.forEach(function (message) { if (text(message)) issues.push(issue('PHOTO_REPORTED_UNCERTAINTY', text(message).slice(0, 1200))); });
    if (raw.totalP !== null && raw.totalP !== undefined && !nonnegative(raw.totalP)) issues.push(issue('PHOTO_TOTAL_INVALID', '识别合计不是明确实际板数。'));
    out.totalP = nonnegative(raw.totalP) ? raw.totalP : null;
    var total = out.items.reduce(function (sum, item) { return sum + (item.physicalP || 0); }, 0);
    if (out.totalP !== null && out.totalP !== total) issues.push(issue('PHOTO_TOTAL_CONFLICT', '明细实际板数与照片合计不一致，未自动记账。'));
    if (job.kind === 'count') {
      var scopeRaw = Array.isArray(raw.scopeLocations) ? raw.scopeLocations : [], emptyRaw = Array.isArray(raw.explicitEmptyLocations) ? raw.explicitEmptyLocations : [];
      if (scopeRaw.some(function (value) { return !location(value); }) || emptyRaw.some(function (value) { return !location(value); })) issues.push(issue('PHOTO_SCOPE_INVALID', '盘点范围或空位标识无法确认。'));
      out.scopeLocations = unique(scopeRaw.map(location).filter(Boolean)).sort(); out.explicitEmptyLocations = unique(emptyRaw.map(location).filter(Boolean)).sort();
      if (!out.scopeLocations.length) issues.push(issue('PHOTO_SCOPE_REQUIRED', '必须从照片明确这次覆盖哪些库位，未默认全仓。'));
      out.explicitEmptyLocations.forEach(function (value) {
        if (out.scopeLocations.indexOf(value) < 0) issues.push(issue('PHOTO_EMPTY_OUTSIDE_SCOPE', '空位不在本次盘点范围。', { location: value }));
        var rows = out.items.filter(function (item) { return item.location === value; });
        if (rows.some(function (item) { return item.physicalP !== 0 || item.destination; })) issues.push(issue('PHOTO_EMPTY_CONFLICT', '同一库位同时识别为空位和有货，请核对。', { location: value }));
        if (!rows.length) out.items.push({ destination: '', location: value, locationOrder: [], shipmentId: '', physicalP: 0, quantityBasis: 'actual', note: '照片明确空位' });
      });
      out.items.forEach(function (item) { if (out.scopeLocations.indexOf(item.location) < 0) issues.push(issue('PHOTO_COUNT_OUTSIDE_SCOPE', '盘点明细不在照片声明范围。', { location: item.location })); });
      out.scopeLocations.forEach(function (value) {
        if (!Object.prototype.hasOwnProperty.call(known, value)) issues.push(issue('PHOTO_LOCATION_UNKNOWN', '盘点范围有未知库位。', { location: value }));
        if (!out.items.some(function (item) { return item.location === value; })) issues.push(issue('PHOTO_SCOPE_UNCOVERED', '范围内库位没有明确实盘明细或空位标记，未当作0。', { location: value }));
        var selected = out.items.filter(function (item) { return item.location === value; });
        if (selected.length > 1 && selected.some(function (item) { return !item.destination; })) issues.push(issue('PHOTO_EMPTY_CONFLICT', '空位和有货记录不能混用。', { location: value }));
      });
    }
    return { extraction: out, issues: issues };
  }
  function semanticItems(items) {
    return (items || []).map(function (item) { return { destination: identity(item.destination), location: location(item.location), locationOrder: Array.isArray(item.locationOrder) ? item.locationOrder.map(location) : [], shipmentId: text(item.shipmentId), physicalP: item.physicalP }; }).sort(function (a, b) { return stable(a).localeCompare(stable(b)); });
  }
  function existingRows(state, external) {
    var rows = [];
    Object.keys(state.receipts || {}).forEach(function (key) { var row = state.receipts[key]; rows.push({ operationId: row.operationId, containerNo: row.containerNo || key.split('|')[0], businessDate: row.businessDate || key.split('|')[1], items: row.items || [], posted: true, record: row }); });
    (external || []).forEach(function (input) { var row = input.operation || input; rows.push({ operationId: input.operationId || row.operationId || input.id, containerNo: row.containerNo, businessDate: row.businessDate, items: row.items || [], posted: input.posted === true, record: input }); });
    return rows;
  }
  function publishedItems(state, containerNo) {
    var result = [], ids = {};
    Object.keys(state.unloadTasks || {}).forEach(function (id) { var task = state.unloadTasks[id], ledger = task.ledger || task; if (identity(ledger.containerNo) !== containerNo && identity(task.containerNo) !== containerNo && identity(id) !== containerNo && !(ledger.publishedAllocations || []).some(function (row) { return identity(row.containerNo) === containerNo; })) return;
      (ledger.publishedAllocations || []).forEach(function (row) { if ((!row.route || row.route === 'ordinary') && !text(row.specialType) && location(row.location)) { if (!ids[row.allocationId]) result.push(row); ids[row.allocationId] = true; } }); });
    return result;
  }
  function receiptOperation(state, job, external) {
    var extraction = job.extraction, items = extraction.items.map(function (item) { var result = { destination: item.destination, shipmentId: item.shipmentId, physicalP: item.physicalP, allocationIds: [] }; if (item.locationOrder.length) result.locationOrder = item.locationOrder.slice(); else result.location = item.location; return result; }), published = publishedItems(state, job.containerNo), issues = [];
    items.forEach(function (item) {
      var matches = published.filter(function (row) { return identity(row.destination) === item.destination && (!item.shipmentId || !text(row.shipmentId) || text(row.shipmentId) === item.shipmentId); });
      if (item.locationOrder) matches = matches.filter(function (row) { return item.locationOrder.indexOf(location(row.location)) >= 0; });
      else if (unique(matches.map(function (row) { return location(row.location); })).length > 1) matches = matches.filter(function (row) { return location(row.location) === item.location; });
      item.allocationIds = matches.map(function (row) { return text(row.allocationId); }).sort();
    });
    var operation = { type: 'receipt', operationId: job.operationId || job.jobId, businessDate: job.businessDate, containerNo: job.containerNo, sourceRef: job.sourceRefs.join('\n'), items: items }, existing = existingRows(state, external).filter(function (row) { return fullContainer(row.containerNo) === job.containerNo; });
    var otherDates = existing.filter(function (row) { return isoDate(row.businessDate) && row.businessDate !== job.businessDate; });
    if (otherDates.length) return { ok: false, issues: [issue('PHOTO_RECEIPT_CROSS_DATE', '该柜已有其他业务日的回单记录，不能换日期再次入库；请核实原记录。', { operationIds: unique(otherDates.map(function (row) { return row.operationId; })) })] };
    var sameDate = existing.filter(function (row) { return row.businessDate === job.businessDate; }), matched = sameDate.filter(function (row) { return stable(semanticItems(row.items)) === stable(semanticItems(items)); });
    if (matched.length) {
      var chosen = matched.filter(function (row) { return row.posted; })[0] || matched[0]; operation.operationId = chosen.operationId || operation.operationId;
      if (chosen.posted) {
        var durable = (state.receipts || {})[job.containerNo + '|' + job.businessDate], durableOperation = durable && (state.operations || {})[durable.operationId];
        if (!durable || !durableOperation || durableOperation.type !== 'receipt') return { ok: false, issues: [issue('PHOTO_RECEIPT_PROOF_MISSING', '找到同柜资料，但缺少权威回单及实物操作双重凭据，未显示已入账。')] };
        var proof = getCore().computeOperation({ state: state, operation: operation });
        if (proof.ok && proof.noOp) return { ok: true, operation: operation, issues: [], existingOperationId: chosen.operationId, alreadyPosted: true };
        // Existing adapters may have stored inferred allocation IDs rather than caller IDs.
        // A semantic match against the durable receipt plus its operation is sufficient proof.
        if (chosen.record && state.receipts && Object.keys(state.receipts).some(function (key) { return state.receipts[key] === chosen.record; }) && (state.operations || {})[chosen.operationId] && state.operations[chosen.operationId].type === 'receipt') return { ok: true, operation: operation, issues: [], existingOperationId: chosen.operationId, alreadyPosted: true };
        return { ok: false, issues: [issue('PHOTO_RECEIPT_PROOF_MISSING', '找到同柜实际记录，但缺少一致的实物操作凭据，未显示为本次已入账。')] };
      }
      var queuedCheck = getCore().computeOperation({ state: state, operation: operation });
      if (!queuedCheck.ok || queuedCheck.blocked) return { ok: false, operation: operation, issues: queuedCheck.issues || [issue('PHOTO_RECEIPT_RULE_REVIEW', '原回单与照片仍需核查，尚未入账。')] };
      return { ok: true, operation: operation, issues: [], existingOperationId: chosen.operationId, alreadyPosted: false };
    }
    if (sameDate.length) {
      var posted = sameDate.filter(function (row) { return row.posted; });
      if (posted.length) {
        var storedReceipt = (state.receipts || {})[job.containerNo + '|' + job.businessDate], storedOperation = storedReceipt && (state.operations || {})[storedReceipt.operationId];
        var postedProof = getCore().computeOperation({ state: state, operation: operation });
        if (storedReceipt && storedOperation && storedOperation.type === 'receipt' && postedProof.ok && postedProof.noOp) return { ok: true, operation: operation, issues: [], existingOperationId: storedReceipt.operationId, alreadyPosted: true };
      }
      return { ok: false, issues: [issue('PHOTO_EXISTING_RECEIPT_CONFLICT', '该柜已有回单资料，与新照片数量或库位不一致；请核对原记录，不新建叠加入库。', { operationIds: unique(sameDate.map(function (row) { return row.operationId; })) })] };
    }
    var claimed = {}; Object.keys(state.receipts || {}).forEach(function (key) { (state.receipts[key].postedAllocationIds || []).forEach(function (id) { claimed[id] = true; }); });
    if (items.some(function (item) { return item.allocationIds.some(function (id) { return claimed[id]; }); })) return { ok: false, issues: [issue('PHOTO_ALLOCATION_ALREADY_POSTED', '对应纸单分配已入账，不能因换日期或新照片再次增加库存。')] };
    var checked = getCore().computeOperation({ state: state, operation: operation });
    if (!checked.ok || checked.blocked) return { ok: false, operation: operation, issues: checked.issues || [issue('PHOTO_RECEIPT_RULE_REVIEW', '实拆资料未通过固定规则。')] };
    return { ok: true, operation: operation, issues: issues, alreadyPosted: !!checked.noOp };
  }
  function buildOperation(args) {
    args = args || {}; var state = args.state || {}, p = portal(state), job = p && p.jobs[safeId(args.jobId || (args.input || {}).jobId)];
    if (!job) return fail('PHOTO_JOB_NOT_FOUND', '找不到照片记录。');
    if (job.stage === 'cancelled') return fail('PHOTO_CANCELLED', '该误传资料已撤销，不能再生成库存操作。');
    if (!job.extraction || (job.issues || []).some(function (entry) { return entry.severity !== 'info' && entry.severity !== 'warning'; })) return { ok: false, issues: copy(job.issues || [issue('PHOTO_NOT_READY', '照片明细尚未核对完成。')]) };
    if (job.kind === 'receipt') return receiptOperation(state, job, args.existingReceipts || []);
    var e = job.extraction, operation = { type: 'count', operationId: job.operationId || job.jobId, countId: job.operationId || job.jobId, businessDate: job.businessDate, scopeLocations: e.scopeLocations.slice(), completeScope: job.completeScopeConfirmed === true, counts: e.items.map(function (item) { return { location: item.location, destination: item.destination, shipmentId: item.shipmentId, physicalP: item.physicalP }; }), sourceRef: job.sourceRefs.join('\n') };
    var result = getCore().reconcile({ state: state, operation: operation });
    return { ok: !!result.ok, operation: operation, issues: result.issues || [], report: result };
  }
  function applyExtraction(args) {
    args = args || {}; var found = changedJob(args); if (found.error) return found.error;
    if (terminal(found.job) || ['posting', 'preview_requested', 'previewed', 'adopt_requested'].indexOf(found.job.stage) >= 0) return fail('PHOTO_EXTRACTION_LOCKED', '资料已进入记账或盘点确认，不能用新识别覆盖。', found.state);
    var next = copy(found.state), job = next.photoIntake.jobs[found.id], parsed = normalizedExtraction(job, args.extraction, found.state);
    job.extraction = parsed.extraction; job.businessDate = parsed.extraction.businessDate; job.containerNo = parsed.extraction.containerNo; job.issues = parsed.issues; job.completeScopeConfirmed = false; job.preview = null; job.adoptionRequested = false; job.stage = parsed.issues.length ? 'review' : 'ready'; job.leaseUntil = ''; job.retryAfter = 0;
    if (!parsed.issues.length) {
      var built = buildOperation({ state: next, jobId: found.id, existingReceipts: args.existingReceipts || [] });
      if (!built.ok) { job.issues = built.issues; job.stage = 'review'; }
      else if (job.kind === 'receipt' && built.existingOperationId) { job.operationId = built.existingOperationId; job.stage = built.alreadyPosted ? 'posted' : 'posting'; job.existingReceipt = true; }
    }
    job.result = job.stage === 'review' ? job.issues.map(function (entry) { return entry.message; }).join('；') : job.stage === 'posted' ? '已核对原实物入账记录；相同回单未重复增加库存。' : job.stage === 'posting' ? '已关联原回单资料，等待原记录入账；不重复登记。' : job.kind === 'receipt' ? '实际明细已识别，待后台核查并正式入账。' : '盘点明细已识别，请核对覆盖库位并确认范围完整后生成差异。';
    touch(job, args.now); return ok(next, job, false, job.issues);
  }
  function clarify(args) {
    args = args || {}; var found = changedJob(args); if (found.error) return found.error; var input = found.input;
    var oldJob = found.job, operationId = oldJob.operationId || oldJob.jobId;
    var hasReceiptProof = Object.keys(found.state.receipts || {}).some(function (key) { var receipt = found.state.receipts[key]; return receipt.operationId === operationId || fullContainer(receipt.containerNo || key.split('|')[0]) === oldJob.containerNo && (receipt.businessDate || key.split('|')[1]) === oldJob.businessDate; });
    var knownDraft = !!(found.state.operationPending || {})[operationId] || (args.existingReceipts || []).some(function (inputRow) { var row = inputRow.operation || inputRow; return (inputRow.operationId || row.operationId || inputRow.id) === operationId && fullContainer(row.containerNo) === oldJob.containerNo && row.businessDate === oldJob.businessDate && inputRow.posted !== true; });
    // Only the trusted server adapter can authorize replacing a proven UNPOSTED
    // physical draft. A similarly named field inside client input is ignored.
    var retryPosting = args.authorizedUnpostedReceiptRetry === true && oldJob.kind === 'receipt' && oldJob.stage === 'posting' && knownDraft && !(found.state.operations || {})[operationId] && !hasReceiptProof;
    if (terminal(oldJob) || resolvedReceipt(found.state, oldJob) || oldJob.stage === 'adopt_requested' || oldJob.stage === 'posting' && !retryPosting) return fail('PHOTO_ALREADY_SUBMITTED', '该资料已入账、已有后续入账记录或正在入账，不能直接改写；请核对处理结果。', found.state);
    if (input.businessDate && !isoDate(input.businessDate)) return fail('PHOTO_DATE_INVALID', '请提供完整业务日期。', found.state);
    if (input.containerNo && !fullContainer(input.containerNo)) return fail('PHOTO_CONTAINER_INVALID', '请提供完整海柜号。', found.state);
    if (text(input.clarification).length > 4000) return fail('PHOTO_INPUT_LENGTH', '补充说明过长。', found.state);
    var next = copy(found.state), job = next.photoIntake.jobs[found.id];
    if (input.businessDate !== undefined && input.businessDate !== '') job.providedBusinessDate = isoDate(input.businessDate);
    if (input.containerNo !== undefined && input.containerNo !== '') job.providedContainerNo = fullContainer(input.containerNo);
    if (text(input.clarification)) job.clarification = [job.clarification, text(input.clarification)].filter(Boolean).join('\n').slice(-8000);
    job.businessDate = job.providedBusinessDate || ''; job.containerNo = job.providedContainerNo || ''; job.stage = 'uploaded'; job.extraction = null; job.issues = []; job.completeScopeConfirmed = false; job.preview = null; job.adoptionRequested = false; job.leaseUntil = ''; job.retryAfter = 0; job.result = '补充说明已接收，按原照片重新识别；未另建收货。'; touch(job, args.now); return ok(next, job, false);
  }
  function requestPreview(args) {
    args = args || {}; var found = changedJob(args); if (found.error) return found.error;
    if (found.job.kind !== 'count' || ['ready', 'previewed', 'review'].indexOf(found.job.stage) < 0) return fail('PHOTO_COUNT_NOT_READY', '请先完成夜盘识别，再生成差异。', found.state);
    if (found.input.completeScopeConfirmed !== true) return fail('PHOTO_SCOPE_CONFIRM_REQUIRED', '请明确确认列出的库位已经全部盘完，未默认全仓完整。', found.state);
    var built = buildOperation({ state: found.state, jobId: found.id, existingReceipts: args.existingReceipts || [] }); if (!built.ok) return fail('PHOTO_COUNT_REVIEW', (built.issues || []).map(function (entry) { return entry.message; }).join('；') || '夜盘仍有未确认资料。', found.state);
    var next = copy(found.state), job = next.photoIntake.jobs[found.id]; job.completeScopeConfirmed = true; job.stage = 'preview_requested'; job.preview = null; job.adoptionRequested = false; job.result = '范围完整确认已接收，等待生成差异；尚未采用实盘。'; touch(job, args.now); return ok(next, job, false);
  }
  function cancel(args) {
    args = args || {}; var found = changedJob(args); if (found.error) return found.error; var job = found.job, id = job.operationId || job.jobId;
    var hasReceipt = Object.keys(found.state.receipts || {}).some(function (key) { var receipt = found.state.receipts[key]; return receipt.operationId === id || !!job.containerNo && fullContainer(receipt.containerNo || key.split('|')[0]) === job.containerNo && (receipt.businessDate || key.split('|')[1]) === job.businessDate; });
    var hasCount = !!(found.state.counts || {})[id] || Object.keys(found.state.counts || {}).some(function (key) { return (found.state.counts[key] || {}).operationId === id; });
    if (['uploaded', 'review', 'error', 'ready'].indexOf(job.stage) < 0 || job.materialized || (found.state.operations || {})[id] || hasReceipt || hasCount || resolvedReceipt(found.state, job)) return fail('PHOTO_CANCEL_NOT_ALLOWED', '该照片已进入实物处理、差异确认或已有正式凭据，不能作为误传撤销；请核对处理结果。', found.state);
    var next = copy(found.state), changed = next.photoIntake.jobs[found.id]; changed.stage = 'cancelled'; changed.cancelledAt = text(args.now); changed.cancelReason = text(found.input.reason).slice(0, 1200); changed.result = '误传资料已撤销，原图和识别记录保留；未改变库存，不再作为待入账或盘点阻塞。'; changed.leaseUntil = ''; changed.leaseToken = ''; changed.retryAfter = 0; touch(changed, args.now); return ok(next, changed, false, changed.issues || []);
  }
  function requestAdoption(args) {
    args = args || {}; var found = changedJob(args); if (found.error) return found.error; var job = found.job, token = text(found.input.previewToken), preview = job.preview || {};
    if (job.kind !== 'count' || job.stage !== 'previewed' || !job.completeScopeConfirmed || !token || token !== text(preview.token)) return fail('PHOTO_PREVIEW_REQUIRED', '请先核对这次夜盘差异，再明确采用。', found.state);
    if (Number.isInteger(preview.inventoryVersion) && preview.inventoryVersion !== (found.state.inventoryVersion || 0)) return fail('PHOTO_PREVIEW_STALE', '预览后库存已经变化，请重新生成差异再采用。', found.state);
    var next = copy(found.state), changed = next.photoIntake.jobs[found.id]; changed.stage = 'adopt_requested'; changed.adoptionRequested = true; changed.result = '采用请求已接收，等待复核待办与差异版本；尚未更新库存。'; touch(changed, args.now); return ok(next, changed, false);
  }
  function reconcileJobs(args) {
    args = args || {}; var state = args.state || {}, p = portal(state); if (!p) return fail('PHOTO_NOT_UPGRADED', '照片入口尚未升级。', state);
    var next = copy(state), changed = false;
    Object.keys(next.photoIntake.jobs).forEach(function (id) {
      var job = next.photoIntake.jobs[id], before = stable(job), proof = (state.operations || {})[job.operationId];
      if (job.kind === 'receipt') {
        var receipt = (state.receipts || {})[job.containerNo + '|' + job.businessDate];
        if (receipt && receipt.operationId === job.operationId && proof && proof.type === 'receipt') { job.stage = 'posted'; job.actualP = receipt.physicalP; job.result = '实拆已正式入账，对应估算按实物流水冲销；重复照片不再加库存。'; job.postedAt = proof.recordedAt || receipt.recordedAt || ''; job.issues = []; }
        else if (!terminal(job) && job.extraction && !job.issues.length) {
          var built = buildOperation({ state: next, jobId: id, existingReceipts: args.existingReceipts || [] });
          if (built.ok && built.existingOperationId) { job.operationId = built.existingOperationId; job.existingReceipt = true; job.stage = built.alreadyPosted ? 'posted' : 'posting'; job.result = built.alreadyPosted ? '已核对原回单入账，不重复加库存。' : '已关联原回单，等待正式入账。'; if (built.alreadyPosted && receipt) job.actualP = receipt.physicalP; }
          else if (!built.ok) { job.stage = 'review'; job.issues = built.issues; job.result = built.issues.map(function (entry) { return entry.message; }).join('；'); }
        }
      } else {
        var count = (state.counts || {})[job.operationId];
        if (count && proof && proof.type === 'count') { job.stage = 'adopted'; job.result = '实盘已正式采用，声明范围衔接次日库存；范围外库存保留。'; job.adoptedAt = proof.recordedAt || ''; job.issues = []; }
      }
      if (stable(job) !== before) { touch(job, args.now); changed = true; }
    });
    // An earlier incomplete/rejected photo must not remain an eternal night-count
    // blocker once another photo of that SAME known cabinet/day has durable stock
    // proof. Keep the rejected evidence and issues; it is not a second receipt.
    var allJobs = next.photoIntake.jobs;
    Object.keys(allJobs).forEach(function (id) {
      var job = allJobs[id]; if (job.kind !== 'receipt' || ['review', 'error'].indexOf(job.stage) < 0 || !fullContainer(job.containerNo) || !isoDate(job.businessDate)) return;
      var target = Object.keys(allJobs).map(function (otherId) { return allJobs[otherId]; }).filter(function (other) { return other.jobId !== job.jobId && other.kind === 'receipt' && other.stage === 'posted' && other.containerNo === job.containerNo && other.businessDate === job.businessDate; })[0];
      if (!target) return;
      var receipt = (next.receipts || {})[job.containerNo + '|' + job.businessDate], operation = receipt && (next.operations || {})[receipt.operationId];
      if (!receipt || receipt.operationId !== target.operationId || !operation || operation.type !== 'receipt') return;
      if (job.resolvedBy !== target.jobId || job.resolvedOperationId !== receipt.operationId) {
        job.resolvedBy = target.jobId; job.resolvedOperationId = receipt.operationId; job.resolvedAt = operation.recordedAt || text(args.now); job.resolutionNote = '原照片和疑点保留；同柜同业务日已由后续照片正式入账，本记录不再单独增加库存。'; touch(job, args.now); changed = true;
      }
    });
    return ok(next, null, !changed);
  }
  function unsettledReceiptJobs(args) {
    args = args || {}; var p = portal(args.state || {}), scope = (args.scopeLocations || []).map(identity), day = isoDate(args.businessDate);
    return p ? Object.keys(p.jobs).map(function (id) { return p.jobs[id]; }).filter(function (job) {
      if (job.kind !== 'receipt' || terminal(job) || resolvedReceipt(args.state || {}, job) || job.jobId === args.excludeJobId) return false;
      if (day && job.businessDate && job.businessDate > day) return false;
      var places = job.extraction && job.extraction.items ? [].concat.apply([], job.extraction.items.map(function (item) { return item.locationOrder && item.locationOrder.length ? item.locationOrder : [item.location]; })).filter(Boolean) : [];
      return !places.length || !scope.length || places.some(function (loc) { return scope.indexOf(identity(loc)) >= 0; });
    }).map(function (job) { return { jobId: job.jobId, businessDate: job.businessDate, containerNo: job.containerNo, stage: job.stage }; }) : [];
  }
  return { VERSION: VERSION, stageLabels: LABELS, stageLabel: stageLabel, stableStringify: stable, upgrade: upgrade, register: register, applyExtraction: applyExtraction, clarify: clarify, cancel: cancel, requestPreview: requestPreview, requestAdoption: requestAdoption, buildOperation: buildOperation, reconcileJobs: reconcileJobs, unsettledReceiptJobs: unsettledReceiptJobs, normalizeExtraction: normalizedExtraction };
}());
if (typeof module !== 'undefined' && module.exports) module.exports = WTCPhotoCore;
