import { writeFileSync } from 'node:fs';
const at = minutes => new Date(Date.UTC(2026, 9, 8, 10, minutes)).toISOString();
function make(id, title, description, total, paid, refunded, status, rows) {
  const invoiceId = `SYN-INV-${id.toUpperCase()}`;
  return { id, title, description, synthetic: true, provenance: 'authored-synthetic', notice: 'Fictional amounts, identities, and normalized events. No real customer data, PayPal transactions, or signature verification.', invoice: { id: invoiceId, currency: 'USD', total }, snapshot: { status, paid, refunded, asOf: at(30), source: 'synthetic' }, deliveries: rows.map(([eid, type, minute, kind, amount, txid, refersTo, verified = true], i) => ({ deliveryId: `D${i + 1}`, receivedAt: at(10 + i), verified, verificationSource: 'fixture-assumption', event: { id: eid, type: `INVOICING.INVOICE.${type}`, createdAt: at(minute), invoiceId, ...(kind ? { transaction: { id: txid, kind, amount, currency: 'USD', ...(refersTo ? { refersTo } : {}) } } : {}) } })) };
}
const scenarios = [
  make('duplicate-storm', 'The invoice paid three times', 'A retry storm repeats one payment under both duplicate event and new event identities.', '240.00', '240.00', '0.00', 'PAID', [['WH-01','SENT',0],['WH-02','PAID',2,'payment','240.00','SYN-PAY-1'],['WH-02','PAID',2,'payment','240.00','SYN-PAY-1'],['WH-03','PAID',2,'payment','240.00','SYN-PAY-1']]),
  make('reordered-refund', 'The refund that beat its payment', 'A refund arrives first; a stale sent event arrives last and regresses a naive worker.', '120.00', '120.00', '30.00', 'PARTIALLY_REFUNDED', [['WH-13','REFUNDED',4,'refund','30.00','SYN-REF-1','SYN-PAY-2'],['WH-12','PAID',2,'payment','120.00','SYN-PAY-2'],['WH-11','SENT',0]]),
  make('untrusted-payment', 'The payment that never happened', 'A fictional payment delivery fails the fixture trust assumption; it must not affect money state.', '399.00', '0.00', '0.00', 'SENT', [['WH-21','SENT',0],['WH-22','PAID',2,'payment','399.00','SYN-PAY-3',null,false]]),
  make('missing-payment', 'Paid upstream, missing locally', 'The snapshot says paid, but the observed delivery stream has no payment event.', '560.00', '560.00', '0.00', 'PAID', [['WH-31','SENT',0]]),
  make('amount-conflict', 'One identity, two amounts', 'Two events claim the same payment transaction with conflicting amounts.', '250.00', '250.00', '0.00', 'PAID', [['WH-41','SENT',0],['WH-42','PAID',2,'payment','250.00','SYN-PAY-4'],['WH-43','PAID',3,'payment','999.00','SYN-PAY-4']]),
  make('healthy-partial', 'Two payments, one partial refund', 'A clean ledger with two distinct partial payments and a referenced refund.', '300.00', '300.00', '50.00', 'PARTIALLY_REFUNDED', [['WH-51','SENT',0],['WH-52','PAID',2,'payment','100.00','SYN-PAY-5'],['WH-53','PAID',4,'payment','200.00','SYN-PAY-6'],['WH-54','REFUNDED',6,'refund','50.00','SYN-REF-2','SYN-PAY-6']])
];
writeFileSync(new URL('../fixtures/scenarios.json', import.meta.url), JSON.stringify({ schemaVersion: 1, scenarios }, null, 2) + '\n');
console.log(`Wrote ${scenarios.length} explicitly synthetic scenarios.`);
