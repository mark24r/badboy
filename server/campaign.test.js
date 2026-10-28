import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENESIS_HASH,
  MAX_ENTRIES_PER_PHONE,
  TOTAL_ENTRIES,
  TOTAL_WINNERS,
  campaignStats,
  computeCommitment,
  computeResultHash,
  createCampaign,
  createPendingEntry,
  markEntryPaid,
  normalizePhone,
  playerEntry,
  publicCampaign,
  revealEntry,
} from './campaign.js';

function paidEntry(state, phone = '0712345678') {
  const pending = createPendingEntry(state, phone);
  return markEntryPaid(state, pending.id, { mpesaReceipt: 'TEST123' });
}

test('normalizes Kenyan mobile numbers and rejects invalid numbers', () => {
  assert.equal(normalizePhone('0712 345 678'), '254712345678');
  assert.equal(normalizePhone('+254 712 345 678'), '254712345678');
  assert.equal(normalizePhone('712345678'), '254712345678');
  assert.equal(normalizePhone('0112 345 678'), '254112345678');
  assert.throws(() => normalizePhone('1234'));
  assert.throws(() => normalizePhone('+44 7123 456789'));
});

test('creates a fixed, committed outcome pool', () => {
  const state = createCampaign();
  assert.equal(TOTAL_ENTRIES, 25);
  assert.equal(TOTAL_WINNERS, 5);
  assert.equal(state.pool.length, TOTAL_ENTRIES);
  assert.equal(state.pool.filter((outcome) => outcome === 'win').length, TOTAL_WINNERS);
  assert.match(state.commitment, /^[a-f0-9]{64}$/);
  assert.equal(computeCommitment(state), state.commitment);
  const first = state.pool[0];
  state.pool[0] = first === 'win' ? 'no-win' : 'win';
  assert.notEqual(computeCommitment(state), state.commitment);
});

test('demo commitment timestamp predates every seeded entry', () => {
  const state = createCampaign({ seedDemo: true, seedCount: 8 });
  const firstEntry = Math.min(...state.entries.map((entry) => Date.parse(entry.createdAt)));
  assert.ok(Date.parse(state.createdAt) < firstEntry);
  assert.equal(computeCommitment(state), state.commitment);
});

test('payment assigns a concealed outcome and spin reveals it exactly once', () => {
  const state = createCampaign();
  const entry = paidEntry(state);
  assert.equal(entry.entryNumber, 1);
  assert.equal(entry.receipt, 'DD-0001');
  assert.equal(entry.outcome, state.pool[0]);
  assert.equal(playerEntry(entry).outcome, null);

  const revealed = revealEntry(state, entry.id, '2026-10-28T12:00:00.000Z');
  assert.equal(revealed.previousHash, GENESIS_HASH);
  assert.equal(revealed.chainIndex, 0);
  assert.equal(revealed.resultHash, computeResultHash(revealed));
  assert.equal(playerEntry(revealed).outcome, state.pool[0]);
  assert.equal(state.ledgerHead, revealed.resultHash);
  assert.equal(state.ledgerLength, 1);

  const repeated = revealEntry(state, entry.id, '2026-10-28T13:00:00.000Z');
  assert.equal(repeated.resultHash, revealed.resultHash);
  assert.equal(repeated.spunAt, revealed.spunAt);
  assert.equal(state.ledgerLength, 1);
});

test('public data masks phones and never exposes the secret pool', () => {
  const state = createCampaign();
  const entry = paidEntry(state);
  revealEntry(state, entry.id);
  const publicData = publicCampaign(state);
  assert.equal(publicData.ledger[0].phone, '+254 7•• ••• 678');
  assert.equal('pool' in publicData, false);
  assert.equal('poolSalt' in publicData, false);
  assert.equal(publicData.startingOdds, '1 in 5');
  assert.equal(publicData.ledgerLength, 1);
});

test('enforces the per-phone entry limit', () => {
  const state = createCampaign();
  for (let index = 0; index < MAX_ENTRIES_PER_PHONE; index += 1) paidEntry(state);
  assert.throws(() => createPendingEntry(state, '0712345678'), /entry limit/);
});

test('closes when all prizes are allocated and reveals only after paid spins complete', () => {
  const state = createCampaign();
  let index = 0;
  while (state.acceptingEntries) {
    const phone = `2547${String(20000000 + index).padStart(8, '0')}`;
    const entry = paidEntry(state, phone);
    revealEntry(state, entry.id);
    index += 1;
    assert.ok(index <= TOTAL_ENTRIES, 'The fixed pool must close by the final entry.');
  }
  const stats = campaignStats(state);
  assert.equal(stats.ticketsRemaining, 0);
  assert.equal(state.poolRevealed, true);
  assert.throws(() => createPendingEntry(state, '0712345678'), /closed/);
});
