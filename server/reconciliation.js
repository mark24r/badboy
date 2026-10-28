import crypto from 'node:crypto';
import { markEntryPaid } from './campaign.js';
import { validatePaystackTransaction, verifyPaystackTransaction } from './paystack.js';

function findEntry(state, entryId) {
  return state.entries.find((entry) => entry.id === entryId);
}

export function applyPaystackTransaction(state, entryId, data) {
  const entry = findEntry(state, entryId);
  if (!entry) throw new Error('Entry not found.');
  if (entry.paymentStatus === 'paid') return entry;

  entry.paystackStatus = data.status || null;
  entry.paystackTransactionId = data.id ? String(data.id) : entry.paystackTransactionId;
  entry.paystackPaidAt = data.paid_at || data.paidAt || entry.paystackPaidAt;

  if (data.status !== 'success') {
    if (['pending', 'review'].includes(entry.paymentStatus) && ['failed', 'abandoned'].includes(data.status)) {
      entry.paymentStatus = 'failed';
      entry.failureReason = data.gateway_response || data.message || 'Paystack M-Pesa payment was not completed.';
    }
    return entry;
  }

  // Verify the amount locked into this entry at checkout, not a possibly
  // changed campaign-wide price during a later webhook or reconciliation run.
  const validation = validatePaystackTransaction(data, entry, { amount: entry.amount });
  if (!validation.valid) {
    entry.paymentStatus = 'review';
    entry.paymentReference = data.reference;
    entry.failureReason = `${validation.reason} Manual review is required before an entry is issued.`;
    return entry;
  }

  try {
    markEntryPaid(state, entry.id, {
      paidAt: entry.paystackPaidAt || new Date().toISOString(),
      paymentReference: data.reference,
    });
  } catch (error) {
    entry.paymentStatus = 'review';
    entry.paymentReference = data.reference;
    entry.failureReason = 'Paystack confirmed this payment, but the entry needs refund or allocation review.';
  }
  return entry;
}

export function reconciliationCandidates(state) {
  return state.entries
    .filter((entry) => {
      if (!entry.paystackReference || entry.bonusOf) return false;
      if (entry.paymentStatus === 'pending') return true;
      // A successful Paystack transaction in review needs human review; do not
      // repeatedly allocate or alter it through the automatic reconciler.
      return entry.paymentStatus === 'review' && entry.paystackStatus !== 'success';
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export function isValidCronAuthorization(authorization, secret = process.env.CRON_SECRET) {
  if (!authorization || !secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8');
  const provided = Buffer.from(String(authorization), 'utf8');
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

async function recordReconciliationError(store, entryId, error, attemptedAt) {
  await store.transact((state) => {
    const entry = findEntry(state, entryId);
    if (!entry || entry.paymentStatus === 'paid') return entry;
    entry.reconciliationAttempts = (entry.reconciliationAttempts || 0) + 1;
    entry.lastReconciliationAt = attemptedAt;
    entry.lastReconciliationError = String(error.message || 'Paystack verification failed.').slice(0, 300);
    return entry;
  });
}

async function reconcileOne(store, candidate, verifyTransaction, now) {
  const attemptedAt = now().toISOString();
  let data;
  try {
    data = await verifyTransaction(candidate.paystackReference);
    if (!data) throw new Error('Paystack returned no transaction data.');
  } catch (error) {
    await recordReconciliationError(store, candidate.id, error, attemptedAt);
    return 'error';
  }

  const entry = await store.transact((state) => {
    const updated = applyPaystackTransaction(state, candidate.id, data);
    updated.reconciliationAttempts = (updated.reconciliationAttempts || 0) + 1;
    updated.lastReconciliationAt = attemptedAt;
    updated.lastReconciliationError = null;
    return updated;
  });
  return entry.paymentStatus;
}

export async function reconcilePayments({
  store,
  verifyTransaction = verifyPaystackTransaction,
  now = () => new Date(),
  limit = 12,
  concurrency = 6,
  logger = console,
} = {}) {
  const candidates = reconciliationCandidates(await store.read());
  const selected = candidates.slice(0, limit);
  const results = new Array(selected.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    while (nextIndex < selected.length) {
      const index = nextIndex;
      nextIndex += 1;
      const candidate = selected[index];
      try {
        results[index] = await reconcileOne(store, candidate, verifyTransaction, now);
      } catch (error) {
        logger.error(`Payment reconciliation storage failure for entry ${candidate.id}: ${error.message}`);
        throw error;
      }
    }
  });
  await Promise.all(workers);

  const summary = {
    ok: true,
    candidates: candidates.length,
    checked: selected.length,
    paid: 0,
    pending: 0,
    failed: 0,
    review: 0,
    error: 0,
    remaining: Math.max(0, candidates.length - selected.length),
  };
  for (const status of results) {
    if (Object.hasOwn(summary, status)) summary[status] += 1;
  }
  results.forEach((status, index) => {
    if (status === 'error') {
      logger.error(`Paystack verification is still failing for entry ${selected[index].id}.`);
    }
    if (status === 'review') {
      logger.warn(`Payment requires manual review for entry ${selected[index].id}.`);
    }
  });
  if (summary.review || summary.error || summary.remaining) {
    logger.warn('Payment reconciliation requires attention.', summary);
  }
  return summary;
}
