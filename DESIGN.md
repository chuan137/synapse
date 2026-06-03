Here is the comprehensive Architecture and Features Document for **Synapse v2.0**. It incorporates your existing `synapse-bus` implementation (Node.js, `better-sqlite3`, and the S-Deck Express + SSE Server) while expanding it into a full multi-agent orchestration daemon.

---

# Synapse v2.0: System Architecture & Feature Specification

## 1. Executive Summary & Design Philosophy

Synapse v2.0 is a terminal-first, local-first multi-agent orchestration engine. It functions as a lightweight, persistent background daemon that bridges low-level terminal multiplexing, local state machines, and open IDE integration protocols.

### Design Principles:

* **Functional Bauhaus Aesthetic:** Minimalist abstraction layers. The system does not reinvent user interfaces; it orchestrates the interfaces you already own (Zed, Neovim, Tmux).
* **Data Sovereignty:** Local-first telemetry, state-tracking, and audit execution via an embedded SQLite engine. No intermediate cloud layer.
* **Decoupled Orchestration:** Isolation of LLM agent runtimes from user workspace configurations using native filesystem mechanisms (Git Worktrees).

---

## 2. System Architecture

Synapse operates as a centralized event bus and process supervisor. The interaction model flows from the developer interface down through the coordinator daemon into ephemeral isolated execution environments.

```
       +-------------------------------------------------------+
       |                  DEVELOPER INTERFACE                  |
       |  [ Zed IDE (via ACP) ]   |   [ Tmux / TUI (via IPC) ] |
       +---------------------------+---------------------------+
                                   |
                     JSON-RPC (stdio / UNIX Sockets)
                                   v
       +-------------------------------------------------------+
       |                 SYNAPSE CORE DAEMON                   |
       |                                                       |
       |   +------------------+  +-------------------------+   |
       |   |    MCP Server    |  |   Dashboard (Express)   |   |
       |   | (Stdio Host API) |  |   (SSE Event Stream)    |   |
       |   +--------+---------+  +------------+------------+   |
       |            |                         |                |
       |            +------------+------------+                |
       |                         |                             |
       |                         v                             |
       |   +-----------------------------------------------+   |
       |   |         STATE & ORCHESTRATION ENGINE          |   |
       |   |                                               |   |
       |   |  [ messages ]        [ agent_status ]         |   |
       |   |  (Priority Queue)    (Heartbeats / PIDs)      |   |
       |   |                                               |   |
       |   |  [ tool_metrics ]    [ shared_state ]         |   |
       |   |  (Token Observability)(Global KV Context)     |   |
       |   +---------------------+-------------------------+   |
       |                         |                             |
       +-------------------------|-----------------------------+
                                 v
       +-------------------------------------------------------+
       |                SANDBOX & PROCESS LAYER                |
       |                                                       |
       |    +---------------------------------------------+    |
       |    |            Git Worktree Sandbox             |    |
       |    |  - Path: .synapse/worktrees/feature-xyz     |    |
       |    |  - Bound Terminal Panes: Tmux / Zellij      |    |
       +--------------------------------------------------+    |
       +-------------------------------------------------------+

```

---

## 3. Core Feature Specification

### 3.1. Unified Gateway Daemon (`synapse start`)

Instead of launching disjointed processes, the system initializes via a unified CLI entrypoint that binds the asynchronous lifecycles of its micro-services into a single Node.js runtime process event loop.

* **Dual Bootstrapping:** Simultaneously hooks up the standard input/output (`stdio`) transport for the Model Context Protocol (MCP) and spins up the HTTP/Server-Sent Events (SSE) servers for visual indexing.
* **Graceful Supervision:** Catches terminal termination signals (`SIGINT`, `SIGTERM`) to clean up running child sub-agents, release database locks, and prune temporary filesystem directories.

### 3.2. Local SQLite Event Bus & Telemetry

A high-performance relational storage layer utilizing `better-sqlite3` configured in Write-Ahead Logging (WAL) mode for simultaneous multi-agent reads and writes.

* **`messages` (The Priority Queue):** Routes asynchronous task delegation packets between agents. Supports statuses: `pending`, `running`, `completed`, `failed`, and `waiting_approval`.
* **`agent_status` (Distributed Heartbeats):** Tracks active sub-agent processes by binding their real-time Process IDs (PIDs) and memory footprints, protecting the workspace from orphan execution loops.
* **`tool_metrics` (Cost Control Guardrails):** Tracks real-time API token spend, latency distribution, and script success metrics per sub-agent.
* **`shared_state` (Central Context Store):** Global key-value database allowing isolated running instances to share runtime constraints, network interfaces, and environment pointers.

### 3.3. Isolation Engine (Git Worktree Sandboxing)

Prevents destructive or experimental changes from contaminating the developer's working index or breaking active compilation streams.

* **Dynamic Worktrees:** When a feature branch refactor is initiated, Synapse checkouts the codebase into an isolated path under `.synapse/worktrees/<branch-name>`.
* **Runtime Containment:** Linter execution, script execution, and dependency installation occur strictly inside this isolated target directory.
* **Visual Diff Promotion:** Upon successful test completion, the daemon surfaces changes directly to the host client (e.g., Zed's inline diff editor) for human approval before branch merging.

### 3.4. Human-in-the-Loop Gateway (The Approval Lock)

An absolute protection barrier restricting autonomous sub-agents from executing high-risk or destructive tools (such as broad file deletions, network operations, or system packaging scripts).

* **Process Suspend:** When an agent invokes a guarded tool, Synapse halts task execution in the `messages` queue and sets state to `waiting_approval`.
* **Asynchronous Interrupt Signaling:** Dispatches signals via the SSE stream (`dashboard.ts`) and intercepts IDE action streams.
* **Manual Override Runtimes:** The developer can query details, execute custom terminal commands inside the sub-agent's isolated pane, and issue `synapse approve <id>` to resume execution.

---

## 4. Current State Component Mapping (`synapse-bus`)

The current code matrix aligns with this architecture through the following functional blocks:

| Planned Layout Component | Implemented Entity | Engineering Status & Context |
| --- | --- | --- |
| `src/types.ts` | Inlined in `db.ts` | **Functional (Evolved).** Type contracts are maintained directly alongside the query preparation wrappers. |
| `src/db.ts` | `src/db.ts` | **Complete.** Built with `better-sqlite3`, transactional safety hooks, and automatic database migration pathways. |
| `src/server.ts` | `src/mcp-server.ts` | **Complete.** Operational standard I/O MCP host exposing codebase analysis and manipulation utilities to IDE clients. |
| `src/dashboard.ts` | `src/dashboard.ts` | **Complete.** High-throughput monitoring stream engine backed by Express and high-frequency Server-Sent Events (SSE). |
| `src/index.ts` | *Pending Realignment* | **Missing Entrypoint.** Tasks are currently decoupled via script entries (`npm run mcp`). |

---

## 5. Phase 2 Execution Plan: CLI Interface Realignment

To tie the structural advantages of `synapse-bus` into a singular client bin executable, the immediate integration task wraps `mcp-server.ts` and `dashboard.ts` under a command line interface runner.

### Step 1: Implementation of Entrypoint Pointers (`src/index.ts`)

```typescript
import { Command } from 'commander';
import { startMcpServer } from './mcp-server';
import { startDashboard } from './dashboard';

const program = new Command();

program
  .name('synapse')
  .description('Synapse CLI: Terminal-First Multi-Agent Orchestrator')
  .version('2.0.0');

program
  .command('start')
  .description('Start the Synapse Core Daemon (MCP Server + S-Deck Dashboard)')
  .option('-p, --port <number>', 'Dashboard telemetry visualization port', '3000')
  .action((options) => {
    console.log('🚀 Initializing Synapse Core Daemon...');
    
    // 1. Boot up the SSE Visualization Web Interface
    startDashboard(Number(options.port));
    
    // 2. Attach the MCP Host standard IO streams to parent standard streams
    startMcpServer();
  });

program.parse(process.argv);

```

### Step 2: Distribution Configurations (`package.json`)

Expose the binary hook globally across local terminal sessions:

```json
{
  "name": "synapse-bus",
  "version": "2.0.0",
  "main": "./dist/index.js",
  "bin": {
    "synapse": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "start": "tsx src/index.ts start"
  }
}

```

*Executing `npm link` registers the global `synapse` terminal alias.*
