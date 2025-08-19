const fs = require('fs');
const path = require('path');
const { createOrder, DATA_FILE, __waitForSaves, loadData, orders, qrCodes } = require('./index');

function readData() {
  if (!fs.existsSync(DATA_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { return null; }
}

async function testPersistence() {
  console.log('Test: persistence of orderCounter');
  const before = readData() && readData().orderCounter;
  const o = createOrder({ customer_name: 'suite-tester', items: 'x' });
  await __waitForSaves();
  const after = readData() && readData().orderCounter;
  console.log('before -> after', before, '->', after);
  return (typeof before !== 'number' || (typeof after === 'number' && after >= (before || 0) + 1));
}

async function testBackupFallback() {
  console.log('Test: loadData fallback to .bak');
  // make sure there's a fresh snapshot
  const bakData = { orders: [{ order_id: 999999, customer_name: 'bak-test' }], orderCounter: 999999, qrCodes: [] };
  const bak = DATA_FILE + '.bak';
  fs.writeFileSync(bak, JSON.stringify(bakData, null, 2), 'utf8');
  // corrupt primary
  fs.writeFileSync(DATA_FILE, '{ this is: not valid json', 'utf8');
  // call loadData which should read bak and populate in-memory arrays
  try { loadData(); } catch (e) { }
  // check in-memory orders (exported)
  const found = orders.find(o => o && Number(o.order_id) === 999999);
  // restore a sensible primary file
  fs.writeFileSync(DATA_FILE, JSON.stringify(bakData, null, 2), 'utf8');
  return !!found;
}

async function testQRsaveRestore() {
  console.log('Test: QR save and restore');
  const beforeCount = (readData() && readData().qrCodes && readData().qrCodes.length) || 0;
  // add a QR
  const id = `TST-${Date.now()}`;
  qrCodes.push({ id, code: id, enabled: true, media: { type: 'text', text: 'pay:'+id } });
  // persist
  const { saveData } = require('./index');
  saveData();
  await __waitForSaves();
  const after = readData();
  const found = after && after.qrCodes && after.qrCodes.find(q => q.id === id);
  // cleanup
  const idx = qrCodes.findIndex(q => q.id === id);
  if (idx !== -1) qrCodes.splice(idx,1);
  saveData(); await __waitForSaves();
  return !!found;
}

async function run() {
  const p1 = await testPersistence();
  console.log('persistence', p1 ? 'PASS' : 'FAIL');
  const p2 = await testBackupFallback();
  console.log('backup fallback', p2 ? 'PASS' : 'FAIL');
  const p3 = await testQRsaveRestore();
  console.log('qr save/restore', p3 ? 'PASS' : 'FAIL');
  if (p1 && p2 && p3) process.exit(0);
  process.exit(1);
}

run();
