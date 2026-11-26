import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  controlTaskRpc,
  getConfigBundleRpc,
  getConversationGraphRpc,
  listTasksRpc,
  saveConfigRpc,
  startTeamTaskRpc,
  watchConversationGraphSubscription,
  watchTasksSubscription,
} from "./shared/contracts.ts";
import { detectPromptLanguage } from "./shared/i18n.ts";
import { saveConfig } from "./server/config-store.ts";
import {
  buildConfigBundle,
  buildConversationGraph,
  createCoordinatorTools,
  createDeveloperTools,
  createExpertTools,
  createReviewerTools,
  listPipelineSnapshots,
  notifyTaskChanges,
  startTeamTask,
  subscribeTaskChanges,
} from "./server/handlers.ts";
import {
  assignReviewerPerspective,
  buildCoordinatorSystemPrompt,
  buildDeveloperPrompt,
  buildExpertPrompt,
  buildReviewerPrompt,
  buildTurnHandoffReminder,
} from "./server/prompts.ts";
import { inspectQualityGate } from "./server/quality-gate.ts";
import {
  type AgentRole,
  checkTurnHandoff,
  findTaskByAgentId,
  listTasksForProject,
  loadTask,
  markTaskCompleted,
  registerTaskAgent,
  saveTask,
} from "./server/task-store.ts";

const HANDOFF_TOOL: Partial<Record<AgentRole, string>> = {
  developer: "paseo_team_submit_delivery",
  expert: "paseo_team_submit_plan",
  "plan-reviewer": "paseo_team_submit_review",
  "code-reviewer": "paseo_team_submit_review",
};

export function isAutoAllowedTeamTool(
  role: AgentRole | undefined,
  toolName: string | null,
): boolean {
  if (!role || !toolName) return false;
  if (role === "coordinator") {
    return (
      /(?:^|__|_|\/|:|\.)(?:create_agent|send_agent_prompt|list_providers|list_models|list_profiles|inspect_provider|get_agent_status|get_agent_activity|list_agents|list_hosts|list_workspaces|list_pending_permissions)$/.test(
        toolName,
      ) ||
      /(?:^|__|_|\/|:|\.)paseo_team_(?:task_summary|submit_plan|record_review|record_delivery|complete)$/.test(
        toolName,
      )
    );
  }
  if (role === "developer") {
    return /(?:^|__|_|\/|:|\.)paseo_team_(?:run_check|submit_delivery)$/.test(
      toolName,
    );
  }
  if (role === "expert") {
    return /(?:^|__|_|\/|:|\.)paseo_team_submit_plan$/.test(toolName);
  }
  if (role === "plan-reviewer" || role === "code-reviewer") {
    return /(?:^|__|_|\/|:|\.)paseo_team_submit_review$/.test(toolName);
  }
  return false;
}

export function isScopedCoordinatorPermissionResponse(options: {
  role: AgentRole | undefined;
  toolName: string | null;
  requestInput: unknown;
  taskRecord?: { nodes: Array<{ role: AgentRole; agentId?: string }> };
  autoAllowedPermissionIds?: ReadonlySet<string>;
}): boolean {
  if (options.role !== "coordinator" || !options.toolName) return false;
  if (!/(?:^|__|_|\/|:|\.)respond_to_permission$/.test(options.toolName)) {
    return false;
  }
  if (!options.requestInput || typeof options.requestInput !== "object") {
    return false;
  }
  const input = options.requestInput as Record<string, unknown>;
  const targetRequestId =
    typeof input.requestId === "string" ? input.requestId : "";
  if (
    targetRequestId &&
    options.autoAllowedPermissionIds?.has(targetRequestId)
  ) {
    return true;
  }
  const targetAgentId = typeof input.agentId === "string" ? input.agentId : "";
  if (!targetAgentId || !options.taskRecord) return false;
  return options.taskRecord.nodes.some(
    (node) => node.role !== "coordinator" && node.agentId === targetAgentId,
  );
}

const ROLE_SLOT_SUFFIX = String.raw`(?:\s*(?:#?\d+|[一二三四]))?`;
const UNBRACKETED_ROLE_DELIM = String.raw`\s*(?:[:：\-–—·/]|$)`;

export function inferChildRole(options: {
  metaRole?: string;
  labelRole?: string;
  title?: string | null;
  planReviewRequired?: boolean;
  hasDelivery?: boolean;
}): Exclude<AgentRole, "coordinator" | "gate"> | null {
  const explicit = (options.metaRole || options.labelRole || "").trim();
  if (
    explicit === "developer" ||
    explicit === "expert" ||
    explicit === "plan-reviewer" ||
    explicit === "code-reviewer"
  ) {
    return explicit;
  }
  const title = (options.title ?? "").trim();
  if (!title) return null;
  if (
    new RegExp(
      `^(?:\\[(?:Developer|Handoff|开发(?:者|成员)?)${ROLE_SLOT_SUFFIX}\\]|(?:Developer|Handoff|开发(?:者|成员)?)${ROLE_SLOT_SUFFIX}${UNBRACKETED_ROLE_DELIM})`,
      "i",
    ).test(title)
  ) {
    return "developer";
  }
  if (
    new RegExp(
      `^(?:\\[(?:Expert|Architect|专家)${ROLE_SLOT_SUFFIX}\\]|(?:Expert|Architect|专家)${ROLE_SLOT_SUFFIX}${UNBRACKETED_ROLE_DELIM})`,
      "i",
    ).test(title)
  ) {
    return "expert";
  }
  if (
    new RegExp(
      `^(?:\\[(?:Plan\\s*Reviewer|方案(?:审查|评审)(?:员)?)${ROLE_SLOT_SUFFIX}\\]|(?:Plan\\s*Reviewer|方案(?:审查|评审)(?:员)?)${ROLE_SLOT_SUFFIX}${UNBRACKETED_ROLE_DELIM})`,
      "i",
    ).test(title)
  ) {
    return "plan-reviewer";
  }
  if (
    new RegExp(
      `^(?:\\[(?:Code\\s*Reviewer|Reviewer|Advisor|(?:代码)?(?:审查|评审)(?:员)?)${ROLE_SLOT_SUFFIX}\\]|(?:Code\\s*Reviewer|Reviewer|Advisor|(?:代码)?(?:审查|评审)(?:员)?)${ROLE_SLOT_SUFFIX}${UNBRACKETED_ROLE_DELIM})`,
      "i",
    ).test(title)
  ) {
    if (options.planReviewRequired && !options.hasDelivery) {
      return "plan-reviewer";
    }
    return "code-reviewer";
  }
  return null;
}

function stripRolePrefix(title: string | null | undefined): string {
  const raw = (title ?? "").trim();
  const bracketed = /^\[[^\]]+\]\s*(.+)$/.exec(raw);
  if (bracketed?.[1]?.trim()) return bracketed[1].trim();
  const prefixed = new RegExp(
    `^(?:Plan\\s*Reviewer|Code\\s*Reviewer|Developer|Handoff|Expert|Architect|Reviewer|Advisor|开发(?:者|成员)?|专家|(?:方案|代码)?(?:审查|评审)(?:员)?)${ROLE_SLOT_SUFFIX}\\s*[:：\\-–—·/]\\s*(.+)$`,
    "i",
  ).exec(raw);
  return prefixed?.[1]?.trim() || raw;
}

export function extractToolName(req: unknown): string | null {
  if (!req || typeof req !== "object") return null;
  const r = req as Record<string, unknown>;
  if (typeof r.toolName === "string" && r.toolName) return r.toolName;
  if (typeof r.name === "string" && r.name) return r.name;
  if (r.tool && typeof r.tool === "object") {
    const t = r.tool as Record<string, unknown>;
    if (typeof t.name === "string" && t.name) return t.name;
  }
  if (typeof r.title === "string" && r.title) return r.title;
  return null;
}

export default function contribute(server: PluginServerContext) {
  const cleanups: (() => void)[] = [];
  const autoAllowedPermissionIds = new Set<string>();
  const rememberAutoAllowedPermission = (requestId: string) => {
    if (!requestId) return;
    autoAllowedPermissionIds.add(requestId);
    if (autoAllowedPermissionIds.size > 200) {
      const oldest = autoAllowedPermissionIds.values().next().value;
      if (oldest) autoAllowedPermissionIds.delete(oldest);
    }
  };

  server.handle(getConfigBundleRpc, async ({ cwd }, { paseo }) => {
    return buildConfigBundle(paseo, cwd);
  });

  server.handle(saveConfigRpc, async ({ config, cwd }, { paseo }) => {
    saveConfig(config);
    notifyTaskChanges();
    return buildConfigBundle(paseo, cwd);
  });

  server.handle(listTasksRpc, async (input, { paseo }) => {
    return listPipelineSnapshots(paseo, input);
  });

  server.handle(getConversationGraphRpc, async (input, { paseo }) => {
    return buildConversationGraph(paseo, input);
  });

  server.handle(
    watchConversationGraphSubscription,
    (input, { paseo, push, signal }) => {
      let pushing = false;
      let queued = false;

      const emit = async () => {
        if (signal.aborted) return;
        if (pushing) {
          queued = true;
          return;
        }
        pushing = true;
        try {
          do {
            queued = false;
            if (signal.aborted) break;
            const payload = await buildConversationGraph(paseo, input);
            if (!signal.aborted) {
              await push({
                ...payload,
                timestamp: new Date().toISOString(),
              });
            }
          } while (queued && !signal.aborted);
        } catch {
          // Ignore push errors after disconnect
        } finally {
          pushing = false;
        }
      };

      let agentDebounce: ReturnType<typeof setTimeout> | null = null;
      const scheduleEmit = () => {
        if (signal.aborted || agentDebounce) return;
        agentDebounce = setTimeout(() => {
          agentDebounce = null;
          void emit();
        }, 150);
      };

      const unsubLocal = subscribeTaskChanges(() => {
        void emit();
      });
      const unsubAgents = paseo.agents.subscribe(() => {
        scheduleEmit();
      });

      signal.addEventListener(
        "abort",
        () => {
          if (agentDebounce) {
            clearTimeout(agentDebounce);
            agentDebounce = null;
          }
          unsubLocal();
          unsubAgents();
        },
        { once: true },
      );

      void emit();
    },
  );

  let invalidateSessionOpenHooks = () => {};

  server.handle(startTeamTaskRpc, async (input, { paseo }) => {
    return startTeamTask(paseo, input, { invalidateSessionOpenHooks });
  });

  server.handle(
    controlTaskRpc,
    async ({ recordPath, action, note, language }, { paseo }) => {
      const zh = language === "zh";
      const record = loadTask(recordPath);

      if (action === "abandon_task") {
        if (record.lifecycleStatus !== "completed") {
          record.lifecycleStatus = "abandoned";
          saveTask(recordPath, record);
          notifyTaskChanges();
        }
        const snap = await listPipelineSnapshots(paseo, {
          cwd: record.projectRoot,
          ...(language ? { language } : {}),
        });
        return {
          ok: true,
          message: zh
            ? "任务已放弃。仍在运行的会话请在 Paseo 中停止。"
            : "Task abandoned. Stop any session still running from Paseo.",
          task: snap.tasks.find((t) => t.taskId === record.taskId),
        };
      }

      if (action === "authorize_extra_round") {
        // Only grant a round when the breaker actually tripped, so repeated clicks don't stack.
        if (record.circuitBroken) {
          record.extraRounds = (record.extraRounds ?? 0) + 1;
        }
        record.circuitBroken = null;
        if (record.lifecycleStatus === "blocked") {
          record.lifecycleStatus = "active";
        }
        saveTask(recordPath, record);
        if (record.coordinatorAgentId) {
          const quote =
            note?.trim() ||
            (zh
              ? "用户在可视化面板授权继续下一轮审查与修订"
              : "User authorized an additional review round from the graph UI");
          await paseo.agents
            .ref(record.coordinatorAgentId)
            .send(
              zh
                ? `[Team 用户裁定] 已解除审查轮次熔断：${quote}`
                : `[Team User Decision] Circuit breaker lifted: ${quote}`,
            )
            .catch(() => {});
        }
        notifyTaskChanges();
        const snap = await listPipelineSnapshots(paseo, {
          cwd: record.projectRoot,
          ...(language ? { language } : {}),
        });
        return {
          ok: true,
          message: zh
            ? "已解除熔断并通知主控会话。"
            : "Circuit breaker lifted and coordinator notified.",
          task: snap.tasks.find((t) => t.taskId === record.taskId),
        };
      }

      const rep = inspectQualityGate({ recordPath });

      if (action === "complete_task" && rep.status === "READY") {
        markTaskCompleted(recordPath);
      }

      notifyTaskChanges();
      const snap = await listPipelineSnapshots(paseo, {
        cwd: record.projectRoot,
        ...(language ? { language } : {}),
      });
      return {
        ok: rep.status === "READY",
        message:
          rep.status === "READY"
            ? action === "complete_task"
              ? zh
                ? "全部验收项通过，任务已标记完成。"
                : "All quality checks passed. Task marked completed."
              : zh
                ? "全部质量验收项已通过。"
                : "All quality gate checks passed."
            : zh
              ? "存在未满足的质量验收项，请查看检查清单。"
              : "Some quality gate checks are not yet satisfied.",
        checks: rep.checks,
        task: snap.tasks.find((t) => t.taskId === record.taskId),
      };
    },
  );

  server.handle(watchTasksSubscription, (input, { paseo, push, signal }) => {
    let pushing = false;
    let queued = false;

    const emit = async () => {
      if (signal.aborted) return;
      if (pushing) {
        queued = true;
        return;
      }
      pushing = true;
      try {
        do {
          queued = false;
          if (signal.aborted) break;
          const payload = await listPipelineSnapshots(paseo, input);
          if (!signal.aborted) {
            await push({
              ...payload,
              timestamp: new Date().toISOString(),
            });
          }
        } while (queued && !signal.aborted);
      } catch {
        // Ignore push errors after disconnect
      } finally {
        pushing = false;
      }
    };

    let agentDebounce: ReturnType<typeof setTimeout> | null = null;
    const scheduleEmit = () => {
      if (signal.aborted || agentDebounce) return;
      agentDebounce = setTimeout(() => {
        agentDebounce = null;
        void emit();
      }, 150);
    };

    const unsubLocal = subscribeTaskChanges(() => {
      void emit();
    });
    const unsubAgents = paseo.agents.subscribe(() => {
      scheduleEmit();
    });

    signal.addEventListener(
      "abort",
      () => {
        if (agentDebounce) {
          clearTimeout(agentDebounce);
          agentDebounce = null;
        }
        unsubLocal();
        unsubAgents();
      },
      { once: true },
    );

    void emit();
  });

  cleanups.push(
    server.addHook("agent.create.after", async ({ agent }) => {
      try {
        if (!agent.parentAgentId || findTaskByAgentId(agent.id)) return;
        const parentMatch = findTaskByAgentId(agent.parentAgentId);
        if (!parentMatch || parentMatch.matchedRole !== "coordinator") return;
        if (parentMatch.record.lifecycleStatus !== "active") return;

        const meta = agent.metadata?.["paseo-team.task"];
        const metaRole =
          meta && typeof meta === "object" && !Array.isArray(meta)
            ? String((meta as Record<string, unknown>).role ?? "")
            : undefined;
        const childRole = inferChildRole({
          metaRole,
          title: agent.title,
          planReviewRequired: parentMatch.record.planReview === "required",
          hasDelivery: Boolean(
            parentMatch.record.delivery || parentMatch.record.candidate,
          ),
        });
        if (!childRole) return;

        registerTaskAgent(parentMatch.recordPath, {
          role: childRole,
          agentId: agent.id,
          profile: "auto",
          provider: agent.provider,
          briefSummary: stripRolePrefix(agent.title) || `Running ${childRole}`,
        });
        notifyTaskChanges();
      } catch (err) {
        console.error("[paseo-team] agent.create.after error:", err);
      }
    }),
  );

  const registerOpenBeforeHook = () =>
    server.addHook("agent.open.before", async ({ request }) => {
      try {
        if (request.purpose === "history" || request.background) {
          return undefined;
        }

        const meta = request.metadata?.["paseo-team.task"];
        const metaObj =
          meta && typeof meta === "object" && !Array.isArray(meta)
            ? (meta as Record<string, unknown>)
            : null;
        const labelTaskId = request.labels?.["task"];
        const labelRole = request.labels?.["role"];
        const parentAgentId = request.labels?.["paseo.parent-agent-id"];

        let recordPath =
          typeof metaObj?.recordPath === "string" ? metaObj.recordPath : "";
        let role: string | undefined =
          typeof metaObj?.role === "string" ? metaObj.role : labelRole;

        if (!recordPath) {
          const matched = findTaskByAgentId(request.agentId);
          if (matched) {
            recordPath = matched.recordPath;
            role = role || matched.matchedRole;
          } else if (parentAgentId) {
            const parentMatch = findTaskByAgentId(parentAgentId);
            if (
              parentMatch?.matchedRole === "coordinator" &&
              parentMatch.record.lifecycleStatus === "active"
            ) {
              const inferred = inferChildRole({
                labelRole,
                title: request.title,
                planReviewRequired:
                  parentMatch.record.planReview === "required",
                hasDelivery: Boolean(
                  parentMatch.record.delivery || parentMatch.record.candidate,
                ),
              });
              if (inferred) {
                recordPath = parentMatch.recordPath;
                role = role || inferred;
              }
            }
          }
          if (!recordPath && request.cwd) {
            const projectTasks = listTasksForProject(request.cwd);
            if (labelTaskId) {
              const byId = projectTasks.find(
                (t) => t.record.taskId === labelTaskId,
              );
              if (byId) {
                recordPath = byId.recordPath;
              }
            } else {
              const activeTasks = projectTasks.filter(
                (t) => t.record.lifecycleStatus === "active",
              );
              if (activeTasks.length === 1) {
                const candidateTask = activeTasks[0];
                const inferred = inferChildRole({
                  labelRole,
                  title: request.title,
                  planReviewRequired:
                    candidateTask.record.planReview === "required",
                  hasDelivery: Boolean(
                    candidateTask.record.delivery ||
                    candidateTask.record.candidate,
                  ),
                });
                if (inferred) {
                  recordPath = candidateTask.recordPath;
                  role = role || inferred;
                }
              }
            }
          }
        }

        if (recordPath && !role) {
          try {
            const tmpRec = loadTask(recordPath);
            role =
              inferChildRole({
                labelRole,
                title: request.title,
                planReviewRequired: tmpRec.planReview === "required",
                hasDelivery: Boolean(tmpRec.delivery || tmpRec.candidate),
              }) ?? undefined;
          } catch {
            // Ignore
          }
        }

        if (!recordPath || !role) {
          return undefined;
        }

        let record;
        try {
          record = loadTask(recordPath);
        } catch {
          return undefined;
        }

        if (
          (role === "developer" ||
            role === "expert" ||
            role === "plan-reviewer" ||
            role === "code-reviewer") &&
          !record.nodes.some((n) => n.agentId === request.agentId)
        ) {
          try {
            record = registerTaskAgent(recordPath, {
              role,
              agentId: request.agentId,
              profile: "auto",
              provider: request.provider,
              briefSummary: stripRolePrefix(request.title) || `Running ${role}`,
            });
            notifyTaskChanges();
          } catch {
            // Non-fatal
          }
        }

        const taskDir = path.dirname(path.resolve(recordPath));
        const promptLang = detectPromptLanguage(record.goal);

        if (role === "coordinator") {
          if (record.coordinatorAgentId !== request.agentId) {
            record.coordinatorAgentId = request.agentId;
            const coordNode = record.nodes.find(
              (n) => n.nodeId === "coordinator",
            );
            if (coordNode) {
              coordNode.agentId = request.agentId;
              coordNode.provider = request.provider;
            }
            try {
              saveTask(recordPath, record);
              notifyTaskChanges();
            } catch {
              // Non-fatal
            }
          }
          return {
            ...request,
            appendSystemPrompt: [
              ...(request.appendSystemPrompt ?? []),
              buildCoordinatorSystemPrompt({
                taskId: record.taskId,
                taskDir,
                teamName: record.teamName,
                complexMode: record.complexMode,
                lang: promptLang,
              }),
            ],
            tools: [
              ...(request.tools ?? []),
              ...createCoordinatorTools(recordPath),
            ],
          };
        }

        if (role === "developer") {
          return {
            ...request,
            appendSystemPrompt: [
              ...(request.appendSystemPrompt ?? []),
              buildDeveloperPrompt({
                taskId: record.taskId,
                taskDir,
                lang: promptLang,
              }),
            ],
            tools: [
              ...(request.tools ?? []),
              ...createDeveloperTools(recordPath, request.agentId),
            ],
          };
        }

        if (role === "expert") {
          return {
            ...request,
            appendSystemPrompt: [
              ...(request.appendSystemPrompt ?? []),
              buildExpertPrompt({
                taskId: record.taskId,
                taskDir,
                lang: promptLang,
              }),
            ],
            tools: [
              ...(request.tools ?? []),
              ...createExpertTools(recordPath, request.agentId),
            ],
          };
        }

        if (role === "plan-reviewer" || role === "code-reviewer") {
          const nodes = Array.isArray(record.nodes) ? record.nodes : [];
          const node = nodes.find((n) => n?.agentId === request.agentId);
          const sameRoleCount = nodes.filter((n) => n?.role === role).length;
          const perspective =
            node?.perspective ??
            assignReviewerPerspective(node?.slotIndex ?? 0, sameRoleCount || 1);
          return {
            ...request,
            appendSystemPrompt: [
              ...(request.appendSystemPrompt ?? []),
              buildReviewerPrompt({
                taskId: record.taskId,
                perspective,
                stage: role === "plan-reviewer" ? "plan" : "code",
                lang: promptLang,
              }),
            ],
            tools: [
              ...(request.tools ?? []),
              ...createReviewerTools(
                recordPath,
                request.agentId,
                role === "plan-reviewer" ? "plan" : "code",
              ),
            ],
          };
        }

        return undefined;
      } catch (err) {
        console.error("[paseo-team] agent.open.before error:", err);
        return undefined;
      }
    });

  let disposeOpenBefore = registerOpenBeforeHook();
  invalidateSessionOpenHooks = () => {
    disposeOpenBefore();
    disposeOpenBefore = registerOpenBeforeHook();
  };
  cleanups.push(() => disposeOpenBefore());

  cleanups.push(
    server.addHook(
      "agent.permission.before",
      async ({ agent, request }, { paseo }) => {
        try {
          if (request.kind !== "tool" && request.kind !== "other") return;
          const toolName = extractToolName(request);
          let match = findTaskByAgentId(agent.id);
          let role = match?.matchedRole;
          if (!role && agent.parentAgentId) {
            const parentMatch = findTaskByAgentId(agent.parentAgentId);
            if (
              parentMatch?.matchedRole === "coordinator" &&
              parentMatch.record.lifecycleStatus === "active"
            ) {
              const inferred = inferChildRole({
                title: agent.title,
                planReviewRequired:
                  parentMatch.record.planReview === "required",
                hasDelivery: Boolean(
                  parentMatch.record.delivery || parentMatch.record.candidate,
                ),
              });
              if (inferred) {
                role = inferred;
                match = { ...parentMatch, matchedRole: inferred };
              } else if (
                toolName &&
                /(?:^|__|_|\/|:|\.)paseo_team_run_check$/.test(toolName)
              ) {
                role = "developer";
                match = { ...parentMatch, matchedRole: "developer" };
              }
            }
          }
          if (
            isAutoAllowedTeamTool(role, toolName) ||
            isScopedCoordinatorPermissionResponse({
              role,
              toolName,
              requestInput: request.input,
              taskRecord: match?.record,
              autoAllowedPermissionIds,
            })
          ) {
            if (role !== "coordinator") {
              rememberAutoAllowedPermission(request.id);
            }
            const allowAction = Array.isArray(request.actions)
              ? request.actions.find((a) => a.behavior === "allow")
              : undefined;
            await paseo.agents
              .ref(agent.id)
              .respondToPermission({
                requestId: request.id,
                response: {
                  behavior: "allow",
                  ...(allowAction?.id
                    ? { selectedActionId: allowAction.id }
                    : {}),
                },
              })
              .catch(() => {});
          }
        } catch (err) {
          console.error("[paseo-team] agent.permission.before error:", err);
        }
      },
    ),
  );

  cleanups.push(
    server.addHook("agent.turn.before", async ({ agent }) => {
      try {
        const match = findTaskByAgentId(agent.id);
        if (match) notifyTaskChanges();
      } catch (err) {
        console.error("[paseo-team] agent.turn.before error:", err);
      }
    }),
  );

  cleanups.push(
    server.addHook(
      "agent.turn.after",
      async ({ agent, outcome }, { paseo }) => {
        try {
          const match = findTaskByAgentId(agent.id);
          if (!match) return;
          // Handoff check: a member's finished turn must end with its submit tool.
          if (
            match.matchedRole !== "coordinator" &&
            outcome.kind === "completed" &&
            match.record.lifecycleStatus !== "completed" &&
            match.record.lifecycleStatus !== "abandoned" &&
            checkTurnHandoff(match.recordPath, agent.id) === "remind"
          ) {
            const tool = HANDOFF_TOOL[match.matchedRole];
            const promptLang = detectPromptLanguage(match.record.goal);
            if (tool) {
              await paseo.agents
                .ref(agent.id)
                .send(
                  buildTurnHandoffReminder({
                    toolName: tool,
                    lang: promptLang,
                  }),
                )
                .catch(() => {});
            }
          }
          notifyTaskChanges();
        } catch (err) {
          console.error("[paseo-team] agent.turn.after error:", err);
        }
      },
    ),
  );

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
