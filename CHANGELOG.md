# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [7.0.0] - 2026-11-28

Slim single-source-of-truth rewrite backed directly by Paseo's native agent tree, plus full UI redesign and per-role permission modes.

### Added

- **Composer Team mode toggle**: one-click `Users` toggle across New Workspace, draft chats, and existing chats (replaces the earlier `Workflow` icon so it never collides with Ultracode).
- **Per-role permission mode configuration**: choose provider-specific permission modes (`auto`, `full-access`, `bypassPermissions`, etc.) alongside model and reasoning effort for every role in **Team → Setup**.
- **Running / History split views**: sidebar **Team** screen defaults to **Running** sessions (with a top horizontal switcher when multiple teams run) and lists idle sessions under **History** with click-to-expand inline DAGs.
- **Terminal DAG node & subagent completion badges**: finished subagents display **Done** (`已完成`), and completed rounds end with a clickable **Round complete** (`本轮已收口`) node linking straight back to the Coordinator chat.
- **Shared real-time daemon stream hub**: single reference-counted `agents.list({ subscribe: {} })` stream with reconnect snapshot replacement and conditional active-session reconciliation so team views and badges stay continuously live.
- **Compact kickoff timeline bubble** for `/paseo-team` messages and tiered offline + opt-in live Paseo E2E tests (`test:unit`, `test:integration`, `test:coverage`, `test:e2e`).

### Changed

- **Slim 2-hook server architecture**: reduced server hooks to `agent.open.before` (Turn-1 direct roster + protocol injection when Team mode is enabled, concise subagent guides with zero custom tools, read-only `paseo_team_roster` fallback) and `agent.permission.before`.
- **Redesigned Team UI & pure localized labels**: unified tab/button naming to **Team** (`团队`), widened high-contrast DAG node cards, added a dedicated top toolbar with clear **Back to main chat** / **Setup** buttons, expanded **Complex tasks** permanently in setup, and removed mixed English/Chinese labels in Chinese UI.
- **Coordinator token & context discipline**: preserved Coordinator's architecture and root-cause role in `simple` mode while guiding parallel read-only lookups, avoiding redundant `get_agent_activity` / huge full `git diff` dumps, and avoiding legacy state paths.

### Removed

- Local `task.json` disk state machine (`server/task-store.ts`), custom quality gate (`server/quality-gate.ts`), passive turn observer (`server/turn-observer.ts`), workspace locks, and all custom subagent handoff tools.
- Dead helpers (`defaultStateRoot`, `formatRoleSpecShort`, unused `roleOverrides` / `GraphLayerSchema.subtitle`, obsolete `test:e2e:all` script).

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

[7.0.0]: https://github.com/OliverWalker1122/paseo-team/compare/v6.0.0...HEAD
[6.0.0]: https://github.com/OliverWalker1122/paseo-team/releases/tag/v6.0.0
