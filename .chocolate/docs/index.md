# Chocolate docs

- Contract format: one YAML per feature in `.chocolate/contracts/`; every criterion maps to a gate.
- Gates: spec/plan are soft (override needs a recorded reason); verify/commit are hard and fail closed.
- Workflow: spec → plan → implement → test → verify → commit; success in V1 is commit-ready.
- History is append-only: retries and replans are new attempts.
