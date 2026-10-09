# InvoiceReplayLab

**Evidence before action.** A local workbench for reproducing invoice event-handling bugs, comparing a naive listener with a protected journal, and inspecting every finding's source evidence.

Built for Prakhar Singh's PayPal AI Hackathon project. This runnable local prototype combines six authored synthetic histories, a fitted local classifier, and a recorded PayPal sandbox draft observation. One authorized native sandbox probe successfully created and read a USD 1.00 DRAFT on 9 October 2026. The draft anchors a separate, explicitly imagined untrusted-payment experiment; it is not a real payment or webhook history. The server and default CLI inspect recorded evidence without PayPal requests. All 70 current tests and isolated browser checks passed. This source is MIT-licensed. The integrated 148.84-second local demo is ready for upload. Public video availability and final entrant review remain pending; no hackathon submission is claimed.

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

`train` regenerates `artifacts/model.json`. `validate` writes `artifacts/validation.json` and `artifacts/example-evidence.json`, and validates the bundled recorded draft offline. These commands do not call PayPal or an external AI service. The measured model result, separate validation runs, and actual sandbox observation are recorded below.

## A five-minute judge walkthrough

1. Keep the provenance disclosure visible. The bundled public observation works without credentials; the badge should read **RECORDED SANDBOX DRAFT**. It represents recorded sandbox evidence, not a fresh API request.
2. Select **The invoice paid three times** (`duplicate-storm`), then click **Replay incident**. Inspect the naive listener's USD 720 payment total versus the protected journal's USD 240 payment total. The repeated event and repeated transaction cannot double-post money in the protected journal.
3. Select a timeline delivery or finding's evidence button. Inspect the actual event identity, delivery identity, timestamps, journal verdict, and reason.
4. Select **The refund that beat its payment** (`reordered-refund`). The protected journal resolves the USD 30 refund against its USD 120 payment; a stale sent event cannot regress the derived state. Select payment delivery `D2`, click **Drop selected**, and replay: the refund should remain unapplied and the discrepancy should be visible. Click **Reset changes** and replay to restore the baseline.
5. On **Two payments, one partial refund** (`healthy-partial`), inject a duplicate using **Duplicate selected**, or enable **Reverse arrival order**. Replay to compare the journal with the altered delivery history.
6. Select **One identity, two amounts** (`amount-conflict`): both claims for the ambiguous transaction are excluded, so the protected paid total is USD 0 and differs from the USD 250 snapshot. Inspect the critical conflicting-amount evidence. The model may rank a missing-state signal from this mixed case; the amount-conflict evidence remains visible.
7. Expand **Model provenance & limitations**. Model output ranks an incident category; deterministic evidence determines the journal. Confidence is a relative softmax score, not a calibrated probability of correctness.
8. Click **Export evidence JSON**. The export labels its synthetic provenance and includes timeline decisions, findings, model output, and a deterministic replay evidence hash.
9. Select **My sandbox draft: imagined payment**. Its reference is the recorded DRAFT, while its payment delivery is simulated and untrusted. The naive listener records USD 1.00; the protected journal remains DRAFT with paid USD 0.00 and quarantines the imagined delivery. This path passed fresh isolated browser checks without additional API requests.

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

## Actual PayPal sandbox observation and probe

A native probe completed at **2026-10-09T16:11:36.361Z**:

| Recorded operation | Result |
| --- | --- |
| `POST /v1/oauth2/token` | HTTP 200 |
| `POST /v2/invoicing/invoices` | HTTP 201; returned `INV2-N7L3-U92J-8WXX-HQLX` |
| `GET /v2/invoicing/invoices/INV2-N7L3-U92J-8WXX-HQLX` | HTTP 200; same identity, DRAFT, USD 1.00 |
| Evidence provenance | `source: paypal-sandbox`, `executed: true`; native transport |

This establishes draft creation and readback. No send, pay, capture, or refund operation occurred. Inspect the [public recorded sandbox evidence](artifacts/paypal-sandbox-evidence.public.json). The fuller sanitized local result is stored in ignored `artifacts/paypal-sandbox-probe.json`; credentials and raw provider bodies are not published.

The server is strictly read-only with respect to PayPal. The default CLI also inspects recorded evidence and sends **zero requests**:

```sh
npm run sandbox:probe
```

External creation is a separately authorized CLI action requiring the explicit `--create-new-draft` flag. It uses only `https://api-m.sandbox.paypal.com`, creates a **USD 1.00 DRAFT** with fictional `example.test` recipient data, and reads it back. An existing private result or attempt marker prevents repeated creation in the same checkout. No send, payment, capture, or refund method is exposed.

To reproduce the probe under your own authorization, use an **existing, authorized sandbox application**. If a local `.env` does not already exist, copy the blank example and edit the local file; preserve any existing private configuration:

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

An independently approved, eligible new creation run uses:

```sh
npm run sandbox:probe -- --create-new-draft
```

The creation path saves sanitized successful evidence to `artifacts/paypal-sandbox-probe.json`. Its prior-result/attempt guard prevents silently creating another draft; do not remove that guard to replay the demonstration. The read-only server and default CLI reuse valid recorded evidence. **My sandbox draft: imagined payment** uses its observed DRAFT snapshot and an explicitly simulated untrusted payment delivery. The protected journal must remain DRAFT with no posted payment. Contract-test responses cannot substitute for the native observation.

Existing credentials were configured privately by the owner for the successful bounded probe. Adapter contract tests still use injected, explicitly mocked responses and remain separate from its native execution evidence. The optional signature-postback helper was not invoked by that probe. The prototype exposes no public webhook ingress and has observed no paid or refunded invoice history.

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

The final aggregate `npm test` run passed **70/70 tests**, with **zero failures, skips, or cancellations**, in 1759.769209 ms on 9 October 2026. Fresh isolated browser checks passed all seven scenarios, including the recorded-draft badge and USD 1.00 naive versus USD 0.00 protected DRAFT behavior, without additional API requests. The native probe remains separate from stubbed contract tests. See the [validation report](artifacts/TEST_REPORT.md).

The prototype uses in-memory replay. Durable webhook ingestion, database transactions, worker concurrency, a complete invoice lifecycle, production operations, and real merchant outcome studies are outside its implemented scope. The evidence hash covers deterministic replay content before classifier output is attached; it is not a signature, a trusted timestamp, or a guarantee of source authenticity.

## Demonstrations and project status

The historical local artifact `video/InvoiceReplayLab_Offline_Synthetic_Preview.mp4` is a 131.92-second offline preview, recorded before any PayPal API execution. Its offline banner and computer-voice narration remain accurate for that footage. The file is not included in the public text-only repository. The current integrated local demo is `video/InvoiceReplayLab_Integrated_Demo.mp4`: 148.84 seconds, H.264/AAC, with actual browser footage, original local computer-voice narration, and a persistent recorded-sandbox / synthetic-replay disclosure. It decoded successfully end to end, and representative frames were reviewed for chapter alignment. No further PayPal request occurred. Video files are distributed separately from this source repository; the public YouTube URL is pending.

The source repository is [prakharsingh1/invoice-replay-lab](https://github.com/prakharsingh1/invoice-replay-lab), licensed under [MIT](LICENSE), copyright 2026 Prakhar Singh. The reviewed source/evidence scope is 29 text files. Video publication is separate; binary videos and screenshots are distributed outside this source repository. Final review, public video verification, and any submission decision remain with the project owner. Consult the [official rules](https://paypalaihackathon.devpost.com/rules) for authoritative entry terms; no final eligibility or submission outcome is asserted here.
