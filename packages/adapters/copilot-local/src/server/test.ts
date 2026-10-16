import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, asStringArray, ensurePathInEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { DEFAULT_COPILOT_LOCAL_MODEL } from "../index.js";
import { detectCopilotAuthRequired, parseCopilotJsonl } from "./parse.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "copilot");
  const target = ctx.executionTarget ?? null;
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const runId = `copilot-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (target?.kind === "remote") {
    checks.push({
      code: "copilot_remote_unsupported",
      level: "error",
      message: "copilot_local does not support remote execution environments yet.",
      detail: ctx.environmentName ?? describeAdapterExecutionTarget(target),
    });
    return { adapterType: ctx.adapterType, status: "fail", checks, testedAt: new Date().toISOString() };
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, { cwd, env: {}, createIfMissing: true });
    checks.push({ code: "copilot_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (err) {
    checks.push({
      code: "copilot_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({ code: "copilot_command_resolvable", level: "info", message: `Command is executable: ${command}` });
  } catch (err) {
    checks.push({
      code: "copilot_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install the GitHub Copilot CLI: npm install -g @github/copilot",
    });
  }

  const hasToken = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"].some(
    (key) => typeof runtimeEnv[key] === "string" && runtimeEnv[key]!.trim().length > 0,
  );
  checks.push(
    hasToken
      ? { code: "copilot_token_present", level: "info", message: "A GitHub token is set for Copilot authentication." }
      : {
          code: "copilot_token_missing",
          level: "info",
          message: "No GitHub token env var detected. Copilot CLI may still authenticate via `copilot login`.",
          hint: "If the hello probe fails with an auth error, run `copilot login` or set COPILOT_GITHUB_TOKEN in adapter env.",
        },
  );

  const canRunProbe = checks.every(
    (check) => check.code !== "copilot_cwd_invalid" && check.code !== "copilot_command_unresolvable",
  );
  if (canRunProbe) {
    const model = asString(config.model, DEFAULT_COPILOT_LOCAL_MODEL).trim() || DEFAULT_COPILOT_LOCAL_MODEL;
    const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 90));
    const extraArgs = asStringArray(config.extraArgs);
    const args = ["-p", "Respond with hello. Do not use tools.", "--output-format", "json", "--stream", "off", "--model", model];
    args.push(...extraArgs);

    const probe = await runAdapterExecutionTargetProcess(runId, target, command, args, {
      cwd,
      env,
      timeoutSec: helloProbeTimeoutSec,
      graceSec: 5,
      onLog: async () => {},
    });
    const parsed = parseCopilotJsonl(probe.stdout);
    const rawDetail = parsed.errors[0] || firstNonEmptyLine(probe.stderr) || firstNonEmptyLine(probe.stdout);
    const detail = rawDetail ? rawDetail.replace(/\s+/g, " ").trim().slice(0, 240) : null;

    if (probe.timedOut) {
      checks.push({
        code: "copilot_hello_probe_timed_out",
        level: "warn",
        message: "Copilot hello probe timed out.",
        hint: "Retry the probe. If this persists, run `copilot -p \"Respond with hello.\"` manually in this directory.",
      });
    } else if ((probe.exitCode ?? 1) === 0) {
      const hasHello = /\bhello\b/i.test(parsed.summary);
      checks.push({
        code: hasHello ? "copilot_hello_probe_passed" : "copilot_hello_probe_unexpected_output",
        level: hasHello ? "info" : "warn",
        message: hasHello
          ? "Copilot hello probe succeeded."
          : "Copilot probe ran but did not return `hello` as expected.",
        ...(parsed.summary ? { detail: parsed.summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
      });
    } else if (detectCopilotAuthRequired(probe.stdout, probe.stderr)) {
      checks.push({
        code: "copilot_hello_probe_auth_required",
        level: "warn",
        message: "Copilot CLI is installed, but authentication is not ready.",
        ...(detail ? { detail } : {}),
        hint: "Run `copilot login` or set COPILOT_GITHUB_TOKEN in adapter env, then retry the probe.",
      });
    } else {
      checks.push({
        code: "copilot_hello_probe_failed",
        level: "error",
        message: "Copilot hello probe failed.",
        ...(detail ? { detail } : {}),
        hint: "Run `copilot -p \"Respond with hello.\" --output-format json` manually in this directory to debug.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
