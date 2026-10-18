---
name: memory
description: Save, recall, and forget persistent cross-session memories for this project. Use when the user says remember this, remember that, keep in mind, don't forget, recall what we said about, what do you remember about, or forget that; when they run /memory save, /memory forget, /memory show, or /memory list; or when they state a preference, correction, or project fact that should survive the session.
---

# Memory — Persistent Project Recall

Save, recall, and forget facts that should survive the session across conversations. Memories live
per project under `~/.opencode/memories/projects/<slug>-<hash16>/memory/` (or `~/.kiro/memories/projects/<slug>-<hash16>/memory/`).

## Syntax

- `/memory save <fact>` — or the user saying "remember this/that ..." in any phrasing
- `/memory forget <topic>` — remove matching memories from disk and from `MEMORY.md`
- `/memory show [topic]` — print the index and/or matching memory files
- `/memory list` — list all saved memory files

## Saving

Write the memory file **immediately** — no confirmation round-trip.

1. Pick the best-fitting type:
   - `user` (preferences, style, habits)
   - `feedback` (corrections, how work should be done)
   - `project` (decisions, constraints, architecture context)
   - `reference` (pointers to external resources or systems)
2. Write one markdown file per memory with frontmatter:
   - `name`: kebab-case slug matching filename
   - `description`: one-line summary of when this memory matters
   - `metadata.type`: one of the 4 types above
   The body holds the fact and `[[name]]` cross-references.
3. Update `MEMORY.md` index:
   `- [Title](file.md) — hook`

**Never save what the repository already records** (code structure, git history, fix recipes, docs), nor ephemeral task state. If a matching memory already exists, update that file instead of creating a duplicate.

## Forgetting

Find memory file(s) matching the topic — delete each file and remove its line from `MEMORY.md`.

## Showing & Listing

Print the `MEMORY.md` index; for a named topic, print the matching memory file bodies.
