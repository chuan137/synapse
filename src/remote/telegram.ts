import TelegramBot from 'node-telegram-bot-api';
import { isAllowedChat } from './auth.js';

const RELAY_TYPES = new Set(['finding', 'blocked', 'done']);
const MAX_MSG_LEN = 3500;

const TYPE_ICON: Record<string, string> = {
  finding:  '🔍',
  blocked:  '🚫',
  done:     '✅',
  decision: '🔀',
  commit:   '📦',
  message:  '💬',
};

export interface TelegramBridgeOptions {
  token: string;
  allowedChats: number[];
  synapsePort: number;
  polling?: boolean;   // default true; set false in tests to avoid real network calls
}

/** Parse `@<slot> <text>` prefix. Returns {slot, text} or {slot:0, text} for bare messages. */
export function parseRoutingPrefix(content: string): { slot: number; text: string } {
  const m = content.match(/^@(\w+)\s+([\s\S]*)$/);
  if (m) {
    const slot = parseInt(m[1], 10);
    return { slot: isNaN(slot) ? 0 : slot, text: m[2].trim() };
  }
  return { slot: 0, text: content.trim() };
}

/** Determine whether a message should be relayed to the operator's Telegram chat. */
export function shouldRelay(msg: { type?: string | null; needs_approval?: number }): boolean {
  return RELAY_TYPES.has(msg.type ?? '') || !!msg.needs_approval;
}

/** Format a Synapse message for Telegram. Truncates at MAX_MSG_LEN. */
function formatMessage(msg: any): string {
  const icon = TYPE_ICON[msg.type ?? 'message'] ?? '💬';
  const from = msg.from_id ?? 'unknown';
  const snippet = String(msg.content ?? '').slice(0, MAX_MSG_LEN);
  return `${icon} [${from}]\n${snippet}`;
}

export class TelegramBridge {
  private bot: TelegramBot;
  private opts: TelegramBridgeOptions;
  private lastSeenMsgId = 0;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: TelegramBridgeOptions) {
    this.opts = opts;
    this.bot = new TelegramBot(opts.token, { polling: opts.polling !== false });
  }

  async waitForSynapse(maxAttempts = 30): Promise<void> {
    const url = `http://localhost:${this.opts.synapsePort}/api/state`;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          process.stdout.write(`[telegram] Connected to Synapse at ${url}\n`);
          return;
        }
      } catch { /* connection refused — expected during startup */ }
      process.stdout.write(`[telegram] Waiting for Synapse server at ${url}... (${i + 1}/${maxAttempts})\n`);
      await new Promise(r => setTimeout(r, 10_000));
    }
    process.stderr.write(`[telegram] Could not connect to Synapse after ${maxAttempts} attempts. Exiting.\n`);
    process.exit(1);
  }

  async start(): Promise<void> {
    this.running = true;

    // Seed cursor so we don't replay old messages
    try {
      const state = await this.fetchState();
      const humanMsgs: any[] = (state?.messages ?? []).filter((m: any) => m.to_id === 'human');
      if (humanMsgs.length > 0) {
        this.lastSeenMsgId = Math.max(...humanMsgs.map((m: any) => m.id ?? 0));
      }
    } catch { /* ignore — cursor stays 0 */ }

    // Inbound: operator Telegram → Synapse agent
    this.bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      if (!isAllowedChat(chatId, this.opts.allowedChats)) {
        process.stdout.write(`[telegram] Rejected message from unlisted chat ${chatId}\n`);
        return;
      }
      const content = msg.text ?? '';
      const { slot, text } = parseRoutingPrefix(content);

      let agentId: string | null = null;
      try {
        const state = await this.fetchState();
        const agent = (state?.statuses ?? []).find((a: any) => a.slot === slot);
        agentId = agent?.agent_id ?? null;
      } catch { /* ignore */ }

      if (!agentId) {
        await this.bot.sendMessage(chatId, `⚠️ No agent at slot ${slot}`);
        return;
      }

      try {
        await fetch(`http://localhost:${this.opts.synapsePort}/api/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to_id: agentId, content: text, priority: 5 }),
        });
      } catch (err) {
        process.stderr.write(`[telegram] Failed to POST message: ${err}\n`);
        await this.bot.sendMessage(chatId, `⚠️ Could not reach Synapse`);
      }
    });

    // Approval / option callback
    this.bot.on('callback_query', async (query) => {
      const chatId = query.message?.chat.id;
      if (!chatId || !isAllowedChat(chatId, this.opts.allowedChats)) return;

      const data = query.data ?? '';
      let url: string | null = null;
      let body: object | null = null;

      if (data.startsWith('approve:')) {
        const id = data.slice('approve:'.length);
        url = `http://localhost:${this.opts.synapsePort}/api/messages/${id}/approve`;
        body = {};
      } else if (data.startsWith('option:')) {
        const [, id, idx] = data.split(':');
        url = `http://localhost:${this.opts.synapsePort}/api/messages/${id}/select-option`;
        body = { option_index: parseInt(idx, 10) };
      }

      if (url) {
        try {
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
          });
        } catch (err) {
          process.stderr.write(`[telegram] Approval POST failed: ${err}\n`);
        }
      }

      await this.bot.answerCallbackQuery(query.id);
      // Edit the message to remove inline keyboard after action
      if (query.message?.message_id && query.message.chat.id) {
        try {
          await this.bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: query.message.chat.id, message_id: query.message.message_id },
          );
        } catch { /* message may have already been edited */ }
      }
    });

    // Outbound poll loop: Synapse → Telegram
    this.pollInterval = setInterval(() => this.pollOutbound(), 2000);
  }

  private async fetchState(): Promise<any> {
    const res = await fetch(`http://localhost:${this.opts.synapsePort}/api/state`);
    return res.json();
  }

  private async pollOutbound(): Promise<void> {
    if (!this.running) return;
    try {
      const state = await this.fetchState();
      const newMsgs: any[] = (state?.messages ?? [])
        .filter((m: any) => m.to_id === 'human' && (m.id ?? 0) > this.lastSeenMsgId && shouldRelay(m))
        .sort((a: any, b: any) => (a.id ?? 0) - (b.id ?? 0));

      for (const msg of newMsgs) {
        const text = formatMessage(msg);
        const opts: any = {};

        if (msg.needs_approval) {
          opts.reply_markup = {
            inline_keyboard: [[
              { text: '✓ Approve', callback_data: `approve:${msg.id}` },
            ]],
          };
        } else if (msg.request_options) {
          try {
            const options: string[] = JSON.parse(msg.request_options);
            opts.reply_markup = {
              inline_keyboard: [
                options.map((opt: string, i: number) => ({
                  text: opt,
                  callback_data: `option:${msg.id}:${i}`,
                })),
              ],
            };
          } catch { /* invalid JSON — skip inline keyboard */ }
        }

        for (const chatId of this.opts.allowedChats) {
          try {
            await this.bot.sendMessage(chatId, text, opts);
          } catch (err) {
            process.stderr.write(`[telegram] Failed to send to chat ${chatId}: ${err}\n`);
          }
        }
        this.lastSeenMsgId = Math.max(this.lastSeenMsgId, msg.id ?? 0);
      }
    } catch { /* Synapse may be momentarily unreachable — next tick will retry */ }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollInterval) clearInterval(this.pollInterval);
    await this.bot.stopPolling();
  }
}
