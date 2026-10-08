import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FEATURE_NAMES, INCIDENT_CLASSES, extractFeatures } from '../src/ml.mjs';

const TRAIN_SEED = 20261008;
const TEST_SEED = 20261013;
const TRAIN_PER_CLASS = 480;
const TEST_PER_CLASS = 160;
const EPOCHS = 850;
const L2 = 0.0006;

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let result = Math.imul(state ^ (state >>> 15), 1 | state);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function syntheticReport(classIndex, random, anchor) {
  const deliveries = anchor === undefined ? 3 + Math.floor(random() * 998) : anchor;
  const metrics = {
    deliveries, uniqueEvents: deliveries,
    duplicates: 0, unverified: 0, outOfOrder: 0, missingPayments: 0,
    snapshotMismatch: 0, amountConflicts: 0, dependencyGaps: 0,
  };
  if (classIndex === 0) return { metrics };
  const rate = random() < 0.2 ? 0.008 + random() * 0.035 : 0.075 + random() * 0.82;
  const count = Math.max(1, Math.ceil(deliveries * rate));
  const coreMetric = [null, 'duplicates', 'unverified', 'outOfOrder', 'missingPayments', 'amountConflicts'][classIndex];
  metrics[coreMetric] = count;
  if (classIndex === 1) metrics.uniqueEvents = Math.max(0, deliveries - count);
  if (classIndex === 4) {
    const mode = Math.floor(random() * 4);
    if (mode === 1) { metrics.missingPayments = 0; metrics.snapshotMismatch = count; }
    if (mode === 2) { metrics.missingPayments = 0; metrics.dependencyGaps = count; }
    if (mode === 3) { metrics.snapshotMismatch = Math.max(1, Math.floor(count * random())); }
  }
  // Conflicting reuse of a transaction identity is both duplicate and amount-conflict evidence.
  // Teach this correlated case explicitly; the generated primary label is the amount conflict.
  if (classIndex === 5 && random() < 0.65) {
    metrics.duplicates = Math.max(1, Math.ceil(count * (0.5 + random() * 0.5)));
  }
  // Some samples include a weak second signal. Their label remains the dominant generated cause.
  if (deliveries > 80 && rate > 0.075 && random() < 0.4) {
    const noiseCandidates = ['duplicates', 'unverified', 'outOfOrder', 'missingPayments', 'amountConflicts']
      .filter((name) => name !== coreMetric && metrics[name] === 0);
    const noiseMetric = noiseCandidates[Math.floor(random() * noiseCandidates.length)];
    metrics[noiseMetric] = Math.floor(deliveries * random() * 0.015);
  }
  return { metrics };
}

function signature(features) {
  return features.map((value) => value.toPrecision(15)).join(',');
}

function generateDataset(seed, countPerClass, excluded, anchors = false) {
  const random = seededRandom(seed);
  const examples = [];
  let rejected = 0;
  for (let label = 0; label < INCIDENT_CLASSES.length; label += 1) {
    let classCount = 0;
    let attempts = 0;
    while (classCount < countPerClass) {
      if (attempts++ > 100000) throw new Error('Synthetic generation exhausted its unique feature space');
      const anchor = anchors && classCount < 8 && attempts === classCount + 1
        ? [0, 1, 2, 3, 5, 8, 13, 21][classCount] : undefined;
      const report = syntheticReport(label, random, anchor);
      const features = extractFeatures(report);
      const featureSignature = signature(features);
      if (excluded.has(featureSignature)) { rejected += 1; continue; }
      excluded.add(featureSignature);
      examples.push({ features, label });
      classCount += 1;
    }
  }
  return { examples, rejected };
}

function standardize(examples) {
  const mean = FEATURE_NAMES.map((_, column) => (
    examples.reduce((sum, item) => sum + item.features[column], 0) / examples.length
  ));
  const scale = FEATURE_NAMES.map((_, column) => Math.max(1e-6, Math.sqrt(
    examples.reduce((sum, item) => sum + (item.features[column] - mean[column]) ** 2, 0) / examples.length,
  )));
  return { mean, scale };
}

function softmax(logits) {
  const highest = Math.max(...logits);
  const exponential = logits.map((value) => Math.exp(value - highest));
  const sum = exponential.reduce((total, value) => total + value, 0);
  return exponential.map((value) => value / sum);
}

function train(examples, preprocessing) {
  const columns = FEATURE_NAMES.length;
  const classes = INCIDENT_CLASSES.length;
  const weights = Array.from({ length: classes }, () => Array(columns).fill(0));
  const bias = Array(classes).fill(0);
  const normalized = examples.map((item) => ({
    ...item, features: item.features.map((value, column) => (value - preprocessing.mean[column]) / preprocessing.scale[column]),
  }));
  const losses = [];
  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    const gradient = Array.from({ length: classes }, () => Array(columns).fill(0));
    const biasGradient = Array(classes).fill(0);
    let crossEntropy = 0;
    for (const example of normalized) {
      const logits = weights.map((row, classIndex) => (
        bias[classIndex] + row.reduce((sum, weight, column) => sum + weight * example.features[column], 0)
      ));
      const probability = softmax(logits);
      crossEntropy -= Math.log(Math.max(1e-15, probability[example.label]));
      for (let classIndex = 0; classIndex < classes; classIndex += 1) {
        const error = probability[classIndex] - Number(classIndex === example.label);
        biasGradient[classIndex] += error;
        for (let column = 0; column < columns; column += 1) {
          gradient[classIndex][column] += error * example.features[column];
        }
      }
    }
    const learningRate = 0.22 / (1 + epoch / 600);
    for (let classIndex = 0; classIndex < classes; classIndex += 1) {
      bias[classIndex] -= learningRate * biasGradient[classIndex] / examples.length;
      for (let column = 0; column < columns; column += 1) {
        weights[classIndex][column] -= learningRate * (
          gradient[classIndex][column] / examples.length + L2 * weights[classIndex][column]
        );
      }
    }
    if (epoch === 0 || epoch === EPOCHS - 1 || (epoch + 1) % 100 === 0) {
      losses.push({ epoch: epoch + 1, crossEntropy: crossEntropy / examples.length });
    }
  }
  return { weights, bias, losses };
}

function evaluate(examples, parameters, preprocessing) {
  const confusionMatrix = INCIDENT_CLASSES.map(() => INCIDENT_CLASSES.map(() => 0));
  let crossEntropy = 0;
  for (const example of examples) {
    const features = example.features.map((value, column) => (value - preprocessing.mean[column]) / preprocessing.scale[column]);
    const logits = parameters.weights.map((row, classIndex) => (
      parameters.bias[classIndex] + row.reduce((sum, weight, column) => sum + weight * features[column], 0)
    ));
    const scores = softmax(logits);
    const predicted = scores.indexOf(Math.max(...scores));
    confusionMatrix[example.label][predicted] += 1;
    crossEntropy -= Math.log(Math.max(1e-15, scores[example.label]));
  }
  const correct = confusionMatrix.reduce((total, row, index) => total + row[index], 0);
  const perClass = INCIDENT_CLASSES.map((incident, index) => {
    const actual = confusionMatrix[index].reduce((sum, value) => sum + value, 0);
    const predicted = confusionMatrix.reduce((sum, row) => sum + row[index], 0);
    const truePositive = confusionMatrix[index][index];
    return { key: incident.key, precision: predicted ? truePositive / predicted : 0,
      recall: actual ? truePositive / actual : 0, support: actual, predicted };
  });
  return { examples: examples.length, accuracy: correct / examples.length,
    crossEntropy: crossEntropy / examples.length,
    confusionMatrixConvention: 'Rows are generated true classes; columns are predicted classes in model.classes order.',
    confusionMatrix, perClass };
}

const signatures = new Set();
const trainingData = generateDataset(TRAIN_SEED, TRAIN_PER_CLASS, signatures, true);
const trainSignatures = new Set(signatures);
const testData = generateDataset(TEST_SEED, TEST_PER_CLASS, signatures);
const overlapCount = testData.examples.filter((item) => trainSignatures.has(signature(item.features))).length;
const preprocessing = standardize(trainingData.examples);
const parameters = train(trainingData.examples, preprocessing);
const evaluation = evaluate(testData.examples, parameters, preprocessing);
const corpusDigest = (examples) => createHash('sha256').update(JSON.stringify(examples)).digest('hex');
const artifact = {
  schemaVersion: 1,
  version: 'incident-softmax-synthetic-v1',
  algorithm: 'multiclass-softmax-regression',
  featureNames: FEATURE_NAMES,
  classes: INCIDENT_CLASSES,
  preprocessing,
  weights: parameters.weights,
  bias: parameters.bias,
  training: {
    datasetKind: 'generated-synthetic-feature-vectors',
    trainingSeed: TRAIN_SEED, holdoutSeed: TEST_SEED,
    examples: trainingData.examples.length, examplesPerClass: TRAIN_PER_CLASS,
    holdoutExamples: testData.examples.length, holdoutExamplesPerClass: TEST_PER_CLASS,
    epochs: EPOCHS, optimizer: 'full-batch cross-entropy gradient descent',
    initialLearningRate: 0.22, learningRateSchedule: '0.22 / (1 + epoch / 600)', l2Regularization: L2,
    initialParameters: 'all-zero weights and biases',
    lossHistory: parameters.losses,
    trainingSha256: corpusDigest(trainingData.examples), holdoutSha256: corpusDigest(testData.examples),
    exactFeatureVectorOverlap: overlapCount,
    rejectedDuplicateVectors: { training: trainingData.rejected, holdout: testData.rejected },
    generator: 'Independent seeded metric generation, dominant incident signals with optional weak secondary signals. Amount-conflict examples sometimes also carry duplicate counts to represent conflicting reuse of an identity. Exact vectors excluded across both sets.',
  },
  evaluation,
  modelCard: {
    intendedUse: 'Assist a human in ranking synthetic invoice replay incident signals alongside deterministic evidence.',
    data: 'All training and holdout examples are algorithmically generated synthetic metric vectors. They contain no customer information and are not captured PayPal API or webhook traffic.',
    architecture: 'Fifteen standardized numeric replay features: seven rates, log delivery volume, and seven signal-presence indicators; six-class linear softmax classifier trained by cross-entropy gradient descent.',
    validation: 'Independent seed holdout, zero exact feature-vector overlap. Preliminary evaluations informed presence features and correlated duplicate/amount-conflict examples. The final holdout uses a new seed. Both sets use the same synthetic generator family, so this measures only synthetic pattern recognition.',
    calibration: 'No probability calibration study was performed. The confidence field is a relative softmax model score.',
    advisoryGuard: 'Critical replay findings outside the learned taxonomy, or any critical finding paired with a healthy model rank, trigger a deterministic unclassified-critical advisory. The raw six-class scores remain inspectable; the guarded advisory has no model confidence.',
    externalAIServiceCalls: 0,
    limitations: [
      'Trained and evaluated only on synthetic incidents; accuracy on real PayPal sandbox or production incidents has not been established.',
      'Softmax scores are relative model scores, not calibrated probabilities of correctness.',
      'Classifier inference cannot prove causality or verify payment authenticity.',
      'The model summarizes aggregate metrics and can miss event sequence details; inspect the cited replay evidence.',
    ],
  },
};

const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex === -1
  ? fileURLToPath(new URL('../artifacts/model.json', import.meta.url))
  : process.argv[outputIndex + 1];
if (!outputPath || outputPath.startsWith('--')) throw new Error('--output requires a file path');
mkdirSync(fileURLToPath(new URL('../artifacts/', import.meta.url)), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, version: artifact.version, trainingExamples: trainingData.examples.length,
  holdoutExamples: testData.examples.length, holdoutAccuracy: evaluation.accuracy,
  featureVectorOverlap: overlapCount, trainingSha256: artifact.training.trainingSha256,
  holdoutSha256: artifact.training.holdoutSha256, externalAIServiceCalls: 0 }, null, 2));
