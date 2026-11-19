<!--
Repo: kirodotdev/KiroCrew
Title: Dashboard: Crew Lobby, a presence view of crewmates (needs you, working, unread, jump to session)
Labels: enhancement, area: dashboard
Related: #12509
Everything below this comment is the issue body.
-->

## What

A **Crew Lobby** page: one calm, people-centric view of every crewmate and agent working for me. Inspired by a Habbo-style lobby, but sober: no pixel art, no game mechanics.

Each crewmate gets a desk card with:

- **Presence**: online (working, waiting on me, or active in the last 15 min), away (active in the last 24 h), offline.
- **What it is doing now**: session title plus the current todo item, the latest message, or the tool it wants to run.
- **State**, most urgent first: awaiting approval, has a question, interrupted, finished (unread), working, waiting for a choice, waiting for instructions, idle.
- **Unread**: a session whose agent replied after I last looked keeps a badge until I open it or mark it read.
- **Context**: time in state ("working for 12 min"), todo progress (3/7), queued prompts, a "no output for 10+ min" hint, linked PRs, model.
- **Jump to session**: one click opens `/chat?sid=<key>` and marks it read.

Layout: zones on a lightly tiled "floor" (Needs you, Finished/unread, Working, Available, Offline), plus a compact list view, search, an "only what needs me" filter, a nav badge (needs you + unread), and an in-app toast when a session moves into approval, question, interrupted or finished. Read-only: the lobby never approves, sends or stops anything.

## Why

With several sessions and crewmates running in parallel, the sidebar is session-centric, so finding who is blocked on me means opening sessions one by one. Existing pieces cover parts of this:

- **Agent Worlds** is spatial, but only shows running/idle, as pixel art.
- **Crew Manager** (registry app) lists needs you / running / done, organised by work item rather than by crewmate.
- #12509 proposes an approvals inbox.

None answers at a glance: who on my crew needs me, who is busy, and what finished while I was away. Presence plus unread is a pattern people already know from Slack and Teams (presence), Discord (activity status), Gather and Teamflow (virtual office), and agent tools such as Devin, Cursor background agents and Codex (needs input, ready for review, unread).

## Additional Context

- **Working POC**: a no-build app (`crew-lobby`), one ES module using `window.__kirocrew_modules`, the same contract as Agent Worlds. Permissions: `api: ["/api/chat/slots", "/api/agents"]`, no events. The manifest passes `AppManifest.validate()`. Happy to share it or open a PR.
- **No new backend data needed for v1.** The slot projection already has `running`, `pending_approval` + `pending_approval_info`, `needs_input`, `has_options`, `waiting_for_input`, `interrupted`, `last_agent_ts`, `last_turn_ts`, `queue_depth`, `todo`, `source_links` and `created_by` (used to group worker sessions under the crewmate that opened them).
- **Gaps a native version should close:**
  1. *Server-side read state.* The POC keeps "last seen" per session in localStorage, so unread does not sync across devices and does not clear when the session is opened from the sidebar. A per-slot `last_seen_ts`, set when the chat pane is focused, fixes both.
  2. *Avatars for app callers.* `GET /api/agents/{name}/avatar` is owner-only and the icon poses live in the dashboard's internal bundle, so an app shows initials on the avatar `bg` color.
  3. *Live updates and CI for app callers.* An app socket only gets slot events for its own sessions (`slots:own`) and `source_links` arrive without `ci`/`state`, so the POC polls every 4 s and shows PR links without CI. A read-only "observe user sessions" scope would fix both.
- **Follow-up**: inline approve/reject on "awaiting approval" cards, reusing the #12509 work.
- Built against the Windows desktop build's app SDK; nothing in the feature is OS-specific.
