# Agent Scan adoption

Chocolate Factory is a local stamp, simulator, and playbook engine. A finished playbook run is commit-ready when a non-draft pull request is open and CI is green. Verify is a hard gate. Its evidence is a reviewer reading the diff. Playbook instructions live in `src/engine/playbooks/`.

[Snyk Agent Scan](https://github.com/snyk/agent-scan) is a Python CLI that discovers installed agent components (MCP servers and `SKILL.md` skills) and sends their contents to Snyk for risk scoring. This repository has no `SKILL.md`, no MCP config, and no skill directory. Agent Scan therefore has nothing in this repo to judge.

## Decisions

- Agent Scan stays out of Chocolate Factory.
- No package, binary, workflow, config key, contract, or playbook step invokes it.
- A personal run of `uvx snyk-agent-scan` on a developer machine is outside this repo. The factory does not document it or require it.
- Verify stays a reviewer of the diff. Commit-ready stays an open, non-draft pull request with green CI.
- No new tests. Existing gate and playbook tests remain the proof that verify and commit are unchanged.

## Reopen

Open a new design only when this repo, or the git repo a playbook run is driving, contains a skill a worker is instructed to load (`SKILL.md`) or an MCP configuration a worker is instructed to start (for example `mcp.json`). A file that merely exists, and that no worker loads or starts, does not reopen this decision.

That later design:

- Scans only those paths.
- Pins a CLI version.
- Stores the report as evidence a person reads.
- Leaves the hard gate decision with the person. The scanner's exit code does not pass or fail the gate by itself.

Until that condition is true, this decision stands and no follow-up work is scheduled.

## Out of scope

- Adding a Snyk token, a Python toolchain, or a CI job for Agent Scan.
- Scanning a developer machine, user-level skills, or user-level MCP configs from a playbook run.
- Changing the verify playbook, the gate evaluator, or the commit-ready rule.
- Vendoring Agent Scan or depending on its CLI output schema.
