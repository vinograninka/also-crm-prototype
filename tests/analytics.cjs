const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

// Exercise the actual standalone application logic; browser actions are checked separately.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new Function(script);
function app(stored) {
  const storage = new Map(stored ? [['also-crm-review-20261103-v1', JSON.stringify(stored)]] : []);
  const context = vm.createContext({
    Intl, Date, Math, Map, Set, Number, Array, Object, JSON, String, Boolean, URL, Blob,
    console, setTimeout() {}, clearTimeout() {}, window: {},
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    document: { addEventListener() {}, querySelectorAll() { return []; } }
  });
  vm.runInContext(script.slice(0, script.indexOf('  let initialDesign=')), context);
  return {
    run: code => vm.runInContext(code, context),
    json: code => JSON.parse(vm.runInContext('JSON.stringify(' + code + ')', context)),
    storage
  };
}
let checks = 0;
function equal(actual, expected) { assert.deepEqual(actual, expected); checks++; }
const a = app();
equal(a.run('data.version'), 4);
equal(a.run('data.deals.filter(d=>d.analyticsExample).length'), 7);
equal(a.run('boardDeals().some(d=>d.archived)'), false);
a.run("const archivedExample=data.deals.find(d=>d.analyticsExample);archivedExample.messages=[{side:'in',text:'Архивный диалог',time:'10:00'}]");
equal(a.run('conversations().some(d=>d.archived)'),false);
equal(a.run("activeDeal({archived:true,stage:'work'})"),false);
const initialCount = a.run('data.deals.length');
equal(a.run('migrateData(data).deals.length'), initialCount);
equal(a.run('migrateData(data).deals.length'), initialCount);

// Known two-order scenario: one sale predates the cohort, one is paid in two instalments.
a.run(`
  data={version:4,analyticsSeedVersion:1,clients:[
    {id:1,name:'Первый',segment:'new',discount:0,tags:[]},
    {id:2,name:'Второй',segment:'vip',discount:0,tags:[]},
    {id:3,name:'Сотрудник',segment:'vip',service:true,tags:['employee']}
  ],deals:[],documents:[],chatLabels:[],role:'owner'};
  const makeItem=(id,qty)=>{const p=PRODUCT_CATALOG.find(p=>p.id===id);return {productId:p.id,name:p.name,unit:p.unit,unitPrice:p.price,qty};};
  const one=deal(901,1,'invoice',94500,0,'initial','Проект 1','production','telegram','2026-10-31');
  one.invoiceItems=[makeItem('catalog',2),makeItem('video',1)];one.baseAmount=105000;one.discountPercent=10;one.payments=[];
  const two=deal(902,2,'invoice',60000,0,'repeat','Проект 2','production','telegram','2026-11-01');
  two.invoiceItems=[makeItem('lookbook',1)];two.payments=[];
  const three=deal(903,1,'work',45000,0,'initial','Ещё не продано','production','telegram','2026-11-02');
  three.invoiceItems=[makeItem('catalog',1)];three.payments=[];
  data.deals.push(one,two,three);
`);
equal(a.run("addConfirmedPayment(getDeal(901),47250,'2026-11-01','Счёт')"), '');
equal(a.run("addConfirmedPayment(getDeal(901),47250,'2026-11-02','Счёт')"), '');
equal(a.run("addConfirmedPayment(getDeal(902),30000,'2026-11-01','Счёт')"), '');
equal(a.run("addConfirmedPayment(getDeal(902),30000,'2026-11-03','Счёт')"), '');
equal(a.run("applyAnalyticsRange('2026-11-01','2026-11-01','all','custom')"), '');
equal(a.json('({sales:analyticsData().sales.length,leads:analyticsData().leads.length,paid:analyticsData().paid,cohort:analyticsData().cohortSales.length})'),
  { sales: 2, leads: 1, paid: 77250, cohort: 1 });
equal(a.json("tariffStats(analyticsData()).map(r=>[r.id,r.quantity,r.orders.size,r.amount])"), [
  ['catalog', 2, 1, 81000], ['lookbook', 1, 1, 60000], ['video', 1, 1, 13500], ['retouch', 0, 0, 0], ['studio', 0, 0, 0]
]);
// Inclusive endpoints, cash from the earlier order, and cohort conversion are different quantities.
a.run("applyAnalyticsRange('2026-11-01','2026-11-02','all','custom')");
equal(a.json('({sales:analyticsData().sales.length,leads:analyticsData().leads.length,paid:analyticsData().paid,cohort:analyticsData().cohortSales.length})'),
  { sales: 2, leads: 2, paid: 124500, cohort: 1 });
a.run("applyAnalyticsRange('2026-11-03','2026-11-03','all','custom')");
equal(a.json('({sales:analyticsData().sales.length,paid:analyticsData().paid})'), { sales: 0, paid: 30000 });
// A selected tariff filters whole orders for cash; quantities/value only include matching lines.
a.run("applyAnalyticsRange('2026-11-01','2026-11-03','video','custom')");
equal(a.json('({sales:analyticsData().sales.length,paid:analyticsData().paid,leads:analyticsData().leads.length})'), { sales: 1, paid: 94500, leads: 0 });
equal(a.json('tariffStats(analyticsData()).map(r=>[r.id,r.quantity,r.orders.size,r.amount])'), [['video', 1, 1, 13500]]);
equal(a.run("matchesTariff(getDeal(903),'catalog')"), true);
equal(a.run('getDeal(903).saleSnapshot===undefined'), true);
// Historical sale prices/quantities are frozen when invoice/catalog/client terms change later.
const snapshot = a.json('getDeal(901).saleSnapshot');
a.run("client(1).discount=75;getDeal(901).invoiceItems=[makeItem('studio',10)];PRODUCT_CATALOG.find(p=>p.id==='video').price=999999");
equal(a.json('getDeal(901).saleSnapshot'), snapshot);
equal(a.json('tariffStats(analyticsData()).map(r=>[r.quantity,r.amount])'), [[1, 13500]]);
// Employee, spam, and internal threads cannot leak into sales, receipts, or tariff counts.
a.run(`
  for (const [id,cid,flag] of [[904,3,'employee'],[905,1,'spam'],[906,1,'serviceThread']]) {
    const d=deal(id,cid,'invoice',15000,0,'initial','Исключённый','production','telegram','2026-11-01');
    d.invoiceItems=[{productId:'video',name:'Видео',unit:'ролик',unitPrice:15000,qty:1}];d.payments=[];
    if(flag!=='employee')d[flag]=true;data.deals.push(d);addConfirmedPayment(d,15000,'2026-11-01','Демо');
  }
`);
equal(a.json('({sales:analyticsData().sales.length,paid:analyticsData().paid})'), { sales: 1, paid: 94500 });
// The actual export must use the same applied range and selected tariff.
a.run("downloadFile=function(name,text){globalThis.savedCSV={name,text};};toast=function(){};exportAnalytics()");
equal(a.run("savedCSV.name.includes('2026-11-01_2026-11-03-video')"), true);
equal(a.run("savedCSV.text.includes('13500')&&savedCSV.text.includes('94500')"), true);
equal(a.run("savedCSV.text.includes('Съёмка лукбука')"), false);
equal(a.run("savedCSV.text.includes('2026-11-03')&&savedCSV.text.includes('Короткое видео для соцсетей')"), true);
// Invalid ranges don't silently reset or change the already applied report.
const previousRange = a.json('analyticsRange()');
equal(a.run("applyAnalyticsRange('2026-11-03','2026-11-01','all')").length > 0, true);
equal(a.run("applyAnalyticsRange('2025-02-29','2026-11-01','all')").length > 0, true);
equal(a.run("applyAnalyticsRange('','2026-11-01','all')").length > 0, true);
equal(a.json('analyticsRange()'), previousRange);
equal(a.run("validReportDate('2024-02-29')"), true);
equal(a.json("analyticsPreset('two')"), { start: '2026-11-02', end: '2026-11-03' });
equal(a.json("analyticsPreset('week')"), { start: '2026-10-28', end: '2026-11-03' });
equal(a.json("analyticsPreset('year')"), { start: '2026-01-01', end: '2026-11-03' });
for (const [start,end] of [
  ['2024-02-28','2024-03-01'],['2025-12-31','2026-01-01'],['2026-03-20','2026-05-03'],
  ['2026-01-01','2026-12-31'],['2025-01-31','2026-01-31'],['2000-01-01','2026-11-03'],['0001-01-01','9999-12-31']
]) {
  const buckets=a.json(`analyticsBuckets('${start}','${end}')`).items;
  equal(buckets[0].start,start);equal(buckets.at(-1).end,end);equal(buckets.length<=24,true);
  for(let i=1;i<buckets.length;i++)equal(a.run(`shiftReportDate('${buckets[i-1].end}',1)`),buckets[i].start);
}
a.run("applyAnalyticsRange('2025-01-01','2025-01-01','all','custom')");
equal(a.json('({sales:analyticsData().sales.length,leads:analyticsData().leads.length,paid:analyticsData().paid})'), { sales: 0, leads: 0, paid: 0 });
equal(a.run("addConfirmedPayment(getDeal(903),45000,'2026-11-04','Счёт')").length>0,true);
equal(a.run("addConfirmedPayment(getDeal(903),45000,'2026-11-01','Счёт')").length>0,true);
equal(a.run("addConfirmedPayment(getDeal(903),45001,'2026-11-03','Счёт')").length>0,true);
equal(a.run("addConfirmedPayment(getDeal(903),45000,'2026-11-03','Счёт')"),'');
equal(a.run("addConfirmedPayment(getDeal(903),1,'2026-11-03','Счёт')").length>0,true);
// A tiny discounted total across several lines cannot produce a negative remainder.
a.run("const roundingOrder={project:'Округление',amount:3,discountPercent:99.9,invoiceItems:Array.from({length:6},()=>({productId:'retouch',name:'Ретушь',unitPrice:500,unit:'кадр',qty:1}))};const roundedSale=captureSale(roundingOrder,'2026-11-03')");
equal(a.run('roundedSale.items.every(item=>item.netAmount>=0)'),true);
equal(a.run('roundedSale.items.reduce((sum,item)=>sum+item.netAmount,0)'),3);
equal(a.run('Math.max(...roundedSale.items.map(item=>item.netAmount))'),1);
// Legacy version-3 migration: no guessed tariff IDs; existing saved documents stay byte-equivalent.
const legacy={version:3,role:'owner',analyticsSeedVersion:1,chatLabels:[],clients:[{id:1,name:'Сохранённый клиент',segment:'vip',discount:10,tags:[]}],deals:[
  {id:1,clientId:1,created:'2026-11-01',stage:'paid',project:'Сохранённый проект',amount:60000,paid:30000,paidOn:'2026-11-02',invoiceItems:[{productId:'lookbook',name:'Старое имя тарифа',unitPrice:60000,unit:'пакет',qty:1}],history:[],messages:[],tasks:[]},
  {id:2,clientId:1,created:'2026-11-01',stage:'paid',project:'Каталожная фотосъёмка',amount:45000,paid:45000,paidOn:'2026-11-03',history:[],messages:[],tasks:[]}
],documents:[{id:1,type:'invoice',dealId:1,pricing:{base:60000,total:60000,percent:0,discount:0,items:[{productId:'lookbook',name:'Старое имя тарифа',unitPrice:60000,unit:'пакет',qty:1}]}}]};
const migrated=app(legacy);
equal(migrated.run('data.version'),4);
equal(migrated.json('data.documents'),legacy.documents);
equal(migrated.run('getDeal(1).paid'),30000);
equal(migrated.run('getDeal(1).project'),'Сохранённый проект');
equal(migrated.run("getDeal(1).payments[0].source"),'legacy-summary');
equal(migrated.run("matchesTariff(getDeal(1),'lookbook')"),true);
equal(migrated.run("matchesTariff(getDeal(2),'unassigned')"),true);
equal(migrated.run("matchesTariff(getDeal(2),'catalog')"),false);
const docSnapshot=migrated.json('data.documents');
migrated.run('migrateData(data);migrateData(data)');
equal(migrated.json('data.documents'),docSnapshot);
console.log(`PASS: ${checks} checks for ranges, boundaries, tariff counts, first payments, instalments, immutable sale snapshots, exclusions, CSV, archive and v3 migration.`);
