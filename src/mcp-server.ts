import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readMessages, sendMessage, updateStatus } from './db.js';

const server = new Server(
  { name: 'synapse-bus', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ───────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'read_messages',
      description:
        'Check for instructions from the human operator. ' +
        'Call this at the START of every turn before doing anything else. ' +
        'Returns unread messages addressed to you, ordered by priority (0 = urgent).',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: 'Your unique agent identifier (e.g. "agent-1", "researcher")',
          },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'send_message',
      description:
        'Send a message to the human operator or another agent. ' +
        'Use to_id = "human" to reach the operator. ' +
        'Keep messages short — the operator is watching multiple agents.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: 'Your agent identifier (sender)',
          },
          to_id: {
            type: 'string',
            description: 'Recipient ID. Use "human" for the operator.',
          },
          content: {
            type: 'string',
            description: 'Message content',
          },
          priority: {
            type: 'number',
            enum: [0, 5],
            description: '0 = urgent (P0), 5 = normal (P5). Default: 5.',
          },
        },
        required: ['agent_id', 'to_id', 'content'],
      },
    },
    {
      name: 'update_status',
      description:
        'Report your current state to the operator dashboard. ' +
        'Call this whenever your state changes AND at the END of every turn. ' +
        'An unreported state makes you invisible to the operator.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: 'Your agent identifier',
          },
          state: {
            type: 'string',
            enum: ['idle', 'working', 'blocked', 'error'],
            description: 'Your current state',
          },
          current_task: {
            type: 'string',
            description: 'Short human-readable description of what you are doing',
          },
          name: {
            type: 'string',
            description: 'Human-readable name for this agent, e.g. "Research Assistant" or derived from the project summary',
          },
          session_id: {
            type: 'string',
            description: 'Unique identifier for this session, e.g. a UUID or timestamp-based ID',
          },
        },
        required: ['agent_id', 'state'],
      },
    },
  ],
}));

// ── Tool handlers ──────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'read_messages') {
    const { agent_id } = args as { agent_id: string };
    const msgs = readMessages(agent_id);

    const reminder = '\n\n[Synapse] Now call update_status to report your current state.';

    if (msgs.length === 0) {
      return { content: [{ type: 'text', text: `No new messages.${reminder}` }] };
    }

    const formatted = msgs
      .map((m) => {
        const ts = new Date(m.created_at).toISOString();
        const label = m.priority === 0 ? '[P0 — URGENT]' : '[P5]';
        return `${label} From: ${m.from_id} at ${ts}\n${m.content}`;
      })
      .join('\n\n---\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `${msgs.length} new message(s):\n\n${formatted}${reminder}`,
        },
      ],
    };
  }

  if (name === 'send_message') {
    const { agent_id, to_id, content, priority = 5 } = args as {
      agent_id: string;
      to_id: string;
      content: string;
      priority?: number;
    };

    sendMessage(agent_id, to_id, content, priority);

    return {
      content: [
        { type: 'text', text: `Message sent to ${to_id} (priority ${priority}).` },
      ],
    };
  }

  if (name === 'update_status') {
    const { agent_id, state, current_task, name: agentName, session_id } = args as {
      agent_id: string;
      state: 'idle' | 'working' | 'blocked' | 'error';
      current_task?: string;
      name?: string;
      session_id?: string;
    };

    updateStatus(agent_id, state, current_task ?? null, agentName ?? null, session_id ?? null);

    return {
      content: [
        {
          type: 'text',
          text: `Status updated: ${state}${current_task ? ` — ${current_task}` : ''}`,
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ── Start ──────────────────────────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Allow direct invocation: `node dist/mcp-server.js`
if (process.argv[1]?.endsWith('mcp-server.js') || process.argv[1]?.endsWith('mcp-server.ts')) {
  await startMcpServer();
}
