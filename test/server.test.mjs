import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';

// Only authored contract fixtures are used. Block networking even if a regression
// accidentally reconnects the browser-facing route to the adapter.
const originalFetch = globalThis.fetch;
let networkCalls = 0;
before(() => {
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error('Network requests are forbidden in synthetic server tests');
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(networkCalls, 0, 'the server must not make any native API requests');
});

function invoke(app, { path, method = 'GET', body, host = '127.0.0.1:4178', origin, contentType = 'application/json' }) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
    req.url = path; req.method = method; req.headers = { host, 'content-type': contentType, ...(origin ? { origin } : {}) };
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value) { try { resolve({ status: this.status, headers: this.headers, body: JSON.parse(value) }); } catch (e) { reject(e); } } };
    app.emit('request', req, res);
  });
}

function syntheticContractRecord(invoiceId = 'INV2-TEST-0000-0000-0001', at = '2026-10-08T10:00:00.000Z') {
  return {
    invoiceId, status: 'DRAFT', executed: true, source: 'paypal-sandbox', at,
    apiCalls: [
      { method: 'POST', path: '/v2/invoicing/invoices', status: 201, debugId: 'synthetic-create' },
      { method: 'GET', path: `/v2/invoicing/invoices/${invoiceId}`, status: 200, debugId: null }
    ],
    snapshot: { status: 'DRAFT', totalCents: 100, currency: 'USD' }
  };
}

function temporaryRecord(t, record = syntheticContractRecord()) {
  const directory = mkdtempSync(join(tmpdir(), 'invoice-replay-contract-'));
  const evidencePath = join(directory, 'synthetic-sandbox-contract.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(evidencePath, typeof record === 'string' ? record : JSON.stringify(record));
  return evidencePath;
}

function canonicalResponse(record) {
  return { ...record, recorded: true, reused: true, observedAt: record.at, replayScenarioId: 'sandbox-draft-guard' };
}

test('replay API executes actual local inference with evidence and does not require credentials', async () => {
  const app = createApp({ env: {}, evidencePath: null });
  const r = await invoke(app, { path: '/api/replay', method: 'POST', body: { scenarioId: 'duplicate-storm' } });
  assert.equal(r.status, 200); assert.equal(r.body.protected.paidCents, 24000); assert.equal(r.body.ai.source, 'trained-local-ml'); assert.equal(r.body.ai.key, 'duplicate_delivery'); assert.equal(r.body.evidenceHash.length, 64);
});

test('offline status and evidence fail clearly; credentials and probe injection cannot enable mutation', async () => {
  for (const env of [{}, { PAYPAL_SANDBOX_ACCESS_TOKEN: 'synthetic-token-never-sent' }]) {
    let calls = 0;
    const app = createApp({ env, evidencePath: null, sandboxProbe: async () => { calls++; throw new Error('A live probe must never run'); } });
    const status = await invoke(app, { path: '/api/status' });
    assert.equal(status.status, 200);
    assert.equal(status.body.paypal.configured, Boolean(env.PAYPAL_SANDBOX_ACCESS_TOKEN));
    assert.equal(status.body.paypal.executed, false);
    for (let i = 0; i < 2; i++) {
      const evidence = await invoke(app, { path: '/api/sandbox/evidence' });
      assert.equal(evidence.status, 404); assert.equal(evidence.body.code, 'NO_RECORDED_SANDBOX_EVIDENCE');
      const probe = await invoke(app, { path: '/api/sandbox/probe', method: 'POST', body: {} });
      assert.equal(probe.status, 409); assert.equal(probe.body.code, 'SANDBOX_MUTATION_DISABLED');
    }
    assert.equal(calls, 0);
    assert.equal((await invoke(app, { path: '/api/scenarios' })).body.scenarios.length, 6);
    assert.equal((await invoke(app, { path: '/api/replay', method: 'POST', body: { scenarioId: 'sandbox-draft-guard' } })).status, 404);
  }
});

test('missing or invalid local records fail closed and never call the supplied probe', async t => {
  const valid = syntheticContractRecord();
  for (const raw of [null, '{bad', JSON.stringify([]), JSON.stringify({ ...valid, source: 'contract-test', executed: false }), JSON.stringify({ ...valid, apiCalls: [valid.apiCalls[1]] }), JSON.stringify({ ...valid, snapshot: { status: 'PAID', totalCents: 100, currency: 'USD' } })]) {
    const evidencePath = temporaryRecord(t, raw === null ? '' : raw);
    if (raw === null) unlinkSync(evidencePath);
    let calls = 0;
    const app = createApp({ env: { PAYPAL_SANDBOX_ACCESS_TOKEN: 'synthetic-token-never-sent' }, evidencePath, sandboxProbe: async () => { calls++; return valid; } });
    const evidence = await invoke(app, { path: '/api/sandbox/evidence' });
    assert.equal(evidence.status, 404); assert.equal(evidence.body.code, 'NO_RECORDED_SANDBOX_EVIDENCE');
    const probe = await invoke(app, { path: '/api/sandbox/probe', method: 'POST', body: valid });
    assert.equal(probe.status, 409); assert.equal(probe.body.code, 'SANDBOX_MUTATION_DISABLED');
    assert.equal((await invoke(app, { path: '/api/status' })).body.paypal.executed, false);
    assert.equal(calls, 0);
  }
});

test('cross-origin and DNS-rebinding hosts cannot read or mutate local API', async () => {
  const app = createApp({ env: {}, evidencePath: null });
  for (const input of [{ host: 'attacker.test:4178' }, { origin: 'https://attacker.test' }, { origin: 'null' }]) {
    assert.equal((await invoke(app, { path: '/api/status', ...input })).status, 403);
    assert.equal((await invoke(app, { path: '/api/sandbox/evidence', ...input })).status, 403);
    assert.equal((await invoke(app, { path: '/api/sandbox/probe', method: 'POST', body: {}, ...input })).status, 403);
  }
  assert.equal((await invoke(app, { path: '/api/status', origin: 'http://127.0.0.1:4178' })).status, 200);
});

test('request content, shape, delivery IDs and body size are validated', async () => {
  const app = createApp({ env: {}, evidencePath: null }); const base = { path: '/api/replay', method: 'POST' };
  const invalid = [ { body: '{bad', expected: 400 }, { body: [], expected: 400 }, { body: { scenarioId: 'none' }, expected: 404 }, { body: { scenarioId: 'duplicate-storm', reverse: 'true' }, expected: 400 }, { body: { scenarioId: 'duplicate-storm', dropDeliveryIds: ['D2-injected'] }, expected: 400 }, { body: '{}', contentType: 'text/plain', expected: 415 }, { body: 'x'.repeat(17000), expected: 413 } ];
  for (const { expected, ...input } of invalid) assert.equal((await invoke(app, { ...base, ...input })).status, expected);
});

test('recorded evidence loads at startup without credentials and legacy POST reuses only the cached record', async t => {
  const record = syntheticContractRecord();
  const evidencePath = temporaryRecord(t, record);
  let calls = 0;
  const app = createApp({ env: {}, evidencePath, sandboxProbe: async () => { calls++; throw new Error('A live probe must never run'); } });
  const status = await invoke(app, { path: '/api/status' });
  assert.equal(status.body.paypal.configured, false); assert.equal(status.body.paypal.executed, true);
  assert.equal(status.body.paypal.invoiceId, record.invoiceId); assert.equal(status.body.paypal.at, record.at);
  const responses = [
    await invoke(app, { path: '/api/sandbox/evidence' }),
    await invoke(app, { path: '/api/sandbox/probe', method: 'POST', body: { evidencePath: '/ignored/browser/path', evidence: syntheticContractRecord('INV2-FAKE-0000-0000-0002') } })
  ];
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, canonicalResponse(record));
  }
  assert.equal(calls, 0);
});

test('browser payloads cannot preload sandbox evidence while the app is offline', async () => {
  const app = createApp({ env: {}, evidencePath: null });
  for (const body of [syntheticContractRecord(), { evidence: syntheticContractRecord(), evidencePath: '/tmp/browser-supplied-record.json', recorded: true }]) {
    const response = await invoke(app, { path: '/api/sandbox/probe', method: 'POST', body });
    assert.equal(response.status, 409); assert.equal(response.body.code, 'SANDBOX_MUTATION_DISABLED');
  }
  assert.equal((await invoke(app, { path: '/api/sandbox/evidence' })).status, 404);
  assert.equal((await invoke(app, { path: '/api/status' })).body.paypal.executed, false);
});

test('restarts load the local record once; overwrites and deletion cannot change a running observation', async t => {
  const first = syntheticContractRecord();
  const evidencePath = temporaryRecord(t, first);
  const app = createApp({ env: {}, evidencePath });
  const initial = await invoke(app, { path: '/api/sandbox/evidence' });
  assert.equal(initial.status, 200);
  const restarted = createApp({ env: {}, evidencePath });
  assert.deepEqual((await invoke(restarted, { path: '/api/sandbox/evidence' })).body, initial.body);
  const replacement = syntheticContractRecord('INV2-TEST-0000-0000-0002', '2026-10-09T11:00:00.000Z');
  writeFileSync(evidencePath, JSON.stringify(replacement));
  assert.deepEqual((await invoke(app, { path: '/api/sandbox/evidence' })).body, initial.body);
  const updatedRestart = createApp({ env: {}, evidencePath });
  const updated = await invoke(updatedRestart, { path: '/api/sandbox/evidence' });
  assert.equal(updated.body.invoiceId, replacement.invoiceId); assert.equal(updated.body.observedAt, replacement.at);
  unlinkSync(evidencePath);
  for (const runningApp of [app, restarted]) {
    assert.deepEqual((await invoke(runningApp, { path: '/api/sandbox/evidence' })).body, initial.body);
    assert.deepEqual((await invoke(runningApp, { path: '/api/sandbox/probe', method: 'POST', body: {} })).body, initial.body);
    assert.equal((await invoke(runningApp, { path: '/api/status' })).body.paypal.invoiceId, first.invoiceId);
  }
  assert.deepEqual((await invoke(updatedRestart, { path: '/api/sandbox/evidence' })).body, updated.body);
  assert.equal((await invoke(createApp({ env: {}, evidencePath }), { path: '/api/sandbox/evidence' })).status, 404);
});

test('cached evidence and replay output strip unexpected credential and customer fields', async t => {
  const record = syntheticContractRecord();
  const marker = 'synthetic-sensitive-marker-never-exposed';
  const raw = { ...record, accessToken: marker, responseBody: { customer: marker }, invoiceUrl: `https://example.test/${marker}`, recorded: false, reused: false, observedAt: marker, snapshot: { ...record.snapshot, customer: marker }, apiCalls: record.apiCalls.map(call => ({ ...call, authorization: marker, body: marker })) };
  const app = createApp({ env: {}, evidencePath: temporaryRecord(t, raw) });
  const evidence = await invoke(app, { path: '/api/sandbox/evidence' });
  assert.equal(evidence.status, 200);
  assert.deepEqual(evidence.body, canonicalResponse(record));
  const replay = await invoke(app, { path: '/api/replay', method: 'POST', body: { scenarioId: 'sandbox-draft-guard' } });
  assert.equal(replay.status, 200);
  assert.equal(JSON.stringify({ evidence: evidence.body, replay: replay.body }).includes(marker), false);
});

test('an explicit public contract record is a credential-free fallback only when the private file is missing', async t => {
  const record = syntheticContractRecord();
  const publicEvidencePath = temporaryRecord(t, { ...record, recordedEvidence: true, scope: 'synthetic test fixture; no native API execution' });
  const evidencePath = `${publicEvidencePath}.private`;
  let calls = 0;
  const options = { env: {}, evidencePath, publicEvidencePath, sandboxProbe: async () => { calls++; throw new Error('A live probe must never run'); } };
  const fallback = await invoke(createApp(options), { path: '/api/sandbox/evidence' });
  assert.equal(fallback.status, 200); assert.deepEqual(fallback.body, canonicalResponse(record));
  assert.equal((await invoke(createApp(options), { path: '/api/status' })).body.paypal.configured, false);
  writeFileSync(evidencePath, '{bad');
  const invalidPrivate = await invoke(createApp(options), { path: '/api/sandbox/evidence' });
  assert.equal(invalidPrivate.status, 404); assert.equal(invalidPrivate.body.code, 'NO_RECORDED_SANDBOX_EVIDENCE');
  const privateRecord = syntheticContractRecord('INV2-TEST-0000-0000-0002');
  writeFileSync(evidencePath, JSON.stringify(privateRecord));
  assert.deepEqual((await invoke(createApp(options), { path: '/api/sandbox/evidence' })).body, canonicalResponse(privateRecord));
  assert.equal(calls, 0);
});

test('recorded draft immediately anchors an explicitly imagined untrusted delivery', async t => {
  const record = syntheticContractRecord();
  const app = createApp({ env: {}, evidencePath: temporaryRecord(t, record) });
  const list = await invoke(app, { path: '/api/scenarios' });
  assert.equal(list.body.scenarios.length, 7); assert.equal(list.body.scenarios[6].sandboxAnchored, true); assert.equal(list.body.scenarios[6].invoiceId, record.invoiceId);
  const replay = await invoke(app, { path: '/api/replay', method: 'POST', body: { scenarioId: 'sandbox-draft-guard' } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.snapshot.source, 'paypal-sandbox'); assert.equal(replay.body.snapshot.asOf, record.at);
  assert.equal(replay.body.protected.status, 'DRAFT'); assert.equal(replay.body.protected.paidCents, 0); assert.equal(replay.body.naive.paidCents, 100);
  assert.equal(replay.body.scenario.synthetic, true); assert.equal(replay.body.scenario.invoice.id, record.invoiceId);
  assert.equal(replay.body.inputEvidence.deliveries[0].verificationSource, 'fixture-assumption'); assert.equal(replay.body.inputEvidence.deliveries[0].verified, false);
});
