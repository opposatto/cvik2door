// small test script to stress-save the data file concurrently
const { saveData, createOrder, DATA_FILE, __waitForSaves } = require('./index.js');
const fs = require('fs');

async function run() {
  console.log('Starting save stress test');
  // make many quick updates
  for (let i = 0; i < 20; i++) {
    createOrder({ customer_name: `tester-${i}`, items: `item ${i}` });
  }
  // fire many saves in parallel
  const saves = [];
  for (let i = 0; i < 50; i++) {
    saves.push(new Promise((res) => { saveData(); setTimeout(res, Math.random() * 100); }));
  }
  await Promise.all(saves);
  // wait for internal queue to finish
  await __waitForSaves();
  console.log('Saves completed. data.json size:', fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE).size : '(missing)');
}

run().catch(e => { console.error('Test failed', e); process.exit(1); });
