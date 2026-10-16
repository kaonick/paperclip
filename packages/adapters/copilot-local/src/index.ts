export const type = "copilot_local";
export const label = "GitHub Copilot CLI (local)";

export const DEFAULT_COPILOT_LOCAL_MODEL = "auto";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @github/copilot";

export const models = [
  { id: DEFAULT_COPILOT_LOCAL_MODEL, label: "Auto" },
  { id: "claude-sonnet-5.5", label: "Claude Sonnet 5.5" },
];

export const agentConfigurationDoc = `# copilot_local agent configuration

Adapter: copilot_local

Use when:
- You want Paperclip to run the GitHub Copilot CLI (\`copilot\`) locally as the agent runtime
- You want to use a GitHub Copilot subscription (model routing is handled by Copilot)
- You want session resume across heartbeats via --resume

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- The GitHub Copilot CLI is not installed or not logged in on the machine (run \`copilot login\`)

Core fields:
- cwd (string, optional): default absolute working directory for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Copilot model id, or "auto" (default) to let Copilot choose
- reasoningEffort (string, optional): none, minimal, low, medium, high, xhigh, max
- command (string, optional): defaults to "copilot"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- dangerouslySkipPermissions (boolean, optional): pass --allow-all (tools, paths, URLs); defaults to true because non-interactive runs cannot prompt. Disable only if you supply explicit --allow-tool/--allow-url extraArgs.
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use \`copilot -p <prompt> --output-format json\`; the prompt is passed as a command-line argument, so very large prompts can hit OS argument-length limits.
- Sessions are resumed with \`--resume <sessionId>\` only when the saved cwd matches the current cwd.
- Paperclip skills are linked into ~/.copilot/skills.
`;
