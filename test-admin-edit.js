const fs = require('fs');
const path = require('path');
const { createOrder, DATA_FILE, __waitForSaves, orders } = require('./index.js');

async function run() {
  console.log('Starting admin edit test');
  const o = createOrder({ customer_name: 'admin-edit-tester', items: 'test' });
  console.log('Created order', o.order_id);
  // simulate admin setting total and given cash via helper
  // find order reference in memory
  const ord = orders.find(x => x.order_id === o.order_id);
  if (!ord) { console.error('Order not found in memory'); process.exit(2); }
  // set total_amount and given_cash
  ord.total_amount = 12.5;
  ord.given_cash = 20;
  ord.change_cash = ord.given_cash - ord.total_amount;
  // save
  const { saveData } = require('./index.js');
  saveData();
  await __waitForSaves();
  // read data file
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const saved = obj.orders.find(x => x.order_id === o.order_id);
    if (!saved) { console.error('Saved order not found'); process.exit(3); }
    if (saved.total_amount === 12.5 && saved.given_cash === 20 && saved.change_cash === 7.5) {
      console.log('PASS: admin edit saved correctly');
      process.exit(0);
    }
    console.error('FAIL: saved values mismatch', saved.total_amount, saved.given_cash, saved.change_cash);
    process.exit(4);
  } catch (e) { console.error('Failed read data file', e && e.message); process.exit(5); }
}

run();
