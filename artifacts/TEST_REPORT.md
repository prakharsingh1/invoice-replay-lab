# Verified validation and recorded sandbox observation

## Final aggregate — 9 October 2026

Command: `npm test`. Result: **70/70 passed**, **0 failed**, **0 skipped**, **0 cancelled**. Duration: **1759.769209 ms**. Local log: `artifacts/final-test.log`. This completed aggregate supersedes the earlier split-run accounting. Four CLI cases are included; validator boundary fixtures are grouped into 14 named cases.

Fresh isolated browser checks passed **all seven scenarios**, including the recorded-draft badge without credentials/public fallback and the imagined-payment case: naive USD 1.00, protected USD 0.00, DRAFT. No additional PayPal API request occurred during these checks.

The server is strictly read-only. Default `sandbox:probe` prints recorded evidence with zero requests; fresh draft creation requires explicit `--create-new-draft` and is blocked by a prior private result/attempt marker. `scripts/validate.mjs` validates the public recorded observation offline, without PayPal requests. The integrated local demo is complete: 148.84 seconds, H.264/AAC, full decode passed, representative chapter frames reviewed. Public YouTube upload remains pending.

## Historical local baseline — 8 October 2026

The earlier `npm test` run passed **46 tests**, zero failed. The coverage and browser observations below describe that dated baseline.

Coverage: 20 ledger/replay tests; six local model tests including reproducible training and critical-evidence guard; 14 sandbox adapter contract tests with injected stubs; six local server boundary tests. No test result is evidence of an actual PayPal API call. Independent review additionally tested all 63 bundled arrival permutations and recomputed the evidence hash.

Fresh isolated Chromium exercised six scenarios with these displayed protected states:

| Case | Net | Status |
| --- | --- | --- |
| duplicate-storm | USD 240.00 | PAID |
| reordered-refund | USD 90.00 | PARTIALLY_REFUNDED |
| untrusted-payment | USD 0.00 | SENT |
| missing-payment | USD 0.00 | SENT |
| amount-conflict | USD 0.00 | SENT |
| healthy-partial | USD 250.00 | PARTIALLY_REFUNDED |

Browser checks additionally passed for duplicate injection, disabled mutations on injected copies, reverse arrivals, and independent verification of the downloaded report hash. Browser checks passed for dropping the reordered payment (refund quarantined), disabled sandbox probe without credentials, downloaded JSON export, and desktop/mobile screenshots with no page horizontal overflow. Final page reported no new console errors after fixing a missing favicon. The shared Edge browser was not used.

The initial credential-free `npm run sandbox:probe` exited 2 without API execution. `npm run validate` generated explicitly synthetic evidence. Those remain historical local checks.

## Separate native sandbox result — 9 October 2026

One authorized native probe succeeded at **2026-10-09T16:11:36.361Z**: `POST /v1/oauth2/token` returned 200; `POST /v2/invoicing/invoices` returned 201; and `GET /v2/invoicing/invoices/INV2-N7L3-U92J-8WXX-HQLX` returned 200 for the created invoice. The recorded snapshot is **DRAFT, USD 1.00 (100 cents)**, with `source: paypal-sandbox` and `executed: true`. Sanitized evidence is stored locally in ignored `artifacts/paypal-sandbox-probe.json`.

This verifies draft creation/readback separately from stubbed adapter tests. No send, pay, capture, refund, live webhook delivery, or signature-verification operation occurred. The imagined untrusted-payment experiment reuses the observed DRAFT; its fresh browser check passed as recorded above, without another API request.

The reviewed source/evidence scope is 29 text files under MIT. Video publication is separate; binary preview/screenshots are not part of the source update. The local integrated demo has passed full-file decoding and chapter-frame review; public YouTube availability and owner final review remain pending. No completed hackathon submission or final eligibility determination is recorded here.

Additional integrated checks: mobile viewport 390 × 844 had no horizontal overflow (scroll width = client width = 390). The downloaded recorded-draft and synthetic dropped-payment reports independently matched their SHA-256 replay hashes. The recorded-draft export preserved DRAFT and paidCents 0; the dropped-payment synthetic refund remained quarantined.
