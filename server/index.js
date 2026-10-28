import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  CAMPAIGN_ID,
  ENTRY_PRICE,
  createPendingEntry,
  markEntryPaid,
  normalizeEmail,
  normalizePhone,
  playerEntry,
  publicCampaign,
  revealEntry,
  revealedPool,
} from './campaign.js';
import {
  initiatePaystackMpesa,
  isValidEntryAccessCode,
  isValidPaystackSignature,
  paystackConfigured,
  paystackReferenceForEntry,
  paystackSignature,
  verifyPaystackTransaction,
} from './paystack.js';
import {
  applyPaystackTransaction,
  isValidCronAuthorization,
  reconcilePayments,
} from './reconciliation.js';
import { createCampaignStore, postgresConfigured } from './store.js';
import { forwardPaystackWebhook } from './webhook-forwarder.js';

const moduleFile = fileURLToPath(import.meta.url);
const __dirname = path.dirname(moduleFile);
const root = path.resolve(__dirname, '..');
const isVercel = Boolean(process.env.VERCEL);
const dataFile = process.env.DATA_FILE || (isVercel
  ? path.join('/tmp', 'detty-dezemba-demo-campaign.json')
  : path.join(root, 'data', 'campaign.json'));
const paymentMode = process.env.PAYMENTS_MODE === 'live' ? 'live' : 'demo';
const isProduction = process.env.NODE_ENV === 'production' || isVercel;

if (isVercel && paymentMode === 'live' && !postgresConfigured()) {
  throw new Error('Live payments require persistent Postgres storage on Vercel.');
}

const store = await createCampaignStore({
  dataFile,
  paymentMode,
  isVercel,
  storageKey: process.env.CAMPAIGN_STORAGE_KEY || undefined,
});
const app = express();
app.set('trust proxy', 1);
app.use(express.json({
  limit: '32kb',
  verify: (request, response, buffer) => {
    request.rawBody = Buffer.from(buffer);
  },
}));
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

const asyncRoute = (handler) => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

const paymentAttempts = new Map();
function paymentRateLimit(request, response, next) {
  const now = Date.now();
  const key = request.ip || 'unknown';
  const recent = (paymentAttempts.get(key) || []).filter((time) => now - time < 5 * 60_000);
  if (recent.length >= 12) {
    return response.status(429).json({ error: 'Too many payment attempts. Please wait a few minutes and try again.' });
  }
  recent.push(now);
  paymentAttempts.set(key, recent);
  return next();
}

function campaignResponse(state) {
  return {
    ...publicCampaign(state),
    paymentMode,
    paymentProvider: 'paystack',
    persistentStorage: store.persistent,
    livePaymentsConfigured: paymentMode === 'live' && store.persistent && paystackConfigured({ live: true }),
    entryAccessRequired: paymentMode === 'live' && Boolean(process.env.LIVE_ENTRY_ACCESS_CODE),
  };
}

function findEntry(state, id) {
  return state.entries.find((entry) => entry.id === id);
}

function sendError(response, error) {
  const status = error.status || 400;
  if (status >= 500) console.error(error.message);
  return response.status(status).json({ error: error.message || 'Something went wrong.' });
}

const paystackVerificationTimes = new Map();

app.get('/api/health', (request, response) => {
  response.json({
    ok: true,
    mode: paymentMode,
    provider: 'paystack',
    storage: store.kind,
    persistentStorage: store.persistent,
    paystackLiveKeyConfigured: paystackConfigured({ live: true }),
    webhookForwardingConfigured: Boolean(process.env.PAYSTACK_WEBHOOK_FORWARD_URL),
    isolatedCampaign: Boolean(process.env.CAMPAIGN_STORAGE_KEY),
    entryAccessRequired: paymentMode === 'live' && Boolean(process.env.LIVE_ENTRY_ACCESS_CODE),
  });
});

app.get('/api/cron/reconcile', asyncRoute(async (request, response) => {
  if (!isValidCronAuthorization(request.get('authorization'))) {
    return response.status(401).json({ error: 'Unauthorized reconciliation request.' });
  }
  if (paymentMode !== 'live') {
    return response.json({ ok: true, skipped: true, reason: 'demo-mode' });
  }
  if (!store.persistent || !paystackConfigured({ live: true })) {
    return response.status(503).json({ error: 'Live reconciliation requires Postgres and a live Paystack key.' });
  }
  return response.json(await reconcilePayments({ store }));
}));

app.post('/api/cron/router-self-test', asyncRoute(async (request, response) => {
  if (!isValidCronAuthorization(request.get('authorization'))) {
    return response.status(401).json({ error: 'Unauthorized router test request.' });
  }
  if (paymentMode !== 'demo') {
    return response.status(403).json({ error: 'The non-payment router self-test is available only in demo mode.' });
  }
  if (!paystackConfigured({ live: true }) || !process.env.PAYSTACK_WEBHOOK_FORWARD_URL) {
    return response.status(503).json({ error: 'Shared router self-test requires a live key and forwarding destination.' });
  }

  const rawBody = Buffer.from(JSON.stringify({
    event: 'detty.router.self_test',
    data: { testedAt: new Date().toISOString() },
  }));
  const signature = paystackSignature(rawBody);
  const target = `${request.protocol}://${request.get('host')}/api/payments/paystack/router`;
  let testResponse;
  try {
    testResponse = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
      body: rawBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return response.status(502).json({ error: 'Could not reach the shared router for its self-test.' });
  }
  return response.status(testResponse.ok ? 200 : 502).json({
    ok: testResponse.ok,
    routerStatus: testResponse.status,
    event: 'detty.router.self_test',
  });
}));

app.get('/api/campaign', asyncRoute(async (request, response) => {
  response.json(campaignResponse(await store.read()));
}));

app.get('/api/campaign/ledger', asyncRoute(async (request, response) => {
  const state = await store.read();
  response.json({
    schema: 'tiketi.public-ledger.v1',
    campaignId: state.campaignId,
    commitment: state.commitment,
    ledgerHead: state.ledgerHead,
    ledgerLength: state.ledgerLength,
    entries: [...campaignResponse(state).ledger].reverse(),
  });
}));

app.get('/api/campaign/reveal', asyncRoute(async (request, response) => {
  response.json(revealedPool(await store.read()));
}));

app.post('/api/payments/initiate', paymentRateLimit, asyncRoute(async (request, response) => {
  let entryId = null;
  let chargeConfirmedStarted = false;
  try {
    if (request.body?.acceptedTerms !== true) {
      throw new Error('Confirm that you are 18+ and accept the drop terms before entering.');
    }
    if (paymentMode === 'live' && !isValidEntryAccessCode(request.body?.accessCode)) {
      return response.status(403).json({ error: 'Live checkout is currently limited to invited testers. Use your private test link.' });
    }
    const phone = normalizePhone(request.body?.phone);

    if (paymentMode === 'demo') {
      const entry = await store.transact((state) => createPendingEntry(state, phone));
      return response.status(202).json({
        entry: playerEntry(entry),
        mode: 'demo',
        message: 'Simulated Paystack M-Pesa prompt created. No real payment will be taken.',
      });
    }

    const email = normalizeEmail(request.body?.email);
    if (!store.persistent || !paystackConfigured({ live: true })) {
      const error = new Error('Live Paystack payments require persistent storage and a live server key.');
      error.status = 503;
      throw error;
    }

    const entry = await store.transact((state) => {
      const pending = createPendingEntry(state, phone, undefined, { email, paymentMethod: 'Paystack M-Pesa' });
      pending.paystackReference = paystackReferenceForEntry(pending.id);
      return pending;
    });
    entryId = entry.id;

    const charge = await initiatePaystackMpesa({
      phone,
      email,
      amount: ENTRY_PRICE,
      entryId: entry.id,
      campaignId: CAMPAIGN_ID,
      reference: entry.paystackReference,
    });
    chargeConfirmedStarted = true;
    await store.transact((state) => {
      const pending = findEntry(state, entryId);
      pending.paystackStatus = charge.status || 'pending';
      pending.paystackTransactionId = charge.id ? String(charge.id) : pending.paystackTransactionId;
      return pending;
    });
    return response.status(202).json({
      entry: playerEntry(entry),
      mode: 'live',
      message: charge.display_text || 'Check your phone for the M-Pesa prompt from Paystack.',
    });
  } catch (error) {
    if (entryId) {
      await store.transact((state) => {
        const entry = findEntry(state, entryId);
        if (entry?.paymentStatus === 'pending') {
          const needsReview = error.ambiguous || chargeConfirmedStarted;
          entry.paymentStatus = needsReview ? 'review' : 'failed';
          entry.failureReason = needsReview
            ? 'Paystack could not confirm whether this charge started. Reconcile it before retrying.'
            : 'Could not initiate Paystack M-Pesa payment.';
        }
        return entry;
      }).catch((updateError) => console.error(`Could not record Paystack initiation failure: ${updateError.message}`));
    }
    return sendError(response, error);
  }
}));

async function processDettyPaystackEvent(event) {
  if (event?.event !== 'charge.success') return;
  const reference = event.data?.reference;
  const state = await store.read();
  const entry = state.entries.find((item) => item.paystackReference === reference);
  if (!entry) {
    console.warn('Received a signed Paystack webhook for an unknown payment reference.');
    return;
  }
  if (entry.paymentStatus === 'paid') return;

  const data = await verifyPaystackTransaction(reference);
  await store.transact((current) => applyPaystackTransaction(current, entry.id, data));
}

app.post('/api/payments/paystack/webhook', asyncRoute(async (request, response) => {
  if (paymentMode !== 'live') {
    return response.status(403).json({ error: 'Paystack webhooks are disabled in demo mode.' });
  }
  if (!isValidPaystackSignature(request.rawBody, request.get('x-paystack-signature'))) {
    return response.status(401).json({ error: 'Invalid Paystack signature.' });
  }

  await processDettyPaystackEvent(request.body);
  return response.json({ received: true });
}));

app.post('/api/payments/paystack/router', asyncRoute(async (request, response) => {
  const signature = request.get('x-paystack-signature');
  if (!isValidPaystackSignature(request.rawBody, signature)) {
    return response.status(401).json({ error: 'Invalid Paystack signature.' });
  }

  const forwardUrl = process.env.PAYSTACK_WEBHOOK_FORWARD_URL || null;
  if (paymentMode !== 'live' && !forwardUrl) {
    return response.status(403).json({ error: 'Shared Paystack routing is not configured.' });
  }

  let forwardingError = null;
  if (forwardUrl) {
    try {
      await forwardPaystackWebhook({ url: forwardUrl, rawBody: request.rawBody, signature });
    } catch (error) {
      forwardingError = error;
      console.error(`Existing Paystack webhook forwarding failed: ${error.message}`);
    }
  }

  if (paymentMode === 'live') await processDettyPaystackEvent(request.body);

  if (forwardingError) {
    return response.status(forwardingError.status || 502).json({
      error: 'The existing webhook receiver could not be confirmed. Paystack will retry.',
    });
  }
  console.log(`Shared Paystack router accepted ${request.body?.event || 'unknown event'}; forwarded=${Boolean(forwardUrl)}; dettyProcessing=${paymentMode === 'live'}.`);
  return response.json({ received: true, forwarded: Boolean(forwardUrl) });
}));

app.post('/api/demo/complete-payment', asyncRoute(async (request, response) => {
  if (paymentMode !== 'demo') {
    return response.status(403).json({ error: 'Simulated payment confirmation is disabled in live mode.' });
  }
  const result = await store.transact((state) => {
    const entry = markEntryPaid(state, request.body?.entryId, {
      mpesaReceipt: `SIM${Date.now().toString().slice(-8)}`,
    });
    return { entry: playerEntry(entry), campaign: campaignResponse(state) };
  });
  response.json(result);
}));

app.get('/api/entries/:entryId', asyncRoute(async (request, response) => {
  let state = await store.read();
  let entry = findEntry(state, request.params.entryId);
  if (!entry) return response.status(404).json({ error: 'Entry not found.' });

  if (paymentMode === 'live' && entry.paymentStatus === 'pending' && entry.paystackReference) {
    const lastCheck = paystackVerificationTimes.get(entry.id) || 0;
    if (Date.now() - lastCheck >= 10_000) {
      paystackVerificationTimes.set(entry.id, Date.now());
      try {
        const data = await verifyPaystackTransaction(entry.paystackReference);
        entry = await store.transact((current) => applyPaystackTransaction(current, entry.id, data));
      } catch (error) {
        console.error(`Paystack status check failed: ${error.message}`);
        state = await store.read();
        entry = findEntry(state, request.params.entryId);
      }
    }
  }
  return response.json({ entry: playerEntry(entry) });
}));

app.post('/api/entries/:entryId/spin', asyncRoute(async (request, response) => {
  const result = await store.transact((state) => {
    const entry = revealEntry(state, request.params.entryId);
    const bonusEntry = entry.freeSpinEntryId ? findEntry(state, entry.freeSpinEntryId) : null;
    return {
      entry: playerEntry(entry),
      bonusEntry: bonusEntry ? playerEntry(bonusEntry) : null,
      campaign: campaignResponse(state),
    };
  });
  response.json(result);
}));

app.use('/api', (request, response) => {
  response.status(404).json({ error: 'API route not found.' });
});

app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  return sendError(response, error);
});

if (isVercel) {
  app.use((request, response) => {
    response.status(404).json({ error: 'Route not found.' });
  });
} else if (isProduction) {
  app.use(express.static(path.join(root, 'dist'), { maxAge: '1h', etag: true }));
  app.get('*', (request, response) => {
    response.sendFile(path.join(root, 'dist', 'index.html'));
  });
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true, hmr: false },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === moduleFile;
if (isDirectRun) {
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Detty Dezemba is running on port ${port} in ${isProduction ? 'production' : 'development'} mode.`);
    console.log(`Payments: ${paymentMode} via Paystack; storage: ${store.kind}.`);
    if (paymentMode === 'live' && !paystackConfigured({ live: true })) console.warn('Live Paystack configuration is incomplete.');
  });

  function shutdown() {
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export default app;
