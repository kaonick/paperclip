import { asNumber, asString, parseJson } from "@paperclipai/adapter-utils/server-utils";

export interface ParsedCopilotOutput {
  sessionId: string | null;
  summary: string;
  exitCode: number | null;
  sawResult: boolean;
  premiumRequests: number | null;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  errors: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Parse `copilot -p ... --output-format json` JSONL stdout. */
export function parseCopilotJsonl(stdout: string): ParsedCopilotOutput {
  const out: ParsedCopilotOutput = {
    sessionId: null,
    summary: "",
    exitCode: null,
    sawResult: false,
    premiumRequests: null,
    model: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    errors: [],
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    const event = parseJson(line);
    if (!event) continue;
    const type = asString(event.type, "");
    const data = asRecord(event.data) ?? {};

    if (type === "assistant.message") {
      const content = asString(data.content, "").trim();
      if (content) out.summary = content;
      const model = asString(data.model, "").trim();
      if (model) out.model = model;
      out.usage.outputTokens += asNumber(data.outputTokens, 0);
      continue;
    }

    if (type === "session.error" || type === "error") {
      const message = asString(data.message, asString(event.message, "")).trim();
      if (message && !out.errors.includes(message)) out.errors.push(message);
      continue;
    }

    if (type === "result") {
      out.sawResult = true;
      const sessionId = asString(event.sessionId, "").trim();
      if (sessionId) out.sessionId = sessionId;
      if (typeof event.exitCode === "number") out.exitCode = event.exitCode;
      const usage = asRecord(event.usage);
      if (usage && typeof usage.premiumRequests === "number") out.premiumRequests = usage.premiumRequests;
    }
  }

  return out;
}

const UNKNOWN_SESSION_RE =
  /(no (such )?session|session .*not found|could not find (a )?session|unknown session|invalid session)/i;

export function isCopilotUnknownSessionError(stdout: string, stderr: string): boolean {
  return UNKNOWN_SESSION_RE.test(`${stdout}\n${stderr}`);
}

const AUTH_REQUIRED_RE =
  /(not (logged|signed) in|authentication (required|failed)|please (run|use) .*login|copilot login|no (valid )?(github )?token)/i;

export function detectCopilotAuthRequired(stdout: string, stderr: string): boolean {
  return AUTH_REQUIRED_RE.test(`${stdout}\n${stderr}`);
}
