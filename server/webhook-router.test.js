import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const secret = 'sk_test_shared_router_secret';
const dataFile = path.join(os.tmpdir(), `detty-router-${process.pid}-${Date.now()}.json`);
process.env.DATA_FILE = dataFile;
process.env.PAYMENTS_MODE = 'demo';
process.env.PAYSTACK_SECRET_KEY = secret;
process.env.PAYSTACK_WEBHOOK_FORWARD_URL = 'https://existing-project.example/api/paystack';
process.env.NODE_ENV = 'production';
delete process.env.VERCEL;

const { default: app } = await import('./index.js');

function localRequest(server, { method = 'GET', route, body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path: route,
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      } : headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: response.statusCode, body: JSON.parse(text) });
        } catch {
          resolve({ status: response.statusCode, body: text });
        }
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function signedBody(body) {
  return crypto.createHmac('sha512', secret).update(Buffer.from(body)).digest('hex');
}

test('shared router preserves the existing receiver path without changing the demo campaign', async () => {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const originalFetch = globalThis.fetch;
  const forwarded = [];
  let receiverStatus = 200;
  globalThis.fetch = async (url, options) => {
    forwarded.push({ url, options });
    return new Response(null, { status: receiverStatus });
  };

  try {
    const before = await localRequest(server, { route: '/api/campaign/ledger' });
    const rawBody = '{"event":"charge.success","data":{"reference":"DD-other-project"}}';
    const signature = signedBody(rawBody);
    const forwardedResponse = await localRequest(server, {
      method: 'POST',
      route: '/api/payments/paystack/router',
      body: rawBody,
      headers: { 'x-paystack-signature': signature },
    });
    assert.equal(forwardedResponse.status, 200);
    assert.deepEqual(forwardedResponse.body, { received: true, forwarded: true });
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].options.body.toString(), rawBody);
    assert.equal(forwarded[0].options.headers['x-paystack-signature'], signature);

    const invalidResponse = await localRequest(server, {
      method: 'POST',
      route: '/api/payments/paystack/router',
      body: rawBody,
      headers: { 'x-paystack-signature': 'invalid' },
    });
    assert.equal(invalidResponse.status, 401);
    assert.equal(forwarded.length, 1);

    const directDemoResponse = await localRequest(server, {
      method: 'POST',
      route: '/api/payments/paystack/webhook',
      body: rawBody,
      headers: { 'x-paystack-signature': signature },
    });
    assert.equal(directDemoResponse.status, 403);
    assert.equal(forwarded.length, 1);

    receiverStatus = 503;
    const failedForward = await localRequest(server, {
      method: 'POST',
      route: '/api/payments/paystack/router',
      body: rawBody,
      headers: { 'x-paystack-signature': signature },
    });
    assert.equal(failedForward.status, 502);
    assert.equal(forwarded.length, 2);

    const after = await localRequest(server, { route: '/api/campaign/ledger' });
    assert.equal(after.body.commitment, before.body.commitment);
    assert.equal(after.body.ledgerHead, before.body.ledgerHead);
    assert.equal(after.body.ledgerLength, before.body.ledgerLength);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataFile, { force: true });
  }
});
