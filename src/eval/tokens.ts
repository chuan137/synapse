import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { join } from 'path';
import type { TokenUsage } from '../db.js';

export async function readTaskTokens(
  sessionIds: string[],
  startedAt: number,
  finishedAt: number,
  cwd: string,
): Promise<TokenUsage> {
  const projectHash = cwd.replace(/\//g, '-');
  const projectDir = join(homedir(), '.claude', 'projects', projectHash);
  const upperBound = finishedAt + 500;

  const total: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  for (const sessionId of sessionIds) {
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    // Some sessions are stored as a directory — try <id>/<id>.jsonl as fallback
    const resolvedPath = existsSync(jsonlPath)
      ? jsonlPath
      : join(projectDir, sessionId, `${sessionId}.jsonl`);
    if (!existsSync(resolvedPath)) continue;

    const rl = createInterface({ input: createReadStream(resolvedPath), crlfDelay: Infinity });
    for await (const line of rl) {
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'assistant') continue;
        const ts = new Date(obj.timestamp).getTime();
        if (ts < startedAt || ts > upperBound) continue;
        const u = obj.message?.usage;
        if (!u) continue;
        total.input_tokens += u.input_tokens ?? 0;
        total.output_tokens += u.output_tokens ?? 0;
        total.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
        total.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
      } catch { /* skip malformed lines */ }
    }
  }

  return total;
}
