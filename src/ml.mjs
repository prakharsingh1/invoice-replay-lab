import { readFileSync } from 'node:fs';

export const FEATURE_NAMES = Object.freeze([
  'duplicateRate', 'unverifiedRate', 'outOfOrderRate', 'missingPaymentRate',
  'snapshotMismatchRate', 'amountConflictRate', 'dependencyGapRate', 'logDeliveryCount',
  'hasDuplicate', 'hasUnverified', 'hasOutOfOrder', 'hasMissingPayment',
  'hasSnapshotMismatch', 'hasAmountConflict', 'hasDependencyGap',
]);

const COUNT_NAMES = [
  'duplicates', 'unverified', 'outOfOrder', 'missingPayments',
  'snapshotMismatch', 'amountConflicts', 'dependencyGaps',
];

export const INCIDENT_CLASSES = Object.freeze([
  { key: 'healthy', label: 'No dominant incident signal' },
  { key: 'duplicate_delivery', label: 'Duplicate webhook delivery' },
  { key: 'untrusted_delivery', label: 'Unverified webhook delivery' },
  { key: 'delivery_reordering', label: 'Webhook delivery reordering' },
  { key: 'missing_delivery', label: 'Missing delivery or state gap' },
  { key: 'amount_conflict', label: 'Payment amount conflict' },
]);

let defaultModel;

function nonnegativeCount(value, name) {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`report.metrics.${name} must be a finite nonnegative number`);
  }
  return value;
}

/** Counts are normalized against deliveries; missing counts are zero, invalid counts fail closed. */
export function extractFeatures(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || !report.metrics || typeof report.metrics !== 'object' || Array.isArray(report.metrics)) {
    throw new TypeError('A replay report with a metrics object is required');
  }
  const deliveries = nonnegativeCount(report.metrics.deliveries, 'deliveries');
  const denominator = Math.max(1, deliveries);
  const counts = COUNT_NAMES.map((name) => nonnegativeCount(report.metrics[name], name));
  return [
    ...counts.map((count) => Math.min(1, count / denominator)),
    // Training covers 0–1,000 deliveries. Keep larger workloads finite without hiding volume.
    Math.log1p(deliveries) / Math.log1p(1000),
    ...counts.map((count) => Number(count > 0)),
  ];
}

function validateModel(model) {
  const featureCount = FEATURE_NAMES.length;
  const classCount = INCIDENT_CLASSES.length;
  const finiteVector = (value, size) => Array.isArray(value) && value.length === size
    && value.every((element) => typeof element === 'number' && Number.isFinite(element));
  if (!model || model.schemaVersion !== 1 || typeof model.version !== 'string'
    || model.algorithm !== 'multiclass-softmax-regression'
    || !Array.isArray(model.featureNames)
    || model.featureNames.join(',') !== FEATURE_NAMES.join(',')
    || !Array.isArray(model.classes)
    || model.classes.map((item) => item?.key).join(',') !== INCIDENT_CLASSES.map((item) => item.key).join(',')
    || !finiteVector(model.preprocessing?.mean, featureCount)
    || !finiteVector(model.preprocessing?.scale, featureCount)
    || model.preprocessing.scale.some((value) => value <= 0)
    || !finiteVector(model.bias, classCount)
    || !Array.isArray(model.weights) || model.weights.length !== classCount
    || model.weights.some((row) => !finiteVector(row, featureCount))
    || !Array.isArray(model.modelCard?.limitations)
    || model.modelCard.limitations.some((value) => typeof value !== 'string')) {
    throw new TypeError('Invalid local model artifact: unsupported schema or nonfinite model parameters');
  }
  return model;
}

function getModel(model) {
  if (model !== undefined) return validateModel(model);
  if (!defaultModel) {
    defaultModel = validateModel(JSON.parse(readFileSync(new URL('../artifacts/model.json', import.meta.url), 'utf8')));
  }
  return defaultModel;
}

function probabilities(features, model) {
  const normalized = features.map((value, index) => (
    (value - model.preprocessing.mean[index]) / model.preprocessing.scale[index]
  ));
  const logits = model.weights.map((row, classIndex) => (
    model.bias[classIndex] + row.reduce((sum, weight, featureIndex) => sum + weight * normalized[featureIndex], 0)
  ));
  if (!logits.every(Number.isFinite)) throw new RangeError('Model inference produced a nonfinite score');
  const maximum = Math.max(...logits);
  const exponential = logits.map((value) => Math.exp(value - maximum));
  const sum = exponential.reduce((total, value) => total + value, 0);
  return exponential.map((value) => value / sum);
}

const FINDING_PATTERNS = {
  healthy: /$a/,
  duplicate_delivery: /duplicat|repeated|idempoten/i,
  untrusted_delivery: /unverified|untrusted|signature|authentic/i,
  delivery_reordering: /out.of.order|reorder|ordering|before.*(creat|updat)|stale/i,
  missing_delivery: /missing|gap|snapshot|dependenc|absent|incomplete/i,
  amount_conflict: /amount|currency|overpay|underpay|total.*conflict/i,
};

// Exact replay finding identities define the supported taxonomy. Free text cannot classify
// a new critical finding just because its description happens to mention a known word.
const MAPPED_FINDING_IDS = new Set([
  'duplicate_delivery', 'untrusted_delivery', 'delivery_reordering',
  'missing_delivery', 'snapshot_mismatch', 'dependency_gap', 'amount_conflict',
]);

function evidenceFrom(findings) {
  return [...new Set(findings.flatMap((finding) => (
    Array.isArray(finding.evidenceIds) ? finding.evidenceIds.filter((id) => typeof id === 'string') : []
  )))];
}

function findingTitles(findings) {
  return findings.map((finding) => finding.title).filter((title) => typeof title === 'string').slice(0, 3);
}

/** A genuine trained model supplies the rank; replay findings supply the evidence and explanations. */
export function predictIncident(report, model) {
  const features = extractFeatures(report);
  const selectedModel = getModel(model);
  const output = probabilities(features, selectedModel);
  const scores = INCIDENT_CLASSES.map((incident, index) => ({ ...incident, probability: output[index] }))
    .sort((left, right) => right.probability - left.probability);
  const winner = scores[0];
  const findings = Array.isArray(report.findings)
    ? report.findings.filter((finding) => finding && typeof finding === 'object') : [];
  const critical = findings.filter((finding) => String(finding.severity).toLowerCase() === 'critical');
  const unmappedCritical = critical.filter((finding) => !MAPPED_FINDING_IDS.has(finding.id));
  const matching = findings.filter((finding) => FINDING_PATTERNS[winner.key]
    .test([finding.id, finding.title, finding.detail].filter(Boolean).join(' ')));
  const evidenceIds = evidenceFrom([...matching, ...critical]);
  const activeGroups = [features[0] > 0, features[1] > 0, features[2] > 0,
    features[3] > 0 || features[4] > 0 || features[6] > 0, features[5] > 0].filter(Boolean).length;
  const limitations = [...selectedModel.modelCard.limitations];
  if (activeGroups > 1) {
    limitations.push('Multiple incident signals are active. A single top class cannot describe every cause.');
  }
  if (features[7] > 1) {
    limitations.push('Delivery volume exceeds the synthetic training range of 0–1,000 deliveries.');
  }
  if (unmappedCritical.length > 0 || (winner.key === 'healthy' && critical.length > 0)) {
    const reason = unmappedCritical.length > 0
      ? 'Critical replay evidence is outside the learned incident taxonomy'
      : 'Critical replay evidence contradicts the model’s no-incident ranking';
    limitations.push('This advisory comes from a deterministic critical-evidence guard; it is not a learned seventh class and has no model confidence.');
    return {
      label: 'Unclassified critical evidence',
      key: 'unclassified_critical',
      confidence: null,
      scores,
      modelVersion: selectedModel.version,
      source: 'deterministic-critical-evidence-guard',
      rawModelPrediction: { ...winner, source: 'trained-local-ml' },
      explanation: `${reason}: ${findingTitles(critical).join('; ') || 'inspect the critical replay findings'}. The trained classifier’s raw top category is “${winner.label}”, but that ranking does not resolve this critical evidence. Investigate the cited findings. This guard is deterministic; classifier inference is not proof of causality.`,
      evidenceIds: evidenceFrom(critical),
      limitations,
    };
  }
  const titles = findingTitles(matching);
  const additionalCriticalTitles = findingTitles(critical.filter((finding) => !matching.includes(finding)));
  const evidenceDescription = titles.length
    ? `Supporting deterministic replay findings: ${titles.join('; ')}.`
    : 'No matching deterministic finding was supplied; the classifier rank is based on replay metrics alone.';
  const additionalDescription = additionalCriticalTitles.length
    ? ` Additional critical replay evidence also requires investigation: ${additionalCriticalTitles.join('; ')}.` : '';
  return {
    label: winner.label,
    key: winner.key,
    confidence: winner.probability,
    scores,
    modelVersion: selectedModel.version,
    source: 'trained-local-ml',
    explanation: `The trained local classifier ranks “${winner.label}” first. ${evidenceDescription}${additionalDescription} This is classifier inference from synthetic training, not proof of causality.`,
    evidenceIds,
    limitations,
  };
}

export function modelInfo() {
  const model = getModel();
  return {
    version: model.version,
    algorithm: model.algorithm,
    source: 'trained-local-ml',
    featureNames: [...model.featureNames],
    classes: model.classes.map((incident) => ({ ...incident })),
    training: structuredClone(model.training),
    evaluation: structuredClone(model.evaluation),
    modelCard: structuredClone(model.modelCard),
  };
}
