import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const TEAM_ENABLED_METADATA_KEY = "paseo-team.enabled";
export const TEAM_SUBAGENT_METADATA_KEY = "paseo-team.subagent";
export const TEAM_ROLE_LABEL_KEY = "paseo-team.role";
export const TEAM_PERSPECTIVE_LABEL_KEY = "paseo-team.perspective";

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
  mode: z.string().min(1).optional(),
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

export const ProviderModeChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

export const ProviderCatalogItemSchema = z.object({
  provider: z.string(),
  label: z.string(),
  ready: z.boolean(),
  modes: z.array(z.string()),
  modeOptions: z.array(ProviderModeChoiceSchema).optional(),
  defaultModeId: z.string().optional(),
  models: z.array(ProviderModelOptionSchema),
});

export const ConfigBundleSchema = z.object({
  config: PaseoTeamConfigSchema,
  effectiveTeamName: z.string().nullable(),
  providers: z.array(ProviderCatalogItemSchema),
});

export const AgentRoleSchema = z.enum([
  "coordinator",
  "expert",
  "plan-reviewer",
  "developer",
  "code-reviewer",
  "subagent",
]);

export const LiveAgentStatusSchema = z.enum([
  "initializing",
  "running",
  "awaiting_permission",
  "idle",
  "error",
  "closed",
]);

export const GraphNodeSchema = z.object({
  agentId: z.string(),
  parentAgentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  role: AgentRoleSchema,
  label: z.string(),
  title: z.string(),
  modelBadge: z.string(),
  perspectiveLabel: z.string().optional(),
  status: LiveAgentStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const GraphLayerSchema = z.object({
  layerId: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  status: z.enum(["running", "awaiting_permission", "error", "idle"]),
  nodes: z.array(GraphNodeSchema),
});

export const AgentTreeSnapshotSchema = z.object({
  rootAgentId: z.string(),
  workspaceId: z.string().nullable(),
  title: z.string(),
  cwd: z.string(),
  isTeamChat: z.boolean(),
  totalAgents: z.number(),
  runningCount: z.number(),
  attentionCount: z.number(),
  layers: z.array(GraphLayerSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ConversationGraphPayloadSchema = z.object({
  viewerAgentId: z.string().nullable(),
  rootAgentId: z.string().nullable(),
  tree: AgentTreeSnapshotSchema.nullable(),
});

export type RoleModelSpecDto = z.infer<typeof RoleModelSpecSchema>;
export type TeamPresetDto = z.infer<typeof TeamPresetSchema>;
export type PaseoTeamConfigDto = z.infer<typeof PaseoTeamConfigSchema>;
export type ProviderCatalogItemDto = z.infer<typeof ProviderCatalogItemSchema>;
export type ProviderModeChoiceDto = z.infer<typeof ProviderModeChoiceSchema>;
export type ProviderModelOptionDto = z.infer<typeof ProviderModelOptionSchema>;
export type ConfigBundleDto = z.infer<typeof ConfigBundleSchema>;
export type AgentRoleDto = z.infer<typeof AgentRoleSchema>;
export type LiveAgentStatusDto = z.infer<typeof LiveAgentStatusSchema>;
export type GraphNodeDto = z.infer<typeof GraphNodeSchema>;
export type GraphLayerDto = z.infer<typeof GraphLayerSchema>;
export type AgentTreeSnapshotDto = z.infer<typeof AgentTreeSnapshotSchema>;
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

export const startTeamTaskRpc = defineRpc({
  name: "paseo_team.start",
  input: z.object({
    cwd: z.string().min(1),
    workspaceId: z.string().optional(),
    agentId: z.string().min(1),
    rawArgs: z.string().min(1),
    language: UiLanguageSchema.optional(),
  }),
  output: z.object({
    coordinatorAgentId: z.string(),
    teamName: z.string(),
    message: z.string(),
  }),
});

export const watchConversationGraphSubscription = defineSubscription({
  name: "paseo_team.conversation.watch",
  input: z.object({
    agentId: z.string().optional(),
    workspaceId: z.string().optional(),
    language: UiLanguageSchema.optional(),
  }),
  event: ConversationGraphPayloadSchema.extend({
    timestamp: z.string(),
  }),
});

export const watchActiveTreesSubscription = defineSubscription({
  name: "paseo_team.trees.watch",
  input: z.object({
    language: UiLanguageSchema.optional(),
  }),
  event: z.object({
    trees: z.array(AgentTreeSnapshotSchema),
    timestamp: z.string(),
  }),
});
