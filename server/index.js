import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  ENTRY_PRICE,
  createPendingEntry,
  loadOrCreateCampaign,
  markEntryPaid,
  normalizeEmail,
  normalizePhone,
  playerEntry,
  publicCampaign,
  revealEntry,
  revealedPool,
  saveCampaign,
} from './campaign.js';
import {
  initiatePaystackMpesa,
  isValidPaystackSignature,
  paystackConfigured,
  paystackReferenceForEntry,
  validatePaystackTransaction,
  verifyPaystackTransaction,
} from './paystack.js';

const moduleFile = fileURLToPath(import.meta.url);
const __dirname = path.dirname(moduleFile);
const root = path.resolve(__dirname, '..');
const isVercel = Boolean(process.env.VERCEL);
const dataFile = process.env.DATA_FILE || (isVercel
  ? path.join('/tmp', 'detty-dezemba-demo-campaign.json')
  : path.join(root, 'data', 'campaign.json'));
const paymentMode = process.env.PAYMENTS_MODE === 'live' ? 'live' : 'demo';
const isProduction = process.env.NODE_ENV === 'production' || isVercel;

if (isVercel && paymentMode === 'live') {
  throw new Error('Live payments require persistent production storage and are disabled on the ephemeral Vercel demo.');
}

const state = loadOrCreateCampaign(dataFile, { demo: paymentMode === 'demo' });

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

function campaignResponse() {
  return {
    ...publicCampaign(state),
    paymentMode,
    paymentProvider: 'paystack',
    livePaymentsConfigured: paymentMode === 'live' && paystackConfigured({ live: true }),
  };
}

function findEntry(id) {
  return state.entries.find((entry) => entry.id === id);
}

function sendError(response, error) {
  const status = error.status || 400;
  if (status >= 500) console.error(error.message);
  return response.status(status).json({ error: error.message || 'Something went wrong.' });
}

const paystackVerificationTimes = new Map();

async function reconcilePaystackEntry(entry) {
  if (entry.paymentStatus === 'paid') return entry;
  const data = await verifyPaystackTransaction(entry.paystackReference);
  entry.paystackStatus = data.status || null;
  entry.paystackTransactionId = data.id ? String(data.id) : entry.paystackTransactionId;
  entry.paystackPaidAt = data.paid_at || data.paidAt || entry.paystackPaidAt;

  if (data.status !== 'success') {
    if (entry.paymentStatus === 'pending' && ['failed', 'abandoned'].includes(data.status)) {
      entry.paymentStatus = 'failed';
      entry.failureReason = data.gateway_response || data.message || 'Paystack M-Pesa payment was not completed.';
    }
    return entry;
  }

  const validation = validatePaystackTransaction(data, entry, { amount: ENTRY_PRICE });
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

app.get('/api/health', (request, response) => {
  response.json({ ok: true, mode: paymentMode, provider: 'paystack', storage: isVercel ? 'ephemeral-demo' : 'local-json' });
});

app.get('/api/campaign', (request, response) => {
  response.json(campaignResponse());
});

app.get('/api/campaign/ledger', (request, response) => {
  response.json({
    schema: 'tiketi.public-ledger.v1',
    campaignId: state.campaignId,
    commitment: state.commitment,
    ledgerHead: state.ledgerHead,
    ledgerLength: state.ledgerLength,
    entries: [...campaignResponse().ledger].reverse(),
  });
});

app.get('/api/campaign/reveal', (request, response) => {
  try {
    response.json(revealedPool(state));
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/api/payments/initiate', paymentRateLimit, async (request, response) => {
  let entry;
  try {
    if (request.body?.acceptedTerms !== true) {
      throw new Error('Confirm that you are 18+ and accept the drop terms before entering.');
    }
    const phone = normalizePhone(request.body?.phone);

    if (paymentMode === 'demo') {
      entry = createPendingEntry(state, phone);
      saveCampaign(state, dataFile);
      return response.status(202).json({
        entry: playerEntry(entry),
        mode: 'demo',
        message: 'Simulated Paystack M-Pesa prompt created. No real payment will be taken.',
      });
    }

    const email = normalizeEmail(request.body?.email);
    if (!paystackConfigured({ live: true })) {
      const error = new Error('Live Paystack payments are not configured on this server.');
      error.status = 503;
      throw error;
    }

    entry = createPendingEntry(state, phone, undefined, { email, paymentMethod: 'Paystack M-Pesa' });
    entry.paystackReference = paystackReferenceForEntry(entry.id);
    saveCampaign(state, dataFile);

    const charge = await initiatePaystackMpesa({
      phone,
      email,
      amount: ENTRY_PRICE,
      entryId: entry.id,
      campaignId: state.campaignId,
      reference: entry.paystackReference,
    });
    entry.paystackStatus = charge.status || 'pending';
    entry.paystackTransactionId = charge.id ? String(charge.id) : entry.paystackTransactionId;
    saveCampaign(state, dataFile);
    return response.status(202).json({
      entry: playerEntry(entry),
      mode: 'live',
      message: charge.display_text || 'Check your phone for the M-Pesa prompt from Paystack.',
    });
  } catch (error) {
    if (entry && entry.paymentStatus === 'pending') {
      entry.paymentStatus = error.ambiguous ? 'review' : 'failed';
      entry.failureReason = error.ambiguous
        ? 'Paystack could not confirm whether this charge started. Reconcile it before retrying.'
        : 'Could not initiate Paystack M-Pesa payment.';
      saveCampaign(state, dataFile);
    }
    return sendError(response, error);
  }
});

app.post('/api/payments/paystack/webhook', async (request, response) => {
  if (paymentMode !== 'live') {
    return response.status(403).json({ error: 'Paystack webhooks are disabled in demo mode.' });
  }
  if (!isValidPaystackSignature(request.rawBody, request.get('x-paystack-signature'))) {
    return response.status(401).json({ error: 'Invalid Paystack signature.' });
  }

  const event = request.body;
  if (event?.event !== 'charge.success') return response.json({ received: true });
  const reference = event.data?.reference;
  const entry = state.entries.find((item) => item.paystackReference === reference);
  if (!entry) {
    console.warn('Received a signed Paystack webhook for an unknown payment reference.');
    return response.json({ received: true });
  }

  try {
    await reconcilePaystackEntry(entry);
    saveCampaign(state, dataFile);
    return response.json({ received: true });
  } catch (error) {
    console.error(`Paystack webhook verification failed: ${error.message}`);
    return response.status(500).json({ error: 'Payment verification temporarily failed.' });
  }
});

app.post('/api/demo/complete-payment', (request, response) => {
  if (paymentMode !== 'demo') {
    return response.status(403).json({ error: 'Simulated payment confirmation is disabled in live mode.' });
  }
  try {
    const entry = markEntryPaid(state, request.body?.entryId, {
      mpesaReceipt: `SIM${Date.now().toString().slice(-8)}`,
    });
    saveCampaign(state, dataFile);
    return response.json({ entry: playerEntry(entry), campaign: campaignResponse() });
  } catch (error) {
    return sendError(response, error);
  }
});

app.get('/api/entries/:entryId', async (request, response) => {
  const entry = findEntry(request.params.entryId);
  if (!entry) return response.status(404).json({ error: 'Entry not found.' });

  if (paymentMode === 'live' && entry.paymentStatus === 'pending' && entry.paystackReference) {
    const lastCheck = paystackVerificationTimes.get(entry.id) || 0;
    if (Date.now() - lastCheck >= 10_000) {
      paystackVerificationTimes.set(entry.id, Date.now());
      try {
        await reconcilePaystackEntry(entry);
        saveCampaign(state, dataFile);
      } catch (error) {
        console.error(`Paystack status check failed: ${error.message}`);
      }
    }
  }
  return response.json({ entry: playerEntry(entry) });
});

app.post('/api/entries/:entryId/spin', (request, response) => {
  try {
    const entry = revealEntry(state, request.params.entryId);
    const bonusEntry = entry.freeSpinEntryId ? findEntry(entry.freeSpinEntryId) : null;
    saveCampaign(state, dataFile);
    return response.json({
      entry: playerEntry(entry),
      bonusEntry: bonusEntry ? playerEntry(bonusEntry) : null,
      campaign: campaignResponse(),
    });
  } catch (error) {
    return sendError(response, error);
  }
});

app.use('/api', (request, response) => {
  response.status(404).json({ error: 'API route not found.' });
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
    console.log(`Payments: ${paymentMode} via Paystack${paymentMode === 'live' && !paystackConfigured({ live: true }) ? ' (live Paystack configuration incomplete)' : ''}.`);
  });

  function shutdown() {
    server.close(() => process.exit(0));
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export default app;
