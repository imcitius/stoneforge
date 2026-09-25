---
"@stoneforge/smithy": patch
---

Pass agent environment overrides and the Stoneforge workspace root to each Codex thread, including resumed threads. This preserves SF_ENTITY_ID for task commands without leaking another agent's identity through the shared app-server.

Add an opt-in live Director → Worker → Merge Steward check using production services, both Codex and Claude Code, immutable acceptance tests and a local Git origin.
