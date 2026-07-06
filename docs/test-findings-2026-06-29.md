# Synapse 测试发现 — 2026-06-29

主导测试者：Claude（基于代码审查 + 真实 `.synapse/synapse.db`（run 1–8）的取证分析）。
注意：实时浏览器 / tmux 测试**未能进行**——测试时 UI server（:53380）已挂掉，且我无法向你的
Terminal 输入命令（沙箱与你的 Mac 隔离）。需要你拉起服务后我才能继续实测（见末尾）。

---

## 0. 核心结论（先看这个）

老版本（v0）和新版本最根本的差别，正是“消息送不到指定位置”的根因：

| | v0（长程） | 当前版本（ephemeral） |
|---|---|---|
| 通信机制 | **MCP 工具**：agent 主动 `read_messages` / `send_message` / `update_status` | **tmux 注入**：monitor 用 `tmux send-keys` 把命令“打字”进终端 |
| 投递模型 | **拉（pull）**——agent 准备好时主动取信，必达 | **推（push）**——monitor *猜* agent idle 后注入键盘 |
| idle 判定 | agent 显式上报 `update_status` | 从 transcript jsonl 的 `stop_reason` + debounce **推断** |
| 可靠性兜底 | hooks（guard/event）、health-monitor、eval/critic gate、nudge | 基本没有；投递失败即终态 |

新版“推 + 推断 idle + 键盘注入”这条链路，每一环都可能错位，这就是为什么消息会送错地方。
拉模型（v0）天然不会有这个问题——agent 没准备好就不取信，准备好了一定取得到。

---

## 1. 致命 Bug：发给 operator 的消息永远送不到（已坐实）

**证据**：8 个 run 里，所有 `to_agent='operator'` 的消息**无一例外全是 `pending`**（14/14），
从来没有一条被标记 delivered / read。

**根因**（`src/commands.ts`）：monitor 的投递只有一条路——`tmuxSendKeys(session, window, body)`，
即把消息打进某个 **tmux 窗口**。而 operator 是“人”，不是 tmux 窗口（`shared.md` 自己也写了
“operator … Not a tmux window”）。投递循环里还显式 `if (agent.window_name === "operator") continue;`。
所以发给 operator 的消息根本没有任何投递代码路径，只能靠 UI 去“顺便显示”。

**现场复现**（run 8，你今天的真实对话）：
- #51 operator→manager TASK「新建一个任务」 → delivered
- #52 manager→operator INFO「收到任务 #51。请问『新建一个任务』具体指什么？」 → **pending，永远没回到你这**
- #53 operator→manager TASK「你看一下老的 V0 的代码…」
- #54 operator→manager TASK「**没有把你的问题发回给我**」 ← 你当场就在抱怨这个 bug
- #55 operator→manager TASK「…你不能决定的时候，你要把问题发回给 operator…」

manager 其实**正确地**把澄清问题发出来了（#52），是这条消息根本没机制送达人类。

**你早就发现过同一个问题**：run-2 的 #13（一条 `failed` 消息）就是你写的：
“the message sent to UI/operator should be marked as read? or we stop tracking the message to operator? all are shown in UI”。

### UI 这条“兜底显示”链路也很脆
即便 UI 开着（`src/ui.ts`）：
- `pollDb()` 每秒只扫 `status='running'` 的 run——run 一旦 `completed`，**之后**发给 operator 的新消息
  再也不会被 push（最终汇报最容易踩这个）。
- 用 per-run `lastMessageId` 游标 + 客户端 `selectedRunId` 匹配来决定要不要渲染；没有持久化的
  “已读/已送达”状态，没有提示音/角标以外的提醒。UI 没开、选错 run、游标先被另一个 poll 推进，
  任一情况这条消息就静默丢失。

**建议**：给 operator 投递一个真正的“投递语义”。最小改法——monitor（或一个专门的 operator
投递器）把发给 operator 的 pending 消息标记为 `delivered`，并由 UI 维护持久 `read` 状态 +
未读提醒；UI 的 `pollDb` 不要只扫 running run。根上更稳的是回到 v0 的**拉模型**（见 §0）。

---

## 2. Run 结束后 manager 卡在 busy / 团队不拆除（已坐实）

**证据**：run 4、run 8 状态是 `completed`，但其 manager 的 `status` 仍是 `busy`；其余 run 的
manager 是 `stopped`（正常拆除）。

**根因**：`cmdDone` 把 run 标为 completed 后，monitor “remains active until UI ACK”——团队拆除
（kill 窗口 + kill tmux session）**只由 UI 的 ack-run 触发**。但 §1 里 operator 根本看不到完成
汇报，自然不会 ack；加上 UI 此刻还可能没开。于是：run 完成 → 没人 ack → 永不拆除 → manager
永远 busy。这是个会自锁的状态机：拆除依赖一个本身就送不到的信号。

**建议**：terminal run 应有兜底自动拆除（超时 / 或 `synapse done` 直接触发拆除），不要把唯一的
teardown 触发器绑死在“人类在 UI 上点确认”。

---

## 3. tmux 键盘注入对多行 / 长消息不可靠（已坐实）

**证据**：唯一一条 `failed` 消息 #13（run-2）就是 operator 从 UI 发的、带换行的多行 TASK，
`tmux send-keys` 失败 → 直接标 `failed`，且**无重试**（`dispatchDirectMessage` 注释自己写了
“Delivery failures are terminal in v1”）。

`shared.md` 警告 agent 别发长 body、要用文件指针——但这约束**管不到 operator 从 UI 发的消息**。
人在输入框里一粘贴多行就触发。键盘注入对引号、长度、换行天然脆弱。

**建议**：UI `/send` 对 body 做约束 / 自动转文件指针；投递失败要可重试（加 retry_count /
next_retry_at），而不是一次失败即终态。

---

## 4. Harness 的“强制回信”机制从未生效（值得查）

`enforceSendBackBeforeMoreWork` 会以 `from_agent='harness'` 注入提醒，逼 coder/reviewer 在
开新活前先回 STATUS。但 8 个 run 里 `from_agent='harness'` 的消息**一条都没有**。要么是 coder
每次都恰好规范回信，要么是这条增强路径根本没被触发（idle 判定/时序没对上）。这正是你说的
“harness 还不够强”的一个具体抓手——建议加日志确认它到底有没有跑。

---

## 5. 杂项 / 卫生问题

- `.synapse/` 里有个 0 字节、文件名是一整条 SQL 的文件：
  `SELECT body,status FROM messages WHERE to_agent='coder-1' ORDER BY id DESC LIMIT 1`
  ——某次 shell 重定向手滑造成的，应删。
- `.synapse/` 累积了 6 个 `monitor-run-*.pid`，说明多次 monitor 没干净退出（残留锁文件）。
- 测试时 UI(:53380) 进程已死，但 run-8 还“等 UI ACK”——服务进程不够 resilient。
- v0 有 hooks / health-monitor / eval-gate / 远程(Telegram) 等大量可靠性机械，当前版本几乎都没移植，
  这是“成熟度差距”的结构性来源，不只是 prompt 写得不够。

---

## 6. 优先级建议

1. **P0** 修 operator 投递（§1）——这是“消息送不到”的直接根因，且自锁了 §2。
2. **P0** terminal run 兜底拆除（§2）——解开 manager 卡 busy。
3. **P1** 投递失败重试 + UI 发送做长度/多行约束（§3）。
4. **P1** 确认并修复 harness 强制回信（§4）。
5. **P2** 清理 .synapse 垃圾文件 / pid（§5）；考虑把 v0 的拉模型或 health-monitor 思路移植回来。

---

## 7. 还需要你配合才能做的实测

我无法向你的 Terminal 打字（沙箱隔离 + Terminal 是只读/只可点击层级）。要继续做你要的
**浏览器实测 + tmux/monitor 实测**，请你在 synapse 目录里起：
- `make build && ./bin/synapse ui`（拉起 :53380 UI）
- 再 `./bin/synapse start templates/task.example.yml --goal "<随便一个任务>"` 起一个新 run

起好告诉我，我就接着在浏览器里点选 run / 发消息 / 看 SSE，并用 DB 交叉验证消息有没有真的送到。

---

## 8. 实测补充 — live run #9（浏览器 + 真实 agents 实跑）

通过 UI 的 + New Run 起了 run-9，goal 故意要求 manager 先向 operator 确认范围。实跑结果：

- **operator 投递 bug 实时复现**：manager 发出 #58（manager→operator INFO「确认范围…」），
  UI 里**确实显示了**这条（所以不是完全看不到），但 DB 里它始终是 `pending`，agent strip 上
  operator 的未读角标一直是 `1` 清不掉——**没有任何"已送达/已读"语义**。结论修正：消息不是
  "完全送不到 UI"，而是"没有投递语义 + 渲染弱 + SSE 不稳"三者叠加导致人容易漏。
- **harness 强制回信这次触发了**：#61 `harness→reviewer`「Harness enforcement: your previous
  REVIEW #60 has ended without a STATUS reply」。证明该机制可用，只是前 8 个 run 没被触发。
  （措辞 bug：对"收到 REVIEW"的 reviewer 说"your previous REVIEW"，主语错位，建议改文案。）
- **instruction 遵循 gap**：goal 明确要求 manager "等 operator 回复后再继续"，但 manager 没等，
  直接 #59 派活给 coder-1。说明"等待人类回复"这种控制流，当前 prompt 约束不住。
- **UI 在 live run 下不稳**：跑起来后顶栏从 live 变红色 `reconnecting`，随后 operator 在 UI 里
  回复 manager 时，`/send` 直接报 **`TypeError: Failed to fetch`**（连点两次都失败，消息没发出）。
- **monitor 崩溃 + run 冻结（最严重）**：`monitor.log` 抓到真实崩溃
  `SQLiteError: disk I/O error at terminalRunStatus → sweep`。monitor 一死，整个 run 就**冻住**：
  #58/#63 等 pending 消息再没人投递，agents 在 tmux 里干等，UI 还显示 "live" 但毫无进展，
  **没有任何自愈/重启**。重启 UI 后 run-9 还被误判为 "Run ended — read only"，连补发指令都做不到。
  → 单点崩溃 = 整 run 报废，这是 harness 健壮性的最大短板。

  ⚠️ 诚实备注：这次 `disk I/O error` 很可能是**我的测试方式**引入的——我从沙箱（另一台机器/挂载）
  反复打开 WAL 模式的 live DB，SQLite 明确不支持跨机/跨文件系统并发访问，read 报 disk I/O error
  是其典型症状。已停止从沙箱碰 DB。要确认它是否会自行复发，需在我不碰 DB 的情况下重启 monitor 重跑。
  但"monitor 一崩 run 就冻死且不自愈"这条结论与崩溃成因无关，独立成立。
