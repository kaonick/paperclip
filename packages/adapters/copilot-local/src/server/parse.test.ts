import { describe, expect, it } from "vitest";
import { isCopilotUnknownSessionError, parseCopilotJsonl } from "./parse.js";
import { sessionCodec } from "./index.js";
import { parseCopilotStdoutLine } from "../ui/parse-stdout.js";

const stdout = [
  JSON.stringify({ type: "assistant.message", data: { content: "hi", model: "claude-sonnet-5.5", toolRequests: [] } }),
  JSON.stringify({ type: "assistant.message_delta", data: { deltaContent: "x" }, ephemeral: true }),
  JSON.stringify({ type: "result", sessionId: "s-1", exitCode: 0, usage: { premiumRequests: 1 } }),
].join("\n");

describe("copilot_local parser", () => {
  it("extracts summary, session, model and premium requests", () => {
    const parsed = parseCopilotJsonl(stdout);
    expect(parsed).toMatchObject({
      summary: "hi",
      sessionId: "s-1",
      model: "claude-sonnet-5.5",
      exitCode: 0,
      sawResult: true,
      premiumRequests: 1,
    });
  });

  it("detects unknown sessions", () => {
    expect(isCopilotUnknownSessionError("", "Error: session abc not found")).toBe(true);
    expect(isCopilotUnknownSessionError("ok", "")).toBe(false);
  });

  it("round-trips the session codec", () => {
    expect(sessionCodec.serialize({ session_id: "s-1", cwd: "/w" })).toEqual({ sessionId: "s-1", cwd: "/w" });
    expect(sessionCodec.deserialize({})).toBeNull();
  });

  it("maps transcript lines", () => {
    const ts = "2026-01-01T00:00:00Z";
    expect(parseCopilotStdoutLine(JSON.stringify({ type: "assistant.message", data: { content: "hi" } }), ts)).toEqual([
      { kind: "assistant", ts, text: "hi" },
    ]);
    expect(parseCopilotStdoutLine("not json", ts)).toEqual([{ kind: "stdout", ts, text: "not json" }]);
  });
});
