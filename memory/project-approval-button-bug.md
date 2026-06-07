---
name: approval-button-bug
description: S-Deck approval button click does not send a message to the bus — operator must send a manual message to confirm
metadata:
  type: project
---

When the operator clicks the "Approve" button on a `needs_approval` message in S-Deck, no message is sent to the orchestrator. The operator has to manually type a follow-up message to confirm approval.

**Why:** Bug in the S-Deck approval button handler — the click event is not wired to `send_message` on the bus.

**How to apply:** Don't block waiting for a bus message after sending a `needs_approval` request. Remind the human to send a manual confirmation if no reply arrives after approval.
