import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSandboxProbe, paypalStatus, PayPalSandboxError } from '../src/paypal.mjs';

// This command performs actual PayPal sandbox requests only when existing credentials
// are provided. It has no mocked transport or fallback to synthetic success evidence.
const status = paypalStatus();
if (!status.configured) {
  console.error(`PayPal sandbox NOT executed. Missing ${status.missing.join(' and ')}; alternatively supply PAYPAL_SANDBOX_ACCESS_TOKEN. No evidence file was written.`);
  process.exitCode = 2;
} else {
  console.log('Executing sandbox-only OAuth (if needed), synthetic DRAFT creation, and draft lookup. The invoice will not be sent or paid.');
  try {
    const evidence = await createSandboxProbe();
    const directory = new URL('../artifacts/', import.meta.url);
    const target = new URL('paypal-sandbox-probe.json', directory);
    await mkdir(directory, { recursive: true });
    // Redacted evidence only: no credentials, response bodies, merchant profiles,
    // customer fields, OAuth scopes, or invoice viewer links are saved.
    await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(`PayPal sandbox executed successfully: ${evidence.invoiceId} DRAFT, USD 1.00. Redacted evidence: ${fileURLToPath(target)}`);
  } catch (error) {
    console.error(error instanceof PayPalSandboxError ? `${error.code}: ${error.message}` : 'PROBE_FAILED: Sandbox probe or evidence write failed.');
    console.error('No successful evidence was written by this run. A draft may exist if creation succeeded before lookup failed; inspect the sandbox dashboard before retrying.');
    process.exitCode = 1;
  }
}
