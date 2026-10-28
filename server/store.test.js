import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCampaignStore } from './store.js';
import { createPendingEntry, markEntryPaid, paidEntries } from './campaign.js';

function temporaryDataFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'detty-store-'));
  return {
    directory,
    dataFile: path.join(directory, 'campaign.json'),
  };
}

test('JSON store rolls back failed mutations and persists committed entries', async () => {
  const { directory, dataFile } = temporaryDataFile();
  const store = await createCampaignStore({ dataFile, paymentMode: 'live', connectionString: null });
  await assert.rejects(store.transact((state) => {
    createPendingEntry(state, '0712345678');
    throw new Error('force rollback');
  }), /force rollback/);
  assert.equal((await store.read()).entries.length, 0);

  const entry = await store.transact((state) => {
    const pending = createPendingEntry(state, '0712345678');
    return markEntryPaid(state, pending.id, { paymentReference: 'TEST-PAID' });
  });
  assert.equal(entry.entryNumber, 1);
  await store.close();

  const reopened = await createCampaignStore({ dataFile, paymentMode: 'live', connectionString: null });
  assert.equal((await reopened.read()).entries[0].paymentReference, 'TEST-PAID');
  await reopened.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('JSON store serializes concurrent payment allocations', async () => {
  const { directory, dataFile } = temporaryDataFile();
  const store = await createCampaignStore({ dataFile, paymentMode: 'live', connectionString: null });
  const entries = await Promise.all(Array.from({ length: 5 }, (_, index) => store.transact((state) => {
    const phone = `07${String(10000000 + index)}`;
    const pending = createPendingEntry(state, phone);
    return markEntryPaid(state, pending.id, { paymentReference: `TEST-${index}` });
  })));
  assert.deepEqual(entries.map((entry) => entry.entryNumber).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(paidEntries(await store.read()).length, 5);
  await store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
