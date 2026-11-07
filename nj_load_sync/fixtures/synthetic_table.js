'use strict';
// Generated entirely from invented cargo. This is a layout regression specimen,
// not a warehouse export; no customer rows or production identifiers are used.
const rows = Array.from({length: 21}, () => []);
rows[0] = ['', '27P/lane', ...Array.from({length:11}, (_,i)=>i+1), '', '10P/lane', 1, 2, 3];
rows[1][1]='A'; rows[1][14]='S';
rows[3][1]='G'; rows[3][14]='T';
rows[5][1]='F'; rows[5][14]='V';
rows[7]=['私仓','',11,12,13];
rows[8]=['','M','DEMO-M-001 7P','DEMO-M-004 2P'];
rows[9]=['','','DEMO-M-002 1P'];
rows[10]=['','','DEMO-M-003 1P'];
rows[12]=['','A',...Array.from({length:10},(_,i)=>i+1)];
rows[13][8]='DEMO-A-001 7P';
rows[15]=['','B',4,5,6];
rows[16][4]='DEMO-B-001/002 15P';
rows[18]=['8P/lane',1,2,3];
rows[19]=['S'];
module.exports={capturedAt:'2026-11-07T00:00:00Z',sourceSheetId:101,sourceSheetName:'Demo inventory',rows:rows.map(row=>Array.from({length:row.length},(_,i)=>row[i]??''))};
