import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replayScenario, cents } from '../src/replay.mjs';
const scenarios = JSON.parse(readFileSync(new URL('../fixtures/scenarios.json', import.meta.url))).scenarios;
const scenario = id => structuredClone(scenarios.find(s => s.id === id));

test('money parsing rejects float, exponent, negative, incomplete and oversized amounts', () => {
  assert.equal(cents('240.01'), 24001);
  for (const value of [240, '2e3', '-1.00', '0.1', '00.10', '1000000000.00', 'NaN']) assert.throws(() => cents(value));
});
test('duplicate event AND transaction identities never double-post a payment', () => {
  const r = replayScenario(scenario('duplicate-storm'));
  assert.equal(r.naive.paidCents, 72000); assert.equal(r.protected.paidCents, 24000);
  assert.equal(r.metrics.duplicates, 2); assert.ok(r.consistency.matches);
});
test('refund-before-payment resolves and stale sent event cannot regress derived status', () => {
  const r = replayScenario(scenario('reordered-refund'));
  assert.equal(r.naive.status, 'SENT'); assert.equal(r.protected.status, 'PARTIALLY_REFUNDED');
  assert.equal(r.protected.refundedCents, 3000); assert.equal(r.metrics.dependencyGaps, 1);
  assert.ok(r.consistency.matches); assert.equal(r.timeline[0].verdict, 'applied');
});
test('untrusted delivery does not mutate protected ledger', () => {
  const r = replayScenario(scenario('untrusted-payment'));
  assert.equal(r.protected.paidCents, 0); assert.equal(r.protected.status, 'SENT');
  assert.equal(r.metrics.unverified, 1); assert.equal(r.timeline[1].verdict, 'quarantined');
});
test('missing payment is surfaced rather than synthesized from snapshot', () => {
  const r = replayScenario(scenario('missing-payment'));
  assert.equal(r.protected.paidCents, 0); assert.ok(!r.consistency.matches);
  assert.equal(r.metrics.missingPayments, 1); assert.ok(r.findings.find(f => f.id === 'missing_delivery').evidenceIds.includes('snapshot'));
});
test('conflicting transaction amounts are quarantined, not posted', () => {
  const r = replayScenario(scenario('amount-conflict'));
  assert.equal(r.protected.paidCents, 0); assert.equal(r.metrics.amountConflicts, 1);
  assert.equal(r.timeline[1].verdict, 'quarantined');
  assert.equal(r.timeline[2].verdict, 'quarantined');
});
test('clean partial payments and refund conserve money', () => {
  const r = replayScenario(scenario('healthy-partial'));
  assert.equal(r.protected.paidCents, 30000); assert.equal(r.protected.refundedCents, 5000);
  assert.equal(r.protected.netCents, 25000); assert.ok(r.consistency.matches); assert.deepEqual(r.findings, []);
});
test('reversing non-conflicting arrivals preserves protected monetary state', () => {
  for (const id of ['healthy-partial', 'duplicate-storm', 'reordered-refund', 'untrusted-payment', 'amount-conflict']) {
    assert.deepEqual(replayScenario(scenario(id)).protected, replayScenario(scenario(id), { reverse: true }).protected, id);
  }
});
test('what-if removed payment leaves refund unresolved and never posts negative money', () => {
  const r = replayScenario(scenario('reordered-refund'), { dropDeliveryIds: ['D2'] });
  assert.equal(r.protected.paidCents, 0); assert.equal(r.protected.refundedCents, 0);
  assert.equal(r.timeline[0].verdict, 'quarantined'); assert.ok(!r.consistency.matches);
});
test('injected duplicates change naive ledger but protected ledger stays equal', () => {
  const s = scenario('healthy-partial');
  const baseline = replayScenario(s); const injected = replayScenario(s, { duplicateDeliveryIds: ['D2', 'D4'] });
  assert.deepEqual(injected.protected, baseline.protected); assert.notEqual(injected.naive.paidCents, baseline.naive.paidCents);
});
test('refund totals cannot exceed their parent payment', () => {
  const s = scenario('healthy-partial'); s.deliveries[3].event.transaction.amount = '201.00';
  const r = replayScenario(s); assert.equal(r.protected.refundedCents, 0); assert.equal(r.timeline[3].verdict, 'quarantined');
});
test('currency mismatch, wrong invoice identity and event transaction type are rejected', () => {
  for (const mutate of [s => { s.deliveries[1].event.transaction.currency = 'EUR'; }, s => { s.deliveries[1].event.invoiceId = 'OTHER'; }, s => { s.deliveries[1].event.type = 'INVOICING.INVOICE.SENT'; }]) {
    const s = scenario('duplicate-storm'); s.deliveries = s.deliveries.slice(0, 2); mutate(s);
    const r = replayScenario(s); assert.equal(r.protected.paidCents, 0); assert.equal(r.timeline[1].verdict, 'quarantined');
  }
});
test('report hash is deterministic and changes for altered evidence', () => {
  const s = scenario('healthy-partial'); assert.equal(replayScenario(s).evidenceHash, replayScenario(s).evidenceHash);
  assert.notEqual(replayScenario(s).evidenceHash, replayScenario(s, { reverse: true }).evidenceHash);
});
test('every finding citation resolves to actual delivery or snapshot', () => {
  for (const s of scenarios) { const r = replayScenario(s); const ids = new Set(['snapshot', ...r.timeline.map(t => t.evidenceId)]); for (const f of r.findings) assert.ok(f.evidenceIds.every(id => ids.has(id))); }
});
test('actual PayPal observations cannot silently enter synthetic replay', () => {
  const s = scenario('healthy-partial'); s.synthetic = false; assert.throws(() => replayScenario(s));
});
test('cross-kind transaction identity reuse quarantines both payment and refund', () => {
  const s = scenario('healthy-partial'); s.deliveries[3].event.transaction.id = 'SYN-PAY-6'; s.deliveries[3].event.transaction.amount = '200.00';
  const r = replayScenario(s); assert.equal(r.protected.paidCents, 10000); assert.equal(r.protected.refundedCents, 0);
  assert.equal(r.metrics.amountConflicts, 1); assert.deepEqual(r.protected, replayScenario(s, { reverse: true }).protected);
});
test('excessive combined refunds quarantine the entire group independent of arrival order', () => {
  const s = scenario('healthy-partial'); s.deliveries[3].event.transaction.amount = '120.00';
  const extra = structuredClone(s.deliveries[3]); extra.deliveryId = 'D5'; extra.event.id = 'WH-55'; extra.event.transaction.id = 'SYN-REF-3'; extra.event.transaction.amount = '150.00'; s.deliveries.push(extra);
  const r = replayScenario(s); assert.equal(r.protected.refundedCents, 0); assert.deepEqual(r.protected, replayScenario(s, { reverse: true }).protected);
});
test('hash includes transaction reference and verification provenance even when totals match', () => {
  const s = scenario('healthy-partial'); const before = replayScenario(s); s.deliveries[3].event.transaction.refersTo = 'SYN-PAY-5';
  assert.deepEqual(before.protected, replayScenario(s).protected); assert.notEqual(before.evidenceHash, replayScenario(s).evidenceHash);
  s.deliveries[3].verificationSource = 'changed-assumption'; assert.notEqual(before.evidenceHash, replayScenario(s).evidenceHash);
});
test('conflicting event identity invalidates all related transactions', () => {
  const s = scenario('healthy-partial'); const extra = structuredClone(s.deliveries[1]); extra.deliveryId = 'D5'; extra.event.transaction.amount = '99.00'; s.deliveries.push(extra);
  const r = replayScenario(s); assert.equal(r.protected.paidCents, 20000); assert.equal(r.timeline[1].verdict, 'quarantined');
});
test('duplicate JSON object key ordering does not make an event ambiguous', () => {
  const s = scenario('duplicate-storm'); const event = s.deliveries[2].event;
  s.deliveries[2].event = Object.fromEntries(Object.entries(event).reverse());
  s.deliveries[2].event.transaction = Object.fromEntries(Object.entries(event.transaction).reverse());
  const r = replayScenario(s); assert.equal(r.protected.paidCents, 24000); assert.equal(r.metrics.amountConflicts, 0);
});
