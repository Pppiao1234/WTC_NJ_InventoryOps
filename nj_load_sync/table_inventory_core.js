/* Read the user's location matrix without AI or inventory transactions. */
var WTCTableInventoryCore = (function () {
  'use strict';
  var VERSION = '1.7.0';
  function text(x) { return x == null ? '' : String(x).trim(); }
  function normal(x) { return text(x).replace(/\s+/g, ' ').toUpperCase(); }
  function copy(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function stableStringify(x) {
    if (x === null || typeof x !== 'object') return JSON.stringify(x);
    if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(x).sort().filter(function (k) { return x[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + stableStringify(x[k]); }).join(',') + '}';
  }
  function fingerprint(x) { var s = stableStringify(x), h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ('00000000' + (h >>> 0).toString(16)).slice(-8); }
  function uniq(list) { return list.filter(function (v, i) { return list.indexOf(v) === i; }); }
  function cellAddress(row, col) { var letters = '', n = col + 1; while (n) { n--; letters = String.fromCharCode(65 + n % 26) + letters; n = Math.floor(n / 26); } return letters + (row + 1); }
  function value(cell) {
    if (cell && typeof cell === 'object' && !Array.isArray(cell)) {
      if (cell.effectiveValue && cell.effectiveValue.errorValue) return '#FORMULA_ERROR!';
      if (cell.formattedValue !== undefined) return text(cell.formattedValue);
      var v = cell.effectiveValue || cell.userEnteredValue || {};
      return text(v.stringValue !== undefined ? v.stringValue : v.numberValue !== undefined ? v.numberValue : v.boolValue !== undefined ? v.boolValue : '');
    }
    return text(cell);
  }
  function area(v) { return /^[A-Z]$/.test(normal(v)) ? normal(v) : ''; }
  function laneNumber(v) { var s = normal(v), m = /^(?:#\s*[（(]\s*)?(\d{1,3})(?:\s*[）)])?$/.exec(s); return m && Number(m[1]) > 0 ? Number(m[1]) : null; }
  function capacity(v) { var m = /^(\d+)\s*P\s*\/\s*(?:LANE|线)$/i.exec(text(v)); return m ? Number(m[1]) : null; }
  function isFormulaError(v) { return /^#(?:REF!|VALUE!|DIV\/0!|N\/A\b|NAME\?|NUM!|NULL!|ERROR!|SPILL!|FORMULA_ERROR!)/i.test(text(v)); }
  function issue(code, message, extra, severity) { return Object.assign({ code: code, message: message, severity: severity || 'warning' }, extra || {}); }
  function cargoIdentity(label) { return normal(label).replace(/^[\s:：,，;；/|+、]+|[\s:：,，;；/|+、]+$/g, ''); }
  function parseRecord(raw, ref, notes) {
    var s = text(raw), result = { records: [], issues: [], empty: false };
    if (!s) return result;
    if (/^(?:0(?:\s*[Pp板])?|空|空位|无货|空库位|已清空|EMPTY)$/i.test(s)) { result.empty = true; return result; }
    function unknown(code, message) {
      result.records.push({ cargoKey: '__UNKNOWN__:' + normal(s), cargoLabel: s, physicalP: null, sourceCells: [ref], rawTexts: [s], notes: notes ? [notes] : [], quantityBasis: 'unknown' });
      result.issues.push(issue(code, message, { sourceCells: [ref], raw: s }));
      return result;
    }
    if (isFormulaError(s)) return unknown('FORMULA_ERROR', '公式返回错误，该格板数保留未知。');
    var matches = [], re = /(-?\d+(?:\.\d+)?)\s*(?:P\b|板(?:数)?)/ig, m;
    while ((m = re.exec(s))) matches.push({ start: m.index, end: re.lastIndex, quantity: Number(m[1]) });
    if (!matches.length) return unknown('QUANTITY_UNKNOWN', '该格未明确板数，未从货物编码、标记或容量猜数。');
    if (matches.some(function (x) { return x.start > 0 && /[A-Za-z0-9.,/\-]/.test(s.charAt(x.start - 1)); })) return unknown('QUANTITY_TOKEN_AMBIGUOUS', '板数字段与货物编码或分数连在一起，未截取其中数字。');
    if (matches.some(function (x) { return !Number.isSafeInteger(x.quantity) || x.quantity < 0; })) return unknown('INVALID_QUANTITY', '板数必须是明确的非负整数。');
    var cursor = 0, parsed = [], bad = false;
    matches.forEach(function (part) {
      var label = cargoIdentity(s.slice(cursor, part.start)); cursor = part.end;
      if (!label) { bad = true; return; }
      parsed.push({ cargoKey: label, physicalP: part.quantity });
    });
    var trailing = cargoIdentity(s.slice(cursor));
    if (trailing || bad) {
      if (matches.length === 1 && !cargoIdentity(s.slice(0, matches[0].start)) && !trailing) {
        var q = matches[0].quantity;
        result.records.push({ cargoKey: '__UNSPECIFIED_CARGO__', cargoLabel: '货物标识未填', physicalP: q, sourceCells: [ref], rawTexts: [s], notes: notes ? [notes] : [], quantityBasis: 'explicit_unit' });
        result.issues.push(issue('CARGO_UNKNOWN', '该格已写板数，但仓点或货物标识未填。', { sourceCells: [ref], raw: s }));
        return result;
      }
      return unknown('QUANTITY_ASSOCIATION_AMBIGUOUS', '多项板数与货物标识对应不清，该格不自动分摊。');
    }
    cursor = 0;
    matches.forEach(function (part, index) {
      var label = text(s.slice(cursor, part.start)).replace(/^[\s:：,，;；/|+、]+|[\s:：,，;；/|+、]+$/g, ''); cursor = part.end;
      result.records.push({ cargoKey: parsed[index].cargoKey, cargoLabel: label, physicalP: part.quantity, sourceCells: [ref], rawTexts: [s], notes: notes ? [notes] : [], quantityBasis: 'explicit_unit' });
    });
    return result;
  }
  function noteAt(args, r, c, cell) { var n = args.notes || {}; return text(Array.isArray(n) ? (n[r] || [])[c] : n[cell] || ((args.rows[r] || [])[c] || {}).note); }
  function detectLayout(rows) {
    var headers = [], sections = [], markers = [], width = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    rows.forEach(function (row, r) {
      if (row.some(function (v) { return /^(?:私仓|私仓区|特殊货区)$/.test(text(v)); })) markers.push(r);
      var c = 0;
      while (c < row.length) {
        var first = laneNumber(row[c]);
        if (first == null) { c++; continue; }
        var start = c, numbers = [first]; c++;
        while (c < row.length && laneNumber(row[c]) === first + numbers.length) { numbers.push(laneNumber(row[c])); c++; }
        if (numbers.length < 3 || start < 1) continue;
        var left = row[start - 1], direct = !!area(left) || capacity(left) !== null, following = false;
        for (var k = r + 1; k < Math.min(rows.length, r + 6); k++) {
          if (rows[k].some(function (v) { return text(v) !== ''; })) { following = !!area(rows[k][start - 1]); break; }
        }
        // A number row immediately below a row's area is usually its quantity row.
        var aboveArea = r > 0 && area(rows[r - 1][start - 1]);
        if (!direct && (!following || aboveArea)) continue;
        headers.push({ row: r, startCol: start, endCol: c - 1, numbers: numbers, capacitySlots: capacity(left), capacitySourceCell: capacity(left) !== null ? cellAddress(r, start - 1) : null });
      }
    });
    rows.forEach(function (row, r) {
      for (var c = 0; c < Math.min(width, row.length); c++) {
        var a = area(row[c]); if (!a) continue;
        var candidates = headers.filter(function (h) { return h.startCol === c + 1 && h.row <= r; });
        if (!candidates.length) continue;
        var h = candidates[candidates.length - 1];
        if (capacity(row[c + 1]) !== null) continue;
        sections.push({ area: a, labelCol: c, startRow: r, header: h, kind: markers.some(function (mark) { return mark <= r; }) ? 'private' : 'ordinary' });
      }
    });
    sections.forEach(function (section) {
      var ends = [rows.length];
      sections.forEach(function (other) { if (other.startRow > section.startRow && other.labelCol === section.labelCol) ends.push(other.startRow); });
      headers.forEach(function (h) { if (h.row > section.startRow && h.startCol === section.header.startCol) ends.push(h.row); });
      markers.forEach(function (mark) { if (mark > section.startRow) ends.push(mark); });
      section.endRow = Math.min.apply(null, ends) - 1;
    });
    return { headers: headers, sections: sections, markers: markers };
  }
  function parseSnapshot(args) {
    args = args || {};
    var rawRows = Array.isArray(args.rows) ? args.rows : [], rows = rawRows.map(function (r) { return Array.isArray(r) ? r.map(value) : []; });
    var layout = detectLayout(rows), issues = [], occurrences = [], covered = Object.create(null), metadataRows = Object.create(null);
    layout.headers.forEach(function (h) { metadataRows[h.row] = true; });
    layout.markers.forEach(function (r) { metadataRows[r] = true; });
    layout.sections.forEach(function (section, sectionIndex) {
      covered[cellAddress(section.startRow, section.labelCol)] = true;
      section.header.numbers.forEach(function (number, n) {
        var col = section.header.startCol + n, location = section.area + number, cells = [];
        for (var r = section.startRow; r <= section.endRow; r++) {
          if (metadataRows[r]) continue;
          var ref = cellAddress(r, col); covered[ref] = true;
          if (text((rows[r] || [])[col])) cells.push({ raw: rows[r][col], ref: ref, row: r, note: noteAt(args, r, col, ref) });
        }
        var records = [], emptyCells = [], sourceCells = cells.map(function (c) { return c.ref; });
        for (var i = 0; i < cells.length; i++) {
          var cell = cells[i], next = cells[i + 1];
          // In the ordinary two-row matrix a point label and following quantity cell form one record.
          if (section.kind === 'ordinary' && next && next.row === cell.row + 1 && !/\d\s*(?:P\b|板)/i.test(cell.raw) && !isFormulaError(cell.raw) && /[A-Z\u4e00-\u9fff]/i.test(cell.raw) && /^\d+(?:\s*[Pp板])?$/.test(next.raw) && !/^(?:空|空位|无货|已清空|EMPTY)$/i.test(cell.raw)) {
            var paired = Number(next.raw.replace(/\s*[Pp板]$/, ''));
            if (Number.isSafeInteger(paired)) { records.push({ cargoKey: cargoIdentity(cell.raw), cargoLabel: cell.raw, physicalP: paired, sourceCells: [cell.ref, next.ref], rawTexts: [cell.raw, next.raw], notes: [cell.note, next.note].filter(Boolean), quantityBasis: 'paired_quantity_cell' }); i++; continue; }
          }
          var parsed = parseRecord(cell.raw, cell.ref, cell.note);
          records = records.concat(parsed.records);
          parsed.issues.forEach(function (x) { issues.push(Object.assign({ location: location }, x)); });
          if (parsed.empty) emptyCells.push(cell.ref);
        }
        var grouped = Object.create(null);
        records.forEach(function (record) {
          var existing = grouped[record.cargoKey];
          if (!existing) { grouped[record.cargoKey] = copy(record); return; }
          var exactRepeat = record.rawTexts.some(function (raw) { return existing.rawTexts.map(normal).indexOf(normal(raw)) >= 0; });
          if (exactRepeat) issues.push(issue('POSSIBLE_DUPLICATE_ROW', '同库位同货物存在重复内容，按表内各行保留并提示复核。', { location: location, sourceCells: existing.sourceCells.concat(record.sourceCells) }));
          existing.physicalP = existing.physicalP === null || record.physicalP === null ? null : existing.physicalP + record.physicalP;
          existing.sourceCells = existing.sourceCells.concat(record.sourceCells); existing.rawTexts = existing.rawTexts.concat(record.rawTexts); existing.notes = existing.notes.concat(record.notes);
        });
        if (emptyCells.length && records.length) issues.push(issue('EMPTY_AND_CONTENT', '同一位置同时写有空位和货物明细，需核对。', { location: location, sourceCells: sourceCells }));
        occurrences.push({ location: location, sectionId: sectionIndex, sectionKind: section.kind, records: Object.keys(grouped).sort().map(function (k) { return grouped[k]; }), explicitEmpty: emptyCells.length > 0 && records.length === 0, conflictingEmpty: emptyCells.length > 0 && records.length > 0, sourceCells: sourceCells, emptyCells: emptyCells, capacitySlots: section.header.capacitySlots, capacitySourceCell: section.header.capacitySourceCell, range: cellAddress(section.startRow, col) + ':' + cellAddress(section.endRow, col) });
      });
    });
    var unmapped = [];
    rows.forEach(function (row, r) { if (metadataRows[r]) return; row.forEach(function (v, c) { if (!text(v) || covered[cellAddress(r, c)]) return; if (capacity(v) !== null) return; unmapped.push({ sourceCells: [cellAddress(r, c)], raw: v }); }); });
    unmapped.forEach(function (x) { issues.push(issue('UNMAPPED_CONTENT', '内容位于未识别的库位区域，已保留待核对。', x, /\d\s*(?:P\b|板)/i.test(x.raw) || isFormulaError(x.raw) ? 'error' : 'warning')); });
    var byLocation = Object.create(null), entries = [], locations = [];
    occurrences.forEach(function (o) { (byLocation[o.location] || (byLocation[o.location] = [])).push(o); });
    Object.keys(byLocation).sort(function (a, b) { return a.localeCompare(b, 'en', { numeric: true }); }).forEach(function (location) {
      var all = byLocation[location], nonblank = all.filter(function (o) { return o.records.length || o.explicitEmpty; }), active = nonblank.length ? nonblank : all;
      var merged = Object.create(null), conflict = active.some(function (o) { return o.conflictingEmpty; }), seenOccurrence = Object.create(null);
      active.forEach(function (o) {
        var signature = stableStringify({ empty: o.explicitEmpty, records: o.records.map(function (r) { return { cargoKey: r.cargoKey, physicalP: r.physicalP }; }) });
        var already = seenOccurrence[signature];
        if (already && (o.records.length || o.explicitEmpty)) {
          issues.push(issue('DUPLICATE_LOCATION_VIEW', '同库位另一处展示内容相同，板数仅计一次。', { location: location, sourceCells: already.sourceCells.concat(o.sourceCells) }));
          o.records.forEach(function (r) { var m = merged[r.cargoKey]; if (m) { m.sourceCells = uniq(m.sourceCells.concat(r.sourceCells)); m.rawTexts = uniq(m.rawTexts.concat(r.rawTexts)); m.notes = uniq(m.notes.concat(r.notes)); } });
          return;
        }
        seenOccurrence[signature] = o;
        o.records.forEach(function (record) {
          var prior = merged[record.cargoKey];
          if (!prior) { merged[record.cargoKey] = Object.assign({ location: location }, copy(record)); return; }
          prior.sourceCells = uniq(prior.sourceCells.concat(record.sourceCells)); prior.rawTexts = uniq(prior.rawTexts.concat(record.rawTexts)); prior.notes = uniq(prior.notes.concat(record.notes));
          if (prior.physicalP !== record.physicalP) { prior.physicalP = null; conflict = true; issues.push(issue('LOCATION_QUANTITY_CONFLICT', '同库位同货物在不同区域写了不同板数，未重复相加。', { location: location, cargoKey: record.cargoKey, sourceCells: prior.sourceCells })); }
          else issues.push(issue('DUPLICATE_CARGO_VIEW', '同库位同货物在多个区域重复展示，仅计一次。', { location: location, cargoKey: record.cargoKey, sourceCells: prior.sourceCells }));
        });
      });
      if (nonblank.length > 1 && Object.keys(seenOccurrence).length > 1) issues.push(issue('MULTIPLE_LOCATION_SECTIONS', '同一物理库位在多个区域有明细；按货物合并，容量仅计一次，请核对区域用途。', { location: location, sourceCells: uniq(nonblank.reduce(function (s, o) { return s.concat(o.sourceCells); }, [])) }));
      var locationEntries = Object.keys(merged).sort().map(function (k) { var e = merged[k]; e.key = location + '|' + encodeURIComponent(k); return e; });
      var hasEmpty = active.some(function (o) { return o.explicitEmpty; });
      if (hasEmpty && locationEntries.length) { conflict = true; issues.push(issue('LOCATION_EMPTY_CONFLICT', '同一物理库位一处标空、一处有货，库存数量保留待核对。', { location: location, sourceCells: uniq(active.reduce(function (s, o) { return s.concat(o.sourceCells); }, [])) })); }
      var caps = uniq(active.map(function (o) { return o.capacitySlots; }).filter(function (x) { return x !== null; }));
      if (caps.length > 1 && nonblank.length) issues.push(issue('CAPACITY_REFERENCE_CONFLICT', '同一库位的有货区域给出不同容量参考，暂不计算精确余位。', { location: location, capacities: caps }));
      // Conflicting empty/content records cannot contribute to a trusted subtotal.
      // Retain the explicitly reported number only as a review reference.
      var reportedP = locationEntries.reduce(function (sum, e) { return sum + (e.physicalP === null ? 0 : e.physicalP); }, 0);
      if (conflict) locationEntries.forEach(function (e) { e.reportedP = e.physicalP; e.physicalP = null; e.quantityBasis = 'conflicting_location'; });
      var knownP = conflict ? 0 : reportedP;
      var known = !conflict && (locationEntries.length ? locationEntries.every(function (e) { return e.physicalP !== null; }) : hasEmpty);
      var sourceCells = uniq(active.reduce(function (s, o) { return s.concat(o.sourceCells); }, []));
      var status = conflict ? 'conflict' : known ? locationEntries.length ? 'recorded' : 'explicit_empty' : locationEntries.length ? 'quantity_unknown' : 'unknown';
      var unavailable = (args.unavailableLocations || ['G10', 'G11']).indexOf(location) >= 0;
      if (unavailable && locationEntries.length) issues.push(issue('UNAVAILABLE_LOCATION_RECORD', '既定不可用库位仍有表内记录，请核对位置。', { location: location, sourceCells: sourceCells }));
      locations.push({ location: location, recordedP: known ? knownP : null, knownP: knownP, reportedP: reportedP, quantityKnown: known, status: status, capacitySlots: caps.length === 1 ? caps[0] : null, capacityBasis: caps.length ? 'source_standard_reference' : 'unknown', capacitySourceCells: uniq(active.map(function (o) { return o.capacitySourceCell; }).filter(Boolean)), capacityReferences: all.filter(function (o) { return o.capacitySlots !== null; }).map(function (o) { return { value: o.capacitySlots, sourceCell: o.capacitySourceCell, sectionKind: o.sectionKind }; }), sourceCells: sourceCells, sourceRanges: uniq(all.map(function (o) { return o.range; })), sectionKinds: uniq(all.map(function (o) { return o.sectionKind; })), cargoCount: locationEntries.length, available: !unavailable });
      entries = entries.concat(locationEntries);
    });
    var structuralValid = layout.sections.length > 0 && !issues.some(function (x) { return x.code === 'UNMAPPED_CONTENT' && x.severity === 'error'; });
    if (!layout.sections.length) issues.push(issue('LAYOUT_NOT_RECOGNIZED', '没有识别到区域字母和库位列号，未生成空库存。', {}, 'error'));
    var readComplete = args.readComplete !== false;
    if (!readComplete) issues.push(issue('SOURCE_READ_INCOMPLETE', '源表只读取了部分内容，不能把本次缺失当作清空。', {}, 'error'));
    var quantityComplete = locations.length > 0 && locations.every(function (l) { return l.quantityKnown; });
    var knownTotal = entries.reduce(function (sum, e) { return sum + (e.physicalP === null ? 0 : e.physicalP); }, 0);
    var result = { ok: structuralValid && readComplete, complete: structuralValid && readComplete, readComplete: readComplete, structuralValid: structuralValid, quantityComplete: quantityComplete, version: VERSION, sourceSheetId: args.sourceSheetId == null ? null : args.sourceSheetId, sourceSheetName: args.sourceSheetName || '库位表', capturedAt: args.capturedAt || '', entries: entries, locations: locations, issues: issues, unmapped: unmapped, summary: { recordedP: quantityComplete ? knownTotal : null, knownP: knownTotal, totalKnownP: knownTotal, locationCount: locations.length, knownLocationCount: locations.filter(function (l) { return l.quantityKnown; }).length, unknownLocationCount: locations.filter(function (l) { return !l.quantityKnown; }).length, entryCount: entries.length, issueCount: issues.length, sectionCount: layout.sections.length } };
    result.semanticHash = fingerprint(semantic(result));
    return result;
  }
  function semantic(snapshot) {
    return { entries: (snapshot.entries || []).map(function (e) { return { key: e.key, physicalP: e.physicalP }; }).sort(function (a, b) { return a.key.localeCompare(b.key); }), locations: (snapshot.locations || []).map(function (l) { return { location: l.location, status: l.status, capacitySlots: l.capacitySlots, available: l.available }; }).sort(function (a, b) { return a.location.localeCompare(b.location); }) };
  }
  function diffSnapshots(before, after) {
    if (!after || !after.complete || !after.structuralValid || after.readComplete === false) return { ok: false, baseline: false, noOp: true, changes: [], issues: [issue('INCOMPLETE_COMPARISON_SOURCE', '读取或库位结构不完整，保留上次成功快照。', {}, 'error')], summary: { changeCount: 0 } };
    if (!before) return { ok: true, baseline: true, noOp: true, changes: [], issues: [], summary: { changeCount: 0, message: '建立手动库位表独立比较基准，不记作新入库。' } };
    var changes = [], oldEntries = Object.create(null), newEntries = Object.create(null), oldLocations = Object.create(null), newLocations = Object.create(null);
    (before.entries || []).forEach(function (e) { oldEntries[e.key] = e; }); (after.entries || []).forEach(function (e) { newEntries[e.key] = e; });
    (before.locations || []).forEach(function (l) { oldLocations[l.location] = l; }); (after.locations || []).forEach(function (l) { newLocations[l.location] = l; });
    uniq(Object.keys(oldEntries).concat(Object.keys(newEntries))).sort().forEach(function (key) {
      var a = oldEntries[key], b = newEntries[key]; if (a && b && a.physicalP === b.physicalP) return;
      var row = b || a, type = !a ? 'added' : !b ? 'cleared' : 'quantity_changed';
      var message = !a ? '表内新增记录，实际作业原因未注明。' : !b ? '表内记录已清空或移至其他位置，未认作实际出库或零库存。' : '表内板数发生变化，实际作业原因未注明。';
      changes.push({ type: type, location: row.location, cargoKey: row.cargoKey, cargoLabel: row.cargoLabel, beforeP: a ? a.physicalP : null, afterP: b ? b.physicalP : null, beforeStatus: (oldLocations[row.location] || {}).status || 'not_observed', afterStatus: (newLocations[row.location] || {}).status || 'not_observed', sourceCells: b ? b.sourceCells : [], beforeSourceCells: a ? a.sourceCells : [], message: message, meaning: 'table_record_change' });
    });
    uniq(Object.keys(oldLocations).concat(Object.keys(newLocations))).sort().forEach(function (location) {
      var a = oldLocations[location], b = newLocations[location], hasEntryChange = changes.some(function (c) { return c.location === location; });
      if (!a || !b) { if (!hasEntryChange) changes.push({ type: !b ? 'location_missing' : 'location_added', location: location, cargoKey: '', cargoLabel: '', beforeP: a ? a.recordedP : null, afterP: b ? b.recordedP : null, beforeStatus: a ? a.status : 'not_observed', afterStatus: b ? b.status : 'not_observed', sourceCells: b ? b.sourceCells : [], beforeSourceCells: a ? a.sourceCells : [], message: '表内库位布局发生变化，未作实物出入库。', meaning: 'table_record_change' }); return; }
      if (a.status !== b.status && !hasEntryChange) changes.push({ type: b.status === 'explicit_empty' ? 'empty_confirmed' : 'status_changed', location: location, cargoKey: '', cargoLabel: '', beforeP: a.recordedP, afterP: b.recordedP, beforeStatus: a.status, afterStatus: b.status, sourceCells: b.sourceCells, beforeSourceCells: a.sourceCells, message: '表内库位填写状态变化，空白与明确空位分别保留。', meaning: 'table_record_change' });
      if (a.capacitySlots !== b.capacitySlots || a.available !== b.available) changes.push({ type: 'capacity_reference_changed', location: location, cargoKey: '', cargoLabel: '', beforeP: a.recordedP, afterP: b.recordedP, beforeStatus: a.status, afterStatus: b.status, sourceCells: b.capacitySourceCells || [], beforeSourceCells: a.capacitySourceCells || [], message: '库位规划参考或可用状态变化，不改变表内板数。', meaning: 'table_record_change' });
    });
    return { ok: true, baseline: false, noOp: changes.length === 0, changes: changes, issues: [], summary: { changeCount: changes.length, addedRecords: changes.filter(function (c) { return c.type === 'added'; }).length, clearedRecords: changes.filter(function (c) { return c.type === 'cleared'; }).length, quantityChanges: changes.filter(function (c) { return c.type === 'quantity_changed'; }).length, beforeKnownP: before.summary ? before.summary.knownP : null, afterKnownP: after.summary ? after.summary.knownP : null } };
  }
  return { VERSION: VERSION, parseSnapshot: parseSnapshot, diffSnapshots: diffSnapshots, parseRecord: parseRecord, stableStringify: stableStringify, fingerprint: fingerprint };
}());
if (typeof module !== 'undefined' && module.exports) module.exports = WTCTableInventoryCore;
