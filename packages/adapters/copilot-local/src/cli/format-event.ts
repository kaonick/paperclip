import pc from "picocolors";

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

export function printCopilotStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(line));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    console.log(line);
    return;
  }

  const type = asString(parsed.type);
  const data = asRecord(parsed.data) ?? {};

  if (type === "assistant.message") {
    const content = asString(data.content).trim();
    if (content) console.log(pc.green(`assistant: ${content}`));
    return;
  }

  if (type === "tool.execution_start") {
    console.log(pc.yellow(`tool_call: ${asString(data.toolName, "tool")}`));
    if (data.arguments !== undefined) console.log(pc.gray(stringifyUnknown(data.arguments)));
    return;
  }

  if (type === "tool.execution_complete") {
    console.log((data.success === false ? pc.red : pc.cyan)("tool_result"));
    const result = asRecord(data.result);
    const text = asString(result?.content) || stringifyUnknown(data.result ?? data.error);
    if (text) console.log((data.success === false ? pc.red : pc.gray)(text));
    return;
  }

  if (type === "session.error" || type === "error") {
    const message = asString(data.message, asString(parsed.message)).trim();
    if (message) console.log(pc.red(`error: ${message}`));
    return;
  }

  if (type === "result") {
    const sessionId = asString(parsed.sessionId).trim();
    const exitCode = typeof parsed.exitCode === "number" ? parsed.exitCode : 0;
    console.log(pc.blue(`Copilot finished (exit ${exitCode})${sessionId ? ` session: ${sessionId}` : ""}`));
    return;
  }

  if (debug) console.log(pc.gray(line));
}
