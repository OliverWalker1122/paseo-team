# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Tiered test suite: L1 unit & prompt contract tests (`npm run test:unit`), L2 full 5-hook & tool pipeline integration tests (`npm run test:integration`), L3 opt-in live Paseo daemon E2E acceptance suite (`npm run test:e2e`), and Node native coverage reporting & SVG badge generator (`npm run test:coverage`, `npm run coverage:badge`).
- Open-source repository templates (`CODE_OF_CONDUCT.md`, GitHub issue & PR templates) and stricter unused-code TypeScript checks (`noUnusedLocals`, `noUnusedParameters`).

### Changed

- Team page: the default-preset and delete actions share one row, Delete is shown in the danger color with a trash icon, and the delete confirmation has a Cancel button.

### Fixed

- Auto-allow coordinator read-only permission checks (`list_pending_permissions`, `list_hosts`, `list_workspaces`, `list_profiles`), dot-delimited provider tool names (`paseo.*`), and task-child-scoped `respond_to_permission` calls in `agent.permission.before` to prevent Antigravity coordinator+child permission deadlocks.
- Separated plan-reviewer vs. code-reviewer prompt guidance (`stage: "plan" | "code"`) and removed the contradictory subagent safety-rule repetition instruction.
- Removed unused dead code in `client/TeamGraphPanel.tsx` and obsolete `UI_TEXT` entries in `shared/i18n.ts`.

### Changed

- Removed automatic model matching. A task now refuses to start and names each role that has no model; pick one in Team settings or turn a reviewer off.
- Team graph: compact square node tiles, short rows for finished tasks, long details collapsed until opened; the "start another task" box under the graph is gone (use `/paseo-team` in the chat).
- A coordinator or member chat's team graph has a "Back to main chat" button that opens the chat which started the task.
- Presets: deleting the default preset is allowed (the first remaining preset becomes default) and the confirmation says where its projects go; the preset card has one select, a default row and a delete row.
- Opening Team no longer loads the whole task history; History loads when its tab is opened, and the config page renders from the last loaded settings while it refreshes.

- Each team task now runs in a new coordinator session that inherits the launching chat's model, so one chat can start several tasks. The chat's graph shows each task as a subtree.
- Members hand off through their own submit tools (`paseo_team_submit_delivery`, `paseo_team_submit_plan`, `paseo_team_submit_review`), which validate the input; a turn that ends without a submission gets one reminder; if the member still does not submit, the coordinator may record on its behalf. Recording is refused while a reminder is pending or after the member submitted, so a handoff is never recorded twice.
- A blocked quality gate lists each missing item, including dispatched reviewers that never submitted.
- One Developer writes at a time; parallel Developers are no longer suggested.
- Quality gate no longer fingerprints the workspace. It checks that the latest CI run passed after the previous rework round and that the latest review round approved, so user edits and commits no longer block it.
- The two-round review limit is soft: verdicts are always recorded, and the task is flagged for a user decision instead of rejecting the record. Authorizing an extra round now actually allows it.
- Code review is no longer forced by diff size or architecture-impact wording; the coordinator decides, and delivery reports diff size as advice.
- Rerunning a check with an existing log name picks a new name instead of failing.

### Removed

- `paseo_team_register_agent`; the plugin registers member sessions itself.
- Workspace content fingerprints, review anti-spoofing sidecar checks, `substantialChange` and `rawOutput` review inputs.

## [6.0.0] - 2026-11-25

First public release as a native Paseo plugin.

### Added

- Team tasks started from any chat with `/paseo-team`, with this chat as the coordinator.
- Separate Developer, Code Reviewer and optional Expert and Plan Reviewer sessions, each with only the permissions its role needs.
- Cross review by two reviewers from opposing angles, limited to two rounds before the team asks you to decide.
- Quality gate with five checks, bound to a fingerprint of the current workspace contents.
- Credential-isolated CI runner that records results without command arguments.
- Setup screen to choose provider, model and reasoning effort per role, with saved presets.
- Live team graph for each chat, and a history view with every review round and its findings.
- English and Chinese UI that follows the Paseo app language.

[6.0.0]: https://github.com/OliverWalker1122/paseo-team/releases/tag/v6.0.0
