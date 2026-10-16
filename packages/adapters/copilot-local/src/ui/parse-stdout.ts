import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolResultText(result: unknown): string {
  const record = asRecord(result);
  if (!record) return stringifyUnknown(result);
  return asString(record.content) || asString(record.detailedContent) || stringifyUnknown(record);
}

/** Map one `copilot --output-format json` JSONL line to transcript entries. */
export function parseCopilotStdoutLine(line: string, ts: string): TranscriptEntry[] {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(line));
  } catch {
    parsed = null;
  }
  if (!parsed) return [{ kind: "stdout", ts, text: line }];

  const type = asString(parsed.type);
  const data = asRecord(parsed.data) ?? {};

  if (type === "session.tools_updated") {
    const model = asString(data.model).trim();
    return model ? [{ kind: "init", ts, model, sessionId: "" }] : [];
  }

  if (type === "assistant.message") {
    const entries: TranscriptEntry[] = [];
    const content = asString(data.content).trim();
    if (content) entries.push({ kind: "assistant", ts, text: content });
    return entries;
  }

  if (type === "assistant.reasoning") {
    const text = asString(data.content).trim();
    return text ? [{ kind: "thinking", ts, text }] : [];
  }

  if (type === "tool.execution_start") {
    return [{
      kind: "tool_call",
      ts,
      name: asString(data.toolName, "tool") || "tool",
      input: data.arguments ?? {},
      toolUseId: asString(data.toolCallId).trim() || undefined,
    }];
  }

  if (type === "tool.execution_complete") {
    return [{
      kind: "tool_result",
      ts,
      toolUseId: asString(data.toolCallId).trim() || "tool_result",
      content: toolResultText(data.result ?? data.error),
      isError: data.success === false,
    }];
  }

  if (type === "result") {
    const exitCode = typeof parsed.exitCode === "number" ? parsed.exitCode : 0;
    const usage = asRecord(parsed.usage);
    const premium = typeof usage?.premiumRequests === "number" ? ` (${usage.premiumRequests} premium requests)` : "";
    return [{
      kind: "result",
      ts,
      text: `Copilot finished with exit code ${exitCode}${premium}`,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      subtype: exitCode === 0 ? "success" : "error",
      isError: exitCode !== 0,
      errors: [],
    }];
  }

  if (type === "session.error" || type === "error") {
    const message = asString(data.message, asString(parsed.message)).trim();
    return message ? [{ kind: "stderr", ts, text: message }] : [];
  }

  // Lifecycle / ephemeral events carry no transcript content.
  return [];
}
