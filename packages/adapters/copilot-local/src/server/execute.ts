import { createProviderStoppedBoundary } from "@paperclipai/adapter-utils/provider-stopped-boundary";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  ensureAdapterExecutionTargetCommandResolvable,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  hydrateFreshSessionHandoff,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  readPaperclipRuntimeSkillEntries,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  resolveLegacyPaperclipDesiredSkillNames,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import fs from "node:fs/promises";
import { DEFAULT_COPILOT_LOCAL_MODEL } from "../index.js";
import { isCopilotUnknownSessionError, parseCopilotJsonl } from "./parse.js";
import { resolveCopilotSkillsHome } from "./skills.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function readTrimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const providerStop = createProviderStoppedBoundary(ctx.onProviderStopped);
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  if (adapterExecutionTargetIsRemote(executionTarget)) {
    throw new Error("copilot_local does not support remote execution environments yet.");
  }

  const conversationMode = context.conversationMode === true;
  const promptTemplate = asString(
    config.promptTemplate,
    conversationMode ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const hasCustomPromptTemplate = asString(config.promptTemplate, "").trim().length > 0;
  const command = asString(config.command, "copilot");
  const model = asString(config.model, DEFAULT_COPILOT_LOCAL_MODEL).trim() || DEFAULT_COPILOT_LOCAL_MODEL;
  const reasoningEffort = asString(config.reasoningEffort, "").trim();
  const skipPermissions = asBoolean(config.dangerouslySkipPermissions, true);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // Link Paperclip skills into ~/.copilot/skills (Copilot's personal skills directory).
  const skillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = new Set(resolveLegacyPaperclipDesiredSkillNames(config, skillEntries));
  const skillsHome = resolveCopilotSkillsHome(config);
  const selectedSkills = skillEntries.filter((entry) => desiredSkillNames.has(entry.key));
  if (selectedSkills.length > 0) {
    await fs.mkdir(skillsHome, { recursive: true });
    for (const entry of selectedSkills) {
      try {
        const result = await ensurePaperclipSkillSymlink(entry.source, path.join(skillsHome, entry.runtimeName));
        if (result === "skipped") continue;
        await onLog(
          "stderr",
          `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Copilot skill "${entry.runtimeName}" into ${skillsHome}\n`,
        );
      } catch (err) {
        await onLog(
          "stderr",
          `[paperclip] Failed to inject Copilot skill "${entry.runtimeName}": ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId = readTrimmed(context.taskId) ?? readTrimmed(context.issueId);
  const wakeReason = readTrimmed(context.wakeReason);
  const wakeCommentId = readTrimmed(context.wakeCommentId) ?? readTrimmed(context.commentId);
  const approvalId = readTrimmed(context.approvalId);
  const approvalStatus = readTrimmed(context.approvalStatus);
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote: false,
    executionCwd: cwd,
  });
  if (authToken) env.PAPERCLIP_API_KEY = authToken;

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(executionTarget, asNumber(config.timeoutSec, 0));
  const graceSec = asNumber(config.graceSec, 20);
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv);
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, { runtimeEnv, includeRuntimeKeys: ["HOME"], resolvedCommand });

  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    return fromExtraArgs.length > 0 ? fromExtraArgs : asStringArray(config.args);
  })();

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Copilot session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath ? path.resolve(cwd, instructionsFilePath) : "";
  let instructionsPrefix = "";
  let instructionsReadFailed = false;
  if (resolvedInstructionsFilePath) {
    try {
      const contents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
      instructionsPrefix =
        `${contents}\n\n` +
        `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
        `Resolve any relative file references from ${path.dirname(resolvedInstructionsFilePath)}/.\n\n`;
    } catch (err) {
      instructionsReadFailed = true;
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const commandNotes = resolvedInstructionsFilePath
    ? [
        instructionsReadFailed
          ? `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`
          : `Prepended agent instructions from ${resolvedInstructionsFilePath} to the prompt.`,
      ]
    : [];

  const runAttempt = async (resumeSessionId: string | null) => {
    const resumed = resumeSessionId !== null;
    await hydrateFreshSessionHandoff(ctx, { resumedSession: resumed });
    const sections = selectPaperclipPromptSections(context, { resumedSession: resumed });
    const bootstrapPrompt =
      !resumed && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
    const heartbeatPrompt =
      (resumed && sections.wakePrompt.length > 0) ||
      isPaperclipRecoveryWakePayload(context.paperclipWake) ||
      !hasCustomPromptTemplate
        ? ""
        : renderTemplate(promptTemplate, templateData);
    // Copilot has no system-prompt flag, so the default execution contract is inlined when no custom template is set.
    const defaultContract = !hasCustomPromptTemplate && !resumed ? renderTemplate(promptTemplate, templateData) : "";
    const prompt = joinPromptSections([
      !resumed ? instructionsPrefix.trim() : "",
      selectInitialCommunicationGuidance(context, { resumedSession: resumed }),
      bootstrapPrompt,
      sections.wakePrompt,
      sections.taskContextNote,
      sessionHandoffNote,
      heartbeatPrompt,
      defaultContract,
    ]);

    // The copilot shim on Windows is a .cmd file: long or multi-line argv breaks cmd.exe, so the prompt goes via a file.
    const promptDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-copilot-prompt-"));
    const promptFile = path.join(promptDir, "prompt.md");
    await fs.writeFile(promptFile, prompt, "utf8");
    const launchPrompt = `Read the file ${promptFile} and carry out the instructions in it exactly as if they were this message.`;

    const args = ["-p", launchPrompt, "--output-format", "json", "--stream", "off", "--add-dir", promptDir];
    args.push("--model", model);
    if (reasoningEffort) args.push("--reasoning-effort", reasoningEffort);
    if (skipPermissions) args.push("--allow-all");
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (extraArgs.length > 0) args.push(...extraArgs);

    if (onMeta) {
      await onMeta({
        adapterType: "copilot_local",
        command: resolvedCommand,
        cwd,
        commandNotes,
        commandArgs: args.map((arg, i) => (args[i - 1] === "-p" ? `<prompt file, ${prompt.length} chars>` : arg)),
        env: loggedEnv,
        prompt,
        promptMetrics: {
          promptChars: prompt.length,
          instructionsChars: instructionsPrefix.length,
          bootstrapPromptChars: bootstrapPrompt.length,
          wakePromptChars: sections.wakePrompt.length,
          taskContextChars: sections.taskContextNote.length,
          sessionHandoffChars: sessionHandoffNote.length,
          heartbeatPromptChars: heartbeatPrompt.length,
        },
        context,
      });
    }

    let proc;
    try {
      proc = await runAdapterExecutionTargetProcess(runId, executionTarget, command, args, {
        onProcessStopped: providerStop.beginInvocation(),
        cwd,
        env: runtimeEnv,
        timeoutSec,
        graceSec,
        onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        onLog,
      });
    } finally {
      await fs.rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return { proc, parsed: parseCopilotJsonl(proc.stdout) };
  };

  const toResult = (
    attempt: Awaited<ReturnType<typeof runAttempt>>,
    clearSessionOnMissingSession = false,
  ): AdapterExecutionResult => {
    const { proc, parsed } = attempt;
    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const sessionId = parsed.sessionId ?? (clearSessionOnMissingSession ? null : runtimeSessionId || null);
    const parsedError = parsed.errors.find((error) => error.trim().length > 0) ?? "";
    const rawExitCode = proc.exitCode ?? parsed.exitCode;
    const exitCode = (rawExitCode ?? 0) === 0 && parsedError ? 1 : rawExitCode;
    return {
      exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage:
        (exitCode ?? 0) === 0
          ? null
          : parsedError || firstNonEmptyLine(proc.stderr) || `Copilot exited with code ${exitCode ?? -1}`,
      errorCode: proc.errorCode ?? null,
      usage: parsed.usage,
      sessionId,
      sessionParams: sessionId ? { sessionId, cwd } : null,
      sessionDisplayId: sessionId,
      provider: "github_copilot",
      biller: "github_copilot",
      model: parsed.model ?? model,
      billingType: "subscription",
      costUsd: null,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
        ...(parsed.premiumRequests !== null ? { premiumRequests: parsed.premiumRequests } : {}),
      },
      summary: parsed.summary || null,
      clearSession: Boolean(clearSessionOnMissingSession && !sessionId),
    };
  };

  const initial = await runAttempt(canResumeSession ? runtimeSessionId : null);
  if (
    canResumeSession &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    isCopilotUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Copilot session "${runtimeSessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    return toResult(await runAttempt(null), true);
  }
  return toResult(initial);
}
