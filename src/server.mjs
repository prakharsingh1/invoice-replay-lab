import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { replayScenario } from './replay.mjs';
import { predictIncident, modelInfo } from './ml.mjs';
import { paypalStatus, createSandboxProbe } from './paypal.mjs';

const scenarios = JSON.parse(readFileSync(new URL('../fixtures/scenarios.json', import.meta.url))).scenarios;
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]]);
const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };

export function createApp({ env = process.env, sandboxProbe = createSandboxProbe } = {}) {
  let lastSandbox = null;
  let probePromise = null;
  function observedSandboxCase() {
    if (lastSandbox?.executed !== true || lastSandbox?.source !== 'paypal-sandbox') return null;
    const id = 'sandbox-draft-guard';
    return { id, title: 'My sandbox draft: imagined payment', description: 'An observed PayPal sandbox DRAFT snapshot anchors this experiment. One imagined, untrusted payment delivery must leave the journal unchanged. No actual payment occurred.', synthetic: true, sandboxAnchored: true, provenance: 'authored-synthetic', invoice: { id: lastSandbox.invoiceId, currency: 'USD', total: '1.00' }, sandboxAnchor: { source: 'paypal-sandbox', invoiceId: lastSandbox.invoiceId, at: lastSandbox.at, apiCalls: lastSandbox.apiCalls }, snapshot: { status: 'DRAFT', paid: '0.00', refunded: '0.00', source: 'paypal-sandbox', asOf: lastSandbox.at }, deliveries: [{ deliveryId: 'D1', receivedAt: lastSandbox.at, verified: false, verificationSource: 'fixture-assumption', event: { id: 'SYN-IMAGINED-PAYMENT', invoiceId: lastSandbox.invoiceId, type: 'INVOICING.INVOICE.PAID', createdAt: lastSandbox.at, transaction: { id: 'SYN-NOT-A-REAL-PAYMENT', kind: 'payment', amount: '1.00', currency: 'USD' } } }] };
  }
  function availableScenarios() { const observed = observedSandboxCase(); return observed ? [...scenarios, observed] : scenarios; }
  function reply(res, status, body) { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
  return createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return reply(res, 403, { error: 'Local host required', code: 'LOCAL_ONLY' });
      if (req.headers.origin && !new Set([`http://${host}`]).has(req.headers.origin)) return reply(res, 403, { error: 'Same-origin request required', code: 'ORIGIN_BLOCKED' });
      const path = new URL(req.url, `http://${host}`).pathname;
      if (req.method === 'GET' && assets.has(path)) {
        const [file, contentType] = assets.get(path);
        res.writeHead(200, { ...headers, 'Content-Type': contentType });
        return res.end(readFileSync(new URL(`../public/${file}`, import.meta.url)));
      }
      if (req.method === 'GET' && path === '/api/status') return reply(res, 200, { paypal: { ...paypalStatus(env), executed: lastSandbox?.executed === true && lastSandbox?.source === 'paypal-sandbox', ...(lastSandbox ? { invoiceId: lastSandbox.invoiceId, at: lastSandbox.at } : {}) }, ai: { ...modelInfo(), type: 'local-trained-model', trainedOn: 'synthetic' }, publication: 'local-only', author: 'Prakhar Singh' });
      if (req.method === 'GET' && path === '/api/scenarios') return reply(res, 200, { scenarios: availableScenarios().map(s => ({ id: s.id, title: s.title, description: s.description, synthetic: true, ...(s.sandboxAnchored ? { sandboxAnchored: true, invoiceId: s.invoice.id } : {}) })) });
      if (req.method === 'GET' && path === '/api/model') return reply(res, 200, modelInfo());
      if (req.method !== 'POST' || !['/api/replay', '/api/sandbox/probe'].includes(path)) return reply(res, 404, { error: 'Route not found' });
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return reply(res, 415, { error: 'Use application/json' });
      let body = ''; let bytes = 0;
      for await (const part of req) { bytes += part.length; if (bytes > 16384) { reply(res, 413, { error: 'Request exceeds 16 KiB' }); return; } body += part.toString('utf8'); }
      let input;
      try { input = JSON.parse(body || '{}'); } catch { return reply(res, 400, { error: 'Invalid JSON' }); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return reply(res, 400, { error: 'JSON object required' });
      if (path === '/api/sandbox/probe') {
        if (!paypalStatus(env).configured) return reply(res, 503, { error: 'Existing PayPal sandbox client ID + secret, or existing sandbox access token, required in server environment.', code: 'MISSING_SANDBOX_CREDENTIALS' });
        probePromise ??= sandboxProbe({ env });
        try { lastSandbox = await probePromise; } catch (error) { probePromise = null; throw error; }
        return reply(res, 200, { ...lastSandbox, ...(observedSandboxCase() ? { replayScenarioId: 'sandbox-draft-guard' } : {}) });
      }
      const scenario = availableScenarios().find(s => s.id === input.scenarioId);
      if (!scenario) return reply(res, 404, { error: 'Unknown synthetic scenario' });
      for (const name of ['dropDeliveryIds', 'duplicateDeliveryIds']) {
        if (input[name] !== undefined && (!Array.isArray(input[name]) || input[name].length > 200 || input[name].some(id => typeof id !== 'string' || !scenario.deliveries.some(d => d.deliveryId === id)))) return reply(res, 400, { error: `${name} must contain known delivery IDs` });
      }
      if (input.reverse !== undefined && typeof input.reverse !== 'boolean') return reply(res, 400, { error: 'reverse must be a boolean' });
      const report = replayScenario(scenario, input);
      report.ai = predictIncident(report);
      reply(res, 200, report);
    } catch (error) {
      // Integration errors may carry details; never send raw provider bodies or credentials.
      reply(res, 502, { error: 'Operation failed. Inspect the local terminal or run sandbox:probe for a redacted diagnostic.', code: error.code ?? 'OPERATION_FAILED', ...(error.debugId ? { debugId: error.debugId } : {}) });
      console.error(JSON.stringify({ level: 'error', code: error.code ?? 'OPERATION_FAILED' }));
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 4178);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 to 65535');
  createApp().listen(port, '127.0.0.1', () => console.log(`InvoiceReplayLab: http://127.0.0.1:${port} — synthetic local replay; sandbox calls only after an explicit probe.`));
}
