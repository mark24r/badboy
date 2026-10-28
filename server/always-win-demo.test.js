import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PAYMENTS_MODE = 'demo';
process.env.DEMO_ALWAYS_WIN = 'true';

const demo = await import('./campaign.js');

test('always-win private demo awards a Regular or VIP demo ticket on all 120 spins', () => {
  const state = demo.createCampaign({ seedDemo: true });
  assert.equal(state.entries.length, 0, 'always-win demo starts without seeded entries');
  assert.equal(state.pool.length, 120);
  assert.equal(state.pool.filter((outcome) => outcome === 'win').length, 60);
  assert.equal(state.pool.filter((outcome) => outcome === 'vip-win').length, 60);
  assert.equal(state.pool.filter((outcome) => outcome === 'no-win').length, 0);
  assert.equal(state.pool.filter((outcome) => outcome === 'free-spin').length, 0);

  for (let index = 0; index < 120; index += 1) {
    const phone = `2547${String(30000000 + index).padStart(8, '0')}`;
    const pending = demo.createPendingEntry(state, phone);
    const paid = demo.markEntryPaid(state, pending.id, { mpesaReceipt: `DEMO${index}` });
    const result = demo.revealEntry(state, paid.id);
    assert.ok(['win', 'vip-win'].includes(result.outcome), `spin ${index + 1} was not a ticket win`);
    assert.match(result.prize, /^(REGULAR|VIP) TICKET \d{2,3}$/);
    assert.equal(result.freeSpinEntryId, null);
    assert.equal(result.spinStatus, 'completed');
  }

  const stats = demo.campaignStats(state);
  assert.equal(stats.entriesUsed, 120);
  assert.equal(stats.entriesRemaining, 0);
  assert.equal(stats.allocatedRegularTickets, 60);
  assert.equal(stats.allocatedVipTickets, 60);
  assert.equal(stats.allocatedFreeSpins, 0);
  assert.equal(state.acceptingEntries, false);
  assert.equal(state.poolRevealed, true);
  assert.equal(demo.computeCommitment(state), state.commitment);

  const publicData = demo.publicCampaign(state);
  assert.equal(publicData.demoAlwaysWin, true);
  assert.equal(publicData.startingOdds, '1 in 1');
  assert.equal(publicData.totalRewards, 120);
  assert.equal(publicData.totalFreeSpins, 0);
});

test('live payment mode ignores the always-win demo setting', async () => {
  process.env.PAYMENTS_MODE = 'live';
  const live = await import('./campaign.js?live-mode-safety-check');
  assert.equal(live.DEMO_ALWAYS_WIN, false);
  assert.equal(live.TOTAL_REGULAR_TICKETS, 1);
  assert.equal(live.TOTAL_VIP_TICKETS, 1);
  assert.equal(live.TOTAL_FREE_SPINS, 4);
  assert.equal(live.TOTAL_REWARDS, 6);
});
