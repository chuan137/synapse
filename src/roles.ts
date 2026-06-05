// Role file parsing/serialization. Source of truth is templates/roles/<name>.md,
// each with YAML-ish front-matter (role/description/capabilities) + a markdown body.
// The format is constrained, so a small regex parser is enough — no YAML lib.

export interface Role {
  name: string;
  description: string;
  capabilities: string[];
  body: string;
}

/** Parse a role file's text into a Role. Returns null if it has no valid front-matter. */
export function parseRoleFile(text: string): Role | null {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;
  const block = match[1];
  const name = (block.match(/^role:\s*(.+)$/m) ?? [])[1]?.trim() ?? '';
  if (!name) return null;
  const description = (block.match(/^description:\s*(.+)$/m) ?? [])[1]?.trim() ?? '';
  const capMatch = block.match(/^capabilities:\s*\[([^\]]*)\]/m);
  const capabilities = capMatch
    ? capMatch[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    : [];
  const body = text.slice(match[0].length).replace(/^\n+/, '');
  return { name, description, capabilities, body };
}

/** Serialize a Role back into role-file text (front-matter + body). */
export function serializeRoleFile(role: Role): string {
  const caps = `[${role.capabilities.join(', ')}]`;
  const fm = [
    '---',
    `role: ${role.name}`,
    `description: ${role.description}`,
    `capabilities: ${caps}`,
    '---',
  ].join('\n');
  return `${fm}\n\n${role.body.replace(/^\n+/, '')}\n`;
}

/** A role slug must be lowercase, start with a letter, and contain only [a-z0-9-]. */
export function isValidRoleName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}
