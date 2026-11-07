/* Forecast intake is planning data only; it never manufactures physical inventory. */
var WTCForecastCore = (function () {
  'use strict';
  var VERSION = '1.4.0', PRIORITY = { daily: 3, weekly: 2, monthly: 1 };
  function text(value) { return value == null ? '' : String(value).trim(); }
  function copy(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function stable(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().filter(function (key) { return value[key] !== undefined; }).map(function (key) { return JSON.stringify(key) + ':' + stable(value[key]); }).join(',') + '}';
  }
  function fingerprint(value) { var raw = stable(value), hash = 2166136261; for (var i = 0; i < raw.length; i++) { hash ^= raw.charCodeAt(i); hash = Math.imul(hash, 16777619); } return ('00000000' + (hash >>> 0).toString(16)).slice(-8); }
  function issue(code, message, detail) { return Object.assign({ code: code, message: message }, detail || {}); }
  function normalizeId(value) { return text(value).toUpperCase().replace(/[\s\u00a0]+/g, '').replace(/[－–—]/g, '-'); }
  function normalizeCarrier(value) { var carrier = normalizeId(value), synonyms = { ZIM: '以星', COSCO: '中远', COSCOSHIPPING: '中远', CMACGM: '达飞', CMA: '达飞', WANHAI: '万海', EVERGREEN: '长荣', YANGMING: '阳明', OOCL: '东方海外', MSC: '地中海', SMLINE: 'SMLINE' }; return synonyms[carrier] || carrier; }
  function normalizeContainer(value) { var id = normalizeId(value); return /^[A-Z]{4}\d{7}$/.test(id) ? id : ''; }
  function dateValue(year, month, day) { var date = new Date(Date.UTC(year, month - 1, day)); return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : ''; }
  function parseBusinessDate(value, anchorDate) {
    var raw = text(value), full = /(?:^|\D)(20\d{2})[-\/.年](\d{1,2})[-\/.月](\d{1,2})(?:日|\D|$)/.exec(raw);
    if (full) return dateValue(Number(full[1]), Number(full[2]), Number(full[3]));
    var short = /(?:^|\D)(\d{1,2})[\/.月](\d{1,2})(?:日)?(?:[\/.](\d{2}|20\d{2}))?(?:\D|$)/.exec(raw);
    var anchor = /^20\d{2}-\d{2}-\d{2}/.test(text(anchorDate)) ? text(anchorDate).slice(0, 10) : '';
    if (!short) return '';
    if (short[3]) { var year = Number(short[3]); return dateValue(year < 100 ? year + 2000 : year, Number(short[1]), Number(short[2])); }
    if (!anchor) return '';
    var anchorYear = Number(anchor.slice(0, 4)), anchorTime = Date.parse(anchor + 'T00:00:00Z'), best = '', distance = Infinity;
    [anchorYear - 1, anchorYear, anchorYear + 1].forEach(function (year) { var candidate = dateValue(year, Number(short[1]), Number(short[2])); if (candidate && Math.abs(Date.parse(candidate + 'T00:00:00Z') - anchorTime) < distance) { best = candidate; distance = Math.abs(Date.parse(candidate + 'T00:00:00Z') - anchorTime); } });
    return best;
  }
  function addDays(day, count) { return new Date(Date.parse(day + 'T00:00:00Z') + count * 86400000).toISOString().slice(0, 10); }
  function forecastPeriod(title, anchorDate) {
    var kind = /当周|當週|周|週/.test(title) ? 'weekly' : /月/.test(title) && !/\d[\/.]\d/.test(title) ? 'monthly' : 'daily';
    var day = parseBusinessDate(title, anchorDate);
    if (kind === 'monthly') {
      var month = /(?:(20\d{2})年)?(\d{1,2})月/.exec(title), anchorYear = Number(text(anchorDate).slice(0, 4));
      if (month && (month[1] || anchorYear >= 2000)) {
        var year = Number(month[1] || anchorYear), monthNo = Number(month[2]);
        if (!month[1] && /^20\d{2}-\d{2}-\d{2}/.test(text(anchorDate))) {
          var candidates = [year - 1, year, year + 1].map(function (y) { return dateValue(y, monthNo, 1); }).filter(Boolean), anchorTime = Date.parse(anchorDate.slice(0, 10) + 'T00:00:00Z');
          candidates.sort(function (a, b) { return Math.abs(Date.parse(a) - anchorTime) - Math.abs(Date.parse(b) - anchorTime); }); day = candidates[0] || '';
        } else day = dateValue(year, monthNo, 1);
      }
    }
    var end = day;
    if (day && kind === 'weekly') end = addDays(day, 6);
    if (day && kind === 'monthly') { var next = new Date(Date.parse(day + 'T00:00:00Z')); next.setUTCMonth(next.getUTCMonth() + 1); end = addDays(next.toISOString().slice(0, 10), -1); }
    return { kind: kind, businessDate: day, period: { start: day, end: end } };
  }
  function blank(value) { return value === null || value === undefined || text(value) === ''; }
  function number(value) { if (blank(value)) return 0; if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value; if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value); return null; }
  function label(value) { return normalizeId(value).replace(/[:：]/g, '').replace(/櫃/g, '柜').replace(/號/g, '号').replace(/總/g, '总').replace(/倉/g, '仓'); }
  function special(destination) { return /^(?:存仓|自提|FEDEX|UPS|私(?:仓|人|货)?|私仓区|OFFICE|检查区)(?:$|[-_\s\d])/.test(destination); }
  function itemFacts(items) { return (items || []).map(function (row) { return { destination: row.destination, p: row.p, kind: row.kind }; }).sort(function (a, b) { return text(a.destination).localeCompare(text(b.destination)) || text(a.kind).localeCompare(text(b.kind)) || a.p - b.p; }); }
  function itemDifferences(selected, other) {
    var groups = {};
    itemFacts(selected).forEach(function (row) { groups[row.destination + '|' + row.kind] = { destination: row.destination, kind: row.kind, selectedP: row.p, sourceP: 0 }; });
    itemFacts(other).forEach(function (row) { var key = row.destination + '|' + row.kind; if (!groups[key]) groups[key] = { destination: row.destination, kind: row.kind, selectedP: 0, sourceP: 0 }; groups[key].sourceP = row.p; });
    return Object.keys(groups).sort().map(function (key) { return Object.assign({}, groups[key], { differenceP: groups[key].sourceP - groups[key].selectedP }); }).filter(function (row) { return row.differenceP !== 0; });
  }
  function parseForecast(args) {
    args = args || {}; var values = args.values || [], period = forecastPeriod(text(args.title), args.anchorDate), errors = [], sourceId = String(args.sourceId == null ? args.sheetId == null ? text(args.title) : args.sheetId : args.sourceId);
    if (args.kind && PRIORITY[args.kind]) period.kind = args.kind;
    if (args.businessDate) { period.businessDate = parseBusinessDate(args.businessDate, args.anchorDate); period.period = { start: period.businessDate, end: period.businessDate && period.kind === 'weekly' ? addDays(period.businessDate, 6) : period.businessDate }; if (period.businessDate && period.kind === 'monthly') { var periodNext = new Date(Date.parse(period.businessDate + 'T00:00:00Z')); periodNext.setUTCMonth(periodNext.getUTCMonth() + 1); period.period.end = addDays(periodNext.toISOString().slice(0, 10), -1); } }
    var fp = fingerprint({ title: args.title, values: values, kind: period.kind, businessDate: period.businessDate }), prior = args.priorSource || {}, observedAt = text(args.observedAt);
    var result = Object.assign({ version: VERSION, sourceId: sourceId, sheetId: args.sheetId, title: text(args.title), observedAt: observedAt, changedAt: prior.contentFingerprint === fp ? text(prior.changedAt || prior.observedAt || observedAt) : observedAt, contentFingerprint: fp, columns: [], valid: true, issues: errors, physicalInventoryUnchanged: true }, period);
    if ((!/预报|預報/.test(result.title) && !args.kind) || !result.businessDate) errors.push(issue('FORECAST_TITLE_DATE', '预报页名称或业务日期无法识别。'));
    var idRows = [], carrierRow = -1;
    values.slice(0, 20).forEach(function (row, index) { if (label(row[1]) === '柜号') idRows.push(index); if (['台口', '船司', '船公司', '承运商', '承運商'].indexOf(label(row[1])) >= 0) carrierRow = index; });
    if (idRows.length !== 1) errors.push(issue('FORECAST_HEADER', '预报必须有唯一B列柜号表头。'));
    if (errors.length) { result.valid = false; result.columns = (prior.columns || []).map(function (column) { return Object.assign({}, copy(column), { valid: false, issues: (column.issues || []).concat(errors) }); }); return result; }
    var idRow = idRows[0], carriers = carrierRow >= 0 ? values[carrierRow] : [], ids = values[idRow] || [], width = Math.max.apply(null, [ids.length].concat(values.map(function (row) { return row.length; })));
    for (var col = 2; col < width; col++) {
      var rawId = text(ids[col]); if (!rawId) continue;
      var entry = { rawId: rawId, carrier: text(carriers[col]), sourceColumn: col + 1, items: [], ordinaryP: 0, specialP: 0, totalP: 0, declaredTotalP: null, valid: true, issues: [] }, seen = {}, started = false, numericCells = 0, declaredTotal = null;
      for (var rowIndex = idRow + 1; rowIndex < values.length; rowIndex++) {
        var row = values[rowIndex] || [], destination = normalizeId(row[1]), value = row[col];
        if (/^(?:总计|總計|合计|合計|TOTAL|GRANDTOTAL)$/.test(destination)) { if (!blank(value)) { var total = number(value); if (total === null) entry.issues.push(issue('FORECAST_TOTAL_INVALID', '预报合计必须是非负数字或空白。')); else if (declaredTotal !== null && declaredTotal !== total) entry.issues.push(issue('FORECAST_TOTAL_CONFLICT', '同柜有不一致的合计值。')); else declaredTotal = total; } continue; }
        if (!destination) { if (!blank(value)) entry.issues.push(issue('FORECAST_UNLABELLED_QUANTITY', '有预报数字但缺仓点。', { row: rowIndex + 1 })); continue; }
        if (!/^[A-Z][A-Z0-9()\-_/]*$/.test(destination) && !special(destination)) { if (!blank(value)) entry.issues.push(issue('FORECAST_DESTINATION', '预报仓点格式无法核实。', { row: rowIndex + 1, destination: destination })); continue; }
        started = true;
        if (seen[destination]) { entry.issues.push(issue('FORECAST_DUPLICATE_DESTINATION', '同柜预报出现重复仓点，不能确定是否重复导出。', { destination: destination, row: rowIndex + 1 })); continue; }
        seen[destination] = true; var p = number(value);
        if (p === null) { entry.issues.push(issue('FORECAST_QUANTITY', '预报板数必须是非负数字或空白。', { destination: destination, row: rowIndex + 1 })); continue; }
        if (!blank(value)) numericCells++;
        if (!p) continue;
        var kind = special(destination) ? 'special' : 'ordinary'; entry.items.push({ destination: destination, p: p, kind: kind }); entry[kind === 'special' ? 'specialP' : 'ordinaryP'] += p; entry.totalP += p;
      }
      if (!started) entry.issues.push(issue('FORECAST_NO_DESTINATIONS', '柜号存在但没有可识别的完整仓点矩阵。'));
      entry.declaredTotalP = declaredTotal;
      if (!numericCells && declaredTotal !== 0) { entry.issues.push(issue('FORECAST_EMPTY_CONTAINER', '整柜仓点数量均空白，不能按0P处理。')); entry.ordinaryP = null; entry.specialP = null; entry.totalP = null; }
      else if (declaredTotal !== null && Math.abs(declaredTotal - entry.totalP) > 0.000001) entry.issues.push(issue('FORECAST_TOTAL_MISMATCH', '仓点明细与原预报合计不一致，保留待核查。', { declaredTotalP: declaredTotal, calculatedTotalP: entry.totalP }));
      entry.valid = entry.issues.length === 0; result.columns.push(entry);
    }
    if (!result.columns.length) { errors.push(issue('FORECAST_NO_CONTAINERS', '预报没有可识别柜号列。')); result.valid = false; }
    return result;
  }
  function list(value) { return Array.isArray(value) ? value : Object.keys(value || {}).map(function (key) { return value[key]; }); }
  function buildRegistry(args) {
    args = args || {}; var byContainer = {}, aliases = {}, issues = [], seeds = list(args.seeds), mappings = list(args.mappings), seededIdentity = {};
    function add(raw, isSeed) {
      if (!raw || typeof raw !== 'object') return; var container = normalizeContainer(raw.containerNo || raw.fullContainerNo || raw.fullId);
      if (!container) { if (raw.containerNo) issues.push(issue('REGISTRY_INVALID_CONTAINER', '登记的完整柜号格式无效。', { rawId: raw.containerNo })); return; }
      var entry = byContainer[container]; if (!entry) entry = byContainer[container] = { containerNo: container, taskId: container, aliases: [], carriers: [] };
      if (isSeed && text(raw.taskId)) {
        var proposedTaskId = text(raw.taskId);
        if (!seededIdentity[container] || (entry.taskId === container && proposedTaskId !== container)) entry.taskId = proposedTaskId;
        else if (proposedTaskId !== container && entry.taskId !== proposedTaskId) issues.push(issue('REGISTRY_TASK_ID_CONFLICT', '同柜登记了不同稳定任务编号，保留原编号待核查。', { containerNo: container }));
        seededIdentity[container] = true;
      } else if (!seededIdentity[container] && text(raw.taskId) && entry.taskId === container) entry.taskId = text(raw.taskId);
      var names = [container].concat(Array.isArray(raw.aliases) ? raw.aliases : []).concat([raw.alias, raw.rawId, raw.taskId]);
      names.forEach(function (name) { var key = normalizeId(name); if (key && entry.aliases.indexOf(key) < 0) entry.aliases.push(key); });
      [raw.carrier].concat(raw.carriers || []).forEach(function (carrier) { var key = normalizeCarrier(carrier); if (key && entry.carriers.indexOf(key) < 0) entry.carriers.push(key); });
    }
    seeds.forEach(function (row) { add(row, true); }); list(args.publishedAllocations).forEach(function (row) { add(row, false); }); list(args.receipts).forEach(function (row) { add(row, false); });
    mappings.forEach(function (row) { if (row && row.enabled !== false && row.confirmed !== false && ['停用', '未确认', '待核查', 'FALSE'].indexOf(text(row.status).toUpperCase()) < 0) add(row, false); });
    Object.keys(byContainer).sort().forEach(function (container) { var entry = byContainer[container]; entry.aliases.sort(); entry.carriers.sort(); entry.aliases.forEach(function (alias) { if (!aliases[alias]) aliases[alias] = []; aliases[alias].push(container); }); });
    var collisions = Object.keys(aliases).filter(function (alias) { return aliases[alias].length > 1; }).sort().map(function (alias) { return { alias: alias, containerNos: aliases[alias].slice().sort() }; });
    return { entries: Object.keys(byContainer).sort().map(function (id) { return byContainer[id]; }), byContainer: byContainer, aliases: aliases, collisions: collisions, issues: issues };
  }
  function resolveIdentity(rawId, registry, carrier) {
    registry = registry || buildRegistry({}); var normalized = normalizeId(rawId), candidates = [], method = '', errors = [], fulls = [], raw = text(rawId).toUpperCase().replace(/([A-Z]{4})\s+(\d{7})(?!\d)/g, '$1$2'), fullPattern = /(?:^|[^A-Z0-9])([A-Z]{4}\d{7})(?=$|[^A-Z0-9])/g, match;
    while ((match = fullPattern.exec(raw))) fulls.push(match[1]);
    fulls = fulls.filter(function (item, index) { return fulls.indexOf(item) === index; });
    if (fulls.length) { candidates = fulls; method = 'full'; }
    else {
      if (registry.aliases[normalized]) { candidates = registry.aliases[normalized].slice(); method = 'alias'; }
      if (!candidates.length) {
        var tokens = text(rawId).split(/[\n\r,，;；]+/).map(normalizeId).filter(Boolean);
        tokens.forEach(function (token) { (registry.aliases[token] || []).forEach(function (id) { if (candidates.indexOf(id) < 0) candidates.push(id); }); });
        if (candidates.length) method = 'alias';
      }
      if (!candidates.length && /^\d{4,7}$/.test(normalized)) { candidates = registry.entries.filter(function (entry) { return entry.containerNo.slice(-normalized.length) === normalized; }).map(function (entry) { return entry.containerNo; }); method = candidates.length ? 'suffix' : ''; }
    }
    // A carrier label is context, never a reason to silently break a conflicting cabinet match.
    candidates.sort(); var resolved = candidates.length === 1;
    if (candidates.length > 1) errors.push(issue('CONTAINER_AMBIGUOUS', '尾号或别名对应多个实体柜号，保留待匹配。', { candidates: candidates.slice() }));
    if (!candidates.length) errors.push(issue('CONTAINER_UNRESOLVED', '尚无唯一完整柜号对应关系。'));
    var entry = resolved ? registry.byContainer[candidates[0]] : null, observedCarrier = normalizeCarrier(carrier);
    if (entry && observedCarrier && entry.carriers.length && entry.carriers.indexOf(observedCarrier) < 0) {
      errors.push(issue('CONTAINER_CARRIER_CONFLICT', '预报船司与登记船司不一致，尾号或别名不能自动关联。'));
      if (method !== 'full') { resolved = false; method = 'carrier_conflict'; }
    }
    return { resolved: resolved, containerNo: resolved ? candidates[0] : '', taskId: resolved ? entry ? entry.taskId : candidates[0] : '', method: method || 'unresolved', ambiguous: candidates.length > 1, candidates: candidates, rawId: text(rawId), normalizedId: normalized, carrier: text(carrier), issues: errors };
  }
  function discoverMap(args) {
    args = args || {}; var values = args.values || [], statuses = [], ids = [], errors = [], day = parseBusinessDate(args.businessDate || args.title, args.anchorDate), result = { valid: true, businessDate: day || '', observations: [], issues: errors, statusRow: null, idRow: null };
    values.slice(0, 20).forEach(function (row, index) { if (['海柜状态', '柜状态', '海柜狀態', '柜狀態'].indexOf(label(row[0])) >= 0) statuses.push(index); if (label(row[0]) === '柜号') ids.push(index); });
    if (!day || statuses.length !== 1 || ids.length !== 1) { result.valid = false; errors.push(issue('MAP_HEADER_DATE', '拆柜地图日期、柜号或海柜状态表头无法唯一识别。')); return result; }
    result.statusRow = statuses[0] + 1; result.idRow = ids[0] + 1;
    var statusRow = values[statuses[0]] || [], idRow = values[ids[0]] || [];
    for (var col = 1; col < Math.max(statusRow.length, idRow.length); col++) {
      var rawId = text(idRow[col]); if (!rawId) continue;
      if (/^(?:柜号|櫃號|待定|待填|TBD|N\/A|-|—)$/i.test(rawId)) continue;
      var status = text(statusRow[col]) || '未读取', valid = ['未到', '已到', '在拆', '拆空', '未读取', '未观测'].indexOf(status) >= 0;
      var row = { rawId: rawId, status: status, sourceColumn: col + 1, sourceSheetId: args.sheetId, sourceTab: text(args.title), businessDate: day, valid: valid, issues: valid ? [] : [issue('MAP_STATUS', '新柜状态无法识别，保留待核查。')] }; result.observations.push(row);
    }
    return result;
  }
  function selectObservations(observations, registry) {
    var groups = {}, unresolved = [];
    (observations || []).forEach(function (observation) { var resolution = resolveIdentity(observation.rawId, registry, observation.carrier), row = Object.assign({}, copy(observation), { resolution: resolution, containerNo: resolution.containerNo, taskId: resolution.taskId }); if (!resolution.resolved) { row.conflict = resolution.ambiguous; row.eligible = false; unresolved.push(row); return; } if (!groups[row.containerNo]) groups[row.containerNo] = []; groups[row.containerNo].push(row); });
    return Object.keys(groups).sort().map(function (container) {
      var rows = groups[container].sort(function (a, b) { return text(b.businessDate).localeCompare(text(a.businessDate)) || text(a.sourceSheetId).localeCompare(text(b.sourceSheetId)) || a.sourceColumn - b.sourceColumn; }), latest = rows.filter(function (row) { return row.businessDate === rows[0].businessDate; }), statuses = latest.map(function (row) { return row.status; }).filter(function (status, index, all) { return all.indexOf(status) === index; }), conflict = statuses.length > 1 || latest.some(function (row) { return row.valid === false; }), result = Object.assign({}, rows[0]);
      result.conflict = conflict; result.eligible = !conflict; result.sourceObservations = copy(rows); if (conflict) { result.status = '待核查'; result.issues = (result.issues || []).concat([issue('MAP_CONFLICT', '同日同柜出现不同状态或无效状态，未选择其中一条。')]); } return result;
    }).concat(unresolved).sort(function (a, b) { return text(a.containerNo || a.rawId).localeCompare(text(b.containerNo || b.rawId)); });
  }
  function containerSet(input) { var result = {}; if (Array.isArray(input)) input.forEach(function (row) { var id = normalizeContainer(typeof row === 'string' ? row : row && row.containerNo); if (id) result[id] = true; }); else Object.keys(input || {}).forEach(function (key) { var row = input[key], id = normalizeContainer(key) || normalizeContainer(row && row.containerNo); if (id && row !== false) result[id] = true; }); return result; }
  function deduplicate(args) {
    args = args || {}; var registry = args.registry || buildRegistry({}), groups = {}, errors = [], posted = containerSet(args.postedContainers), published = containerSet(args.publishedContainers), observations = selectObservations(args.observations || [], registry), observationByContainer = {}, totals = { verifiedOrdinaryP: 0, provisionalOrdinaryP: 0, excludedPostedP: 0, alreadyPublishedP: 0, verifiedSpecialP: 0, provisionalSpecialP: 0, selectedContainers: 0, verifiedContainers: 0, provisionalContainers: 0, blockedContainers: 0 };
    observations.forEach(function (row) { if (row.containerNo) observationByContainer[row.containerNo] = row; });
    (args.sources || []).forEach(function (source) {
      if (source.valid === false && !(source.columns || []).length) { errors = errors.concat(source.issues || []); return; }
      (source.columns || []).forEach(function (column) {
        var resolution = resolveIdentity(column.rawId, registry, column.carrier), key = resolution.resolved ? resolution.containerNo : 'PROVISIONAL|' + normalizeId(column.carrier) + '|' + normalizeId(column.rawId);
        if (!groups[key]) groups[key] = []; groups[key].push({ source: source, column: column, resolution: resolution });
      });
    });
    var rows = Object.keys(groups).sort().map(function (key) {
      var candidates = groups[key].sort(function (a, b) { return (PRIORITY[b.source.kind] || 0) - (PRIORITY[a.source.kind] || 0) || text(b.source.businessDate).localeCompare(text(a.source.businessDate)) || text(b.source.changedAt).localeCompare(text(a.source.changedAt)) || text(a.source.sourceId).localeCompare(text(b.source.sourceId)) || a.column.sourceColumn - b.column.sourceColumn; });
      var chosen = candidates[0], selected = chosen.column, source = chosen.source, resolution = chosen.resolution, sameSource = candidates.filter(function (row) { return row.source.sourceId === source.sourceId; }), conflicts = sameSource.length > 1, valid = selected.valid !== false && source.valid !== false && !conflicts;
      var excluded = resolution.resolved && !!posted[resolution.containerNo], already = resolution.resolved && !excluded && !!published[resolution.containerNo], provenance = candidates.map(function (row) { return { sourceId: row.source.sourceId, title: row.source.title, kind: row.source.kind, businessDate: row.source.businessDate, changedAt: row.source.changedAt, contentFingerprint: row.source.contentFingerprint, sourceColumn: row.column.sourceColumn, rawId: row.column.rawId, carrier: row.column.carrier, ordinaryP: row.column.ordinaryP, specialP: row.column.specialP, totalP: row.column.totalP, itemFingerprint: fingerprint(itemFacts(row.column.items)), valid: row.source.valid !== false && row.column.valid !== false }; });
      var rowIssues = copy(selected.issues || []).concat(resolution.issues || []); if (conflicts) rowIssues.push(issue('FORECAST_DUPLICATE_CONTAINER', '同一预报版本重复出现同柜，不合并或相加。'));
      var tied = candidates.filter(function (row) { return row.source.sourceId !== source.sourceId && row.source.kind === source.kind && row.source.businessDate === source.businessDate && text(row.source.changedAt) === text(source.changedAt); });
      if (tied.some(function (row) { return stable(itemFacts(row.column.items)) !== stable(itemFacts(selected.items)); })) { valid = false; rowIssues.push(issue('FORECAST_VERSION_CONFLICT', '同优先级同时间预报数值冲突，保留待核查。')); }
      var differences = candidates.slice(1).map(function (candidate, index) { var item = provenance[index + 1], warehouseDifferences = itemDifferences(selected.items, candidate.column.items); return Object.assign({}, item, { ordinaryDifferenceP: item.ordinaryP - selected.ordinaryP, specialDifferenceP: item.specialP - selected.specialP, warehouseMixChanged: warehouseDifferences.length > 0, warehouseDifferences: warehouseDifferences }); }).filter(function (item) { return item.ordinaryDifferenceP || item.specialDifferenceP || item.totalP !== selected.totalP || item.warehouseMixChanged; });
      var result = { key: key, containerNo: resolution.containerNo, taskId: resolution.taskId, verified: resolution.resolved, valid: valid, resolutionStatus: resolution.resolved ? 'resolved' : resolution.ambiguous ? 'ambiguous' : 'unresolved', rawIds: provenance.map(function (row) { return row.rawId; }).filter(function (id, index, all) { return all.indexOf(id) === index; }), carrier: selected.carrier, selectedSourceId: source.sourceId, selectedSourceTitle: source.title, sourceKind: source.kind, businessDate: source.businessDate, changedAt: source.changedAt, ordinaryP: selected.ordinaryP, specialP: selected.specialP, totalP: selected.totalP, items: copy(selected.items || []), eligible: valid && resolution.resolved && !excluded && !already, excludedPosted: excluded, alreadyPublished: already, provenance: provenance, differences: differences, issues: rowIssues, observation: observationByContainer[resolution.containerNo] || null };
      result.status = !valid ? '来源异常·待核查' : excluded ? '已实拆入账·排除预报' : already ? '已发布·不重复占用' : resolution.resolved ? '预报待规划' : resolution.ambiguous ? '尾号冲突·待匹配' : resolution.method === 'carrier_conflict' ? '船司冲突·待匹配' : '缺完整柜号·待匹配';
      totals.selectedContainers++; if (resolution.resolved) totals.verifiedContainers++; else totals.provisionalContainers++;
      if (!valid || resolution.ambiguous || resolution.method === 'carrier_conflict') totals.blockedContainers++;
      if (valid && excluded) totals.excludedPostedP += selected.ordinaryP;
      else if (valid && already) totals.alreadyPublishedP += selected.ordinaryP;
      else if (valid && resolution.resolved) { totals.verifiedOrdinaryP += selected.ordinaryP; totals.verifiedSpecialP += selected.specialP; }
      else if (valid && !resolution.ambiguous) { totals.provisionalOrdinaryP += selected.ordinaryP; totals.provisionalSpecialP += selected.specialP; }
      return result;
    });
    return { version: VERSION, rows: rows, totals: totals, observations: observations, issues: errors, physicalInventoryUnchanged: true };
  }
  return { VERSION: VERSION, stable: stable, fingerprint: fingerprint, normalizeId: normalizeId, normalizeContainer: normalizeContainer, parseBusinessDate: parseBusinessDate, parseForecast: parseForecast, buildRegistry: buildRegistry, resolveIdentity: resolveIdentity, discoverMap: discoverMap, selectObservations: selectObservations, deduplicate: deduplicate };
}());
if (typeof module !== 'undefined' && module.exports) module.exports = WTCForecastCore;
