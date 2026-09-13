'use strict';
// tools/seed_20k.js — Fast bulk seeder for Step 5b using repository.saveMany
const config = require('../src/config');
const { repository } = require('../src/messages/repository');
const pool = require('../src/db/pool');

async function seed() {
  console.log('Connecting to repository...');
  await repository.init();
  
  const TOTAL = 20000;
  const BATCH_SIZE = 1000;
  const roomId = config.LAB_ROOM || 'feed';
  
  console.log(`Seeding ${TOTAL} messages in batches of ${BATCH_SIZE}...`);
  const t0 = Date.now();
  
  let inserted = 0;
  for (let b = 0; b < TOTAL; b += BATCH_SIZE) {
    const batch = [];
    const batchStart = b;
    const batchEnd = Math.min(b + BATCH_SIZE, TOTAL);
    for (let i = batchStart; i < batchEnd; i++) {
      batch.push({
        id: `seed_msg_${i}`,
        from: `user_${i % 100}`,
        fromId: `u_${i % 100}`,
        colour: 100,
        text: `Message payload #${i} for 20k cold cache verification`,
        ts: Date.now() - (TOTAL - i) * 10,
      });
    }
    await repository.saveMany(roomId, batch);
    inserted += batch.length;
    process.stdout.write(`\rInserted ${inserted}/${TOTAL} messages...`);
  }
  
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`\nDone in ${elapsed.toFixed(2)}s (${(TOTAL / elapsed).toFixed(0)} msg/s)`);
  
  await pool.close();
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
