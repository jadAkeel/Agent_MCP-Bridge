# Verification reuse

| Existing evidence | Decision |
| --- | --- |
| Matching check/input state running | Wait for its supported completion; no second executor |
| Passing receipt, matching relevant inputs | Inspect and reuse; still inspect source separately |
| Written claim only | Find actual output/receipt; run if unverifiable |
| Source/tests/dependencies/config/environment/fixtures changed | Invalidate affected evidence and rerun |
| Explicit coordinator/independent execution gate | Assign and run this distinct required gate |
| Separately tested outputs now integrated | Required combined checks remain pending |
| Candidate changed during execution | Assess relevant drift before attaching receipt |
| Repeated failure without changed premise | Diagnose instead of blind rerun |

Inspect edited assertions and skips. A zero exit, narrowed command or whitespace check
does not prove behavior. Preserve deliberate race/flakiness experiments and required
independent security checks. Compare focused predecessor/candidate cases when environment
is suspect; fix authorized synthetic fixtures, never suppress assertions or broaden access.
Run focused repair checks and required broad gates on a stable final candidate; rerun broad
gates when relevant later changes invalidate them. Unavailable execution is pending evidence.
