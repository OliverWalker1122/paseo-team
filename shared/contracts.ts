import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const TEAM_ENABLED_METADATA_KEY = "paseo-team.enabled";
export const TEAM_TASK_METADATA_KEY = "paseo-team.task";

export function hasTeamSlashPrefix(prompt: string): boolean {
  return /^\s*\/paseo-team(?:\s|$)/i.test(prompt);
}

export function addTeamSlashPrefix(prompt: string): string {
  if (hasTeamSlashPrefix(prompt)) return prompt;
  const trimmed = prompt.trimStart();
  return trimmed ? `/paseo-team ${trimmed}` : "/paseo-team ";
}

export function stripTeamSlashPrefix(prompt: string): string {
  return prompt.replace(/^\s*\/paseo-team(?:[ \t]+|\r?\n|$)/i, "");
}

export const UiLanguageSchema = z.enum(["en", "zh"]);
export const ComplexModeSchema = z.enum(["expert", "simple"]);

export const RoleModelSpecSchema = z.object({
  model: z.string().min(1),
  thinking: z.string().min(1).optional(),
});

export const TeamPresetSchema = z.object({
  developer: RoleModelSpecSchema,
  codeReviewers: z.array(RoleModelSpecSchema),
  separatePlanReviewers: z.boolean().optional(),
  planReviewers: z.array(RoleModelSpecSchema),
  expert: RoleModelSpecSchema.optional(),
  complexMode: ComplexModeSchema,
  description: z.string().optional(),
});

export const PaseoTeamConfigSchema = z.object({
  schemaVersion: z.literal(5),
  teams: z.record(z.string(), TeamPresetSchema),
  default: z.string().nullable(),
  projects: z.record(z.string(), z.string()),
});

export const ProviderThinkingChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
});

export const ProviderModelOptionSchema = z.object({
  id: z.string(),
  fullId: z.string(),
  label: z.string(),
  isDefault: z.boolean().optional(),
  thinkingOptions: z.array(ProviderThinkingChoiceSchema),
  defaultThinkingId: z.string().optional(),
});

export const ProviderCatalogItemSchema = z.object({
  provider: z.string(),
  label: z.string(),
  ready: z.boolean(),
  modes: z.array(z.string()),
  defaultModeId: z.string().optional(),
  models: z.array(ProviderModelOptionSchema),
});

export const ConfigBundleSchema = z.object({
  config: PaseoTeamConfigSchema,
  effectiveTeamName: z.string().nullable(),
  providers: z.array(ProviderCatalogItemSchema),
});

export const PipelineNodeViewSchema = z.object({
  nodeId: z.string(),
  stage: z.enum([
    "coordinator",
    "expert",
    "plan-review",
    "development",
    "code-review",
    "merge-gate",
  ]),
  role: z.enum([
    "coordinator",
    "expert",
    "plan-reviewer",
    "developer",
    "code-reviewer",
    "gate",
  ]),
  slotIndex: z.number(),
  label: z.string(),
  profile: z.string(),
  modelBadge: z.string().optional(),
  serverId: z.string().optional(),
  agentId: z.string().optional(),
  perspectiveLabel: z.string().optional(),
  briefSummary: z.string(),
  liveState: z.enum([
    "not_started",
    "initializing",
    "running",
    "awaiting_permission",
    "idle",
    "error",
    "closed",
  ]),
  visualStatus: z.enum([
    "pending",
    "running",
    "awaiting_permission",
    "completed",
    "approved",
    "changes_requested",
    "blocked",
    "skipped",
  ]),
  round: z.number().optional(),
  verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "BLOCKED"]).optional(),
  summary: z.string().optional(),
  rounds: z
    .array(
      z.object({
        round: z.number(),
        verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "BLOCKED"]),
        summary: z.string(),
        findings: z.array(z.string()).optional(),
        recordedAt: z.string().optional(),
      }),
    )
    .optional(),
  updatedAt: z.string(),
});

export const PipelineStageColumnSchema = z.object({
  stepId: z.string(),
  stageId: z.enum([
    "coordinator",
    "expert",
    "plan-review",
    "development",
    "code-review",
    "merge-gate",
  ]),
  round: z.number().optional(),
  stepNumber: z.number(),
  title: z.string(),
  subtitle: z.string(),
  stageStatus: z.enum([
    "pending",
    "running",
    "awaiting_permission",
    "completed",
    "blocked",
    "skipped",
  ]),
  nodes: z.array(PipelineNodeViewSchema),
});

export const PipelineTaskSnapshotSchema = z.object({
  recordPath: z.string(),
  taskId: z.string(),
  sourceKind: z.enum(["team_task", "native_subagents"]).optional(),
  projectRoot: z.string(),
  goal: z.string(),
  isComplex: z.boolean(),
  routeDecided: z.boolean().optional(),
  routeReason: z.string().optional(),
  teamName: z.string(),
  complexMode: ComplexModeSchema,
  coordinatorAgentId: z.string().optional(),
  coordinatorServerId: z.string().optional(),
  /** The chat that started the task; team chats link back to it. */
  launcherAgentId: z.string().optional(),
  planReview: z.enum(["required", "not-required", "waived"]),
  planReviewReason: z.string().optional(),
  planReviewRound: z.number(),
  codeReview: z.enum(["required", "not-required", "waived"]),
  codeReviewReason: z.string().optional(),
  codeReviewRound: z.number(),
  ciStatus: z.enum(["pending", "pass", "waived"]),
  architectureImpact: z.string().optional(),
  circuitBroken: z
    .object({
      stage: z.enum(["plan", "code"]),
      round: z.number(),
      reason: z.string(),
      triggeredAt: z.string(),
    })
    .nullable(),
  gateChecks: z.record(z.string(), z.boolean()).optional(),
  gateReady: z.boolean().optional(),
  gateMissing: z.array(z.string()).optional(),
  lifecycleStatus: z.enum([
    "active",
    "completed",
    "paused",
    "abandoned",
    "blocked",
  ]),
  runningCount: z.number(),
  attentionCount: z.number(),
  skippedStageCount: z.number().optional(),
  stages: z.array(PipelineStageColumnSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ConversationGraphPayloadSchema = z.object({
  mode: z.enum(["team_task", "launcher", "native_subagents", "empty"]),
  viewerAgentId: z.string().nullable(),
  rootAgentId: z.string().nullable(),
  task: PipelineTaskSnapshotSchema.nullable(),
  /** mode "launcher": every task subtree this chat started, newest first. */
  tasks: z.array(PipelineTaskSnapshotSchema).optional(),
});

export type RoleModelSpecDto = z.infer<typeof RoleModelSpecSchema>;
export type TeamPresetDto = z.infer<typeof TeamPresetSchema>;
export type PaseoTeamConfigDto = z.infer<typeof PaseoTeamConfigSchema>;
export type ProviderCatalogItemDto = z.infer<typeof ProviderCatalogItemSchema>;
export type ProviderModelOptionDto = z.infer<typeof ProviderModelOptionSchema>;
export type ConfigBundleDto = z.infer<typeof ConfigBundleSchema>;
export type PipelineNodeViewDto = z.infer<typeof PipelineNodeViewSchema>;
export type PipelineStageColumnDto = z.infer<typeof PipelineStageColumnSchema>;
export type PipelineTaskSnapshotDto = z.infer<
  typeof PipelineTaskSnapshotSchema
>;
export type ConversationGraphPayloadDto = z.infer<
  typeof ConversationGraphPayloadSchema
>;

export const getConfigBundleRpc = defineRpc({
  name: "paseo_team.config.get",
  input: z.object({
    cwd: z.string().optional(),
  }),
  output: ConfigBundleSchema,
});

export const saveConfigRpc = defineRpc({
  name: "paseo_team.config.save",
  input: z.object({
    config: PaseoTeamConfigSchema,
    cwd: z.string().optional(),
  }),
  output: ConfigBundleSchema,
});

export const getConversationGraphRpc = defineRpc({
  name: "paseo_team.conversation.get",
  input: z.object({
    agentId: z.string().optional(),
    workspaceId: z.string().optional(),
    cwd: z.string().optional(),
    language: UiLanguageSchema.optional(),
  }),
  output: ConversationGraphPayloadSchema,
});

export const watchConversationGraphSubscription = defineSubscription({
  name: "paseo_team.conversation.watch",
  input: z.object({
    agentId: z.string().optional(),
    workspaceId: z.string().optional(),
    cwd: z.string().optional(),
    language: UiLanguageSchema.optional(),
  }),
  event: ConversationGraphPayloadSchema.extend({
    timestamp: z.string(),
  }),
});

export const listTasksRpc = defineRpc({
  name: "paseo_team.tasks.list",
  input: z.object({
    cwd: z.string().optional(),
    includeAllProjects: z.boolean().optional(),
    language: UiLanguageSchema.optional(),
  }),
  output: z.object({
    projectKey: z.string().nullable(),
    tasks: z.array(PipelineTaskSnapshotSchema),
  }),
});

export const watchTasksSubscription = defineSubscription({
  name: "paseo_team.tasks.watch",
  input: z.object({
    cwd: z.string().optional(),
    includeAllProjects: z.boolean().optional(),
    language: UiLanguageSchema.optional(),
  }),
  event: z.object({
    projectKey: z.string().nullable(),
    tasks: z.array(PipelineTaskSnapshotSchema),
    timestamp: z.string(),
  }),
});

export const startTeamTaskRpc = defineRpc({
  name: "paseo_team.tasks.start",
  input: z.object({
    cwd: z.string().min(1),
    workspaceId: z.string().optional(),
    agentId: z.string().optional(),
    rawArgs: z.string().min(1),
    language: UiLanguageSchema.optional(),
    teamOverride: z.string().optional(),
    complexModeOverride: ComplexModeSchema.optional(),
    isComplex: z.boolean().optional(),
    requireReview: z.boolean().optional(),
  }),
  output: z.object({
    taskId: z.string(),
    recordPath: z.string(),
    coordinatorAgentId: z.string().optional(),
    teamName: z.string(),
    message: z.string(),
  }),
});

export const controlTaskRpc = defineRpc({
  name: "paseo_team.tasks.control",
  input: z.object({
    recordPath: z.string().min(1),
    action: z.enum([
      "inspect_gate",
      "complete_task",
      "authorize_extra_round",
      "abandon_task",
    ]),
    note: z.string().optional(),
    language: UiLanguageSchema.optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    message: z.string(),
    checks: z.record(z.string(), z.boolean()).optional(),
    task: PipelineTaskSnapshotSchema.optional(),
  }),
});
