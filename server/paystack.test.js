import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  initiatePaystackMpesa,
  isValidEntryAccessCode,
  isValidPaystackSignature,
  paystackConfigured,
  validatePaystackTransaction,
  verifyPaystackTransaction,
} from './paystack.js';

const secretKey = 'sk_live_unit_test_only';
const reference = 'DD-entry-1';
const entry = { id: 'entry-1', paystackReference: reference };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function successfulTransaction() {
  return {
    id: 123456,
    status: 'success',
    reference,
    domain: 'live',
    channel: 'mobile_money',
    currency: 'KES',
    amount: 50_000,
    metadata: { entryId: entry.id },
  };
}

test('requires a live Paystack secret for live charges', () => {
  assert.equal(paystackConfigured({ secretKey: 'sk_test_example' }), true);
  assert.equal(paystackConfigured({ live: true, secretKey: 'sk_test_example' }), false);
  assert.equal(paystackConfigured({ live: true, secretKey }), true);
  assert.equal(paystackConfigured({ live: true, secretKey: '' }), false);
});

test('invite-only live checkout accepts the exact access code and fails closed when configured', () => {
  assert.equal(isValidEntryAccessCode('anything', ''), true);
  assert.equal(isValidEntryAccessCode('correct-private-code', 'correct-private-code'), true);
  assert.equal(isValidEntryAccessCode('wrong-private-code', 'correct-private-code'), false);
  assert.equal(isValidEntryAccessCode('', 'correct-private-code'), false);
  assert.equal(isValidEntryAccessCode(undefined, 'correct-private-code'), false);
});

test('creates a Paystack M-Pesa charge with the exact KES subunit amount and entry metadata', async () => {
  let request;
  const result = await initiatePaystackMpesa({
    phone: '254712345678',
    email: 'user@example.com',
    amount: 500,
    entryId: entry.id,
    campaignId: 'detty-dezemba-dec-2026',
    reference,
    secretKey,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ status: true, data: { reference, status: 'pay_offline' } });
    },
  });
  assert.equal(result.status, 'pay_offline');
  assert.equal(request.url, 'https://api.paystack.co/charge');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, `Bearer ${secretKey}`);
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.amount, 50_000);
  assert.equal(payload.currency, 'KES');
  assert.equal(payload.email, 'user@example.com');
  assert.equal(payload.reference, reference);
  assert.deepEqual(payload.mobile_money, { phone: '+254712345678', provider: 'mpesa' });
  assert.deepEqual(payload.metadata, { entryId: entry.id, campaignId: 'detty-dezemba-dec-2026' });
});

test('formats Kenyan 01 and 07 M-Pesa numbers with one international prefix', async () => {
  for (const [phone, expected] of [
    ['254112345678', '+254112345678'],
    ['+254712345678', '+254712345678'],
  ]) {
    let payload;
    await initiatePaystackMpesa({
      phone,
      email: 'user@example.com',
      amount: 500,
      entryId: entry.id,
      campaignId: 'campaign',
      reference,
      secretKey,
      fetchImpl: async (url, options) => {
        payload = JSON.parse(options.body);
        return jsonResponse({ status: true, data: { reference, status: 'pay_offline' } });
      },
    });
    assert.equal(payload.mobile_money.phone, expected);
  }
});

test('treats a mismatched charge reference as ambiguous and blocks automatic entry', async () => {
  await assert.rejects(
    initiatePaystackMpesa({
      phone: '254712345678',
      email: 'user@example.com',
      amount: 500,
      entryId: entry.id,
      campaignId: 'campaign',
      reference,
      secretKey,
      fetchImpl: async () => jsonResponse({ status: true, data: { reference: 'different-reference' } }),
    }),
    (error) => error.ambiguous === true && /mismatched/.test(error.message),
  );
});

test('verifies a transaction by reference and accepts only the matching live payment', async () => {
  const transaction = successfulTransaction();
  let requestedUrl;
  const data = await verifyPaystackTransaction(reference, {
    secretKey,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return jsonResponse({ status: true, data: transaction });
    },
  });
  assert.equal(requestedUrl, `https://api.paystack.co/transaction/verify/${reference}`);
  assert.equal(data.id, 123456);
  assert.deepEqual(validatePaystackTransaction(data, entry), { valid: true });
});

test('rejects successful-looking transactions with mismatched payment details', () => {
  const invalidCases = [
    { status: 'pending' },
    { reference: 'wrong-reference' },
    { domain: 'test' },
    { channel: 'card' },
    { currency: 'USD' },
    { amount: 49_999 },
    { metadata: { entryId: 'another-entry' } },
  ];
  for (const patch of invalidCases) {
    assert.equal(validatePaystackTransaction({ ...successfulTransaction(), ...patch }, entry).valid, false);
  }
});

test('validates Paystack webhook signatures against the raw body', () => {
  const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference } }));
  const signature = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  assert.equal(isValidPaystackSignature(rawBody, signature, secretKey), true);
  assert.equal(isValidPaystackSignature(Buffer.from('{"tampered":true}'), signature, secretKey), false);
  assert.equal(isValidPaystackSignature(rawBody, signature, 'sk_live_wrong_key'), false);
  assert.equal(isValidPaystackSignature(rawBody, 'not-a-signature', secretKey), false);
  assert.equal(isValidPaystackSignature(rawBody, null, secretKey), false);
});

test('uses the server environment key in the Authorization header when no override is provided', async () => {
  const previous = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = secretKey;
  let authorization;
  try {
    await initiatePaystackMpesa({
      phone: '254712345678',
      email: 'user@example.com',
      amount: 500,
      entryId: entry.id,
      campaignId: 'campaign',
      reference,
      fetchImpl: async (url, options) => {
        authorization = options.headers.Authorization;
        return jsonResponse({ status: true, data: { reference, status: 'pay_offline' } });
      },
    });
  } finally {
    if (previous === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = previous;
  }
  assert.equal(authorization, `Bearer ${secretKey}`);
});
