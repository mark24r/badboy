import crypto from 'node:crypto';

const PAYSTACK_API_BASE = 'https://api.paystack.co';

export function paystackConfigured({ live = false, secretKey = process.env.PAYSTACK_SECRET_KEY } = {}) {
  if (!secretKey) return false;
  return live ? secretKey.startsWith('sk_live_') : true;
}

function requireLiveSecret(secretKey) {
  if (!paystackConfigured({ live: true, secretKey })) {
    const error = new Error('Live Paystack payments are not configured. Add a live PAYSTACK_SECRET_KEY on the server.');
    error.status = 503;
    throw error;
  }
  return secretKey;
}

async function paystackRequest(path, { method = 'GET', body, secretKey, fetchImpl = fetch } = {}) {
  const key = requireLiveSecret(secretKey);
  let response;
  try {
    response = await fetchImpl(`${PAYSTACK_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
    });
  } catch (cause) {
    const error = new Error('Could not reach Paystack to confirm the payment status.');
    error.status = 502;
    error.ambiguous = true;
    error.cause = cause;
    throw error;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== true || !payload.data) {
    const error = new Error(payload.message || 'Paystack could not process the payment request.');
    error.status = response.status >= 400 && response.status < 500 ? 400 : 502;
    error.ambiguous = response.status >= 500 || (response.ok && payload.status !== false);
    throw error;
  }
  return payload.data;
}

export function paystackReferenceForEntry(entryId) {
  return `DD-${entryId}`;
}

export async function initiatePaystackMpesa({
  phone,
  email,
  amount,
  entryId,
  campaignId,
  reference,
  secretKey,
  fetchImpl,
}) {
  const data = await paystackRequest('/charge', {
    method: 'POST',
    body: {
      email,
      amount: Math.round(amount * 100),
      currency: 'KES',
      reference,
      mobile_money: {
        phone,
        provider: 'mpesa',
      },
      metadata: {
        entryId,
        campaignId,
      },
    },
    secretKey,
    fetchImpl,
  });
  if (data.reference !== reference) {
    const error = new Error('Paystack returned a mismatched payment reference. Reconcile this charge before retrying.');
    error.status = 502;
    error.ambiguous = true;
    throw error;
  }
  return data;
}

export async function verifyPaystackTransaction(reference, { secretKey, fetchImpl } = {}) {
  return paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, { secretKey, fetchImpl });
}

export function validatePaystackTransaction(data, entry, { amount = 500 } = {}) {
  if (!data || data.status !== 'success') return { valid: false, reason: 'Paystack has not confirmed a successful payment.' };
  if (data.reference !== entry.paystackReference) return { valid: false, reason: 'The Paystack reference does not match this entry.' };
  if (data.domain !== 'live') return { valid: false, reason: 'The transaction is not a live Paystack payment.' };
  if (data.channel !== 'mobile_money') return { valid: false, reason: 'The transaction was not paid through mobile money.' };
  if (data.currency !== 'KES' || Number(data.amount) !== Math.round(amount * 100)) {
    return { valid: false, reason: 'The paid amount or currency does not match this entry.' };
  }
  if (data.metadata?.entryId !== entry.id) return { valid: false, reason: 'The Paystack metadata does not match this entry.' };
  return { valid: true };
}

export function paystackSignature(rawBody, secretKey = process.env.PAYSTACK_SECRET_KEY) {
  return crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
}

export function isValidPaystackSignature(rawBody, signature, secretKey = process.env.PAYSTACK_SECRET_KEY) {
  if (!rawBody || !signature || !secretKey) return false;
  const expected = paystackSignature(rawBody, secretKey);
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(String(signature), 'utf8');
  return expectedBytes.length === providedBytes.length && crypto.timingSafeEqual(expectedBytes, providedBytes);
}
