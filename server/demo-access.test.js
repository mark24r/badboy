import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataFile = path.join(os.tmpdir(), `detty-demo-access-${process.pid}-${Date.now()}.json`);
process.env.DATA_FILE = dataFile;
process.env.PAYMENTS_MODE = 'demo';
process.env.ENTRY_ACCESS_CODE = 'correct-private-demo-code';
process.env.NODE_ENV = 'production';
delete process.env.LIVE_ENTRY_ACCESS_CODE;
delete process.env.PAYSTACK_SECRET_KEY;
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

test('invite-only demo checkout blocks strangers and completes without Paystack or a real charge', async () => {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error('Demo checkout must not call Paystack.');
  };

  try {
    const campaign = await localRequest(server, { route: '/api/campaign' });
    assert.equal(campaign.body.paymentMode, 'demo');
    assert.equal(campaign.body.entryAccessRequired, true);
    assert.equal(campaign.body.livePaymentsConfigured, false);

    const initialEntries = JSON.parse(fs.readFileSync(dataFile, 'utf8')).entries.length;
    for (const accessCode of [undefined, 'wrong-code']) {
      const response = await localRequest(server, {
        method: 'POST',
        route: '/api/payments/initiate',
        body: JSON.stringify({
          phone: '0712345678',
          acceptedTerms: true,
          accessCode,
        }),
      });
      assert.equal(response.status, 403);
      assert.match(response.body.error, /invited testers/);
    }
    assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8')).entries.length, initialEntries);

    const initiated = await localRequest(server, {
      method: 'POST',
      route: '/api/payments/initiate',
      body: JSON.stringify({
        phone: '0712345678',
        acceptedTerms: true,
        accessCode: 'correct-private-demo-code',
      }),
    });
    assert.equal(initiated.status, 202);
    assert.equal(initiated.body.mode, 'demo');
    assert.equal(initiated.body.entry.paymentStatus, 'pending');
    assert.match(initiated.body.message, /No real payment/);

    const completed = await localRequest(server, {
      method: 'POST',
      route: '/api/demo/complete-payment',
      body: JSON.stringify({ entryId: initiated.body.entry.id }),
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.entry.paymentStatus, 'paid');
    assert.equal(completed.body.entry.spinStatus, 'ready');

    const spun = await localRequest(server, {
      method: 'POST',
      route: `/api/entries/${initiated.body.entry.id}/spin`,
      body: '{}',
    });
    assert.equal(spun.status, 200);
    assert.equal(spun.body.entry.spinStatus, 'completed');
    assert.ok(spun.body.entry.receipt);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataFile, { force: true });
  }
});
