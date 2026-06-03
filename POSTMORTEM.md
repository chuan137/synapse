# Synapse v2 — 问题总结 & v3 设计方向

## 已知 Bug

### 1. `agent.env` 竞争条件
MCP server 启动时把自己的 agent ID 写进 `.synapse/agent.env`：
```typescript
writeFileSync(join(SYNAPSE_DIR, 'agent.env'), `SYNAPSE_AGENT_ID=${AGENT_ID}\n`, 'utf8');
```
多进程同时跑时（orchestrator + workers），最后启动的进程覆盖文件。hook 读到的 agent ID 是错的，消息上报到别人身上。

**Fix：** hook 改用 `CLAUDE_CODE_SESSION_ID` 环境变量直接查 DB：
```bash
AGENT_ID=$(sqlite3 "$DB" "SELECT agent_id FROM agent_status WHERE session_id='$CLAUDE_CODE_SESSION_ID' LIMIT 1;")
```

---

### 2. `read_messages` 的隐式副作用
`mcp-server.ts` 第183行：
```typescript
if (name === 'read_messages') {
  updateStatus(AGENT_ID, 'idle', null, agentName || null, null);  // 强制重置状态
```
调一次 `read_messages` 就把状态改成 `idle`，不管 agent 当时在不在工作。工具语义不干净。

---

### 3. `spawn_agent` 阻塞轮询
```typescript
for (let i = 0; i < 30; i++) {
  spawnSync('sleep', ['0.5']);   // 最多等15秒
  const latest = getLatestAgent();
  if (latest && latest.slot > slotsBefore) { worker = latest; break; }
}
```
用最新 slot 判断 worker 是否注册成功，不可靠（如果有其他进程同时注册会误判）。且会阻塞 MCP 响应15秒。

---

## Hook 架构问题

### 4. `SubagentStop` hook 对 Synapse workers 无效
Synapse 用 `tmux new-window` 启动 worker，它们是独立的 Claude Code 进程。`SubagentStop` 只对通过 Claude Code 原生 `Task` tool 派生的 subagent 触发，跟 Synapse worker 没有关系。

**Fix：** 用 worker 自己的 `Stop` hook 上报状态，不从 parent 捕获。

---

### 5. `mcp_tool` hook type 不存在
Claude Code hooks 只支持 `type: "command"`。`mcp_tool` 类型是假设存在的，实际不支持。`synapse init` 写进 settings.json 的也只有 `command` 类型。

---

### 6. PostToolUse hook 只用来检查未读消息
当前 hook 只做了一件事：查未读消息数量，提示 Claude 去读。Tool call 的详情（工具名、输入、输出、耗时）完全没有记录。这是最大的观察盲区。

---

## 设计层面的局限

### 7. 没有 Run / Workflow 概念
Schema 只有 `agent_status` + `messages`，能知道每个 agent 现在的状态，但无法回答：
- 这次 workflow 执行了哪些步骤？
- 哪个 agent 做了什么、花了多少时间？
- 整个 pipeline 的执行链路是什么？

---

### 8. Tool call 没有记录
`PostToolUse` hook 有完整的工具调用上下文（工具名、输入、输出），但当前实现完全忽略了。这是 workflow 内部状态可观察性的核心数据源。

---

### 9. Dashboard 全量轮询
`dashboard.ts` 每500ms `getAllStatuses()` + `getRecentMessages(200)` 全量拉，靠 JSON 字符串对比检测变化。数据量大时有性能问题，且不支持增量事件流。

---

## v3 设计方向

**核心模型：分布式 Tracing（借鉴 OpenTelemetry）**

```
Run     ── 一次 workflow 执行
 └── Span  ── 单个 agent 的工作段
      └── Event ── tool call、状态变更、handoff（由 hook 自动写入）
```

**Schema（精简）：**
```sql
runs   (run_id, name, status, started_at, ended_at)
spans  (span_id, run_id, parent_span_id, agent_session_id, role, name, status, summary, started_at, ended_at)
events (id, span_id, type, name, input_json, output_json, duration_ms, ts)
```

**MCP tools（4个）：**
- `create_run(name?)` → run_id
- `join_run(run_id, role, name?, parent_span_id?)` → span_id
- `finish_span(span_id, status, summary?)`
- `get_pipeline(run_id)` → 全局状态树

**Hooks 职责：**
- `PostToolUse` → 自动写 event（工具名、输入、输出、耗时）
- `Stop` → 自动 finish_span（兜底，agent 忘记调用时）

**Hook agent 身份识别：**
```bash
# 不用 agent.env，用 session_id 查 DB
SPAN_ID=$(sqlite3 "$DB" "SELECT span_id FROM spans WHERE agent_session_id='$CLAUDE_CODE_SESSION_ID' LIMIT 1;")
```

**Agent 间协调：**
去掉 `messages` / `send_message`，改用 Claude Code 原生 `Task` tool。Synapse 专注观察，不做通信总线。
