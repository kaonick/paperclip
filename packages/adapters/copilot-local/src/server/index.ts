import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSessionId(record: Record<string, unknown>): string | null {
  return (
    readNonEmptyString(record.sessionId) ??
    readNonEmptyString(record.session_id) ??
    readNonEmptyString(record.session)
  );
}

function readCwd(record: Record<string, unknown>): string | null {
  return readNonEmptyString(record.cwd) ?? readNonEmptyString(record.workdir) ?? readNonEmptyString(record.folder);
}

function normalize(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const sessionId = readSessionId(record);
  if (!sessionId) return null;
  const cwd = readCwd(record);
  return { sessionId, ...(cwd ? { cwd } : {}) };
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize: normalize,
  serialize: (params) => (params ? normalize(params) : null),
  getDisplayId: (params) => (params ? readSessionId(params) : null),
};

export { execute } from "./execute.js";
export { listCopilotSkills, syncCopilotSkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export { parseCopilotJsonl, isCopilotUnknownSessionError, detectCopilotAuthRequired } from "./parse.js";
