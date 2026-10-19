---
name: table-review
description: Work on a Horizon task while preserving owner comments and task identity.
---

# Horizon tasks

The task brief identifies the workspace, task T-ID, review document and installed CLI.
Code belongs to the connected project. The Horizon workspace stores documents and task results.

1. Read the current task and project AGENTS.md. Only the explicit assignment authorizes work.
2. Register the current session using the installed `scripts/agent-session.mjs` with `--root WORKSPACE_ROOT --project local --provider codex --title TITLE --task Tnn`. For connected projects use their actual project ID. Codex takes the session from CODEX_THREAD_ID; never invent a session or task ID.
3. Before work, update only your task's agent fields through the installed `scripts/review-agent.mjs`. Start with **In progress.**
4. After a meaningful result update the same row, beginning with **Needs review.**, **Blocked.** or **Done.** Include time, evidence and next step. Do not overwrite owner comments or other rows.

Read command:

```sh
node /path/to/scripts/review-agent.mjs read WORKSPACE_ROOT reviews/agent-overview.md
```

For an update, write a JSON file with the freshly read `revision` and `changes`:

```json
{"revision":"fresh revision","changes":[{"id":"T01","updates":"**Needs review.** Result and next step.","replyTo":"commentVersion from the original assignment"}]}
```

Then:

```sh
node /path/to/scripts/review-agent.mjs update WORKSPACE_ROOT reviews/agent-overview.md changes.json
```

A fresh revision allows writing; it does not mean a new comment was addressed. Keep `replyTo` from the original assignment. Empty comments and read markers do not indicate approval. Return to the same T-ID across sessions. Subtasks use parentId and may have only two levels. A plan assignment does not authorize implementing its proposed tasks. Never edit .horizon manually.
