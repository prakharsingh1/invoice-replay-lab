import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// This adapter has no production endpoint option and no send/payment/refund methods.
export const PAYPAL_SANDBOX_ORIGIN = 'https://api-m.sandbox.paypal.com';
const INVOICES = '/v2/invoicing/invoices';
const TOKEN = '/v1/oauth2/token';
const VERIFY = '/v1/notifications/verify-webhook-signature';
const invoiceIdPattern = /^INV2-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/;
const caches = new WeakMap();

function value(env, name) {
  return typeof env[name] === 'string' ? env[name].trim() : '';
}

export function paypalStatus(env = process.env) {
  const token = value(env, 'PAYPAL_SANDBOX_ACCESS_TOKEN');
  const missing = token ? [] : ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'].filter(name => !value(env, name));
  return { configured: missing.length === 0, executed: false, missing };
}

export class PayPalSandboxError extends Error {
  constructor(code, message, apiCalls = []) {
    super(message);
    this.name = 'PayPalSandboxError';
    this.code = code;
    this.apiCalls = apiCalls.map(call => ({ ...call }));
  }
}

function fail(code, message, calls) {
  throw new PayPalSandboxError(code, message, calls);
}

function safeDebugId(response) {
  const id = response.headers.get('paypal-debug-id');
  return typeof id === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(id) ? id : null;
}

function allowedRequest(method, path) {
  return (method === 'POST' && [TOKEN, INVOICES, VERIFY].includes(path)) ||
    (method === 'GET' && path.startsWith(`${INVOICES}/`) && invoiceIdPattern.test(path.slice(INVOICES.length + 1)));
}

function client({ env, fetchImpl, nowImpl = Date.now, sleepImpl = delay, timeoutMs = 8000 }) {
  const calls = [];
  if (typeof fetchImpl !== 'function') fail('FETCH_UNAVAILABLE', 'A fetch implementation is required.', calls);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 15000) fail('INVALID_TIMEOUT', 'Timeout must be between 1 and 15000 milliseconds.', calls);

  async function request(method, path, { headers, body, expectedStatus, requestId } = {}) {
    if (!allowedRequest(method, path)) fail('OPERATION_BLOCKED', 'This sandbox operation is not allowed.', calls);
    const operationRequestId = method === 'POST' ? requestId ?? randomUUID() : requestId;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      let timer;
      let response;
      let data;
      try {
        // The deadline includes reading the JSON response, not just receiving headers.
        const operation = (async () => {
          const result = await fetchImpl(`${PAYPAL_SANDBOX_ORIGIN}${path}`, {
            method, redirect: 'error', signal: controller.signal,
            headers: { Accept: 'application/json', ...headers, ...(operationRequestId ? { 'PayPal-Request-Id': operationRequestId } : {}) },
            ...(body === undefined ? {} : { body })
          });
          response = result;
          calls.push({ method, path, status: result.status, debugId: safeDebugId(result) });
          // Never retain error response bodies: they can echo credentials or customer fields.
          if (result.status === expectedStatus) return await result.json();
          await result.body?.cancel().catch(() => {});
          return undefined;
        })();
        data = await Promise.race([operation, new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new PayPalSandboxError('TIMEOUT', 'PayPal sandbox request timed out.', calls));
          }, timeoutMs);
        })]);
      } catch (error) {
        if (error instanceof PayPalSandboxError) throw error;
        // Avoid leaking the fetch error, request headers, response body, or cause.
        fail(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR', 'PayPal sandbox request did not complete. Check connectivity and credentials.', calls);
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 429 && attempt < 2) {
        const retryHeader = response.headers.get('retry-after');
        const retry = retryHeader === null || retryHeader.trim() === '' ? NaN : Number(retryHeader);
        const waitMs = Number.isFinite(retry) && retry >= 0 ? Math.min(2000, retry * 1000) : 250 * (2 ** attempt);
        await sleepImpl(waitMs);
        continue;
      }
      if (response.status !== expectedStatus) {
        fail(response.status === 401 ? 'AUTH_REJECTED' : 'API_REJECTED', `PayPal sandbox returned HTTP ${response.status} for ${method} ${path}.`, calls);
      }
      return data;
    }
  }

  async function accessToken() {
    const status = paypalStatus(env);
    if (!status.configured) fail('MISSING_CREDENTIALS', `Missing ${status.missing.join(' and ')}. Alternatively supply PAYPAL_SANDBOX_ACCESS_TOKEN.`, calls);
    const supplied = value(env, 'PAYPAL_SANDBOX_ACCESS_TOKEN');
    if (supplied) {
      if (/\s/.test(supplied) || supplied.length > 16000) fail('INVALID_CREDENTIALS', 'Sandbox access token must be a single line.', calls);
      return supplied;
    }
    const id = value(env, 'PAYPAL_CLIENT_ID');
    const secret = value(env, 'PAYPAL_CLIENT_SECRET');
    if (/[\s:]/.test(id) || /\s/.test(secret)) fail('INVALID_CREDENTIALS', 'Sandbox credentials must be single-line values.', calls);
    let cache = caches.get(fetchImpl);
    if (!cache) { cache = new Map(); caches.set(fetchImpl, cache); }
    const key = createHash('sha256').update(JSON.stringify([id, secret])).digest('hex');
    const entry = cache.get(key);
    if (entry && entry.expiresAt > nowImpl()) return entry.token;
    const startedAt = nowImpl();
    const token = await request('POST', TOKEN, {
      headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials', expectedStatus: 200
    });
    if (!token || typeof token.access_token !== 'string' || !token.access_token || /\s/.test(token.access_token) ||
      token.access_token.length > 16000 || token.token_type?.toLowerCase() !== 'bearer' ||
      !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
      fail('INVALID_TOKEN_RESPONSE', 'PayPal sandbox did not return a valid expiring bearer token.', calls);
    }
    const lifespan = token.expires_in * 1000;
    // Use actual expires_in; refresh slightly early, never assume an eight-hour lifetime.
    cache.set(key, { token: token.access_token, expiresAt: startedAt + lifespan - Math.min(30000, lifespan / 10) });
    return token.access_token;
  }
  return { calls, request, accessToken, nowImpl };
}

/** Only the default native fetch produces live evidence. Injected fetch is for labeled contract tests. */
export async function createSandboxProbe({ env = process.env, fetchImpl = globalThis.fetch, ...testOptions } = {}) {
  const liveTransport = fetchImpl === globalThis.fetch;
  const api = client({ env, fetchImpl, ...testOptions });
  const token = await api.accessToken();
  const requestId = randomUUID();
  const draft = {
    detail: {
      currency_code: 'USD', reference: `ReplayLab-${requestId}`,
      note: 'SYNTHETIC SANDBOX TEST. Do not send or pay this draft.',
      memo: 'InvoiceReplayLab integration probe; no customer data.'
    },
    primary_recipients: [{ billing_info: { email_address: 'replay-buyer@example.test' } }],
    items: [{ name: 'Synthetic replay fixture', description: 'Test data only; no goods or services.', quantity: '1', unit_amount: { currency_code: 'USD', value: '1.00' } }],
    configuration: { allow_tip: false, partial_payment: { allow_partial_payment: false } }
  };
  const created = await api.request('POST', INVOICES, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(draft), expectedStatus: 201, requestId
  });
  if (!created || !invoiceIdPattern.test(created.id) || created.status !== 'DRAFT') {
    fail('INVALID_DRAFT_RESPONSE', 'PayPal sandbox did not return an identifiable DRAFT invoice.', api.calls);
  }
  const invoice = await api.request('GET', `${INVOICES}/${created.id}`, {
    headers: { Authorization: `Bearer ${token}` }, expectedStatus: 200
  });
  if (!invoice || invoice.id !== created.id || invoice.status !== 'DRAFT' ||
      invoice.amount?.currency_code !== 'USD' || !/^1(?:\.0{1,2})?$/.test(invoice.amount?.value)) {
    fail('UNEXPECTED_SNAPSHOT', 'PayPal sandbox invoice details did not confirm the expected USD 1.00 DRAFT.', api.calls);
  }
  return {
    invoiceId: invoice.id, status: 'DRAFT', apiCalls: api.calls,
    snapshot: { status: 'DRAFT', totalCents: 100, currency: 'USD' },
    source: liveTransport ? 'paypal-sandbox' : 'contract-test', executed: liveTransport,
    at: new Date(api.nowImpl()).toISOString()
  };
}

/** Optional postback verification. No webhook ingress is exposed by this prototype. */
export async function verifySandboxWebhook({ headers = {}, event, webhookId, env = process.env, fetchImpl = globalThis.fetch, ...testOptions } = {}) {
  const api = client({ env, fetchImpl, ...testOptions });
  const header = name => headers instanceof Headers ? headers.get(name) : headers[name] ?? headers[name.toUpperCase()];
  const fields = {
    auth_algo: header('paypal-auth-algo'), cert_url: header('paypal-cert-url'),
    transmission_id: header('paypal-transmission-id'), transmission_sig: header('paypal-transmission-sig'),
    transmission_time: header('paypal-transmission-time'), webhook_id: webhookId ?? value(env, 'PAYPAL_WEBHOOK_ID')
  };
  try {
    if (Object.values(fields).some(field => typeof field !== 'string' || !field || field.length > 4000) ||
        fields.auth_algo !== 'SHA256withRSA' || !event || typeof event !== 'object' || Array.isArray(event) ||
        !Number.isFinite(Date.parse(fields.transmission_time))) return { verified: false, reason: 'invalid-verification-input', apiCalls: [] };
    const cert = new URL(fields.cert_url);
    if (cert.protocol !== 'https:' || !['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com'].includes(cert.hostname) ||
        cert.username || cert.password || cert.port || cert.search || cert.hash || !/^\/v1\/notifications\/certs\/[A-Za-z0-9-]+$/.test(cert.pathname)) {
      return { verified: false, reason: 'invalid-certificate-url', apiCalls: [] };
    }
    const token = await api.accessToken();
    const result = await api.request('POST', VERIFY, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...fields, webhook_event: event }), expectedStatus: 200
    });
    return { verified: result?.verification_status === 'SUCCESS', reason: result?.verification_status === 'SUCCESS' ? 'paypal-verified' : 'verification-failed', apiCalls: api.calls };
  } catch {
    return { verified: false, reason: 'verification-unavailable', apiCalls: api.calls };
  }
}
