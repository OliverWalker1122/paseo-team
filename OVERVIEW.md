Role-separated multi-agent orchestration, direct model routing (zero external Agent Profile setup), adversarial cross review, and a per-conversation left-to-right agent pipeline graph (English and Chinese).

## Highlights

- **Zero-Friction Direct Model Setup**: Pick `Developer` and `Code Reviewer #1 / #2` models and reasoning effort directly from connected Paseo providers in a compact 3-row table, with no need to pre-create Paseo Agent Profiles.
- **Native Paseo Workspace Integration**: Subagents work directly inside your chosen Paseo Workspace (project directory or Paseo-managed worktree), keeping live file diffs and commits inside Paseo's native UI without hidden plugin worktrees.
- **1 Conversation = 1 Live Left-to-Right Graph**: Visualize Coordinator, single or parallel Developers, two cross-reviewing Code Reviewers, and the Quality Gate (plus native Paseo subagent trees) with one-click session switching.
- **Evidence-Based Quality Gate**: Credential-isolated CI runs (`SKIP_DOTENV=true`), latest-round review approvals, and a 2-round review limit that hands the decision back to you.
- **Follows the Paseo App Language**: Chinese when Paseo is set to Chinese, English otherwise; subagent prompts match your task language.

## Quick Start

1. Click **Team** in the sidebar (or run `/paseo-team setup`) to optionally customize models. Out of the box, `Auto` model matching works with zero setup.
2. Run `/paseo-team <your task goal>` inside any chat, or click the **Team Graph** composer pill to view the live left-to-right pipeline.
