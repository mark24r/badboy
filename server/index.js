import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  ENTRY_PRICE,
  createPendingEntry,
  loadOrCreateCampaign,
  markEntryPaid,
  normalizePhone,
  playerEntry,
  publicCampaign,
  revealEntry,
  revealedPool,
  saveCampaign,
} from './campaign.js';
import { darajaConfigured, initiateStkPush } from './daraja.js';

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
app.use(express.json({ limit: '32kb' }));
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
    livePaymentsConfigured: paymentMode === 'live' && darajaConfigured(),
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

app.get('/api/health', (request, response) => {
  response.json({ ok: true, mode: paymentMode, storage: isVercel ? 'ephemeral-demo' : 'local-json' });
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
    entry = createPendingEntry(state, phone);

    if (paymentMode === 'demo') {
      saveCampaign(state, dataFile);
      return response.status(202).json({
        entry: playerEntry(entry),
        mode: 'demo',
        message: 'Simulated STK Push created. No real payment will be taken.',
      });
    }

    const stkResponse = await initiateStkPush({ phone, amount: ENTRY_PRICE, entryId: entry.id });
    entry.merchantRequestId = stkResponse.MerchantRequestID;
    entry.checkoutRequestId = stkResponse.CheckoutRequestID;
    saveCampaign(state, dataFile);
    return response.status(202).json({
      entry: playerEntry(entry),
      mode: 'live',
      message: stkResponse.CustomerMessage || 'Check your phone for the M-Pesa prompt.',
    });
  } catch (error) {
    if (entry && entry.paymentStatus === 'pending') {
      entry.paymentStatus = 'failed';
      entry.failureReason = 'Could not initiate M-Pesa payment.';
      saveCampaign(state, dataFile);
    }
    return sendError(response, error);
  }
});

app.post('/api/payments/callback', (request, response) => {
  const callback = request.body?.Body?.stkCallback;
  if (!callback?.CheckoutRequestID) {
    return response.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid callback' });
  }

  const entry = state.entries.find((item) => item.checkoutRequestId === callback.CheckoutRequestID);
  if (!entry) {
    console.warn('Received an M-Pesa callback for an unknown CheckoutRequestID.');
    return response.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  try {
    if (callback.ResultCode !== 0) {
      entry.paymentStatus = 'failed';
      entry.failureReason = callback.ResultDesc || 'M-Pesa payment was not completed.';
    } else if (entry.paymentStatus !== 'paid') {
      const metadata = Object.fromEntries(
        (callback.CallbackMetadata?.Item || []).map((item) => [item.Name, item.Value]),
      );
      const validAmount = Number(metadata.Amount) === ENTRY_PRICE;
      const validPhone = normalizePhone(metadata.PhoneNumber) === entry.phone;
      if (!validAmount || !validPhone || !metadata.MpesaReceiptNumber) {
        entry.paymentStatus = 'review';
        entry.failureReason = 'Payment details did not match this entry and need manual review.';
      } else {
        markEntryPaid(state, entry.id, { mpesaReceipt: metadata.MpesaReceiptNumber });
      }
    }
    saveCampaign(state, dataFile);
  } catch (error) {
    entry.paymentStatus = 'review';
    entry.failureReason = 'Payment needs manual review before a refund or entry is issued.';
    saveCampaign(state, dataFile);
    console.error(error.message);
  }
  return response.json({ ResultCode: 0, ResultDesc: 'Accepted' });
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

app.get('/api/entries/:entryId', (request, response) => {
  const entry = findEntry(request.params.entryId);
  if (!entry) return response.status(404).json({ error: 'Entry not found.' });
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
    console.log(`Payments: ${paymentMode}${paymentMode === 'live' && !darajaConfigured() ? ' (Daraja configuration incomplete)' : ''}.`);
  });

  function shutdown() {
    server.close(() => process.exit(0));
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export default app;
