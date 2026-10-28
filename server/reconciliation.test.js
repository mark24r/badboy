import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPAIGN_ID,
  createCampaign,
  createPendingEntry,
  paidEntries,
  validateCampaignState,
} from './campaign.js';
import { paystackReferenceForEntry } from './paystack.js';
import {
  isValidCronAuthorization,
  reconcilePayments,
} from './reconciliation.js';

const silentLogger = { error() {}, warn() {} };

function makeStore(state) {
  return {
    read: async () => state,
    transact: async (mutator) => mutator(state),
  };
}

function makeLiveEntry(state, phone = '0712345678', createdAt = '2026-10-28T10:00:00.000Z') {
  const entry = createPendingEntry(state, phone, createdAt, {
    email: 'customer@example.com',
    paymentMethod: 'Paystack M-Pesa',
  });
  entry.paystackReference = paystackReferenceForEntry(entry.id);
  return entry;
}

function successfulTransaction(entry, overrides = {}) {
  return {
    id: 123456,
    status: 'success',
    reference: entry.paystackReference,
    amount: 50_000,
    currency: 'KES',
    channel: 'mobile_money',
    domain: 'live',
    paid_at: '2026-10-28T10:01:00.000Z',
    metadata: { entryId: entry.id, campaignId: CAMPAIGN_ID },
    ...overrides,
  };
}

test('reconciliation confirms a pending payment once and repeated runs stay idempotent', async () => {
  const state = createCampaign();
  const entry = makeLiveEntry(state);
  const store = makeStore(state);
  let calls = 0;
  const verifyTransaction = async (reference) => {
    calls += 1;
    assert.equal(reference, entry.paystackReference);
    return successfulTransaction(entry);
  };

  const first = await reconcilePayments({ store, verifyTransaction, logger: silentLogger });
  assert.equal(first.checked, 1);
  assert.equal(first.paid, 1);
  assert.equal(entry.paymentStatus, 'paid');
  assert.equal(entry.entryNumber, 1);
  assert.equal(entry.receipt, 'DD-0001');
  assert.equal(entry.reconciliationAttempts, 1);
  assert.equal(entry.lastReconciliationError, null);
  assert.equal(paidEntries(state).length, 1);
  validateCampaignState(state);

  const second = await reconcilePayments({ store, verifyTransaction, logger: silentLogger });
  assert.equal(second.candidates, 0);
  assert.equal(second.checked, 0);
  assert.equal(calls, 1);
  assert.equal(paidEntries(state).length, 1);
  assert.equal(state.entries.length, 1);
});

test('reconciliation can recover an entry left in ambiguous review', async () => {
  const state = createCampaign();
  const entry = makeLiveEntry(state);
  entry.paymentStatus = 'review';
  entry.failureReason = 'Paystack could not confirm whether this charge started.';
  const store = makeStore(state);

  const summary = await reconcilePayments({
    store,
    verifyTransaction: async () => successfulTransaction(entry),
    logger: silentLogger,
  });
  assert.equal(summary.paid, 1);
  assert.equal(entry.paymentStatus, 'paid');
  assert.equal(entry.failureReason, null);
  assert.equal(entry.entryNumber, 1);
});

test('a successful but mismatched transaction remains manual review and is not auto-retried', async () => {
  const state = createCampaign();
  const entry = makeLiveEntry(state);
  const store = makeStore(state);
  let calls = 0;
  const verifyTransaction = async () => {
    calls += 1;
    return successfulTransaction(entry, { amount: 49_900 });
  };

  const first = await reconcilePayments({ store, verifyTransaction, logger: silentLogger });
  assert.equal(first.review, 1);
  assert.equal(entry.paymentStatus, 'review');
  assert.equal(entry.paystackStatus, 'success');
  assert.equal(entry.entryNumber, null);
  assert.match(entry.failureReason, /amount or currency/);

  const second = await reconcilePayments({ store, verifyTransaction, logger: silentLogger });
  assert.equal(second.candidates, 0);
  assert.equal(calls, 1);
  assert.equal(paidEntries(state).length, 0);
});

test('a temporary verification outage preserves the pending entry and a later run retries it', async () => {
  const state = createCampaign();
  const entry = makeLiveEntry(state);
  const store = makeStore(state);
  let available = false;

  const verifyTransaction = async () => {
    if (!available) throw new Error('Temporary Paystack outage.');
    return successfulTransaction(entry);
  };
  const failedRun = await reconcilePayments({ store, verifyTransaction, logger: silentLogger });
  assert.equal(failedRun.error, 1);
  assert.equal(entry.paymentStatus, 'pending');
  assert.equal(entry.reconciliationAttempts, 1);
  assert.equal(entry.lastReconciliationError, 'Temporary Paystack outage.');
  assert.equal(paidEntries(state).length, 0);

  available = true;
  const recoveredRun = await reconcilePayments({ store, verifyTransaction, logger: silentLogger });
  assert.equal(recoveredRun.paid, 1);
  assert.equal(entry.paymentStatus, 'paid');
  assert.equal(entry.reconciliationAttempts, 2);
  assert.equal(entry.lastReconciliationError, null);
  assert.equal(paidEntries(state).length, 1);
});

test('a definitively failed Paystack payment does not allocate an entry', async () => {
  const state = createCampaign();
  const entry = makeLiveEntry(state);
  const store = makeStore(state);
  const summary = await reconcilePayments({
    store,
    verifyTransaction: async () => successfulTransaction(entry, {
      status: 'failed',
      gateway_response: 'The M-Pesa request was cancelled.',
    }),
    logger: silentLogger,
  });
  assert.equal(summary.failed, 1);
  assert.equal(entry.paymentStatus, 'failed');
  assert.equal(entry.entryNumber, null);
  assert.equal(paidEntries(state).length, 0);
});

test('reconciliation batches oldest entries first and reports remaining work', async () => {
  const state = createCampaign();
  const first = makeLiveEntry(state, '0712345678', '2026-10-28T10:00:00.000Z');
  const second = makeLiveEntry(state, '0712345679', '2026-10-28T10:02:00.000Z');
  const third = makeLiveEntry(state, '0712345680', '2026-10-28T10:04:00.000Z');
  const store = makeStore(state);
  const entries = new Map([first, second, third].map((entry) => [entry.paystackReference, entry]));

  const summary = await reconcilePayments({
    store,
    limit: 2,
    concurrency: 1,
    verifyTransaction: async (reference) => successfulTransaction(entries.get(reference)),
    logger: silentLogger,
  });
  assert.equal(summary.candidates, 3);
  assert.equal(summary.checked, 2);
  assert.equal(summary.paid, 2);
  assert.equal(summary.remaining, 1);
  assert.equal(first.paymentStatus, 'paid');
  assert.equal(second.paymentStatus, 'paid');
  assert.equal(third.paymentStatus, 'pending');
  assert.deepEqual(paidEntries(state).map((entry) => entry.entryNumber), [1, 2]);
});

test('cron authorization requires the exact bearer secret', () => {
  const secret = 'a-long-random-cron-secret-for-tests';
  assert.equal(isValidCronAuthorization(`Bearer ${secret}`, secret), true);
  assert.equal(isValidCronAuthorization(`Bearer ${secret}x`, secret), false);
  assert.equal(isValidCronAuthorization(secret, secret), false);
  assert.equal(isValidCronAuthorization('', secret), false);
  assert.equal(isValidCronAuthorization(`Bearer ${secret}`, ''), false);
});
