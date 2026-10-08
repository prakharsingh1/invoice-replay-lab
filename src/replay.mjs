import { createHash } from 'node:crypto';

export function cents(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,8})\.\d{2}$/.test(value)) throw new Error('Amount must be a nonnegative decimal string with two places');
  const [whole, fraction] = value.split('.');
  return Number(whole) * 100 + Number(fraction);
}
const money = n => (n / 100).toFixed(2);
const sameTx = (a, b) => a.amountCents === b.amountCents && a.currency === b.currency && a.refersTo === b.refersTo && a.kind === b.kind;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function replayScenario(input, options = {}) {
  const scenario = structuredClone(input);
  if (!scenario.synthetic || scenario.provenance !== 'authored-synthetic') throw new Error('Replay accepts authored synthetic cases only; sandbox observations stay separate');
  const invoice = scenario.invoice;
  const totalCents = cents(invoice.total);
  if (!/^[A-Z]{3}$/.test(invoice.currency)) throw new Error('Invalid invoice currency');
  const snapshot = { status: scenario.snapshot.status, paidCents: cents(scenario.snapshot.paid), refundedCents: cents(scenario.snapshot.refunded), evidenceId: 'snapshot', source: scenario.sandboxAnchor?.source === 'paypal-sandbox' ? 'paypal-sandbox' : 'synthetic', asOf: scenario.snapshot.asOf };
  const drop = new Set(options.dropDeliveryIds ?? []);
  const duplicate = new Set(options.duplicateDeliveryIds ?? []);
  let deliveries = scenario.deliveries.filter(d => !drop.has(d.deliveryId));
  deliveries = deliveries.flatMap(d => duplicate.has(d.deliveryId) ? [d, { ...structuredClone(d), deliveryId: `${d.deliveryId}-injected`, injected: true }] : [d]);
  if (options.reverse) deliveries.reverse();
  if (deliveries.length > 200) throw new Error('At most 200 deliveries');
  const metrics = { deliveries: deliveries.length, uniqueEvents: 0, duplicates: 0, unverified: 0, outOfOrder: 0, missingPayments: 0, snapshotMismatch: 0, amountConflicts: 0, dependencyGaps: 0 };
  const timeline = [];
  const findings = [];
  const seenEvents = new Map();
  const payments = new Map();
  const refunds = new Map();
  const poisonedTxIds = new Set();
  let sent = false;
  let newestTime = 0;
  const naive = { status: 'DRAFT', paidCents: 0, refundedCents: 0 };
  function addFinding(key, severity, title, detail, evidenceIds, action) {
    const existing = findings.find(f => f.id === key);
    if (existing) existing.evidenceIds = [...new Set([...existing.evidenceIds, ...evidenceIds])];
    else findings.push({ id: key, severity, title, detail, evidenceIds, action });
  }
  function poisonIdentity(id, currentRow, reason) {
    if (!id) return;
    poisonedTxIds.add(id);
    for (const ledger of [payments, refunds]) {
      const old = ledger.get(id);
      if (old) {
        const oldRow = timeline.find(t => t.evidenceId === old.evidenceId);
        if (oldRow) { oldRow.verdict = 'quarantined'; oldRow.reason = reason; }
        ledger.delete(id);
      }
    }
    currentRow.verdict = 'quarantined'; currentRow.reason = reason;
  }
  for (const [index, delivery] of deliveries.entries()) {
    const event = delivery.event;
    if (!event || typeof event.id !== 'string' || !Number.isFinite(Date.parse(event.createdAt)) || typeof delivery.deliveryId !== 'string') throw new Error('Malformed event envelope');
    const tx = event.transaction;
    const amountCents = tx ? cents(tx.amount) : 0;
    const row = { deliveryId: delivery.deliveryId, eventId: event.id, type: event.type, createdAt: event.createdAt, receivedAt: delivery.receivedAt, verdict: 'applied', reason: '', evidenceId: delivery.deliveryId, amountCents, sequence: index + 1, injected: !!delivery.injected };
    timeline.push(row);
    const time = Date.parse(event.createdAt);
    if (time < newestTime) {
      metrics.outOfOrder++;
      addFinding('delivery_reordering', 'warning', 'Delivery order differs from event order', 'A later arrival carries an older event timestamp. A last-event-wins worker can regress invoice state.', [row.evidenceId], 'Derive state from the transaction ledger; avoid assigning status directly from delivery order.');
    }
    newestTime = Math.max(newestTime, time);
    // Intentionally faulty comparison worker: no trust, no deduplication, last-event-wins.
    if (event.type === 'INVOICING.INVOICE.SENT') naive.status = 'SENT';
    if (tx?.kind === 'payment') { naive.paidCents += amountCents; naive.status = 'PAID'; }
    if (tx?.kind === 'refund') { naive.refundedCents += amountCents; naive.status = 'REFUNDED'; }
    if (delivery.verified !== true) {
      metrics.unverified++;
      row.verdict = 'quarantined'; row.reason = 'Synthetic verification assumption is false; no ledger mutation';
      addFinding('untrusted_delivery', 'critical', 'Untrusted delivery blocked', 'This fixture delivery has no trusted verification result. Its payment claim cannot affect the protected ledger.', [row.evidenceId], 'Verify actual signatures server-side before processing; never trust a payload-supplied verification flag.');
      continue;
    }
    if (event.invoiceId !== invoice.id) { row.verdict = 'quarantined'; row.reason = 'Invoice identity mismatch'; addFinding('identity_conflict', 'critical', 'Wrong invoice identity', 'A delivery refers to another invoice.', [row.evidenceId], 'Reject invoice identity mismatches.'); continue; }
    const eventFingerprint = JSON.stringify(canonical(event));
    if (seenEvents.has(event.id)) {
      metrics.duplicates++;
      row.verdict = 'duplicate'; row.reason = 'Event ID already processed';
      if (seenEvents.get(event.id).fingerprint !== eventFingerprint) {
        metrics.amountConflicts++; row.verdict = 'quarantined'; row.reason = 'Same event ID carries conflicting content';
        const previous = seenEvents.get(event.id);
        poisonIdentity(previous.txId, row, 'Event identity is ambiguous; related transactions excluded');
        poisonIdentity(tx?.id, row, 'Event identity is ambiguous; related transactions excluded');
        addFinding('amount_conflict', 'critical', 'Conflicting event payload', 'The same event identity arrived with different content. Related transactions are excluded until reconciled.', [previous.evidenceId, row.evidenceId], 'Quarantine conflicting payloads and compare the authoritative sandbox resource.');
      } else addFinding('duplicate_delivery', 'warning', 'Duplicate delivery ignored', 'Repeated event or transaction identities would inflate a worker that adds every delivery.', [row.evidenceId], 'Persist event and transaction identities atomically before side effects.');
      continue;
    }
    seenEvents.set(event.id, { fingerprint: eventFingerprint, txId: tx?.id, evidenceId: row.evidenceId });
    if (!tx) {
      if (event.type === 'INVOICING.INVOICE.SENT') { sent = true; row.reason = 'Observed sent event; ledger-derived status takes priority'; }
      else { row.verdict = 'ignored'; row.reason = 'Unsupported non-transaction event'; }
      continue;
    }
    if (typeof tx.id !== 'string' || !tx.id || !['payment', 'refund'].includes(tx.kind) || amountCents <= 0 || tx.currency !== invoice.currency || (tx.kind === 'payment' && event.type !== 'INVOICING.INVOICE.PAID') || (tx.kind === 'refund' && event.type !== 'INVOICING.INVOICE.REFUNDED')) {
      metrics.amountConflicts++; row.verdict = 'quarantined'; row.reason = 'Unsupported transaction, amount, event type, or currency';
      addFinding('amount_conflict', 'critical', 'Transaction contract mismatch', 'The delivery fails the supported transaction contract.', [row.evidenceId], 'Inspect currency, amount, event type, and transaction identity before replay.'); continue;
    }
    const ledger = tx.kind === 'payment' ? payments : refunds;
    const otherLedger = tx.kind === 'payment' ? refunds : payments;
    const normalized = { ...tx, amountCents, evidenceId: row.evidenceId };
    if (poisonedTxIds.has(tx.id)) { row.verdict = 'quarantined'; row.reason = 'Transaction identity was already contradicted'; continue; }
    if (otherLedger.has(tx.id)) {
      metrics.amountConflicts++;
      const previous = otherLedger.get(tx.id);
      poisonIdentity(tx.id, row, 'Transaction ID reused across payment and refund kinds');
      addFinding('amount_conflict', 'critical', 'Transaction kind conflict', 'One transaction identity cannot represent both a payment and a refund. Both claims are excluded.', [previous.evidenceId, row.evidenceId], 'Reconcile the transaction identity with the authoritative resource.');
      continue;
    }
    if (ledger.has(tx.id)) {
      metrics.duplicates++;
      if (!sameTx(ledger.get(tx.id), normalized)) {
        metrics.amountConflicts++; row.verdict = 'quarantined'; row.reason = 'Existing transaction ID has a different amount or reference';
        const previous = ledger.get(tx.id);
        poisonIdentity(tx.id, row, 'Transaction identity has conflicting monetary content; all claims excluded');
        addFinding('amount_conflict', 'critical', 'Same transaction, conflicting amount', 'A transaction identity carries conflicting monetary content. All values for that identity are quarantined until reconciled.', [previous.evidenceId, row.evidenceId], 'Post neither value; reconcile against the sandbox invoice and transaction details.');
      } else {
        row.verdict = 'duplicate'; row.reason = 'Transaction ID already posted';
        addFinding('duplicate_delivery', 'warning', 'Duplicate transaction ignored', 'Different event identities can still refer to one transaction.', [ledger.get(tx.id).evidenceId, row.evidenceId], 'Deduplicate by both event and transaction identity.');
      }
      continue;
    }
    if (tx.kind === 'refund' && !payments.has(tx.refersTo)) {
      metrics.dependencyGaps++; row.verdict = 'deferred'; row.reason = 'Refund arrived before its payment; resolve after collecting trusted payments';
      addFinding('dependency_gap', 'warning', 'Refund dependency arrived late', 'A refund arrived before the payment it references. The protected reducer defers it rather than losing it.', [row.evidenceId], 'Resolve refund references after collecting trusted payments; quarantine unresolved dependencies.');
    } else row.reason = 'Unique trusted transaction collected';
    ledger.set(tx.id, normalized);
  }
  metrics.uniqueEvents = seenEvents.size;
  let paidCents = 0;
  for (const tx of payments.values()) paidCents += tx.amountCents;
  let refundedCents = 0;
  const refundGroups = new Map();
  for (const tx of refunds.values()) {
    const group = refundGroups.get(tx.refersTo) ?? []; group.push(tx); refundGroups.set(tx.refersTo, group);
  }
  for (const [parentId, group] of refundGroups) {
    const parent = payments.get(parentId);
    const total = group.reduce((sum, tx) => sum + tx.amountCents, 0);
    const invalid = !parent || total > parent.amountCents;
    for (const tx of group) {
      const row = timeline.find(t => t.evidenceId === tx.evidenceId);
      if (invalid) {
        metrics.amountConflicts++; row.verdict = 'quarantined'; row.reason = !parent ? 'Referenced payment absent after replay' : 'Combined refunds exceed payment; entire refund group excluded';
        addFinding('amount_conflict', 'critical', 'Refund cannot be posted', row.reason, group.map(t => t.evidenceId), 'Fetch the missing payment or inspect the entire refund group; no inferred money is posted.');
      } else { refundedCents += tx.amountCents; row.verdict = 'applied'; row.reason = 'Refund reference resolved against unique trusted payment'; }
    }
  }
  let status = sent ? 'SENT' : 'DRAFT';
  if (paidCents > 0) status = paidCents >= totalCents ? 'PAID' : 'PARTIALLY_PAID';
  if (refundedCents > 0) status = refundedCents === paidCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  const protectedState = { status, paidCents, refundedCents, balanceCents: Math.max(0, totalCents - paidCents), netCents: paidCents - refundedCents, totalCents, currency: invoice.currency };
  const differences = ['status', 'paidCents', 'refundedCents'].filter(k => protectedState[k] !== snapshot[k]).map(k => `${k}: ledger ${protectedState[k]}, snapshot ${snapshot[k]}`);
  metrics.snapshotMismatch = differences.length ? 1 : 0;
  if (paidCents < snapshot.paidCents) {
    metrics.missingPayments = 1;
    addFinding('missing_delivery', 'critical', 'Snapshot contains money absent from deliveries', `Trusted observed payments total ${money(paidCents)}, while the synthetic snapshot reports ${money(snapshot.paidCents)} ${invoice.currency}. The missing amount is not fabricated.`, ['snapshot', ...timeline.filter(t => t.verdict === 'applied').map(t => t.evidenceId)], 'Re-fetch the sandbox invoice and inspect webhook delivery history before changing the ledger.');
  } else if (differences.length) addFinding('snapshot_mismatch', 'warning', 'Ledger and snapshot disagree', differences.join('; '), ['snapshot', ...timeline.map(t => t.evidenceId)], 'Check snapshot time and supported lifecycle assumptions; disagreement is evidence, not proof of a lost event.');
  const report = { scenario: { id: scenario.id, title: scenario.title, description: scenario.description, synthetic: true, provenance: scenario.provenance, invoice, ...(scenario.sandboxAnchor ? { sandboxAnchor: scenario.sandboxAnchor } : {}) }, naive, protected: protectedState, snapshot, timeline, findings, metrics, consistency: { matches: !differences.length, differences }, transformations: { dropped: [...drop], duplicated: [...duplicate], reversed: !!options.reverse }, inputEvidence: { invoice, snapshot: scenario.snapshot, deliveries }, evidenceHashScope: 'SHA-256 of the entire deterministic replay report before evidenceHash and AI output are added; includes normalized input deliveries and transformations.', limitations: ['Deliveries are normalized authored simulations, not actual PayPal webhook payloads or verified signatures. Snapshot provenance is labeled separately.', 'Replay is in-memory; durable ingestion, concurrency, and the full invoice lifecycle are outside this prototype.', 'Snapshot comparison can detect disagreement; it cannot prove which system is wrong.'] };
  report.evidenceHash = createHash('sha256').update(JSON.stringify(report)).digest('hex');
  return report;
}
