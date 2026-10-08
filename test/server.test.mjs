import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApp } from '../src/server.mjs';

function invoke(app, { path, method = 'GET', body, host = '127.0.0.1:4178', origin, contentType = 'application/json' }) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
    req.url = path; req.method = method; req.headers = { host, 'content-type': contentType, ...(origin ? { origin } : {}) };
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value) { try { resolve({ status: this.status, headers: this.headers, body: JSON.parse(value) }); } catch (e) { reject(e); } } };
    app.emit('request', req, res);
  });
}
test('replay API executes actual local inference with evidence and does not require credentials', async () => {
  const app = createApp({ env: {} });
  const r = await invoke(app, { path: '/api/replay', method: 'POST', body: { scenarioId: 'duplicate-storm' } });
  assert.equal(r.status, 200); assert.equal(r.body.protected.paidCents, 24000); assert.equal(r.body.ai.source, 'trained-local-ml'); assert.equal(r.body.ai.key, 'duplicate_delivery'); assert.equal(r.body.evidenceHash.length, 64);
});
test('status and probe fail clearly with no sandbox credentials and cannot claim execution', async () => {
  let calls = 0; const app = createApp({ env: {}, sandboxProbe: async () => { calls++; } });
  const status = await invoke(app, { path: '/api/status' }); assert.equal(status.body.paypal.configured, false); assert.equal(status.body.paypal.executed, false);
  const probe = await invoke(app, { path: '/api/sandbox/probe', method: 'POST', body: {} }); assert.equal(probe.status, 503); assert.equal(calls, 0);
});
test('cross-origin and DNS-rebinding hosts cannot read or mutate local API', async () => {
  const app = createApp({ env: {} });
  for (const input of [{ host: 'attacker.test:4178' }, { origin: 'https://attacker.test' }, { origin: 'null' }]) assert.equal((await invoke(app, { path: '/api/status', ...input })).status, 403);
  assert.equal((await invoke(app, { path: '/api/status', origin: 'http://127.0.0.1:4178' })).status, 200);
});
test('request content, shape, delivery IDs and body size are validated', async () => {
  const app = createApp({ env: {} }); const base = { path: '/api/replay', method: 'POST' };
  const invalid = [ { body: '{bad', expected: 400 }, { body: [], expected: 400 }, { body: { scenarioId: 'none' }, expected: 404 }, { body: { scenarioId: 'duplicate-storm', reverse: 'true' }, expected: 400 }, { body: { scenarioId: 'duplicate-storm', dropDeliveryIds: ['D2-injected'] }, expected: 400 }, { body: '{}', contentType: 'text/plain', expected: 415 }, { body: 'x'.repeat(17000), expected: 413 } ];
  for (const { expected, ...input } of invalid) assert.equal((await invoke(app, { ...base, ...input })).status, expected);
});
test('sandbox stub evidence stays contract-test and repeated probe shares one result', async () => {
  let calls = 0; const app = createApp({ env: { PAYPAL_SANDBOX_ACCESS_TOKEN: 'stub-for-test-only' }, sandboxProbe: async () => { calls++; return { invoiceId: 'STUB', executed: false, source: 'contract-test' }; } });
  for (let i = 0; i < 2; i++) { const r = await invoke(app, { path: '/api/sandbox/probe', method: 'POST', body: {} }); assert.equal(r.body.executed, false); }
  assert.equal(calls, 1); assert.equal((await invoke(app, { path: '/api/status' })).body.paypal.executed, false);
  assert.equal((await invoke(app, { path: '/api/scenarios' })).body.scenarios.length, 6);
});
test('observed draft anchors an explicitly simulated delivery only after reported native probe success (server contract stub)', async () => {
  const app = createApp({ env: { PAYPAL_SANDBOX_ACCESS_TOKEN: 'server-contract-stub-only' }, sandboxProbe: async () => ({ invoiceId: 'INV2-TEST-0000-0000-0001', status: 'DRAFT', executed: true, source: 'paypal-sandbox', at: '2026-10-08T10:00:00.000Z', apiCalls: [{ method: 'GET', path: '/v2/invoicing/invoices/INV2-TEST-0000-0000-0001', status: 200 }], snapshot: { status: 'DRAFT', totalCents: 100, currency: 'USD' } }) });
  assert.equal((await invoke(app, { path: '/api/replay', method: 'POST', body: { scenarioId: 'sandbox-draft-guard' } })).status, 404);
  const probe = await invoke(app, { path: '/api/sandbox/probe', method: 'POST', body: {} }); assert.equal(probe.body.replayScenarioId, 'sandbox-draft-guard');
  const list = await invoke(app, { path: '/api/scenarios' }); assert.equal(list.body.scenarios.length, 7); assert.equal(list.body.scenarios[6].sandboxAnchored, true);
  const replay = await invoke(app, { path: '/api/replay', method: 'POST', body: { scenarioId: 'sandbox-draft-guard' } });
  assert.equal(replay.body.snapshot.source, 'paypal-sandbox'); assert.equal(replay.body.protected.status, 'DRAFT'); assert.equal(replay.body.protected.paidCents, 0); assert.equal(replay.body.naive.paidCents, 100); assert.equal(replay.body.scenario.synthetic, true); assert.equal(replay.body.inputEvidence.deliveries[0].verificationSource, 'fixture-assumption');
});
