'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./table_inventory_core.js');
const fixture = require('./fixtures/synthetic_table.js');
const copy = x => JSON.parse(JSON.stringify(x));
const snapshot = rows => C.parseSnapshot({ rows, sourceSheetId:101, capturedAt:'2026-11-07T00:00:00Z' });
function matrix(a='',b='',c='') { return [['','27P/lane','1','2','3'],['','A',a,b,c],[]]; }
function paired(a='ABE8',n='5') { return [['','27P/lane','1','2','3'],['','A',a,'AVP1',''],['','',n,'3','']]; }
const loc = (s,n) => s.locations.find(x=>x.location===n);
const entries = (s,n) => s.entries.filter(x=>x.location===n);

test('synthetic source retains six synthetic records as 33 recorded P, not full-warehouse inventory',()=>{
  const before=copy(fixture),s=C.parseSnapshot(fixture);
  assert.equal(s.complete,true); assert.equal(s.structuralValid,true); assert.equal(s.quantityComplete,false);
  assert.equal(s.summary.knownP,33); assert.equal(s.summary.entryCount,6); assert.equal(s.summary.locationCount,48);
  assert.equal(s.summary.recordedP,null); assert.deepEqual(fixture,before);
  assert.equal(loc(s,'M11').recordedP,9); assert.equal(entries(s,'M11').length,3);
  assert.equal(loc(s,'A7').recordedP,7); assert.equal(loc(s,'A7').capacitySlots,null);
  assert.equal(loc(s,'A1').status,'unknown'); assert.equal(loc(s,'G10').available,false);
  assert.equal(s.issues.length,0);
});
test('slash-bearing reference remains one cargo rather than split tickets',()=>{
  const s=C.parseSnapshot(fixture),r=entries(s,'B6')[0];
  assert.equal(r.cargoLabel,'DEMO-B-001/002');assert.equal(r.physicalP,15);
  assert.deepEqual(r.sourceCells,['E17']);
});
test('empty matrix is readable but its empty cells are unknown',()=>{
  const s=snapshot(matrix());assert.equal(s.ok,true);assert.equal(s.complete,true);assert.equal(s.quantityComplete,false);
  assert.equal(s.summary.knownP,0);assert.equal(s.summary.recordedP,null);assert.equal(loc(s,'A1').recordedP,null);
});
test('explicit empties distinguish zero from unknown',()=>{
  const s=snapshot(matrix('0','空位','无货'));assert.equal(s.quantityComplete,true);assert.equal(s.summary.recordedP,0);
  assert.ok(s.locations.every(x=>x.status==='explicit_empty'&&x.recordedP===0));
});
test('explicit unit recognizes lowercase p and Chinese 板, zero cargo remains a record',()=>{
  const s=snapshot(matrix('ABE8 5p','AVP1 2板','BNA2 0P'));
  assert.equal(s.summary.knownP,7);assert.equal(entries(s,'A3')[0].physicalP,0);assert.equal(s.quantityComplete,true);
});
test('ordinary point row and following quantity row are associated with both source cells',()=>{
  const s=snapshot(paired());assert.equal(entries(s,'A1')[0].physicalP,5);assert.equal(entries(s,'A1')[0].cargoKey,'ABE8');
  assert.deepEqual(entries(s,'A1')[0].sourceCells,['C2','C3']);assert.equal(entries(s,'A1')[0].quantityBasis,'paired_quantity_cell');
});
test('ascending quantities under a point row are not mistaken for a fresh location header',()=>{
  const rows=[['','27P/lane',1,2,3],['','A','ABE8','AVP1','BNA2'],['','',1,2,3],['','B','TEB4 7P'],[]];
  const s=snapshot(rows);assert.equal(loc(s,'A1').recordedP,1);assert.equal(loc(s,'A2').recordedP,2);assert.equal(loc(s,'A3').recordedP,3);assert.equal(loc(s,'B1').recordedP,7);
});
test('pure codes, check marks and full-lane text never become quantities',()=>{
  const s=snapshot(matrix('DEMO-CARGO-001','✓','满线'));assert.equal(s.summary.knownP,0);assert.equal(s.entries.length,3);
  assert.ok(s.entries.every(x=>x.physicalP===null));assert.equal(s.complete,true);
});
test('unlabelled bare positive number stays unknown',()=>{
  const s=snapshot(matrix('18020'));assert.equal(entries(s,'A1')[0].physicalP,null);assert.equal(s.summary.knownP,0);
});
test('unit-only value retains quantity and missing-cargo issue',()=>{
  const s=snapshot(matrix('5P'));assert.equal(entries(s,'A1')[0].physicalP,5);assert.ok(s.issues.some(x=>x.code==='CARGO_UNKNOWN'));
});
test('two clearly paired items in one cell parse without splitting internal slash',()=>{
  const s=snapshot(matrix('SHIP/A 3P；TEB4 2P'));assert.equal(entries(s,'A1').length,2);assert.equal(loc(s,'A1').recordedP,5);
  assert.deepEqual(entries(s,'A1').map(x=>x.cargoKey),['SHIP/A','TEB4']);
});
test('ambiguous sum and dangling label are not silently partially counted',()=>{
  for(const raw of ['ABE8 3P+2P','ABE8 3P AVP1']){const s=snapshot(matrix(raw));assert.equal(s.summary.knownP,0);assert.equal(entries(s,'A1')[0].physicalP,null);}
});
test('negative and fractional pallet counts stay unknown',()=>{
  for(const raw of ['ABE8 -2P','ABE8 2.5P']){const s=snapshot(matrix(raw));assert.equal(s.summary.knownP,0);assert.ok(s.issues.some(x=>x.code==='INVALID_QUANTITY'));}
});
test('thousands, fractions and P-ending cargo tokens cannot be misread as short numeric suffixes',()=>{
  for(const raw of ['ABE8 1,000P','ABE8 1/2P','ABC123P','ABE8 1.2.3P']){const s=snapshot(matrix(raw));assert.equal(s.summary.knownP,0);assert.ok(s.issues.some(x=>x.code==='QUANTITY_TOKEN_AMBIGUOUS'));}
});
test('formula errors stay local unknowns while successful other positions remain visible',()=>{
  const s=snapshot(matrix('#REF!','ABE8 5P'));
  assert.equal(s.complete,true);assert.equal(loc(s,'A1').recordedP,null);assert.equal(loc(s,'A2').recordedP,5);
  assert.ok(s.issues.some(x=>x.code==='FORMULA_ERROR'));
});
test('CellData error metadata wins over a stale formatted number',()=>{
  const rows=matrix({formattedValue:'ABE8 9P',effectiveValue:{errorValue:{type:'REF',message:'Bad'}}});
  const s=snapshot(rows);assert.equal(s.summary.knownP,0);assert.equal(s.complete,true);
});
test('notes are retained but never parsed as an alternative inventory amount',()=>{
  const s=C.parseSnapshot({rows:matrix('ABE8 2P'),notes:{C2:'昨天还有 99P'}});
  assert.equal(s.summary.knownP,2);assert.deepEqual(entries(s,'A1')[0].notes,['昨天还有 99P']);
});
test('blank upper region does not mask populated lower view of the same physical location',()=>{
  const rows=matrix();rows.push(['私仓','','1','2','3'],['','A','SHIP-1 7P'],[]);
  const s=snapshot(rows);assert.equal(loc(s,'A1').recordedP,7);assert.equal(s.summary.locationCount,3);assert.equal(s.summary.knownP,7);
});
test('identical populated duplicate views are counted once and retain both sources',()=>{
  const rows=matrix('ABE8 7P');rows.push(['私仓','','1','2','3'],['','A','ABE8 7P'],[]);
  const s=snapshot(rows);assert.equal(s.summary.knownP,7);assert.deepEqual(entries(s,'A1')[0].sourceCells,['C2','C5']);
  assert.ok(s.issues.some(x=>x.code==='DUPLICATE_LOCATION_VIEW'));
});
test('different cargo across two views shares one location and receives a review flag',()=>{
  const rows=matrix('ABE8 7P');rows.push(['私仓','','1','2','3'],['','A','SHIP-2 4P'],[]);
  const s=snapshot(rows);assert.equal(loc(s,'A1').recordedP,11);assert.equal(s.summary.locationCount,3);assert.equal(entries(s,'A1').length,2);
  assert.ok(s.issues.some(x=>x.code==='MULTIPLE_LOCATION_SECTIONS'));
});
test('same cargo with contradictory quantities across views is unknown, not summed',()=>{
  const rows=matrix('ABE8 7P');rows.push(['私仓','','1','2','3'],['','A','ABE8 4P'],[]);
  const s=snapshot(rows);assert.equal(entries(s,'A1')[0].physicalP,null);assert.equal(loc(s,'A1').recordedP,null);assert.equal(s.summary.knownP,0);
  assert.ok(s.issues.some(x=>x.code==='LOCATION_QUANTITY_CONFLICT'));
});
test('empty and populated representations cannot claim a confirmed location balance',()=>{
  const rows=matrix('空');rows.push(['私仓','','1','2','3'],['','A','ABE8 4P'],[]);
  const s=snapshot(rows);assert.equal(loc(s,'A1').quantityKnown,false);assert.equal(loc(s,'A1').status,'conflict');assert.equal(loc(s,'A1').recordedP,null);
  assert.equal(s.summary.knownP,0);assert.equal(entries(s,'A1')[0].physicalP,null);assert.equal(entries(s,'A1')[0].reportedP,4);
});
test('empty and populated rows within one section also exclude the conflicted amount',()=>{
  const rows=[['私仓','','1','2','3'],['','M','REF 5P'],['','','空']];
  const s=snapshot(rows);assert.equal(s.complete,true);assert.equal(loc(s,'M1').status,'conflict');
  assert.equal(loc(s,'M1').reportedP,5);assert.equal(loc(s,'M1').knownP,0);assert.equal(s.summary.knownP,0);
  assert.equal(entries(s,'M1')[0].physicalP,null);assert.equal(entries(s,'M1')[0].reportedP,5);
});
test('multiple detail rows aggregate by cargo and do not duplicate physical capacity',()=>{
  const rows=[['私仓','','1','2','3'],['','M','REF 3P'],['','','REF 4P'],['','','OTHER 2P']];
  const s=snapshot(rows);assert.equal(loc(s,'M1').recordedP,9);assert.equal(entries(s,'M1').length,2);assert.equal(entries(s,'M1').find(x=>x.cargoKey==='REF').physicalP,7);
});
test('source location inserted rows and shifted source coordinates preserve semantic identity',()=>{
  const before=C.parseSnapshot(fixture),changed=copy(fixture);changed.rows.splice(0,0,[],[]);changed.rows.splice(11,0,[]);
  const after=C.parseSnapshot(changed),diff=C.diffSnapshots(before,after);
  assert.equal(after.complete,true);assert.equal(after.summary.knownP,33);assert.equal(after.semanticHash,before.semanticHash);assert.equal(diff.noOp,true);
});
test('sorting same-location detail rows is not a stock change',()=>{
  const before=C.parseSnapshot(fixture),changed=copy(fixture);[changed.rows[9][2],changed.rows[10][2]]=[changed.rows[10][2],changed.rows[9][2]];
  const after=C.parseSnapshot(changed);assert.equal(C.diffSnapshots(before,after).noOp,true);assert.equal(before.semanticHash,after.semanticHash);
});
test('quantity edit reports a table change with before/after and source cells',()=>{
  const a=snapshot(matrix('ABE8 5P')),b=snapshot(matrix('ABE8 8P')),d=C.diffSnapshots(a,b);
  assert.equal(d.changes.length,1);assert.equal(d.changes[0].type,'quantity_changed');assert.equal(d.changes[0].beforeP,5);assert.equal(d.changes[0].afterP,8);
  assert.equal(d.changes[0].meaning,'table_record_change');assert.match(d.changes[0].message,/原因未注明/);
});
test('cleared entry has null after amount, never an inferred outflow or zero',()=>{
  const d=C.diffSnapshots(snapshot(matrix('ABE8 5P')),snapshot(matrix()));assert.equal(d.changes[0].type,'cleared');assert.equal(d.changes[0].afterP,null);assert.equal(d.changes[0].afterStatus,'unknown');
});
test('explicit empty is distinguishable from blank even when no cargo records exist',()=>{
  const d=C.diffSnapshots(snapshot(matrix()),snapshot(matrix('0')));assert.equal(d.changes.length,1);assert.equal(d.changes[0].type,'empty_confirmed');assert.equal(d.changes[0].afterP,0);
});
test('changing warehouse point is old-record clear plus new-record addition, not two inventory transactions',()=>{
  const d=C.diffSnapshots(snapshot(matrix('ABE8 5P')),snapshot(matrix('AVP1 5P')));assert.equal(d.changes.length,2);assert.deepEqual(d.changes.map(x=>x.type).sort(),['added','cleared']);assert.ok(d.changes.every(x=>x.meaning==='table_record_change'));
});
test('same cargo moved between locations remains table changes without asserting a completed move',()=>{
  const d=C.diffSnapshots(snapshot(matrix('ABE8 5P')),snapshot(matrix('','ABE8 5P')));assert.equal(d.changes.length,2);assert.ok(d.changes.every(x=>x.type!=='move'));
});
test('first successful read creates comparison baseline, never an intake ledger',()=>{
  const d=C.diffSnapshots(null,snapshot(matrix('ABE8 5P')));assert.equal(d.baseline,true);assert.equal(d.noOp,true);assert.deepEqual(d.changes,[]);
});
test('failed or incomplete source cannot replace a previous baseline',()=>{
  const a=snapshot(matrix('ABE8 5P')),bad=C.parseSnapshot({rows:matrix(),readComplete:false});assert.equal(bad.complete,false);
  const d=C.diffSnapshots(a,bad);assert.equal(d.ok,false);assert.equal(d.changes.length,0);
});
test('unrecognized structure is not a successful zero-stock snapshot',()=>{
  const s=snapshot([['ABE8 5P']]);assert.equal(s.ok,false);assert.equal(s.structuralValid,false);assert.equal(s.summary.recordedP,null);
});
test('unmapped apparent cargo produces a structural issue rather than silently missing quantity',()=>{
  const rows=matrix('ABE8 5P');rows[1][8]='AVP1 7P';const s=snapshot(rows);assert.equal(s.structuralValid,false);assert.ok(s.issues.some(x=>x.code==='UNMAPPED_CONTENT'&&x.severity==='error'));
});
test('capacity standard change changes planning reference only',()=>{
  const a=snapshot(matrix('ABE8 30P')),rows=matrix('ABE8 30P');rows[0][1]='20P/lane';const b=snapshot(rows),d=C.diffSnapshots(a,b);
  assert.equal(b.summary.knownP,30);assert.ok(!b.issues.some(x=>/超容|超出/.test(x.message)));assert.equal(d.changes[0].type,'capacity_reference_changed');
});
test('G10 and G11 remain unavailable without inventing zero or rejecting explicit data',()=>{
  const rows=[['','27P/lane','9','10','11'],['','G','','ABE8 1P','']];const s=snapshot(rows);
  assert.equal(loc(s,'G10').available,false);assert.equal(loc(s,'G11').recordedP,null);assert.equal(loc(s,'G10').recordedP,1);assert.ok(s.issues.some(x=>x.code==='UNAVAILABLE_LOCATION_RECORD'));
});
test('duplicate literal detail rows preserve table-record count while flagging possible duplication',()=>{
  const rows=[['私仓','','1','2','3'],['','M','REF 3P'],['','','REF 3P']];const s=snapshot(rows);
  assert.equal(loc(s,'M1').recordedP,6);assert.ok(s.issues.some(x=>x.code==='POSSIBLE_DUPLICATE_ROW'));
});
test('input formulas and source notes are immutable through read and compare',()=>{
  const rows=matrix({formattedValue:'ABE8 4P',userEnteredValue:{formulaValue:'="ABE8 4P"'},note:'original'}),before=copy(rows);
  const a=snapshot(rows);C.diffSnapshots(a,a);assert.deepEqual(rows,before);assert.deepEqual(a.entries[0].notes,['original']);
});
