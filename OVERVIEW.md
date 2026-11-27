Role-separated multi-agent collaboration for Paseo with per-role model, reasoning effort, and permission mode setup, a composer Team toggle across New Workspace and open chats, and a real-time agent DAG powered directly by Paseo's native sessions (English and Chinese).

## Highlights

- **Direct Role Setup**: Pick `Developer`, `Code Reviewer #1 / #2`, and optional `Expert` / `Plan Reviewer` models, reasoning effort, and permission modes (`auto`, `full-access`, `bypassPermissions`, etc.) directly from connected Paseo providers on one expanded setup page.
- **One-Click Team Toggle Everywhere**: Enable the Team toggle right in the composer toolbar on New Workspace, draft chats, and existing chats, or run `/paseo-team <goal>` directly.
- **Single Source of Truth**: Zero local task state machine, zero stale locks, and zero custom subagent handoff tools. Your chat coordinates via Paseo's native `create_agent` and `send_agent_prompt` callbacks while the **Team** view streams live updates directly from Paseo daemon.
- **Running & History Views**: The sidebar **Team** screen defaults to **Running** sessions with a top horizontal switcher, while completed sessions live in a clean **History** list with click-to-expand inline DAGs and a terminal **Round complete** card linking straight back to the main chat.
- **Adversarial Cross Review**: Two independent reviewers examine changes from opposing angles (requirements and real edge cases vs. architecture and simpler alternatives) with a 2-round cap before handing trade-offs back to you.
- **Native Workspace Integration**: Subagents work directly in your chosen Paseo Workspace (project folder or Paseo-managed worktree) without hidden worktrees or unsolicited merges or pushes.
- **Follows the Paseo App Language**: Pure Chinese UI when Paseo is set to Chinese, English otherwise; subagent instructions follow the language of your task.

## Quick Start

1. Click **Team** in the sidebar (or run `/paseo-team setup`) and pick a model, effort, and permission mode for each role.
2. Turn on the **Team mode** icon in any composer (including New Workspace) and send your goal, or run `/paseo-team <your task goal>` in an open chat.
3. Click the **Team** composer pill to watch live subagent waves and jump between subagents and your main chat.
