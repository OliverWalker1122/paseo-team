Role-separated multi-agent collaboration for Paseo with direct role model setup, a composer Team toggle across New Workspace and open chats, and a live agent tree graph backed directly by Paseo's native sessions (English and Chinese).

## Highlights

- **Direct Role Model Setup**: Pick `Developer`, `Code Reviewer #1 / #2`, and optional `Expert` / `Plan Reviewer` models and reasoning effort directly from connected Paseo providers in one compact screen.
- **One-Click Team Toggle Everywhere**: Enable the Team toggle right in the composer toolbar on New Workspace, draft chats, and existing chats, or run `/paseo-team <goal>` directly.
- **Single Source of Truth**: Zero local task state machine, zero stale locks, and zero custom subagent handoff tools. Your chat coordinates via Paseo's native `create_agent` and `send_agent_prompt` callbacks while the graph renders directly from live Paseo sessions.
- **Adversarial Cross Review**: Two independent reviewers examine changes from opposing angles (requirements and real edge cases vs. architecture and simpler alternatives) with a 2-round review cap.
- **Native Workspace Integration**: Subagents work directly in your chosen Paseo Workspace (project folder or Paseo-managed worktree) without hidden worktrees or unsolicited commits.
- **Follows the Paseo App Language**: Chinese when Paseo is set to Chinese, English otherwise; subagent instructions follow the language of your task.

## Quick Start

1. Click **Team** in the sidebar (or run `/paseo-team setup`) and pick a model for each role.
2. Turn on the **Team mode** icon in any composer (including New Workspace) and send your goal, or run `/paseo-team <your task goal>` in an open chat.
3. Click the **Team** composer pill to inspect the live agent graph and jump between subagents and your main chat.
