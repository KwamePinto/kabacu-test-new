require('dotenv').config();
const mongoose = require('mongoose');
const Transaction = require('../server/models/TransactionModel');
const { fetchDataTransactions } = require('../server/services/ourdatastore');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function check() {
  await mongoose.connect(process.env.MONGO_URI);

  // 1. Show sample Kabacu phone fields
  const txns = await Transaction.find({
    paymentMethod: 'wallet',
    status: 'success',
    phone: { $exists: true, $ne: '' }
  }).sort({ createdAt: -1 }).limit(5).lean();

  console.log('Sample Kabacu success phone numbers (raw):');
  txns.forEach(t => console.log(' ', JSON.stringify(t.phone), '|', new Date(t.createdAt).toISOString()));

  // 2. Show sample ODS records
  const result = await fetchDataTransactions({ page: 1, status: 'ALL', perPage: 10 });
  console.log('\nSample ODS records (plan_phone | plan_date | plan_status):');
  (result.data || []).slice(0, 10).forEach(r =>
    console.log(' ', JSON.stringify(r.plan_phone), '|', r.plan_date, '|', r.plan_status)
  );

  // 3. Search ODS for a specific suspicious phone (no time constraint)
  const suspPhone = '09138850617';
  const norm = p => String(p || '').replace(/\D/g, '').replace(/^234/, '0');

  console.log('\nSearching ALL ODS pages for phone', suspPhone, '...');
  let found = [];
  const ODS_OFFSET_MS = 60 * 60 * 1000;
  const THREE_WEEKS_AGO = new Date(Date.now() - 22 * 24 * 60 * 60 * 1000);

  for (let page = 1; page <= 35; page++) {
    const r = await fetchDataTransactions({ page, status: 'ALL', perPage: 100 });
    const rows = r.data || [];
    if (!rows.length) { console.log('  Empty page', page, '— stopping'); break; }

    rows.forEach(row => {
      if (norm(row.plan_phone) === norm(suspPhone)) found.push(row);
    });

    const oldest = rows[rows.length - 1];
    if (oldest && oldest.plan_date) {
      const oldestUtc = new Date(new Date(oldest.plan_date).getTime() - ODS_OFFSET_MS);
      if (oldestUtc < THREE_WEEKS_AGO) {
        console.log('  Reached 3-week cutoff at page', page);
        break;
      }
    }
    await sleep(500);
  }

  if (found.length === 0) {
    console.log('  NOT found in ODS — this phone has no record there');
  } else {
    console.log('  Found', found.length, 'ODS record(s):');
    found.forEach(m => console.log('   plan_phone:', m.plan_phone, '| plan_date:', m.plan_date, '| plan_status:', m.plan_status));
  }

  // 4. Also check one of the MATCHED phones to confirm ODS lookup works
  const matchedPhone = '08161160013';
  console.log('\nVerifying a KNOWN MATCHED phone', matchedPhone, 'is findable in ODS...');
  let matchFound = [];
  for (let page = 1; page <= 5; page++) {
    const r = await fetchDataTransactions({ page, status: 'ALL', perPage: 100 });
    const rows = r.data || [];
    rows.forEach(row => {
      if (norm(row.plan_phone) === norm(matchedPhone)) matchFound.push(row);
    });
    await sleep(500);
  }
  console.log('  Found', matchFound.length, 'records for matched phone (expected ≥ 1)');
  matchFound.slice(0, 3).forEach(m => console.log('   plan_phone:', m.plan_phone, '| plan_date:', m.plan_date));

  process.exit(0);
}

check().catch(e => { console.error(e.message, e.stack); process.exit(1); });
