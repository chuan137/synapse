# UI Multi-Run Spec

## Goal

让 operator 在同一个 UI 里同时管理多个并行的 run，每个 run 有独立的 task、独立的 agent team 和独立的消息线程。UI 不需要重新加载就可以在 run 之间切换，也可以同时看到多个 run 的状态。

---

## 核心概念

| 概念 | 当前 | 目标 |
|---|---|---|
| Run | UI 只追踪一个 activeRun | UI 可感知所有 running/recent run |
| Thread | 一个全局 operator thread | 每个 run 一个独立的 thread，互不污染 |
| Agents panel | 显示当前 run 的 agents | 按 run 分组展示，或切换 run 后刷新 |
| Compose | 固定发给 manager | 发给当前选中 run 的 manager |
| `/events` SSE | 服务端只推当前 activeRun 数据 | 服务端推所有 running run 数据，客户端按 run_id 过滤展示 |

---

## 布局

```
┌─────────────────────────────────────────────────────────────────┐
│  SYNAPSE  ● live                                          ☀︎    │  ← header (不变)
├──────────────┬──────────────────────────────────────────────────┤
│  Runs        │  ┌──────────────────────────────────────────┐    │
│  ──────────  │  │ run #3 · run-3 · [running]               │    │
│  ● run #3  ◀─┼─▶│ Implement feature X                      │    │  ← thread panel header
│    run-3     │  │ 2 agents  3 pending                      │    │    shows selected run metadata
│              │  └──────────────────────────────────────────┘    │
│  ○ run #2    │  ┌──────────────────────────────────────────┐    │
│    run-2     │  │ Agents                                   │    │
│    [done]    │  │  ● manager  idle  ○ coder  busy          │    │  ← agents strip (horizontal,
│              │  └──────────────────────────────────────────┘    │    compact, inside thread panel)
│  + New Run   │  ┌──────────────────────────────────────────┐    │
│              │  │ messages…                                │    │  ← messages list (largest area)
│              │  │                                          │    │
│              │  │                                          │    │
│              │  └──────────────────────────────────────────┘    │
│              │  ┌──────────────────────────────────────────┐    │
│              │  │ compose (send to selected run's manager) │    │
│              │  └──────────────────────────────────────────┘    │
└──────────────┴──────────────────────────────────────────────────┘
```

**Runs sidebar (左侧，140px)**
- 列出所有 run，按 id 倒序（最新在上）
- 每条显示：状态点 + `run #N` + session 名 + `[status]`
- 点击切换选中 run → 右侧 thread/agents 随之切换
- 默认选中最新的 running run（或最近的 run）
- `+ New Run` 按钮：打开 start-run 面板（Phase 2 实现，Phase 1 可以省略）
- running run 的状态点持续 pulse；completed/failed 用静态灰点

**Thread panel (右侧，剩余空间)**
- 顶部 header：展示选中 run 的 goal（截断到 80 字符）+ status badge
- Agents strip：横向紧凑排列当前 run 的 agents，每个显示 name + 状态点 + pending badge
- Messages list：只显示当前选中 run 的 operator thread 消息
- Compose：发送 TASK 给当前 run 的 manager；run 已结束时 compose 变灰并提示

---

## 数据模型变更（后端）

### 新增 `/runs` API endpoint

```
GET /runs
→ { runs: [ { id, session, status, goal, started_at, ended_at } ... ] }
  按 id DESC，最多返回最近 20 条
```

### SSE 事件扩展

**现有事件**调整为携带 `run_id`：
- `agent-status` → `{ run_id, agents: [...] }`（已按 run_id 分组）
- `operator-thread` → `{ run_id, run, messages: [...] }`（现有结构已有 run）
- `message-stream` → message row（现有结构已有 `run_id` 字段）

**新增事件**：
- `runs-list` → `{ runs: [...] }` — 每次 pollDb 都推送，客户端用来维护 runs sidebar

### `pollDb` 变更

当前 `pollDb` 只处理 `activeRun()`。改为：

1. 查询所有 `status='running'` 的 run（上限 10 个）
2. 对每个 running run 推送 agent-status 和新消息
3. 推送 runs-list（包含所有 run，不只是 running 的）

`lastMessageId` 改为 `Map<runId, lastMsgId>` 以分别追踪每个 run 的游标。

---

## 前端状态

```js
const state = {
  runs: [],          // from runs-list event
  selectedRunId: null,
  agents: new Map(), // runId -> agents[]
  messages: new Map(), // runId -> messages[]
  seenMsgIds: new Set(),
};
```

切换 run：
1. 更新 `selectedRunId`
2. 渲染 agents strip（从 `state.agents.get(runId)`）
3. 渲染 messages list（从 `state.messages.get(runId)`）
4. 更新 thread header
5. compose 按选中 run 的 manager 名发送

初始加载：
- 连接 SSE → 接收 `runs-list` 后自动选中第一个 running run
- 接收 `operator-thread` 后填充该 run 的初始 messages
- 此后 `message-stream` 事件增量追加到对应 run 的 messages

---

## `/send` endpoint 变更

新增 `run_id` 字段（可选，不传时行为不变）：

```json
POST /send
{ "to": "manager", "type": "TASK", "body": "...", "run_id": 3 }
```

后端用 `run_id` 来查 agent registry（`WHERE window_name=? AND run_id=?`）并写入消息。

---

## 实现阶段

### Phase 1 — 多 run 视图（本 spec 范围）

- [ ] 后端：添加 `/runs` GET endpoint
- [ ] 后端：`pollDb` 改为多 run 模式，`runs-list` 事件，`agent-status`/`message-stream` 携带 `run_id`
- [ ] 后端：`/send` 接受并使用 `run_id`
- [ ] 前端：runs sidebar
- [ ] 前端：thread panel 响应 run 切换
- [ ] 前端：agents strip（横向，替换左侧竖向 agents panel）
- [ ] 前端：compose 按 run 路由

### Phase 2 — 从 UI 启动新 run（out of scope for now）

- `+ New Run` 按钮，上传 task.yml 或填写 goal，调用后端 `/start` endpoint
- 这需要把 `cmdStart` 的逻辑暴露为 HTTP API

---

## 不变的部分

- SSE 连接机制（EventSource + reconnect）
- Markdown 渲染（marked + DOMPurify）
- 主题切换（dark/light）
- 消息行样式（`.message-row` 等 CSS 类）
- `synapse start` CLI 工作流不受影响

---

## 关键约束

- `agents.run_id=0` 是 operator 哨兵，UI 的 agents strip 需要 `WHERE run_id=? OR run_id=0`（已有）
- 多个 running run 并发时，每个 run 独立计 `lastMessageId`，防止消息跨 run 漏推或重复
- 已结束（completed/failed/aborted）的 run 保持只读可查看，compose 禁用
- runs sidebar 最多显示 20 条（最近的），避免 DB 全表扫描
