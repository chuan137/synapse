export const DEFAULT_TMUX_SESSION = "team";

export function nowIso(): string {
  return new Date().toISOString().slice(0, 19);
}

export function fail(msg: string): never {
  console.error(`synapse: ${msg}`);
  process.exit(1);
}
