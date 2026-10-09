import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSandboxProbe, paypalStatus, PayPalSandboxError, validateSandboxEvidence } from '../src/paypal.mjs';

const privateRecord = new URL('../artifacts/paypal-sandbox-probe.json', import.meta.url);
const publicRecord = new URL('../artifacts/paypal-sandbox-evidence.public.json', import.meta.url);
const marker = new URL('../artifacts/probe-attempt.private.json', import.meta.url);
const originalMarker = new URL('../.git/paypal-sandbox-authorized-attempt.json', import.meta.url);
const createNew = process.argv.includes('--create-new-draft');
const source = existsSync(privateRecord) ? privateRecord : existsSync(publicRecord) ? publicRecord : null;
let recorded = null;
if (source) {
  try { recorded = validateSandboxEvidence(JSON.parse(readFileSync(source, 'utf8'))); } catch {}
  if (!recorded) {
    console.error('INVALID_RECORDED_EVIDENCE: Inspect the existing record. No PayPal request made.');
    process.exit(2);
  }
}
if (!createNew) {
  if (recorded) {
    console.log(JSON.stringify({ ...recorded, recorded: true, reused: true, observedAt: recorded.at, requestsMadeByThisRun: 0, evidencePath: fileURLToPath(source) }, null, 2));
  } else {
    console.error('No recorded observation. A new sandbox draft requires existing credentials and explicit --create-new-draft authorization. No request made.');
    process.exitCode = 2;
  }
} else if (existsSync(privateRecord) || existsSync(marker) || existsSync(originalMarker)) {
  console.error('PRIOR_PROBE_ATTEMPT: This checkout already has native evidence or an attempt marker. Inspect that attempt; no additional draft will be created.');
  process.exitCode = 2;
} else if (!paypalStatus().configured) {
  console.error('MISSING_SANDBOX_CREDENTIALS: Existing sandbox credentials are required. No request made.');
  process.exitCode = 2;
} else {
  mkdirSync(new URL('../artifacts/', import.meta.url), { recursive: true });
  const attempt = { startedAt: new Date().toISOString(), status: 'started', scope: 'One synthetic USD 1.00 sandbox DRAFT creation and returned-ID lookup; never send or pay.' };
  // Exclusive persistent marker prevents a failed or interrupted attempt being repeated blindly.
  writeFileSync(marker, JSON.stringify(attempt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    const evidence = validateSandboxEvidence(await createSandboxProbe());
    if (!evidence) throw new Error('Native evidence validation failed');
    writeFileSync(privateRecord, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    writeFileSync(marker, JSON.stringify({ ...attempt, status: 'succeeded', completedAt: new Date().toISOString(), invoiceId: evidence.invoiceId }, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ ...evidence, recorded: false, evidencePath: fileURLToPath(privateRecord) }, null, 2));
  } catch (error) {
    const diagnostic = error instanceof PayPalSandboxError ? { code: error.code, message: error.message, apiCalls: error.apiCalls } : { code: 'PROBE_OR_EVIDENCE_FAILED', message: 'Probe or sanitized evidence persistence failed. Inspect the attempt before any further action.' };
    writeFileSync(marker, JSON.stringify({ ...attempt, status: 'failed-stop', completedAt: new Date().toISOString(), error: diagnostic }, null, 2) + '\n', { mode: 0o600 });
    console.error(JSON.stringify(diagnostic));
    console.error('Stopped. A draft may exist if creation succeeded before lookup failed. No blind retry is permitted.');
    process.exitCode = 1;
  }
}
