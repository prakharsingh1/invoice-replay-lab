import { createServer } from 'node:http';
import { readFileSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { replayScenario } from './replay.mjs';
import { predictIncident, modelInfo } from './ml.mjs';
import { paypalStatus, validateSandboxEvidence } from './paypal.mjs';

const scenarios = JSON.parse(readFileSync(new URL('../fixtures/scenarios.json', import.meta.url))).scenarios;
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]]);
const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
const defaultEvidencePath = new URL('../artifacts/paypal-sandbox-probe.json', import.meta.url);
const defaultPublicEvidencePath = new URL('../artifacts/paypal-sandbox-evidence.public.json', import.meta.url);

function loadRecordedEvidence(path) {
  if (path === null) return { evidence: null, state: 'missing' };
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 16384) return { evidence: null, state: 'invalid' };
    const evidence = validateSandboxEvidence(JSON.parse(readFileSync(descriptor, 'utf8')));
    return { evidence, state: evidence ? 'recorded' : 'invalid' };
  } catch (error) {
    return { evidence: null, state: error.code === 'ENOENT' ? 'missing' : 'invalid' };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function createApp({ env = process.env, evidencePath = defaultEvidencePath,
  publicEvidencePath = evidencePath === defaultEvidencePath ? defaultPublicEvidencePath : null } = {}) {
  // Only a trusted local startup file supplies evidence. Browser JSON cannot load it.
  // This server never calls the PayPal adapter, including after missing/invalid evidence.
  let recorded = loadRecordedEvidence(evidencePath);
  // Judge clones can use the published sanitized observation without credentials.
  // An invalid private file does not silently fall back to a different observation.
  if (recorded.state === 'missing' && publicEvidencePath !== null) recorded = loadRecordedEvidence(publicEvidencePath);
  const lastSandbox = recorded.evidence;
  function recordedResponse() {
    return { ...lastSandbox, recorded: true, reused: true, observedAt: lastSandbox.at, replayScenarioId: 'sandbox-draft-guard' };
  }
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
      if (req.method === 'GET' && path === '/api/status') return reply(res, 200, { paypal: { ...paypalStatus(env), executed: Boolean(lastSandbox), recorded: Boolean(lastSandbox), reused: Boolean(lastSandbox), mutationsAllowed: false, evidenceState: recorded.state, ...(lastSandbox ? { invoiceId: lastSandbox.invoiceId, at: lastSandbox.at, observedAt: lastSandbox.at } : {}) }, ai: { ...modelInfo(), type: 'local-trained-model', trainedOn: 'synthetic' }, publication: 'local-only', author: 'Prakhar Singh' });
      if (req.method === 'GET' && path === '/api/sandbox/evidence') return lastSandbox
        ? reply(res, 200, recordedResponse())
        : reply(res, 404, { error: 'No valid recorded PayPal sandbox observation is available. This server will not create a new invoice.', code: 'NO_RECORDED_SANDBOX_EVIDENCE' });
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
        // Compatibility for older clients: this route now reuses recorded data only.
        if (lastSandbox) return reply(res, 200, recordedResponse());
        return reply(res, 409, { error: 'Creating PayPal sandbox invoices through this server is disabled. No valid recorded observation is available.', code: 'SANDBOX_MUTATION_DISABLED' });
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
      reply(res, 502, { error: 'Operation failed. Inspect the local terminal for a redacted diagnostic.', code: error.code ?? 'OPERATION_FAILED' });
      console.error(JSON.stringify({ level: 'error', code: error.code ?? 'OPERATION_FAILED' }));
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 4178);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 to 65535');
  createApp().listen(port, '127.0.0.1', () => console.log(`InvoiceReplayLab: http://127.0.0.1:${port} — synthetic replay with recorded sandbox evidence; server PayPal mutations disabled.`));
}
