# Verify

Reviewers do not edit files. Do not commit. Do not push.

One finding per line:

MUST src/a.ts:10 Title | failure scenario | suggested fix
NICE src/a.ts:3 Title | why | suggestion
COULD src/a.ts:1 Title

Three reviewer angles:

- correctness
- tests and intent
- security, data, and performance

Fewer than 300 changed lines uses one reviewer. 300 or more uses one reviewer for each angle.
A verifier replies `DISPROVE M1 reason` for a must-fix that does not hold.
Later passes reply `BASE M1 resolved` or `BASE M1 open`.
New must-fix items are deferred and are not fixed in this run.
Fix only the pass-1 ids you are given. Do not edit other files.
