import {
  loadTask,
  nextReviewRound,
  recordCandidateDelivery,
  recordPlanSubmission,
  recordReviewVerdict,
  type ReviewVerdict,
  saveTask,
} from "./task-store.ts";

export interface TurnShellHint {
  hasPassingShell: boolean;
  hasFailingShell: boolean;
}

export interface ExtractedTurnReply {
  text: string;
  shellHint: TurnShellHint;
}

export interface ParsedReviewerReply {
  verdict: ReviewVerdict | null;
  summary: string;
  findings: string[];
}

export interface ParsedDeveloperReply {
  summary: string;
  architectureImpact: string;
  ciStatus?: "pass" | "fail";
  ciSummary?: string;
  ciWaivedUserQuote?: string;
}

export interface ParsedExpertReply {
  summary: string;
  planFile?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Extracts the final assistant reply text (and shell exit hints) for a completed
 * turn from Paseo's `timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true })`.
 */
export function extractTurnReply(
  entries: readonly unknown[],
  turnId?: string | null,
): ExtractedTurnReply {
  const rows = entries
    .map((entry) => asRecord(entry))
    .filter((row): row is Record<string, unknown> => row !== null);

  let scoped = rows;
  if (turnId) {
    const byTurn = rows.filter((row) => row.turnId === turnId);
    if (byTurn.length > 0) {
      scoped = byTurn;
    }
  }
  if (scoped === rows) {
    // Projected timeline rows from persisted/replayed sessions may omit `turnId`;
    // isolate the tail turn after the last incoming user/agent message boundary.
    let lastBoundary = -1;
    for (let i = 0; i < rows.length; i += 1) {
      const item = asRecord(rows[i].item);
      if (!item) continue;
      if (
        item.type === "user_message" ||
        (item.type === "tool_call" && item.name === "agent_message")
      ) {
        lastBoundary = i;
      }
    }
    if (lastBoundary >= 0) {
      scoped = rows.slice(lastBoundary + 1);
    }
  }

  let lastAssistantText = "";
  let hasPassingShell = false;
  let hasFailingShell = false;

  for (const row of scoped) {
    const item = asRecord(row.item);
    if (!item) continue;
    if (item.type === "assistant_message" && typeof item.text === "string") {
      const trimmed = item.text.trim();
      if (trimmed) {
        lastAssistantText = trimmed;
      }
    } else if (item.type === "tool_call") {
      const detail = asRecord(item.detail);
      if (detail?.type === "shell") {
        if (detail.exitCode === 0) {
          hasPassingShell = true;
        } else if (
          typeof detail.exitCode === "number" &&
          detail.exitCode !== 0
        ) {
          hasFailingShell = true;
        }
      }
    }
  }

  return {
    text: lastAssistantText,
    shellHint: { hasPassingShell, hasFailingShell },
  };
}

function cleanLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*•]+|#+\s*|\d+\.\s*)/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function normalizeVerdictToken(token: string): ReviewVerdict | null {
  const upper = token.trim().toUpperCase();
  if (upper === "APPROVE" || upper === "APPROVED") return "APPROVE";
  if (upper === "REQUEST_CHANGES" || upper === "CHANGES_REQUESTED") {
    return "REQUEST_CHANGES";
  }
  if (upper === "BLOCKED") return "BLOCKED";
  if (/^(?:通过|批准)$/.test(token.trim())) return "APPROVE";
  if (/^(?:要求修改|需修改|需要修改)$/.test(token.trim())) {
    return "REQUEST_CHANGES";
  }
  if (/^阻断$/.test(token.trim())) return "BLOCKED";
  return null;
}

function firstSubstantiveSummary(text: string, maxLen = 280): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !/^[-_*=]{3,}$/.test(l) &&
        !/^(?:\*{1,2})?(?:Verdict|结论|审查结论|评审结论)(?:\*{1,2})?\s*[:：]\s*(?:\*{1,2})?(?:APPROVE|REQUEST_CHANGES|BLOCKED|通过|批准|要求修改|需修改|需要修改|阻断)(?:\*{1,2})?\s*$/i.test(
          l,
        ),
    );
  const joined = lines.slice(0, 2).map(cleanLine).filter(Boolean).join(" ");
  return (joined || cleanLine(text)).slice(0, maxLen);
}

export function parseReviewerReply(text: string): ParsedReviewerReply {
  const trimmed = text.trim();
  if (!trimmed) {
    return { verdict: null, summary: "", findings: [] };
  }

  let verdict: ReviewVerdict | null = null;
  const headerMatch =
    /^\s*(?:[-*•]\s*)?(?:#+\s*)?(?:\*{1,2})?(?:Verdict|结论|审查结论|评审结论|第\s*\d+\s*轮(?:复审)?结论)(?:\*{1,2})?\s*[:：]\s*(?:\*{1,2}|`)?(APPROVE|REQUEST_CHANGES|BLOCKED|通过|批准|要求修改|需修改|需要修改|阻断)(?:\*{1,2}|`)?/im.exec(
      trimmed,
    );
  if (headerMatch?.[1]) {
    verdict = normalizeVerdictToken(headerMatch[1]);
  }
  if (!verdict) {
    // Fallback for natural top-paragraph verdicts like "第 2 轮已提交 **REQUEST_CHANGES**".
    const head = trimmed.slice(0, 400);
    const inlineMatch =
      /(?:\*\*|`|\b)(APPROVE|REQUEST_CHANGES|BLOCKED)(?:\*\*|`|\b)/.exec(head);
    if (inlineMatch?.[1]) {
      verdict = normalizeVerdictToken(inlineMatch[1]);
    }
  }

  const findings: string[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const m =
      /^\s*(?:[-*•]|\d+\.)?\s*(?:\*{1,2})?(blocking|advice|阻断|必改|建议)(?:\*{1,2})?\s*[:：]\s*(.+)$/i.exec(
        rawLine,
      );
    if (!m) continue;
    const tag = m[1].toLowerCase();
    const body = m[2].trim();
    if (!body) continue;
    const prefix =
      tag === "blocking" || tag === "阻断" || tag === "必改"
        ? "blocking"
        : "advice";
    findings.push(`${prefix}: ${body}`);
    if (findings.length >= 30) break;
  }

  const summaryMatch =
    /^\s*(?:[-*•]\s*)?(?:\*{1,2})?(?:Summary|摘要|总结)(?:\*{1,2})?\s*[:：]\s*(.+)$/im.exec(
      trimmed,
    );
  const summary = summaryMatch?.[1]?.trim()
    ? cleanLine(summaryMatch[1]).slice(0, 280)
    : firstSubstantiveSummary(trimmed, 280);

  return { verdict, summary, findings };
}

export function parseDeveloperReply(
  text: string,
  shellHint?: TurnShellHint,
): ParsedDeveloperReply {
  const trimmed = text.trim();
  const summaryMatch =
    /^\s*(?:[-*•]\s*)?(?:\*{1,2})?(?:Summary|摘要|交付摘要|改动摘要)(?:\*{1,2})?\s*[:：]\s*(.+)$/im.exec(
      trimmed,
    );
  const summary = summaryMatch?.[1]?.trim()
    ? cleanLine(summaryMatch[1]).slice(0, 320)
    : firstSubstantiveSummary(trimmed, 320) || "Developer completed turn.";

  const archMatch =
    /^\s*(?:[-*•]\s*)?(?:\*{1,2})?(?:Architecture(?:\s*Impact)?|架构影响|架构与性能影响)(?:\*{1,2})?\s*[:：]\s*(.+)$/im.exec(
      trimmed,
    );
  const architectureImpact = archMatch?.[1]?.trim()
    ? cleanLine(archMatch[1]).slice(0, 240)
    : /[\u4e00-\u9fff]/.test(trimmed)
      ? "见交付摘要"
      : "See delivery summary";

  let ciStatus: "pass" | "fail" | undefined;
  let ciSummary: string | undefined;
  let ciWaivedUserQuote: string | undefined;

  const checkLine =
    /^\s*(?:[-*•]\s*)?(?:\*{1,2})?(?:Checks?|Tests?|CI|检查(?:结果)?|测试(?:结果)?)(?:\*{1,2})?\s*[:：]\s*(.+)$/im.exec(
      trimmed,
    );
  if (checkLine?.[1]?.trim()) {
    const val = cleanLine(checkLine[1]).slice(0, 240);
    const sanitized = val.replace(
      /\b0\s*(?:fail(?:ed|ures)?|errors?)\b|0\s*(?:失败|报错)/gi,
      "",
    );
    if (/\b(?:waiv(?:ed|e)|skip(?:ped)?|n\/a)\b|豁免|跳过|无测试/i.test(val)) {
      ciWaivedUserQuote = val;
    } else if (
      /\b(?:fail(?:ed|ure)?|error)\b|失败|未通过|报错/i.test(sanitized)
    ) {
      ciStatus = "fail";
      ciSummary = val;
    } else if (
      /\b(?:pass(?:ed)?|ok|green|success)\b|通过|全绿|成功/i.test(val)
    ) {
      ciStatus = "pass";
      ciSummary = val;
    }
  }

  if (!ciStatus && !ciWaivedUserQuote) {
    const sanitized = trimmed.replace(
      /\b0\s*(?:fail(?:ed|ures)?|errors?)\b|0\s*(?:失败|报错)/gi,
      "",
    );
    if (
      /(?:\d+\s*\/\s*\d+\s*(?:通过|pass(?:ed)?))|(?:全部通过|全绿|tests?\s+pass(?:ed)?|all\s+(?:tests?\s+)?pass(?:ed)?|checks?\s+pass(?:ed)?)/i.test(
        trimmed,
      )
    ) {
      ciStatus = "pass";
      ciSummary = firstSubstantiveSummary(trimmed, 160);
    } else if (
      /(?:\b[1-9]\d*\s*fail(?:ed|ures)?\b|测试失败|检查未通过)/i.test(sanitized)
    ) {
      ciStatus = "fail";
      ciSummary = firstSubstantiveSummary(trimmed, 160);
    } else if (shellHint?.hasPassingShell && !shellHint?.hasFailingShell) {
      ciStatus = "pass";
      ciSummary = "Shell check exited with code 0";
    }
  }

  return {
    summary,
    architectureImpact,
    ...(ciStatus ? { ciStatus } : {}),
    ...(ciSummary ? { ciSummary } : {}),
    ...(ciWaivedUserQuote ? { ciWaivedUserQuote } : {}),
  };
}

export function parseExpertReply(text: string): ParsedExpertReply {
  const trimmed = text.trim();
  const planMatch =
    /(?:^|\s|`|\/)([a-zA-Z0-9._-]+\.md)(?:`|\s|$|[）)），。,.])/m.exec(trimmed);
  const summaryMatch =
    /^\s*(?:[-*•]\s*)?(?:\*{1,2})?(?:Summary|摘要|结论)(?:\*{1,2})?\s*[:：]\s*(.+)$/im.exec(
      trimmed,
    );
  return {
    summary: summaryMatch?.[1]?.trim()
      ? cleanLine(summaryMatch[1]).slice(0, 280)
      : firstSubstantiveSummary(trimmed, 280) || "Expert completed plan draft.",
    ...(planMatch?.[1] ? { planFile: planMatch[1] } : {}),
  };
}

/**
 * Passively updates task state from a member's native Paseo turn reply.
 * Never throws or interrupts the conversation flow.
 */
export function observeMemberTurn(
  recordPath: string,
  input: {
    role: "developer" | "expert" | "plan-reviewer" | "code-reviewer";
    agentId: string;
    text: string;
    shellHint?: TurnShellHint;
  },
): { recorded: boolean; verdict?: ReviewVerdict } {
  const text = input.text.trim();
  if (!text) return { recorded: false };

  if (input.role === "developer") {
    const parsed = parseDeveloperReply(text, input.shellHint);
    recordCandidateDelivery(recordPath, {
      agentId: input.agentId,
      summary: parsed.summary,
      architectureImpact: parsed.architectureImpact,
      ...(parsed.ciStatus ? { ciStatus: parsed.ciStatus } : {}),
      ...(parsed.ciSummary ? { ciSummary: parsed.ciSummary } : {}),
      ...(parsed.ciWaivedUserQuote
        ? { ciWaivedUserQuote: parsed.ciWaivedUserQuote }
        : {}),
    });
    return { recorded: true };
  }

  if (input.role === "expert") {
    const parsed = parseExpertReply(text);
    recordPlanSubmission(recordPath, {
      agentId: input.agentId,
      ...(parsed.planFile ? { planFile: parsed.planFile } : {}),
      summary: parsed.summary,
      allowMissingFile: true,
    });
    return { recorded: true };
  }

  const stage = input.role === "plan-reviewer" ? "plan" : "code";
  const parsed = parseReviewerReply(text);
  const record = loadTask(recordPath);
  if (parsed.verdict) {
    const round = nextReviewRound(record, stage, input.agentId);
    recordReviewVerdict(recordPath, {
      stage,
      agentId: input.agentId,
      round,
      verdict: parsed.verdict,
      summary: parsed.summary || `Submitted ${parsed.verdict}`,
      ...(parsed.findings.length > 0 ? { findings: parsed.findings } : {}),
      source: "self",
    });
    return { recorded: true, verdict: parsed.verdict };
  }

  // No explicit verdict (e.g., clarifying question): record summary passively without blocking or nagging.
  const node = record.nodes.find((n) => n.agentId === input.agentId);
  if (node && parsed.summary) {
    node.summary = parsed.summary;
    node.updatedAt = new Date().toISOString();
    saveTask(recordPath, record);
  }
  return { recorded: false };
}
