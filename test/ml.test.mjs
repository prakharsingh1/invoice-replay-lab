import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_NAMES, extractFeatures, predictIncident, modelInfo } from '../src/ml.mjs';
import { replayScenario } from '../src/replay.mjs';

const metrics = (patch = {}) => ({
  deliveries: 10, uniqueEvents: 10, duplicates: 0, unverified: 0, outOfOrder: 0,
  missingPayments: 0, snapshotMismatch: 0, amountConflicts: 0, dependencyGaps: 0, ...patch,
});

test('a genuinely trained artifact separates the six core synthetic patterns', () => {
  const cases = [
    [{}, 'healthy'], [{ duplicates: 4 }, 'duplicate_delivery'],
    [{ unverified: 4 }, 'untrusted_delivery'], [{ outOfOrder: 4 }, 'delivery_reordering'],
    [{ missingPayments: 4 }, 'missing_delivery'], [{ amountConflicts: 4 }, 'amount_conflict'],
    [{ snapshotMismatch: 3 }, 'missing_delivery'], [{ dependencyGaps: 3 }, 'missing_delivery'],
  ];
  for (const [patch, expected] of cases) {
    const prediction = predictIncident({ metrics: metrics(patch), findings: [] });
    assert.equal(prediction.key, expected, JSON.stringify(patch));
    assert.equal(prediction.source, 'trained-local-ml');
    assert.equal(prediction.scores.length, 6);
    assert.ok(prediction.confidence >= 0 && prediction.confidence <= 1);
    assert.ok(Math.abs(prediction.scores.reduce((sum, score) => sum + score.probability, 0) - 1) < 1e-12);
  }
  const info = modelInfo();
  assert.ok(info.training.lossHistory.at(-1).crossEntropy < info.training.lossHistory[0].crossEntropy);
  assert.ok(info.evaluation.accuracy >= 0.9);
  assert.equal(info.training.exactFeatureVectorOverlap, 0);
  assert.equal(info.modelCard.externalAIServiceCalls, 0);
  assert.equal(info.evaluation.perClass.length, 6);
});

test('explanations cite only provided matching deterministic evidence and mark mixed causes', () => {
  const report = {
    metrics: metrics({ duplicates: 5, unverified: 1 }),
    findings: [
      { id: 'duplicate-event', title: 'Repeated event ID', detail: 'A duplicate webhook was received', evidenceIds: ['delivery-2', 'delivery-4'] },
      { id: 'signature-failed', title: 'Unverified signature', evidenceIds: ['delivery-6'] },
    ],
  };
  const prediction = predictIncident(report);
  assert.equal(prediction.key, 'duplicate_delivery');
  assert.deepEqual(prediction.evidenceIds, ['delivery-2', 'delivery-4']);
  assert.match(prediction.explanation, /Repeated event ID/);
  assert.match(prediction.explanation, /not proof of causality/);
  assert.ok(prediction.limitations.some((item) => /Multiple incident signals/.test(item)));
  assert.ok(prediction.limitations.some((item) => /not calibrated/.test(item)));
});

test('actual authored replay fixtures are classified and grounded in their supplied evidence', () => {
  const { scenarios } = JSON.parse(readFileSync(new URL('../fixtures/scenarios.json', import.meta.url), 'utf8'));
  const expected = {
    'duplicate-storm': 'duplicate_delivery', 'reordered-refund': 'delivery_reordering',
    'untrusted-payment': 'untrusted_delivery', 'missing-payment': 'missing_delivery',
    // Quarantining both conflicting claims also creates a ledger/snapshot payment gap.
    // Preserve the trained model's rank on this mixed case rather than override its scores.
    'amount-conflict': 'missing_delivery', 'healthy-partial': 'healthy',
  };
  assert.equal(scenarios.length, 6);
  for (const scenario of scenarios) {
    const report = replayScenario(scenario);
    const prediction = predictIncident(report);
    assert.equal(prediction.key, expected[scenario.id], scenario.id);
    const evidence = new Set(['snapshot', ...report.timeline.map((item) => item.evidenceId)]);
    assert.ok(prediction.evidenceIds.every((id) => evidence.has(id)), scenario.id);
    if (prediction.key !== 'healthy') assert.ok(prediction.evidenceIds.length > 0, scenario.id);
    if (scenario.id === 'amount-conflict') {
      assert.match(prediction.explanation, /Additional critical replay evidence/);
      assert.match(prediction.explanation, /Same transaction, conflicting amount/);
      assert.ok(prediction.evidenceIds.includes('D2') && prediction.evidenceIds.includes('D3'));
      assert.ok(prediction.limitations.some((item) => /Multiple incident signals/.test(item)));
    }
  }
});

test('unknown critical evidence cannot be presented as a healthy learned incident class', () => {
  const report = {
    metrics: metrics(),
    findings: [{ id: 'identity_conflict', severity: 'critical', title: 'Wrong invoice identity',
      detail: 'A delivery refers to another invoice.', evidenceIds: ['D-wrong'] }],
  };
  const prediction = predictIncident(report);
  assert.equal(prediction.key, 'unclassified_critical');
  assert.equal(prediction.confidence, null);
  assert.equal(prediction.source, 'deterministic-critical-evidence-guard');
  assert.equal(prediction.rawModelPrediction.key, 'healthy');
  assert.equal(prediction.rawModelPrediction.source, 'trained-local-ml');
  assert.equal(prediction.scores.length, 6);
  assert.equal(prediction.scores[0].key, 'healthy');
  assert.deepEqual(prediction.evidenceIds, ['D-wrong']);
  assert.match(prediction.explanation, /outside the learned incident taxonomy/);
  assert.match(prediction.explanation, /Wrong invoice identity/);
  assert.ok(prediction.limitations.some((item) => /not a learned seventh class/.test(item)));

  const conflictingReport = { metrics: metrics(), findings: [{
    id: 'amount_conflict', severity: 'CRITICAL', title: 'Amount conflict despite missing metric', evidenceIds: ['D-critical'],
  }] };
  const guarded = predictIncident(conflictingReport);
  assert.equal(guarded.key, 'unclassified_critical');
  assert.match(guarded.explanation, /contradicts the model/);
  assert.deepEqual(guarded.evidenceIds, ['D-critical']);
});

test('malformed and nonfinite replay values and model parameters fail explicitly', () => {
  for (const report of [undefined, null, {}, { metrics: [] }, { metrics: 'invalid' }]) {
    assert.throws(() => extractFeatures(report), TypeError);
  }
  for (const value of [NaN, Infinity, -1, '3', null]) {
    assert.throws(() => predictIncident({ metrics: metrics({ duplicates: value }) }), /finite nonnegative/);
    assert.throws(() => predictIncident({ metrics: metrics({ deliveries: value }) }), /finite nonnegative/);
  }
  assert.equal(extractFeatures({ metrics: {} }).length, FEATURE_NAMES.length);
  assert.ok(extractFeatures({ metrics: metrics({ deliveries: 0, missingPayments: 3 }) }).every(Number.isFinite));
  assert.throws(() => predictIncident({ metrics: metrics() }, {}), /Invalid local model artifact/);
  const artifact = JSON.parse(readFileSync(new URL('../artifacts/model.json', import.meta.url), 'utf8'));
  artifact.weights[0][0] = NaN;
  assert.throws(() => predictIncident({ metrics: metrics() }, artifact), /Invalid local model artifact/);
});

test('seeded training reproduces the committed artifact byte for byte', { timeout: 150000 }, () => {
  const temporary = mkdtempSync(join(tmpdir(), 'invoice-replay-ml-'));
  try {
    const output = join(temporary, 'model.json');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/train-model.mjs', import.meta.url)), '--output', output], {
      encoding: 'utf8', timeout: 120000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(readFileSync(output, 'utf8'), readFileSync(new URL('../artifacts/model.json', import.meta.url), 'utf8'));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
