# docs/

Design and test plans for Synapse. One file per topic, flat layout.

## Naming

- `plan-<topic>.md` — design/implementation plan
- `test-plan-<topic>.md` — test plan

Each file starts with a title and a `Status:` line (planned / in review / done).

## Index

| File | What | Status |
|---|---|---|
| [plan-enforce-spawn-ack.md](plan-enforce-spawn-ack.md) | Enforce worker spawn ACK in server code (`ready_at` gate) | planned |
| [plan-telegram-bot.md](plan-telegram-bot.md) | Telegram bot remote access, phase 1 design | pending operator review |
| [test-plan-retro-eval.md](test-plan-retro-eval.md) | Test plan for the retro-eval self-improvement loop | — |
