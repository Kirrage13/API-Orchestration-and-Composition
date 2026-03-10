# Grade Report: Practice 3 — API Orchestration & Service Composition

**Submission:** 2026-03-10 20:19:02.877 UTC
**Commit:** local

## Deterministic Automated Results (26 points)

| # | Test | Points | Status |
|---|---|---|---|
| 1 | Services start and health checks pass | 2/2 | PASS |
| 2 | Happy path full sequence and completed result | 4/4 | PASS |
| 3 | Payment fail short-circuits downstream calls | 3/3 | PASS |
| 4 | Inventory fail triggers payment refund compensation | 4/4 | PASS |
| 5 | Shipping timeout within limit triggers compensation | 4/4 | PASS |
| 6 | Compensation failure mapped to 422 + compensation_failed | 2/2 | PASS |
| 7 | Idempotency replay same key same payload | 3/3 | PASS |
| 8 | Idempotency mismatch same key different payload => 409 | 2/2 | PASS |
| 9 | Trace contract strict fields and order | 2/2 | PASS |

## Bonus Stress (2 points, cannot reduce score)

| 10 | Bonus probabilistic stress checks | 2/2 | PASS |

## Manual Review (2 points)

| Item | Points | Status |
|---|---|---|
| README quality + architecture rationale | -/2 | MANUAL REVIEW |

**Deterministic Automated Score: 26/26**
**Bonus Score: 2/2**
**Total with Bonus (without manual): 28/28**
**Manual Review Remaining: 2 points**