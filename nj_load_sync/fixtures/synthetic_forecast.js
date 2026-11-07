'use strict';
// Generated examples only: no exported workbook or customer data is embedded.
module.exports = function syntheticForecast(seeds) {
  function forecast(title, count, emptyLast) {
    const ids = Array.from({length:count}, (_, i) => i < seeds.length ? seeds[i].containerNo : String(60000 + i));
    if (emptyLast) ids[ids.length - 1] = '69999';
    const carrier = ids.map(() => 'EXAMPLE CARRIER');
    const values = [
      ['总计', '', count], ['', '台口', ...carrier], ['', '柜号', ...ids],
      ['', 'WH01', ...ids.map((_, i) => emptyLast && i === count - 1 ? '' : i % 7 + 1)],
      ['', 'WH02', ...ids.map((_, i) => emptyLast && i === count - 1 ? '' : i % 3)]
    ];
    return {title, values};
  }
  const mapRows = Array.from({length:16}, () => []);
  mapRows[5] = ['海柜状态', '已到', '在拆', '已到', '未到', '拆空', '未到'];
  mapRows[14] = ['柜号', ...seeds.map(s => s.containerNo), '88888'];
  return {capturedAt:'2026-10-30', forecasts:[forecast('10/30/26拆柜预报',5,false),forecast('11/2/26当周拆柜预报',31,false),forecast('11月拆柜预报',78,true)],map:{title:'10/30',values:mapRows}};
};
