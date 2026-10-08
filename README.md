# InvoiceReplayLab

**Evidence before action.** A local workbench for reproducing invoice event-handling bugs, comparing a naive listener with a protected journal, and inspecting every finding's source evidence.

Built for Prakhar Singh's PayPal AI Hackathon project. This is a runnable local prototype. All replay histories are authored synthetic fixtures, not captured PayPal traffic. The sandbox adapter is implemented, but successful actual PayPal execution is still pending existing credentials. This source is MIT-licensed. Actual sandbox execution and final hackathon submission remain pending.

## Run locally

Requirements: Node.js 22 or later and npm. The application uses Node's standard library and has no package dependencies; no install step or AI service key is needed.

From this project directory:

```sh
npm test
npm start
```

Open **http://127.0.0.1:4178**. The server binds to loopback, and rejects unexpected host or cross-origin requests. Set `PORT` to another integer from 1024 to 65535 if needed. Stop with `Ctrl+C`.

To regenerate local artifacts:

```sh
npm run train
npm run validate
```

`train` regenerates `artifacts/model.json`. `validate` writes `artifacts/validation.json` and `artifacts/example-evidence.json`. These commands run locally and do not call PayPal or an external AI service. The measured model result and completed test/browser validation are recorded below.

## A five-minute judge walkthrough

1. Keep the **Synthetic incident lab** disclosure visible. Without credentials, the connection badge should read **SANDBOX NOT CONNECTED**.
2. Select **The invoice paid three times** (`duplicate-storm`), then click **Replay incident**. Inspect the naive listener's USD 720 payment total versus the protected journal's USD 240 payment total. The repeated event and repeated transaction cannot double-post money in the protected journal.
3. Select a timeline delivery or finding's evidence button. Inspect the actual event identity, delivery identity, timestamps, journal verdict, and reason.
4. Select **The refund that beat its payment** (`reordered-refund`). The protected journal resolves the USD 30 refund against its USD 120 payment; a stale sent event cannot regress the derived state. Select payment delivery `D2`, click **Drop selected**, and replay: the refund should remain unapplied and the discrepancy should be visible. Click **Reset changes** and replay to restore the baseline.
5. On **Two payments, one partial refund** (`healthy-partial`), inject a duplicate using **Duplicate selected**, or enable **Reverse arrival order**. Replay to compare the journal with the altered delivery history.
6. Select **One identity, two amounts** (`amount-conflict`): both claims for the ambiguous transaction are excluded, so the protected paid total is USD 0 and differs from the USD 250 snapshot. Inspect the critical conflicting-amount evidence. The model may rank a missing-state signal from this mixed case; the amount-conflict evidence remains visible.
7. Expand **Model provenance & limitations**. Model output ranks an incident category; deterministic evidence determines the journal. Confidence is a relative softmax score, not a calibrated probability of correctness.
8. Click **Export evidence JSON**. The export labels its synthetic provenance and includes timeline decisions, findings, model output, and a deterministic replay evidence hash.
9. If approved existing credentials are available, use the separate sandbox probe below. A configured badge alone does not establish successful API execution.

## Synthetic cases

| Scenario ID | What it exercises |
| --- | --- |
| `duplicate-storm` | Deduplication by event identity and transaction identity |
| `reordered-refund` | Refund before its referenced payment; stale status delivery |
| `untrusted-payment` | Authored fixture trust assumption fails; delivery is quarantined |
| `missing-payment` | Snapshot reports payment absent from observed deliveries; no money is invented |
| `amount-conflict` | Reused payment identity with conflicting amounts; all claims for that identity are quarantined |
| `healthy-partial` | Two distinct partial payments and one referenced partial refund |

Money is stored as integer cents. The journal rejects malformed amounts, wrong invoice identities, unsupported currency/type combinations, and refunds exceeding their parent payment. Ambiguous event or transaction identities invalidate the associated money claims; combined excessive refunds invalidate the whole refund group. Snapshot agreement is useful evidence, not proof that either system is correct. This conservative behavior can leave money unapplied until a discrepancy is investigated.

The trust flag is authored fixture data. It is not proof that a real PayPal webhook signature was verified. Fixtures are normalized development scenarios and do not implement the complete PayPal invoice webhook schema or lifecycle.

## Local model

The code includes a fifteen-feature, six-class linear softmax classifier and a seeded training pipeline. Inputs include seven signal rates, seven signal-presence indicators, and log delivery volume. Weights are learned through cross-entropy gradient descent with standardization and L2 regularization, rather than selected by a hard-coded incident switch.

| Measured model result | Value |
| --- | --- |
| Training examples | 2,880 generated synthetic vectors |
| Final holdout examples | 960 generated synthetic vectors |
| Correct final holdout predictions | 955 / 960 (99.48%) |
| Exact feature-vector overlap between sets | 0 |
| Training / final holdout seed | `20261008` / `20261013` |
| External AI service calls | 0 |

The model artifact includes the confusion matrix, per-class precision/recall, training losses, and corpus hashes. Preliminary synthetic evaluations informed feature design and correlated duplicate/amount-conflict examples; the final holdout uses a new seed and excludes exact training vectors. Both sets still come from the same generator family. The score establishes only synthetic pattern recognition, not a real PayPal benchmark. Real-incident performance and probability calibration have not been established. The classifier does not prove causality or payment authenticity.

Model recommendations cite matching deterministic findings and preserve additional critical evidence even when its signal differs from the top class. A deterministic guard replaces the advisory with **Unclassified critical evidence** when a critical finding falls outside the learned taxonomy, or contradicts a healthy model rank. It preserves the raw six-class scores and has no model confidence; it is not a learned seventh class. No LLM generates ledger facts, and no external AI call is needed or claimed.

## Actual PayPal sandbox probe

This optional path calls the fixed sandbox origin `https://api-m.sandbox.paypal.com`. It creates a **USD 1.00 DRAFT** invoice containing fictional `example.test` recipient data, then reads it back and checks its identity, amount, currency, and draft status. It exposes no send, payment, capture, or refund method. Each CLI run can create a new sandbox draft.

Use an **existing, authorized sandbox application**. Copy the blank example and edit the local file:

```sh
cp .env.example .env
```

Supply either:

```dotenv
PAYPAL_CLIENT_ID=existing_sandbox_client_id
PAYPAL_CLIENT_SECRET=existing_sandbox_client_secret
```

or an existing, unexpired sandbox bearer token:

```dotenv
PAYPAL_SANDBOX_ACCESS_TOKEN=existing_single_line_sandbox_token
```

The client ID and secret path exchanges credentials at `/v1/oauth2/token`; the existing-token path skips that exchange. Credentials remain server-side. Do not publish `.env`, tokens, screenshots of secret fields, or raw provider responses. The adapter uses the token response's actual expiry, timeouts, constrained rate-limit retries, fixed allowed operations, and redacted diagnostics.

After editing `.env`, restart the server and click **Run sandbox probe**, or run:

```sh
npm run sandbox:probe
```

The CLI saves sanitized successful evidence to `artifacts/paypal-sandbox-probe.json`. With missing credentials it exits with code 2 and writes no successful evidence. A request failure exits with code 1; draft creation may have succeeded before a later lookup failed, so inspect the sandbox dashboard before retrying. After a successful native probe, the UI adds My sandbox draft: imagined payment. Its reference is the observed PayPal DRAFT snapshot; its untrusted payment delivery is explicitly simulated. The protected journal must remain DRAFT with no posted payment. Contract-test probes cannot unlock this case; true execution remains required.

Existing credentials have not been supplied to this build task; **no actual sandbox result is currently claimed**. Adapter contract tests use injected, explicitly mocked responses. The optional signature-postback helper is not exercised by the scenario library, and the prototype exposes no public webhook ingress.

Official references: [PayPal AI developer resources](https://developer.paypal.com/ai-tools/get-started), [PayPal AI Toolkit](https://github.com/paypal/AI-Toolkit). The Toolkit was consulted as a reference; it is not a runtime dependency or a claimed integration.

## API checks

With the local server running:

```sh
curl http://127.0.0.1:4178/api/status
curl http://127.0.0.1:4178/api/scenarios
curl http://127.0.0.1:4178/api/model
curl -X POST http://127.0.0.1:4178/api/replay \
  -H 'Content-Type: application/json' \
  -d '{"scenarioId":"duplicate-storm"}'
curl -X POST http://127.0.0.1:4178/api/replay \
  -H 'Content-Type: application/json' \
  -d '{"scenarioId":"reordered-refund","dropDeliveryIds":["D2"]}'
```

`/api/replay` accepts a known `scenarioId`, optional boolean `reverse`, and optional `dropDeliveryIds` / `duplicateDeliveryIds` arrays of known fixture delivery IDs. It does not ingest arbitrary webhook events. POST requests require JSON, with a 16 KiB body limit.

## Validation and limits

`npm test` passed **46 tests**: 20 reducer, six ML, 14 stubbed PayPal contract, and six server checks. Fresh Chromium verified all six displayed cases, a dropped-payment experiment, evidence download, and mobile layout. PayPal contract tests use stubs; they do not demonstrate actual sandbox calls. See the [validation report](artifacts/TEST_REPORT.md).

The prototype uses in-memory replay. Durable webhook ingestion, database transactions, worker concurrency, a complete invoice lifecycle, production operations, and real merchant outcome studies are outside its implemented scope. The evidence hash covers deterministic replay content before classifier output is attached; it is not a signature, a trusted timestamp, or a guarantee of source authenticity.

## Offline demonstration and project status

[Watch the 2m12s offline synthetic preview](video/InvoiceReplayLab_Offline_Synthetic_Preview.mp4). This records the actual local browser prototype and prominently labels **SYNTHETIC / OFFLINE PREVIEW | SANDBOX NOT EXECUTED**. Its narration uses the local computer voice. It demonstrates replay behavior and fitted local AI inference; it does not demonstrate a PayPal API execution.

The source repository is [prakharsingh1/invoice-replay-lab](https://github.com/prakharsingh1/invoice-replay-lab), licensed under [MIT](LICENSE), copyright 2026 Prakhar Singh. No actual PayPal sandbox execution or hackathon submission is claimed. A compliant final entry still needs genuine sandbox evidence and its final public demonstration. Consult the [official rules](https://paypalaihackathon.devpost.com/rules) for authoritative entry terms.
