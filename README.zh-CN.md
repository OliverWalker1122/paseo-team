# Paseo Team

[English](./README.md) | 简体中文

[![CI](https://github.com/OliverWalker1122/paseo-team/actions/workflows/ci.yml/badge.svg)](https://github.com/OliverWalker1122/paseo-team/actions/workflows/ci.yml)
[![Coverage](./.github/badges/coverage.svg)](https://github.com/OliverWalker1122/paseo-team/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen.svg)](./package.json)
[![Paseo](https://img.shields.io/badge/paseo-%3E%3D0.17.3-informational)](https://paseo.sh)

一个轻量级的 [Paseo](https://paseo.sh) 角色分离多 Agent 协作插件：一次配好各角色模型，在任意输入框（含「新建 workspace」）一键点亮**团队模式**，直接基于 Paseo 原生会话树查看实时 DAG 状态图。

## 设计理念

同一个 Agent 既写代码又自审，容易对自身盲点放行；而维护一套复杂的私有磁盘状态机，又容易和宿主状态漂移冲突。Paseo Team 坚持极简单一真源：

- **单一真源**：直接以 Paseo 实时会话树作为唯一状态来源，彻底去掉私有 `task.json` 状态机、本地锁和回复正则解析。
- **纯原生 Paseo 协作**：当前对话直接作为主控，通过 Paseo 原生 `create_agent` / `send_agent_prompt` 派发 Developer 与审查员并接收回调，零自定义交接工具。
- **一次配置，处处复用**：在 **团队 → 配置** 里按角色选好 Provider、模型与推理强度即可自动生效。

## 功能

- **全场景输入框「团队模式」开关**：在 **新建 workspace**、**草稿对话** 和 **已有对话** 的底部工具栏都提供双人图标开关，点亮后直接发需求即可；也支持 `/paseo-team <任务目标>`。
- **清晰角色分离**：主控负责定范围、写验收标准、派发与裁决，不直接改业务代码；同一时刻仅一名 Developer 写代码并运行完整测试；审查员只审不改业务代码，可运行测试/复现命令核实边界。
- **对抗性交叉审查**：两位审查员从对立视角（需求与边界场景 vs 架构与简洁性）独立审核，最多 2 轮，仍未通过则整理取舍交由用户裁定。
- **你的工作区，你来提交**：子会话直接继承你当前打开的 Paseo 工作区（本地目录或 Paseo worktree），不建隐藏 `.worktrees`，不擅自 `git commit` / `git push`。
- **实时 DAG 状态图**：每个工作区共享一个「团队状态图」标签页，实时展示主控派出的每一层子会话状态，支持一键进入子对话和 **← 返回主对话**。
- **中英文跟随**：界面跟随 Paseo 语言，Agent 指引跟随任务目标语言。

## 环境要求

- Paseo 0.17.3 或更高版本
- 至少连接一个 Agent Provider（如 Claude、Codex、Antigravity 或 Pi）
- Node.js 22.18 或更高版本（仅开发插件时需要）

## 安装

从 GitHub 安装：

```bash
paseo plugin add git:OliverWalker1122/paseo-team
```

或从本地克隆安装：

```bash
git clone https://github.com/OliverWalker1122/paseo-team.git
cd paseo-team
npm ci
paseo plugin add "$(pwd)"
```

修改本地代码后运行 `paseo plugin reload paseo-team` 即可生效。

## 使用

1. 在 Paseo 侧边栏打开 **团队 → 配置**，为各角色选择模型。
2. 任选以下方式启动团队协作：
   - **新建 workspace / 草稿对话**：点亮输入框底部的双人「团队模式」图标，直接输入需求发送。
   - **已有对话**：输入 `/paseo-team <任务目标>`，或点击底部「团队模式」图标自动补全前缀。
3. 点击输入框上方的 **团队** 胶囊打开实时状态图，点击任意节点查看模型与状态并跳转会话。

### 命令

| 命令                     | 作用                           |
| ------------------------ | ------------------------------ |
| `/paseo-team <任务目标>` | 以当前对话为主控启动团队协作   |
| `/paseo-team setup`      | 打开角色模型与预设配置         |
| `/paseo-team status`     | 打开当前工作区的实时团队状态图 |

### 可选内联短语

| 短语                                 | 效果                       |
| ------------------------------------ | -------------------------- |
| `需要审查` / `开启审查` / `必须审查` | 明确要求开启代码审查       |
| `方案审查`                           | 写代码前先进行方案评审     |
| `不要审查` / `跳过审查` / `免审`     | 本次跳过审查               |
| `用专家模式`                         | 复杂任务派独立专家起草方案 |
| `用简单模式`                         | 复杂任务由主控起草方案     |
| `用 <名称> 预设`                     | 临时使用指定预设           |

英文短语同样支持，见 [README.md](./README.md)。

## 架构说明

```mermaid
flowchart LR
  C["主控（当前对话）"] --> E["专家（复杂任务）"]
  E --> P["方案审查员（并行）"]
  C --> D["Developer（当前工作区写代码 + 跑测试）"]
  P --> D
  D --> R1["代码审查 #1：需求与边界场景"]
  D --> R2["代码审查 #2：架构与简洁性"]
```

- **仅 2 个服务端 Hook**：
  - `agent.open.before`：为团队子会话注入对应角色精简指引（零自定义工具）；新建对话开启团队模式时直接注入完整角色参数表与协作协议（首轮直达、无需额外查工具）；普通对话附带一个只读 `paseo_team_roster` 兜底工具。
  - `agent.permission.before`：为团队主控自动放行只读 `paseo_team_roster` 与 Paseo 原生编排工具调用。
- **状态图与胶囊**：100% 直接由 Paseo 实时会话树（`parentAgentId` / `labels["paseo.parent-agent-id"]`）派生。

## 配置

配置保存在 `~/.config/paseo-team/config.json`（或 `$XDG_CONFIG_HOME/paseo-team/config.json`），兼容 schema v5：

```json
{
  "schemaVersion": 5,
  "default": "Standard",
  "teams": {
    "Standard": {
      "developer": { "model": "codex/gpt-6.1-sol", "thinking": "high" },
      "codeReviewers": [
        { "model": "claude/claude-opus-5-5", "thinking": "high" },
        { "model": "codex/gpt-6-astra", "thinking": "high" }
      ],
      "separatePlanReviewers": false,
      "planReviewers": [],
      "complexMode": "simple"
    }
  },
  "projects": {}
}
```

## 安全与隐私

- 所有配置与状态完全留在本地，无遥测，插件自身不发起任何外部网络请求。
- 所有角色指引强制要求凭据隔离（禁止读取 `.env*`、禁止导出环境变量；格式化、lint 与单测须加 `SKIP_DOTENV=true DOTENV_CONFIG_PATH=/dev/null`）。

报告安全漏洞请见 [SECURITY.md](./SECURITY.md)。

## 开发

```bash
npm ci
npm run ci               # 格式检查、Markdown 检查、类型检查、插件审计、L1 + L2 测试
npm run test:unit        # L1：配置、提示词、处理器与前端 UI 单元测试（离线，<1s）
npm run test:integration # L2：服务端 Hook、RPC 与订阅集成测试（离线，<1s）
npm run test:coverage    # L1 + L2 覆盖率报告与 80% 行覆盖率门槛
npm run coverage:badge   # 更新覆盖率徽章
npm run test:e2e         # L3：真实 Paseo 实跑验收（按需手动触发）
npm run format           # Prettier 格式化
```

客户端代码必须保持跨平台（仅用 React Native 基础组件与 `@getpaseo/plugin/client/ui`，禁用 DOM 与 `node:` 模块），`npm run check:plugin` 会自动审计。

## 参与贡献

欢迎提交 Issue 和 Pull Request，请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 与[行为准则](./CODE_OF_CONDUCT.md)。

## 许可证

[MIT](./LICENSE) © OliverWalker1122
