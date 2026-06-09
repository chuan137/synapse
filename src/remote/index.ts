import { parseAllowedChats } from './auth.js';
import { TelegramBridge } from './telegram.js';

export async function startTelegramBridge(synapsePort: number): Promise<void> {
  const token = process.env.SYNAPSE_TELEGRAM_TOKEN;
  if (!token) {
    process.stderr.write(
      'error: SYNAPSE_TELEGRAM_TOKEN is not set.\n' +
      'Obtain a bot token from BotFather (https://t.me/BotFather) and set it:\n' +
      '  export SYNAPSE_TELEGRAM_TOKEN=<your-token>\n'
    );
    process.exit(1);
  }

  const allowedChats = parseAllowedChats(process.env.SYNAPSE_TELEGRAM_ALLOWED_CHATS);
  if (allowedChats.length === 0) {
    process.stderr.write(
      'error: SYNAPSE_TELEGRAM_ALLOWED_CHATS is not set or contains no valid chat IDs.\n' +
      'Set it to your Telegram chat ID(s), comma-separated:\n' +
      '  export SYNAPSE_TELEGRAM_ALLOWED_CHATS=123456789\n' +
      'To find your chat ID, message @userinfobot on Telegram.\n'
    );
    process.exit(1);
  }

  const bridge = new TelegramBridge({ token, allowedChats, synapsePort });

  process.stdout.write(`[telegram] Starting bridge (allowed chats: ${allowedChats.length})\n`);

  await bridge.waitForSynapse();
  await bridge.start();

  process.stdout.write(`[telegram] Bridge running. Type @0 <message> in Telegram to reach the orchestrator.\n`);

  // Keep alive until signal
  const shutdown = async () => {
    process.stdout.write('\n[telegram] Shutting down...\n');
    await bridge.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
