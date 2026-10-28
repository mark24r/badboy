import test from 'node:test';
import assert from 'node:assert/strict';
import {
  forwardPaystackWebhook,
  normalizeWebhookForwardUrl,
} from './webhook-forwarder.js';

test('forwarding preserves the exact raw webhook body and Paystack signature', async () => {
  const rawBody = Buffer.from('{"event":"charge.success","data":{"id":1}}');
  const signature = 'a'.repeat(128);
  let request;
  const result = await forwardPaystackWebhook({
    url: 'https://existing-project.example/api/paystack',
    rawBody,
    signature,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200 };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://existing-project.example/api/paystack');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.body, rawBody);
  assert.equal(request.options.headers['x-paystack-signature'], signature);
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.equal(request.options.redirect, 'manual');
  assert.ok(request.options.signal);
});

test('forwarding rejects insecure URLs and URLs with embedded credentials', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, status: 200 };
  };
  await assert.rejects(
    forwardPaystackWebhook({ url: 'http://insecure.example/hook', rawBody: '{}', signature: 'signed', fetchImpl }),
    /must be HTTPS/,
  );
  await assert.rejects(
    forwardPaystackWebhook({ url: 'https://user:secret@example.com/hook', rawBody: '{}', signature: 'signed', fetchImpl }),
    /without embedded credentials/,
  );
  assert.equal(called, false);
  assert.equal(normalizeWebhookForwardUrl(''), null);
});

test('a non-success response from the existing receiver triggers a retryable failure', async () => {
  await assert.rejects(
    forwardPaystackWebhook({
      url: 'https://existing-project.example/hook',
      rawBody: '{}',
      signature: 'signed',
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    (error) => error.status === 502 && /HTTP 503/.test(error.message),
  );
});

test('a forwarding network error does not expose the existing receiver URL', async () => {
  await assert.rejects(
    forwardPaystackWebhook({
      url: 'https://private-existing-project.example/hook',
      rawBody: '{}',
      signature: 'signed',
      fetchImpl: async () => { throw new Error('Connection refused'); },
    }),
    (error) => error.status === 502
      && /Could not reach/.test(error.message)
      && !error.message.includes('private-existing-project'),
  );
});
