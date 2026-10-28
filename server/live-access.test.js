import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataFile = path.join(os.tmpdir(), `detty-live-access-${process.pid}-${Date.now()}.json`);
process.env.DATA_FILE = dataFile;
process.env.PAYMENTS_MODE = 'live';
process.env.PAYSTACK_SECRET_KEY = 'sk_live_access_test_no_network';
process.env.LIVE_ENTRY_ACCESS_CODE = 'correct-private-test-code';
process.env.NODE_ENV = 'production';
delete process.env.VERCEL;
delete process.env.CAMPAIGN_STORAGE_KEY;

const { default: app } = await import('./index.js');

function localRequest(server, { route, body = null, method = 'GET' }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: route,
      method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

test('invite-only live checkout blocks public visitors before Paystack or storage mutation', async () => {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error('Paystack must not be called without the private access code.');
  };

  try {
    const campaign = await localRequest(server, { route: '/api/campaign' });
    assert.equal(campaign.body.paymentMode, 'live');
    assert.equal(campaign.body.entryAccessRequired, true);

    for (const accessCode of [undefined, 'wrong-code']) {
      const response = await localRequest(server, {
        method: 'POST',
        route: '/api/payments/initiate',
        body: JSON.stringify({
          phone: '0712345678',
          email: 'customer@example.com',
          acceptedTerms: true,
          accessCode,
        }),
      });
      assert.equal(response.status, 403);
      assert.match(response.body.error, /invited testers/);
    }
    assert.equal(networkCalls, 0);
    const stored = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(stored.entries.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataFile, { force: true });
  }
});
