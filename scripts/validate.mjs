import { readFileSync, writeFileSync } from 'node:fs';
import { replayScenario } from '../src/replay.mjs';
import { predictIncident, modelInfo } from '../src/ml.mjs';
import { validateSandboxEvidence } from '../src/paypal.mjs';
const scenarios = JSON.parse(readFileSync(new URL('../fixtures/scenarios.json', import.meta.url))).scenarios;
const reports = scenarios.map(s => { const r = replayScenario(s); r.ai = predictIncident(r); return r; });
let observation = null;
try { observation = validateSandboxEvidence(JSON.parse(readFileSync(new URL('../artifacts/paypal-sandbox-evidence.public.json', import.meta.url), 'utf8'))); } catch {}
const result = { generatedAt: new Date().toISOString(), scope: 'Local synthetic replay validation and recorded evidence checks. This command makes zero PayPal API requests.', sandbox: { recordedEvidenceValid: Boolean(observation), requestsMadeByThisValidation: 0, ...(observation ? { invoiceId: observation.invoiceId, status: observation.status, snapshot: observation.snapshot, observedAt: observation.at, originalApiCalls: observation.apiCalls } : {}) }, ai: modelInfo(), cases: reports.map(r => ({ id: r.scenario.id, consistency: r.consistency, metrics: r.metrics, ai: { key: r.ai.key, confidence: r.ai.confidence }, evidenceHash: r.evidenceHash })), blockers: [...(!observation ? ['Valid recorded PayPal sandbox evidence unavailable.'] : []), 'Final public source and demo availability must be checked before submission.', 'Updated under-three-minute public YouTube demo upload and final entrant review remain.'] };
writeFileSync(new URL('../artifacts/validation.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
writeFileSync(new URL('../artifacts/example-evidence.json', import.meta.url), JSON.stringify(reports[0], null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
