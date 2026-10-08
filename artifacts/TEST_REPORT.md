# Verified local validation

Date: 8 October 2026. Command: `npm test`. Result: **46 tests passed, zero failed**.

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

`npm run sandbox:probe` was run without credentials: exit code 2, no API execution and no success evidence file. `npm run validate` generated explicitly synthetic evidence. The prototype has not been submitted or tested with actual PayPal sandbox credentials. The source now includes its approved MIT license; publication does not establish sandbox integration.
