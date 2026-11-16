# Plan a feature

Write `plan.md`. Do not edit source files. Do not invent requirements.

## Acceptance criteria
- AC1: <testable statement>

## Test plan
Mention every acceptance criterion id in this section.
- cmd: <command>

Work units use this table. One verification command per unit:

| ID | Goal | Files (create/modify) | Depends on | Verify with |
| --- | --- | --- | --- | --- |
| U1 | <goal> | <path> | - | <command> |

Two units must not share a file unless one depends on the other.
Prefix files that do not exist with `new:`.
