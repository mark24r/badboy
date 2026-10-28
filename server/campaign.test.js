import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRY_PRICE,
  GENESIS_HASH,
  MAX_ENTRIES_PER_PHONE,
  TOTAL_ENTRIES,
  TOTAL_FREE_SPINS,
  TOTAL_REGULAR_TICKETS,
  TOTAL_VIP_TICKETS,
  TOTAL_WINNERS,
  campaignStats,
  computeCommitment,
  computeResultHash,
  createCampaign,
  createPendingEntry,
  markEntryPaid,
  normalizeEmail,
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

test('normalizes Paystack email and keeps customer payment details private', () => {
  assert.equal(normalizeEmail(' User@Example.COM '), 'user@example.com');
  assert.throws(() => normalizeEmail('not-an-email'), /valid email/);
  const state = createCampaign();
  const entry = createPendingEntry(state, '0712345678', undefined, {
    email: 'user@example.com',
    paymentMethod: 'Paystack M-Pesa',
  });
  entry.paystackReference = 'DD-private-reference';
  const projected = playerEntry(entry);
  assert.equal(projected.paymentMethod, 'Paystack M-Pesa');
  assert.equal(projected.email, undefined);
  assert.equal(projected.paystackReference, undefined);
});

test('creates a fixed, committed outcome pool', () => {
  const state = createCampaign();
  assert.equal(TOTAL_ENTRIES, 120);
  assert.equal(TOTAL_REGULAR_TICKETS, 1);
  assert.equal(TOTAL_VIP_TICKETS, 1);
  assert.equal(TOTAL_WINNERS, 2);
  assert.equal(TOTAL_FREE_SPINS, 4);
  assert.equal(state.pool.length, TOTAL_ENTRIES);
  assert.equal(state.pool.filter((outcome) => outcome === 'win').length, TOTAL_REGULAR_TICKETS);
  assert.equal(state.pool.filter((outcome) => outcome === 'vip-win').length, TOTAL_VIP_TICKETS);
  assert.equal(state.pool.filter((outcome) => outcome === 'free-spin').length, TOTAL_FREE_SPINS);
  assert.equal(state.pool.filter((outcome) => outcome === 'no-win').length, 114);
  assert.equal(state.pool.filter((outcome) => outcome === 'no-win').length / TOTAL_ENTRIES, 0.95);
  assert.notEqual(state.pool[state.pool.length - 1], 'free-spin');
  assert.match(state.commitment, /^[a-f0-9]{64}$/);
  assert.equal(computeCommitment(state), state.commitment);
  const first = state.pool[0];
  state.pool[0] = first === 'win' ? 'no-win' : 'win';
  assert.notEqual(computeCommitment(state), state.commitment);
});

test('reveals Regular and VIP tickets with distinct prize references', () => {
  const state = createCampaign();
  state.pool = ['win', 'vip-win', ...Array(4).fill('free-spin'), ...Array(114).fill('no-win')];
  state.commitment = computeCommitment(state);
  const regular = paidEntry(state);
  const regularResult = revealEntry(state, regular.id);
  const vip = paidEntry(state);
  const vipResult = revealEntry(state, vip.id);
  assert.equal(regularResult.prize, 'REGULAR TICKET 01');
  assert.equal(vipResult.prize, 'VIP TICKET 01');
  assert.equal(campaignStats(state).regularTicketsRemaining, 0);
  assert.equal(campaignStats(state).vipTicketsRemaining, 0);
  assert.equal(campaignStats(state).ticketsRemaining, 0);
});

test('demo commitment timestamp predates every seeded entry', () => {
  const state = createCampaign({ seedDemo: true, seedCount: 8 });
  const firstEntry = Math.min(...state.entries.map((entry) => Date.parse(entry.createdAt)));
  assert.ok(Date.parse(state.createdAt) < firstEntry);
  assert.ok(state.pool.slice(0, 8).every((outcome) => outcome === 'no-win'));
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
  assert.equal(publicData.startingOdds, '1 in 20');
  assert.equal(publicData.ticketOdds, '1 in 60');
  assert.equal(publicData.regularTicketOdds, '1 in 120');
  assert.equal(publicData.vipTicketOdds, '1 in 120');
  assert.equal(publicData.ledgerLength, 1);
});

test('enforces the per-phone entry limit', () => {
  const state = createCampaign();
  state.pool = Array(TOTAL_ENTRIES).fill('no-win');
  state.commitment = computeCommitment(state);
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
    let readyBonus;
    while ((readyBonus = state.entries.find((item) => item.paymentStatus === 'paid' && item.spinStatus === 'ready'))) {
      revealEntry(state, readyBonus.id);
    }
    index += 1;
    assert.ok(index <= TOTAL_ENTRIES, 'The fixed pool must close by the final entry.');
  }
  const stats = campaignStats(state);
  assert.equal(stats.ticketsRemaining, 0);
  assert.equal(state.poolRevealed, true);
  assert.throws(() => createPendingEntry(state, '0712345678'), /closed/);
});

test('free-spin bonus entries can chain through consecutive committed positions', () => {
  const state = createCampaign();
  state.pool = ['free-spin', 'free-spin', 'free-spin', 'free-spin', ...Array(114).fill('no-win'), 'win', 'vip-win'];
  assert.equal(state.pool.length, TOTAL_ENTRIES);
  assert.equal(state.pool.filter((outcome) => outcome === 'no-win').length, 114);
  state.commitment = computeCommitment(state);
  const parent = paidEntry(state);
  const first = revealEntry(state, parent.id);
  const secondEntry = state.entries.find((entry) => entry.id === first.freeSpinEntryId);
  const second = revealEntry(state, secondEntry.id);
  const thirdEntry = state.entries.find((entry) => entry.id === second.freeSpinEntryId);
  assert.equal(second.outcome, 'free-spin');
  assert.equal(thirdEntry.amount, 0);
  assert.equal(thirdEntry.bonusOf, secondEntry.id);
  assert.equal(thirdEntry.outcome, 'free-spin');
  assert.equal(thirdEntry.entryNumber, 3);
  assert.equal(state.entries.length, 3);
});

test('a free spin creates one idempotent KES 0 bonus entry from the same committed pool', () => {
  const state = createCampaign();
  state.pool = ['free-spin', 'no-win', ...Array(3).fill('free-spin'), ...Array(113).fill('no-win'), 'win', 'vip-win'];
  assert.equal(state.pool.length, TOTAL_ENTRIES);
  assert.equal(state.pool.filter((outcome) => outcome === 'free-spin').length, TOTAL_FREE_SPINS);
  assert.equal(state.pool.filter((outcome) => outcome === 'no-win').length, 114);
  state.commitment = computeCommitment(state);
  const parent = paidEntry(state);
  const result = revealEntry(state, parent.id);
  assert.equal(result.outcome, 'free-spin');
  assert.ok(result.freeSpinEntryId);
  assert.equal(state.entries.length, 2);
  const bonus = state.entries[1];
  assert.equal(bonus.amount, 0);
  assert.equal(bonus.bonusOf, parent.id);
  assert.equal(bonus.paymentMethod, 'Free spin');
  assert.equal(bonus.paymentStatus, 'paid');
  assert.equal(bonus.spinStatus, 'ready');
  assert.equal(bonus.outcome, 'no-win');
  assert.equal(bonus.entryNumber, 2);
  assert.equal(playerEntry(bonus).outcome, null);
  const repeated = revealEntry(state, parent.id);
  assert.equal(repeated.freeSpinEntryId, bonus.id);
  assert.equal(state.entries.length, 2);
  assert.equal(paidEntry(state).amount, ENTRY_PRICE, 'a paid entry remains allowed after a bonus');
  const bonusResult = revealEntry(state, bonus.id);
  assert.equal(bonusResult.outcome, 'no-win');
  assert.ok(bonusResult.resultHash);
  assert.equal(state.ledgerLength, 2);
});
