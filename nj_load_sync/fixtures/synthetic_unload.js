'use strict';
// All identifiers and amounts are deterministic public-test examples.
const seeds = [
  {taskId:'FCH260101-01',containerNo:'DEMU1001004',aliases:['#90004','90004','FCH260101-01','DEMU1001004','1-01']},
  {taskId:'DEMU1001001',containerNo:'DEMU1001001',aliases:['01001','DEMU1001001']},
  {taskId:'DEMU1001005',containerNo:'DEMU1001005',aliases:['01005','DEMU1001005']},
  {taskId:'DEMU1001003',containerNo:'DEMU1001003',aliases:['01003','DEMU1001003']},
  {taskId:'DEMU1001002',containerNo:'DEMU1001002',aliases:['01002','DEMU1001002']}
];
function buildLargePlan(tasks) {
  const locations=[];
  for (const area of ['A','B','C','D','E','F','G','S','T','V','W','X','Y','Z','M']) for(let n=1;n<=11;n++) if(!['G10','G11'].includes(area+n)) locations.push(area+n);
  const used=locations.slice(0,159).concat('检查区');
  const inventory=used.map((location,i)=>({inventoryId:'EXAMPLE-BASE-'+i,location,destination:'WH'+String(i%8+1).padStart(2,'0'),shipmentId:'',physicalP:0,occupiedSlots:0,slotBasis:'one_per_pallet',capacitySlots:location==='检查区'?70:27}));
  const capacity=[['库位','收工状态','已知实物板数','图示容量','图示可用板位','保守参考余位','说明'],...inventory.map(r=>[r.location,'空位',0,r.capacitySlots,r.capacitySlots,r.capacitySlots,'合成示例'])];
  const groups=Array.from({length:54},(_,index)=>{
    const task=tasks[index%tasks.length],inspection=index<11,qty=inspection?(index<10?4:3):(index<23?4:3);
    return {group_key:'EXAMPLE-GROUP-'+String(index+1).padStart(3,'0'),task_reference:task.taskId,container_no:task.containerNo,destination:'WH'+String(index%8+1).padStart(2,'0'),ticket_type:inspection?'示例特殊票':'',allocations:[{location:inspection?'检查区':used[index-11],qty}]};
  });
  return {inventory,capacity,published:{plan_id:'EXAMPLE-LARGE-PLAN',groups}};
}
module.exports={seeds,buildLargePlan};
