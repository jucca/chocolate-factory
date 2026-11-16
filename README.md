# Chocolate Factory

Stampable, local rehearsal software factory. V1 ships a stamp CLI, contract/roadmap files, a simulator run engine, fail-closed gates, and a cockpit so operators can drive a run to **commit-ready** without a live agent.

## Prerequisites

- Git
- [Node.js](https://nodejs.org/) 22 or newer
- [pnpm](https://pnpm.io/) 9+ (`corepack enable` then `corepack prepare pnpm@latest --activate`)
- Optional: [GitHub CLI](https://cli.github.com/) (`gh`) authenticated, if you want a live issue inbox

## 1. Restore on the laptop (full guide: local env setup)

From a git bundle:

```bash
git clone /path/to/chocolate-factory-v1.bundle chocolate-factory
cd chocolate-factory
git checkout feat/chocolate-factory-v1
pnpm install
pnpm test   # expect 66 passed
```

Bundle path: `chocolate-factory-v1.bundle`.

Or clone the GitHub remote (still check out the feature branch — `main` is an empty PR base):

```bash
git clone https://github.com/jucca/chocolate-factory.git chocolate-factory
cd chocolate-factory
git checkout feat/chocolate-factory-v1
pnpm install
pnpm test   # expect 66 passed
```

This repo is already stamped (`.chocolate/` is present). Serve it as the factory root with `.` in the commands below.

To stamp a **different** git repo once:

```bash
pnpm exec tsx bin/chocolate.ts stamp /path/to/other-repo
```

A second stamp on the same repo is refused. Stamp creates `.chocolate/` (contracts, roadmap, config, templates, exec-plans, runtime) and gitignores `.chocolate/runtime/`.

## 2. Run the cockpit

Two processes: API on `:4200`, Vite UI proxying `/api` to that port.

```bash
# Terminal 1 — API on http://127.0.0.1:4200
pnpm exec tsx bin/chocolate.ts serve .
```

```bash
# Terminal 2 — UI (Vite proxies /api → :4200)
pnpm exec vite --config web/vite.config.ts
```

Open the UI at **http://127.0.0.1:5173**. Leave the API running; the UI will not load roadmap or runs without it.

## Use the factory

Workflow is **spec → plan → implement → test → verify → commit**. V1 success is **commit-ready**. History is append-only: retries and replans are new attempts.

| Gate | Kind | Operator action |
| --- | --- | --- |
| spec, plan | soft | Approve, rework, or override with a recorded reason |
| verify, commit | hard | Approve only when independent evidence exists — no override |

### Roadmap tab

- Milestones and contracts from `.chocolate/roadmap.yaml` and `.chocolate/contracts/*.yaml`
- Derived status (not-started, in-progress, in-review, failed, commit-ready, …)
- Edit a contract’s title and intent in the cockpit (writes back the YAML surgically)

Invalid contract files block runs. Fix the YAML, then refresh.

### Runs tab

1. **Issue inbox** lists open GitHub issues labelled `chocolate:ready` (see config below). Refresh inbox to re-sync.
2. **Claim & start run** binds the issue to a contract (or creates a draft `issue-<number>` contract) and starts a simulator run.
3. Open the run: **Advance phase** walks spec → plan → implement → test → verify → commit.
4. At a gate, approve / rework / override (soft only). Hard gates fail closed without evidence.
5. If the run **failed**, **New Attempt** starts a new attempt from spec. Previous attempts stay in the event log.

Exec plans live under `.chocolate/exec-plans/`. Run data lives in `.chocolate/runtime/` (SQLite) and must not be committed.

### GitHub inbox

Edit `.chocolate/config.yaml`:

```yaml
issue_label: chocolate:ready
issue_source:
  repo: owner/repo   # e.g. jucca/chocolate-factory
```

The inbox uses `gh issue list`. If GitHub is unreachable, the cockpit shows the last synced issues as stale.

Without a configured repo, the inbox is empty or stale; you can still inspect this repo’s v1 contracts on the Roadmap tab and run `pnpm test`.

### Layout

See `.chocolate/AGENTS.md` for the map. Contracts are one YAML per feature; every acceptance criterion maps to a gate.
