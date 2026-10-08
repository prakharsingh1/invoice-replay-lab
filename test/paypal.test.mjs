import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createSandboxProbe, paypalStatus, PAYPAL_SANDBOX_ORIGIN, verifySandboxWebhook } from '../src/paypal.mjs';

// These are explicit stubbed REST contract tests, NOT real PayPal integration evidence.
// No test makes a network request or writes a successful integration evidence file.
const invoiceId = 'INV2-AAAA-BBBB-CCCC-DDDD';
const created = { id: invoiceId, status: 'DRAFT' };
const invoice = { ...created, amount: { currency_code: 'USD', value: '1.00' }, invoicer: { email_address: 'private@example.test' } };
const tokenEnv = { PAYPAL_SANDBOX_ACCESS_TOKEN: 'stubbed-token-not-real' };
function reply(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'PayPal-Debug-Id': 'contract-debug-id', ...headers } });
}
function transport(responses) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, ...options });
    assert.ok(responses.length, 'Unexpected contract request');
    return responses.shift();
  };
  return { fetchImpl, requests };
}
function verifyInput(extra = {}) {
  return {
    env: tokenEnv,
    webhookId: 'stub-webhook-id',
    headers: {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-stub',
      'paypal-transmission-id': 'stub-transmission',
      'paypal-transmission-sig': 'stub-signature',
      'paypal-transmission-time': '2026-10-08T00:00:00Z'
    },
    event: { id: 'stub-event', event_type: 'INVOICING.INVOICE.CREATED', resource: created },
    ...extra
  };
}

describe('PayPal REST contract tests (stubbed; no live integration evidence)', () => {
  it('reports configuration without implying execution or exposing credential values', () => {
    assert.deepEqual(paypalStatus({}), { configured: false, executed: false, missing: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'] });
    assert.deepEqual(paypalStatus({ PAYPAL_CLIENT_ID: 'stub-id' }), { configured: false, executed: false, missing: ['PAYPAL_CLIENT_SECRET'] });
    assert.deepEqual(paypalStatus(tokenEnv), { configured: true, executed: false, missing: [] });
    assert.deepEqual(paypalStatus({ PAYPAL_CLIENT_ID: 'stub-id', PAYPAL_CLIENT_SECRET: 'stub-secret' }), { configured: true, executed: false, missing: [] });
    assert.ok(!JSON.stringify(paypalStatus(tokenEnv)).includes('stubbed-token'));
  });

  it('fails before any external operation without credentials', async () => {
    let called = false;
    await assert.rejects(createSandboxProbe({ env: {}, fetchImpl: async () => { called = true; } }), error => error.code === 'MISSING_CREDENTIALS');
    assert.equal(called, false);
  });

  it('uses existing client credentials and returns only a redacted verified draft snapshot', async () => {
    const stub = transport([reply({ access_token: 'stub-issued-token', token_type: 'Bearer', expires_in: 3600 }), reply(created, 201), reply(invoice)]);
    const evidence = await createSandboxProbe({ env: { PAYPAL_CLIENT_ID: 'stub-id', PAYPAL_CLIENT_SECRET: 'stub-secret' }, fetchImpl: stub.fetchImpl });
    assert.equal(stub.requests.length, 3);
    assert.equal(stub.requests[0].url, `${PAYPAL_SANDBOX_ORIGIN}/v1/oauth2/token`);
    assert.equal(stub.requests[0].headers.Authorization, `Basic ${Buffer.from('stub-id:stub-secret').toString('base64')}`);
    assert.equal(stub.requests[0].body, 'grant_type=client_credentials');
    assert.equal(stub.requests[1].headers.Authorization, 'Bearer stub-issued-token');
    assert.equal(stub.requests[1].headers.Prefer, 'return=representation');
    assert.match(stub.requests[1].headers['PayPal-Request-Id'], /^[a-f0-9-]{36}$/);
    const draft = JSON.parse(stub.requests[1].body);
    assert.equal(draft.primary_recipients[0].billing_info.email_address, 'replay-buyer@example.test');
    assert.equal(draft.detail.currency_code, 'USD');
    assert.equal(draft.invoicer, undefined, 'Use authenticated sandbox merchant, not an invented merchant email');
    assert.equal(draft.items[0].unit_amount.value, '1.00');
    assert.match(draft.detail.note, /SYNTHETIC/);
    assert.deepEqual(evidence.snapshot, { status: 'DRAFT', totalCents: 100, currency: 'USD' });
    assert.equal(evidence.invoiceId, invoiceId);
    assert.equal(evidence.source, 'contract-test');
    assert.equal(evidence.executed, false, 'Injected transport must never imply live integration');
    assert.deepEqual(evidence.apiCalls.map(call => call.status), [200, 201, 200]);
    assert.ok(evidence.apiCalls.every(call => call.debugId === 'contract-debug-id'));
    assert.ok(!/stub-secret|stub-issued-token|private@example.test/.test(JSON.stringify(evidence)));
  });

  it('pins all requests to sandbox and rejects HTTP redirects even with a production env override', async () => {
    const stub = transport([reply(created, 201), reply(invoice)]);
    await createSandboxProbe({ env: { ...tokenEnv, PAYPAL_API_BASE: 'https://api-m.paypal.com' }, fetchImpl: stub.fetchImpl });
    assert.deepEqual(stub.requests.map(request => [request.method, new URL(request.url).pathname]), [
      ['POST', '/v2/invoicing/invoices'], ['GET', `/v2/invoicing/invoices/${invoiceId}`]
    ]);
    assert.ok(stub.requests.every(request => new URL(request.url).origin === PAYPAL_SANDBOX_ORIGIN && request.redirect === 'error' && request.signal instanceof AbortSignal));
  });

  it('reuses the same request ID and body across bounded 429 retries', async () => {
    const waits = [];
    const stub = transport([reply({}, 429, { 'retry-after': '500' }), reply({}, 429), reply(created, 201), reply(invoice)]);
    await createSandboxProbe({ env: tokenEnv, fetchImpl: stub.fetchImpl, sleepImpl: async milliseconds => { waits.push(milliseconds); } });
    assert.equal(stub.requests.length, 4);
    assert.equal(new Set(stub.requests.slice(0, 3).map(request => request.headers['PayPal-Request-Id'])).size, 1);
    assert.equal(new Set(stub.requests.slice(0, 3).map(request => request.body)).size, 1);
    assert.deepEqual(waits, [2000, 500]);
  });

  it('stops after three rate-limited attempts and does not claim success', async () => {
    const stub = transport([reply({}, 429), reply({}, 429), reply({}, 429)]);
    await assert.rejects(createSandboxProbe({ env: tokenEnv, fetchImpl: stub.fetchImpl, sleepImpl: async () => {} }), error => error.code === 'API_REJECTED' && error.apiCalls.length === 3);
    assert.equal(stub.requests.length, 3);
  });

  it('uses actual expires_in to cache tokens and refresh before expiration', async () => {
    let now = 100000;
    const stub = transport([
      reply({ access_token: 'stub-first', token_type: 'Bearer', expires_in: 10 }), reply(created, 201), reply(invoice),
      reply(created, 201), reply(invoice),
      reply({ access_token: 'stub-second', token_type: 'Bearer', expires_in: 10 }), reply(created, 201), reply(invoice)
    ]);
    const options = { env: { PAYPAL_CLIENT_ID: 'stub-id-cache', PAYPAL_CLIENT_SECRET: 'stub-secret-cache' }, fetchImpl: stub.fetchImpl, nowImpl: () => now };
    await createSandboxProbe(options);
    now += 8000;
    const cached = await createSandboxProbe(options);
    assert.equal(cached.apiCalls.length, 2);
    now += 1000;
    await createSandboxProbe(options);
    assert.equal(stub.requests.filter(request => request.url.endsWith('/v1/oauth2/token')).length, 2);
    assert.equal(stub.requests[6].headers.Authorization, 'Bearer stub-second');
  });

  it('rejects malformed token responses rather than assuming a lifetime', async () => {
    const stub = transport([reply({ access_token: 'stub-token', token_type: 'Bearer' })]);
    await assert.rejects(createSandboxProbe({ env: { PAYPAL_CLIENT_ID: 'stub-id', PAYPAL_CLIENT_SECRET: 'stub-secret' }, fetchImpl: stub.fetchImpl }), error => error.code === 'INVALID_TOKEN_RESPONSE');
    assert.equal(stub.requests.length, 1);
  });

  it('does not propagate provider error bodies, credential echoes, or raw fetch errors', async () => {
    const stub = transport([reply({ message: 'stubbed-token-not-real private@example.test', debug_id: 'unsafe@example.test' }, 422, { 'paypal-debug-id': 'unsafe@example.test' })]);
    await assert.rejects(createSandboxProbe({ env: tokenEnv, fetchImpl: stub.fetchImpl }), error => {
      assert.equal(error.code, 'API_REJECTED');
      assert.equal(error.apiCalls[0].debugId, null);
      assert.ok(!/stubbed-token|private@example.test|unsafe@example.test/.test(`${error.message}${JSON.stringify(error)}`));
      return true;
    });
    await assert.rejects(createSandboxProbe({ env: tokenEnv, fetchImpl: async () => { throw new Error('secret-fetch-detail'); } }), error => error.code === 'NETWORK_ERROR' && !error.message.includes('secret-fetch-detail') && error.cause === undefined);
  });

  it('fails a hung transport within the configured finite deadline', async () => {
    await assert.rejects(createSandboxProbe({ env: tokenEnv, fetchImpl: () => new Promise(() => {}), timeoutMs: 10 }), error => error.code === 'TIMEOUT');
  });

  it('rejects non-drafts, substituted invoice IDs, and unexpected totals without claiming success', async () => {
    for (const detail of [
      { ...invoice, status: 'PAID' }, { ...invoice, id: 'INV2-EEEE-FFFF-GGGG-HHHH' },
      { ...invoice, amount: { currency_code: 'USD', value: '2.00' } },
      { ...invoice, amount: { currency_code: 'EUR', value: '1.00' } }
    ]) {
      const stub = transport([reply(created, 201), reply(detail)]);
      await assert.rejects(createSandboxProbe({ env: tokenEnv, fetchImpl: stub.fetchImpl }), error => error.code === 'UNEXPECTED_SNAPSHOT');
    }
    const stub = transport([reply({ id: '../send', status: 'DRAFT' }, 201)]);
    await assert.rejects(createSandboxProbe({ env: tokenEnv, fetchImpl: stub.fetchImpl }), error => error.code === 'INVALID_DRAFT_RESPONSE');
    assert.equal(stub.requests.length, 1);
  });

  it('keeps optional webhook verification closed for invalid signatures or unavailable APIs', async () => {
    const stub = transport([reply({ verification_status: 'FAILURE' })]);
    assert.equal((await verifySandboxWebhook(verifyInput({ fetchImpl: stub.fetchImpl }))).verified, false);
    const unavailable = await verifySandboxWebhook(verifyInput({ fetchImpl: async () => { throw new Error('network'); } }));
    assert.equal(unavailable.verified, false);
    assert.equal(unavailable.reason, 'verification-unavailable');
  });

  it('verifies only explicit PayPal SUCCESS and blocks unsafe certificate URLs before network I/O', async () => {
    const stub = transport([reply({ verification_status: 'SUCCESS' })]);
    const verified = await verifySandboxWebhook(verifyInput({ fetchImpl: stub.fetchImpl }));
    assert.equal(verified.verified, true);
    assert.equal(stub.requests[0].url, `${PAYPAL_SANDBOX_ORIGIN}/v1/notifications/verify-webhook-signature`);
    assert.equal(JSON.parse(stub.requests[0].body).webhook_id, 'stub-webhook-id');
    let called = false;
    for (const certUrl of ['https://api-m.paypal.com/v1/notifications/certs/CERT-stub', 'http://127.0.0.1/cert', 'https://api.sandbox.paypal.com.evil.test/v1/notifications/certs/CERT-stub']) {
      const options = verifyInput({ fetchImpl: async () => { called = true; } });
      options.headers['paypal-cert-url'] = certUrl;
      assert.equal((await verifySandboxWebhook(options)).verified, false);
    }
    assert.equal(called, false);
  });

  it('exits 2 without sandbox credentials and cannot silently fabricate probe evidence', () => {
    const env = { ...process.env, PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '', PAYPAL_SANDBOX_ACCESS_TOKEN: '' };
    const result = spawnSync(process.execPath, ['scripts/sandbox-probe.mjs'], { env, encoding: 'utf8', cwd: new URL('..', import.meta.url) });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /NOT executed/);
    assert.match(result.stderr, /No evidence file was written/);
    assert.ok(!result.stdout.includes('executed successfully'));
  });
});
