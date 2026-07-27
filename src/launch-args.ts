// Build the argument list for a claude launch so that --disallowedTools (a
// variadic flag) never consumes the positional prompt. The `--` separator
// terminates option processing, so anything after it is treated as a
// positional argument regardless of its content.
export function buildClaudeArgs(
  sessionId: string,
  model: string | undefined,
  initialPrompt: string,
  mcpConfigPath?: string,
): string[] {
  const args = [
    "--session-id", sessionId,
    "--dangerously-skip-permissions",
    "--disallowedTools", "AskUserQuestion,EnterPlanMode",
  ];
  if (model) args.push("--model", model);
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
  args.push("--", initialPrompt);
  return args;
}
