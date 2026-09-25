---
"@stoneforge/smithy": patch
---

Update Claude Agent SDK to 0.3.282 and terminate SDK processes when sessions close. Sanitize the environment for Claude model discovery as well as session launches.

Align Codex app-server integration with the current model catalog, paginated model discovery, turn cancellation IDs, nested turn completion status, error notifications and command output. Terminate failed headless sessions with a non-zero exit instead of leaving their message queues open. Preserve resume IDs reported during graceful shutdown without marking stopped agents as running.
