import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSandboxEvidence } from '../src/paypal.mjs';

// Every record here is a SYNTHETIC validator contract fixture. These tests do not
// read saved evidence, invoke a probe, use credentials, or make network requests.
const invoiceId = 'INV2-AAAA-BBBB-CCCC-DDDD';
const otherInvoiceId = 'INV2-EEEE-FFFF-GGGG-HHHH';
const tokenPath = '/v1/oauth2/token';
const invoicesPath = '/v2/invoicing/invoices';
const invoicePath = `${invoicesPath}/${invoiceId}`;

function call(method, path, status, debugId = 'synthetic-debug-123') {
  return { method, path, status, debugId };
}

function fixture(overrides = {}) {
  return {
    source: 'paypal-sandbox',
    executed: true,
    invoiceId,
    status: 'DRAFT',
    snapshot: { status: 'DRAFT', totalCents: 100, currency: 'USD' },
    at: '2026-10-09T12:34:56.000Z',
    apiCalls: [call('POST', invoicesPath, 201), call('GET', invoicePath, 200)],
    ...overrides
  };
}

function rejected(label, mutate) {
  const raw = fixture();
  mutate(raw);
  assert.equal(validateSandboxEvidence(raw), null, `Reject ${label}`);
}

describe('sandbox evidence validation (synthetic contract fixtures only)', () => {
  it('accepts a minimal single-create draft observation without OAuth calls', () => {
    const raw = fixture();
    assert.deepEqual(validateSandboxEvidence(raw), raw);
  });

  it('accepts every permitted OAuth and GET retry combination', () => {
    for (const oauthAttempts of [0, 1, 2, 3]) {
      for (const getAttempts of [1, 2, 3]) {
        const oauth = oauthAttempts === 0 ? [] : [
          ...Array.from({ length: oauthAttempts - 1 }, () => call('POST', tokenPath, 429)),
          call('POST', tokenPath, 200)
        ];
        const reads = [
          ...Array.from({ length: getAttempts - 1 }, () => call('GET', invoicePath, 429)),
          call('GET', invoicePath, 200)
        ];
        const raw = fixture({ apiCalls: [...oauth, call('POST', invoicesPath, 201), ...reads] });
        assert.deepEqual(validateSandboxEvidence(raw), raw, `${oauthAttempts} OAuth attempts and ${getAttempts} GET attempts`);
      }
    }
  });

  it('accepts uppercase alphanumeric invoice IDs and safe debug-ID boundaries', () => {
    const raw = fixture({ invoiceId: 'INV2-A1B2-C3D4-E5F6-G7H8' });
    raw.apiCalls[1].path = `${invoicesPath}/${raw.invoiceId}`;
    raw.apiCalls[0].debugId = 'A';
    raw.apiCalls[1].debugId = 'aA0-'.repeat(32);
    assert.deepEqual(validateSandboxEvidence(raw), raw);
  });

  it('retains null debug IDs and canonicalizes missing ones to null', () => {
    const raw = fixture();
    raw.apiCalls[0].debugId = null;
    delete raw.apiCalls[1].debugId;
    const validated = validateSandboxEvidence(raw);
    assert.deepEqual(validated, fixture({ apiCalls: [
      call('POST', invoicesPath, 201, null), call('GET', invoicePath, 200, null)
    ] }));
    assert.equal(Object.hasOwn(raw.apiCalls[1], 'debugId'), false, 'Validation must not mutate the fixture');
  });

  it('rejects malformed evidence record shapes', () => {
    for (const [label, raw] of [
      ['null', null], ['undefined', undefined], ['a string', 'synthetic-record'],
      ['a number', 100], ['a boolean', true], ['an array', []]
    ]) {
      assert.equal(validateSandboxEvidence(raw), null, `Reject ${label} as the evidence record`);
    }
  });

  it('requires complete sandbox execution metadata and draft status', () => {
    for (const key of ['source', 'executed', 'invoiceId', 'status', 'snapshot', 'at', 'apiCalls']) {
      rejected(`a missing ${key}`, raw => { delete raw[key]; });
    }

    for (const [label, key, value] of [
      ['contract-test provenance', 'source', 'contract-test'],
      ['production provenance', 'source', 'paypal-production'],
      ['non-string provenance', 'source', { value: 'paypal-sandbox' }],
      ['an unexecuted record', 'executed', false],
      ['a string execution flag', 'executed', 'true'],
      ['a numeric execution flag', 'executed', 1],
      ['a non-draft top-level status', 'status', 'PAID'],
      ['a lowercase top-level status', 'status', 'draft'],
      ['a null top-level status', 'status', null]
    ]) {
      rejected(label, raw => { raw[key] = value; });
    }
  });

  it('rejects malformed and unsafe invoice IDs', () => {
    for (const id of [
      '', null, 123, 'INV2-aaaa-BBBB-CCCC-DDDD', 'INV2-AAA-BBBB-CCCC-DDDD',
      'INV2-AAAA-BBBB-CCCC', 'INV2-AAAA-BBBB-CCCC-DDDD-EEEE',
      'INV2-AAAA-BBBB-CCCC-DDD_', 'INV2-AAAA-BBBB-CCCC-DDDD/send',
      ' INV2-AAAA-BBBB-CCCC-DDDD', 'INV2-AAAA-BBBB-CCCC-DDDD\n'
    ]) {
      rejected(`invalid invoice ID ${JSON.stringify(id)}`, raw => {
        raw.invoiceId = id;
        raw.apiCalls[1].path = `${invoicesPath}/${id}`;
      });
    }
  });

  it('requires a complete USD 100-cent draft snapshot', () => {
    for (const snapshot of [null, [], 'DRAFT', 100]) {
      rejected(`a malformed snapshot ${JSON.stringify(snapshot)}`, raw => { raw.snapshot = snapshot; });
    }
    for (const key of ['status', 'totalCents', 'currency']) {
      rejected(`a snapshot missing ${key}`, raw => { delete raw.snapshot[key]; });
    }
    for (const [key, value] of [
      ['status', 'SENT'], ['status', 'draft'], ['status', null],
      ['totalCents', 0], ['totalCents', 101], ['totalCents', '100'],
      ['totalCents', NaN], ['totalCents', Infinity], ['totalCents', null],
      ['currency', 'EUR'], ['currency', 'usd'], ['currency', null]
    ]) {
      rejected(`snapshot ${key} ${typeof value} ${String(value)}`, raw => { raw.snapshot[key] = value; });
    }
  });

  it('rejects invalid ISO observation timestamps', () => {
    for (const at of [
      '', null, 0, new Date('2026-10-09T12:34:56.000Z'), 'not-a-date',
      'October 9, 2026', '2026-13-09T12:34:56.000Z',
      '2026-10-09T25:34:56.000Z', '2026-10-09T12:34:60.000Z',
      '2026-02-30T12:34:56.000Z'
    ]) {
      rejected(`invalid ISO observation time ${typeof at} ${JSON.stringify(at)}`, raw => { raw.at = at; });
    }
  });

  it('rejects malformed API call collections and incomplete call records', () => {
    for (const apiCalls of [null, {}, 'calls', [], [null], ['GET'], [201]]) {
      rejected(`malformed API calls ${JSON.stringify(apiCalls)}`, raw => { raw.apiCalls = apiCalls; });
    }
    for (const key of ['method', 'path', 'status']) {
      rejected(`a call missing ${key}`, raw => { delete raw.apiCalls[0][key]; });
    }
  });

  it('requires the permitted endpoint, method, status, order, and retry bounds', () => {
    for (const [label, calls] of [
    ['a missing create call', [call('GET', invoicePath, 200)]],
    ['a missing read call', [call('POST', invoicesPath, 201)]],
    ['read-before-create ordering', [call('GET', invoicePath, 200), call('POST', invoicesPath, 201)]],
    ['a second successful create', [call('POST', invoicesPath, 201), call('POST', invoicesPath, 201), call('GET', invoicePath, 200)]],
    ['a create retry', [call('POST', invoicesPath, 429), call('POST', invoicesPath, 201), call('GET', invoicePath, 200)]],
    ['an unexpected create status', [call('POST', invoicesPath, 200), call('GET', invoicePath, 200)]],
    ['a string create status', [call('POST', invoicesPath, '201'), call('GET', invoicePath, 200)]],
    ['an incorrect create verb', [call('GET', invoicesPath, 201), call('GET', invoicePath, 200)]],
    ['a lowercase create verb', [call('post', invoicesPath, 201), call('GET', invoicePath, 200)]],
    ['a production create URL', [call('POST', `https://api-m.paypal.com${invoicesPath}`, 201), call('GET', invoicePath, 200)]],
    ['a full sandbox create URL', [call('POST', `https://api-m.sandbox.paypal.com${invoicesPath}`, 201), call('GET', invoicePath, 200)]],
    ['a create path query', [call('POST', `${invoicesPath}?send=true`, 201), call('GET', invoicePath, 200)]],
    ['an invoice send endpoint', [call('POST', invoicesPath, 201), call('POST', `${invoicePath}/send`, 200)]],
    ['a different invoice read', [call('POST', invoicesPath, 201), call('GET', `${invoicesPath}/${otherInvoiceId}`, 200)]],
    ['a read path suffix', [call('POST', invoicesPath, 201), call('GET', `${invoicePath}/payments`, 200)]],
    ['a read path query', [call('POST', invoicesPath, 201), call('GET', `${invoicePath}?fields=all`, 200)]],
    ['an incorrect read verb', [call('POST', invoicesPath, 201), call('POST', invoicePath, 200)]],
    ['a failed read', [call('POST', invoicesPath, 201), call('GET', invoicePath, 500)]],
    ['a pending rate-limited read', [call('POST', invoicesPath, 201), call('GET', invoicePath, 429)]],
    ['a read failure before success', [call('POST', invoicesPath, 201), call('GET', invoicePath, 404), call('GET', invoicePath, 200)]],
    ['a second successful read', [call('POST', invoicesPath, 201), call('GET', invoicePath, 200), call('GET', invoicePath, 200)]],
    ['a fourth read attempt', [call('POST', invoicesPath, 201), ...Array.from({ length: 3 }, () => call('GET', invoicePath, 429)), call('GET', invoicePath, 200)]],
    ['OAuth after create', [call('POST', invoicesPath, 201), call('POST', tokenPath, 200), call('GET', invoicePath, 200)]],
    ['OAuth after read', [call('POST', invoicesPath, 201), call('GET', invoicePath, 200), call('POST', tokenPath, 200)]],
    ['unfinished OAuth', [call('POST', tokenPath, 429), call('POST', invoicesPath, 201), call('GET', invoicePath, 200)]],
    ['a failed OAuth attempt', [call('POST', tokenPath, 401), call('POST', tokenPath, 200), call('POST', invoicesPath, 201), call('GET', invoicePath, 200)]],
    ['an incorrect OAuth verb', [call('GET', tokenPath, 200), call('POST', invoicesPath, 201), call('GET', invoicePath, 200)]],
    ['a repeated successful OAuth', [call('POST', tokenPath, 200), call('POST', tokenPath, 200), call('POST', invoicesPath, 201), call('GET', invoicePath, 200)]],
    ['a fourth OAuth attempt', [...Array.from({ length: 3 }, () => call('POST', tokenPath, 429)), call('POST', tokenPath, 200), call('POST', invoicesPath, 201), call('GET', invoicePath, 200)]],
    ['an unrelated operation', [call('POST', '/v1/notifications/verify-webhook-signature', 200), call('POST', invoicesPath, 201), call('GET', invoicePath, 200)]],
    ['a trailing unrelated operation', [call('POST', invoicesPath, 201), call('GET', invoicePath, 200), call('GET', '/v2/invoicing/invoices', 200)]]
    ]) {
      rejected(label, raw => { raw.apiCalls = calls; });
    }
  });

  it('rejects unsafe or malformed debug IDs', () => {
    for (const debugId of ['', 'unsafe@example.test', 'has space', 'has\nnewline', 'underscore_id', 'a'.repeat(129), 123, false, {}, []]) {
      rejected(`unsafe debug ID ${JSON.stringify(debugId)}`, raw => { raw.apiCalls[0].debugId = debugId; });
    }
  });

  it('strips extra record, snapshot, and call fields without mutating the input', () => {
    const raw = fixture();
    const canonical = fixture();
    raw.Authorization = 'Bearer SYNTHETIC-SECRET-MARKER';
    raw.headers = { authorization: 'SYNTHETIC-HEADER-MARKER' };
    raw.response = { customer: 'synthetic-person@example.test' };
    raw.snapshot.email = 'synthetic-person@example.test';
    raw.snapshot.amount = { currency_code: 'USD', value: '1.00' };
    raw.apiCalls[0].body = { access_token: 'SYNTHETIC-TOKEN-MARKER' };
    raw.apiCalls[1].headers = { authorization: 'SYNTHETIC-HEADER-MARKER' };
    const before = structuredClone(raw);

    const validated = validateSandboxEvidence(raw);
    assert.deepEqual(validated, canonical);
    assert.deepEqual(raw, before);
    assert.doesNotMatch(JSON.stringify(validated), /SYNTHETIC-.*-MARKER|synthetic-person/);
  });

  it('returns independently owned canonical arrays and objects', () => {
    const raw = fixture();
    const canonical = fixture();
    const validated = validateSandboxEvidence(raw);
    assert.deepEqual(validated, canonical);
    assert.notEqual(validated, raw);
    assert.notEqual(validated.snapshot, raw.snapshot);
    assert.notEqual(validated.apiCalls, raw.apiCalls);
    for (let index = 0; index < raw.apiCalls.length; index++) {
      assert.notEqual(validated.apiCalls[index], raw.apiCalls[index]);
    }

    raw.snapshot.status = 'PAID';
    raw.apiCalls[0].path = '/synthetic-mutated-path';
    raw.apiCalls.push(call('GET', '/synthetic-extra-call', 200));
    assert.deepEqual(validated, canonical);

    // Immutable canonical output is allowed; either way, it cannot alias input.
    Reflect.set(validated.snapshot, 'totalCents', 200);
    Reflect.set(validated.apiCalls[1], 'debugId', 'synthetic-output-mutation');
    assert.equal(raw.snapshot.totalCents, 100);
    assert.equal(raw.apiCalls[1].debugId, 'synthetic-debug-123');
  });
});
