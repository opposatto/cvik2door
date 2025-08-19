// Test that orderCounter persists to data.json after creating orders (moved to test/)
const fs = require('fs');
const path = require('path');
const { createOrder, DATA_FILE, __waitForSaves } = require('../index.js');

function readCounter() {
  if (!fs.existsSync(DATA_FILE)) return null;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return typeof obj.orderCounter === 'number' ? obj.orderCounter : null;
  } catch (e) {
    console.error('Failed to read data.json:', e && e.message);
    return null;
  }
}

async function run() {
  console.log('Starting orderCounter persistence test');
  const before = readCounter();
  console.log('orderCounter before:', before);

  // create one order
  const o = createOrder({ customer_name: 'persistence-tester', items: 'test' });
  console.log('Created order id', o.order_id);

  // wait for queued saves to finish
  await __waitForSaves();

  const after = readCounter();
  console.log('orderCounter after:', after);

  if (before === null) {
    if (typeof after === 'number') {
      console.log('PASS: data.json now has orderCounter =', after);
      process.exit(0);
    }
    console.error('FAIL: data.json has no orderCounter after save');
    process.exit(2);
  }

  if (typeof before === 'number' && typeof after === 'number' && after >= before + 1) {
    console.log('PASS: orderCounter persisted and incremented (before -> after):', before, '->', after);
    process.exit(0);
  }

  console.error('FAIL: orderCounter did not persist/increment as expected:', before, '->', after);
  process.exit(3);
}

run().catch(e => { console.error('Test error', e); process.exit(4); });
