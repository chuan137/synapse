# Synapse Team Bootstrap — 设计 Spec

状态：14 项决策全部拍板，可进入实现。本文把每个问题的可选方案摊开、做对比；决策见下方「决策记录」与「待拍板清单」表，实现要点见「实现概要」。

## 决策记录

- **问题一 → B1（三段式组装 + 落盘到 per-agent 文件夹）。** 独立文件夹已实现，沿用之；`synapse start` 把共享/角色/实例三段拼好后写入 `<cwd>/CLAUDE.md`。连带 #2 = 保留 per-agent 文件夹。剩余子决策见 #3/#4/#5。
- **#4 实例块来源 → task.yml 字段（手动）。** 角色与分配内容（谁负责 backend/frontend 等）在组装 task.yml 时手动写进字段，start 读取后填进实例块。
- **#5 CLAUDE.md 生成策略 → 覆盖（幂等）。** 每次 `synapse start` 用三段式重新拼装并覆盖 `<cwd>/CLAUDE.md`，不追加。保证可重复运行结果一致、无残留累积。
- **角色边界 → manager 是唯一接口、每 session 恰一个。** 任务一次性、流程固定，operator 只跟 manager 打交道；manager 合并规划与问责职责（4 角色不变）。**不再引入 orchestrator 概念。** 角色定义在 task.yml、**流程定义在 CLAUDE.md（#14）**（共享块=公共流程，角色块=各角色步骤）。详见「角色边界」节。
- **生命周期（问题四）全部拍板：** #8 显式 `synapse done`、#9 monitor 自动解散（人工兜底）、#10 加 `runs` 表、#11 每 run 唯一 session 名 `run-<id>`。manager 干完根任务 → `synapse done` 写终态 → monitor 落定末条消息、kill 各 window、自身退出、kill session；DB/audit 保留。
- **问题二 → 极简第一脚（覆盖了早先的 D 方案）。** 触发指令保持极简，如 `synapse pending <name>`：agent 一被踢就去 DB 拉自己的 pending 消息，真正的任务内容始终走 `messages` 表（operator→manager TASK），不塞进触发指令本身。这与「问题三·职责划分」一致——“怎么做”静态注入、”做什么”从 DB 取、第一脚只负责”开始取”。
- **#7 第一脚通道 → `claude` 启动时初始 prompt。** 把 `synapse pending <name>` 作为启动参数传给 `claude`，加载完成即自动执行，**无需外部猜时机**——可移除现有 nudge `hi`（硬编码 3 秒）与 transcript 轮询凑时机的逻辑。实现影响：`launchAgentWindow` 的启动命令从 `claude --session-id <id>` 改为 `claude --session-id <id> "synapse pending <name>"`。

关联：`docs/synapse-spec.md` §6.1（定义团队）/ §6.2（启动团队）。本文是对那两节里两个被一笔带过的环节——“每个 cwd 有自己的 CLAUDE.md”和“启动后谁来踢第一脚”——的展开。

## 背景：现状与痛点

`synapse start task.yml` 当前做的事（见 `src/synapse.ts` `cmdStart`）：

1. `init` DB，注册 `operator` 伪 agent。
2. 建 tmux session，每个 agent 一个 window，window 里 `cd <cwd> && claude --session-id <uuid>`。session-id 由 synapse 预先生成并传入，所以启动前就知道。
3. 在 `monitor` window 起监控进程。
4. 若带 `--goal`，把目标作为一条 `operator → manager` 的 `TASK` 写进 `messages` 表。

注入”第一脚”靠的是 monitor：manager 空闲时，monitor 通过 `tmux send-keys` 把那条 TASK 的 body 打进 window。代码里还有一个细节——为了触发第一份 transcript jsonl，start 会在 3 秒后向 window `send-keys “hi”` 做 nudge（`waitForSessionId` 中）。

两个痛点：

- **CLAUDE.md 手写、难维护。** 每个 `.synapse/<agent>/CLAUDE.md` 是手写的，共享协议（synapse 命令、ref_id 规范、DB 路径）和角色专属内容混在一起，四份文件里重复抄。
- **触发时机脆弱。** 除 manager 外的 agent 启动后停在空提示符等输入；manager 的第一脚依赖”monitor 恰好在它空闲时投递”，而 nudge / 投递 / Claude Code 加载完成之间的时序并不稳。

---

## 角色边界：manager 是唯一接口

三个前提把角色关系定死了：

- **任务一次性（ephemeral）**：一个 team 只为一个根任务存在，干完即解散（问题四）。
- **流程固定**：TASK/STATUS 走 manager 的 hub-and-spoke、REVIEW 点对点、完成发 `synapse done`——这套协作流程对所有团队都一样，不随任务变。
- **manager 是唯一接口**：operator **只跟 manager** 打交道。manager 是这支队伍对其唯一任务的单一问责人——接根 TASK、用 ref_id 跟踪完成度（DB 为准）、判定完成/失败、发 `synapse done`、是解散信号的来源。每个 session 有且仅有一个 manager（#12）。

**manager = 唯一接口、单一问责人。** manager 是这支队伍对其唯一任务的单一问责人——接根 TASK、用 ref_id 跟踪完成度（DB 为准）、判定完成/失败、发 `synapse done`、是解散信号的来源。每个 session 有且仅有一个 manager（#12）。manager 既规划（拆子任务、分给 coder）又问责，4 角色不变。改名消除”manager 只管规划”的误读（早先的混淆正源于此名）。拆分成两角色留待”规划本身大到值得独立”时再说。

**不再引入 orchestrator。** 既然任务一次性、流程固定、task.yml 手动组装、manager 又是唯一接口，就没有一个“站在 team 之上自动造队伍”的独立角色的位置——此前的 orchestrator 说法去掉。

**角色 vs 流程，分别落在哪（#14，已定）：**
- **角色**——哪些角色、谁担任、各自 focus——在 `task.yml` 决定。
- **流程**——那套固定的协作步骤——放 **CLAUDE.md**，不进 task.yml 字段：它是个**常量**，对每个团队都一样。跨角色的公共流程进三段式的**共享块**，每个角色自己的步骤进**角色块**。改用 task.yml 字段等于把同一段常量抄进每个团队文件，纯增重复。

## 问题一：角色指令从哪来、以什么形式送到 agent

这其实是两个正交的维度，现状把它们绑死在“一份手写文件”里，拆开看选项更清楚：

- **维度 A——内容怎么组装**（三段式 vs 手写）
- **维度 B——以什么载体送达 agent**（落盘文件 vs 启动参数 vs 运行时查询 vs 对话消息）

### 维度 A：内容组装

目标是把每个 agent 的指令拆成三段、由 `synapse start` 拼装，而不是手写整份：

1. **共享块**：团队结构、synapse 命令协议、ref_id 规范、DB 路径约定。全队一份，改一处全员生效。
2. **角色块**：该角色的职责与工作流（manager / coder / reviewer 各不同）。每个角色一份。
3. **实例块**：该**具体某个 agent**（而非某类角色）独有的配置。区别于角色块——角色块对”所有 coder”都一样，实例块把同角色的不同实例区分开：coder-1 负责 backend、coder-2 负责 frontend，就是它们各自的实例块。每个 agent 一份、最短；对只有单一实例的角色（manager / reviewer）实例块可为空。

三段的粒度：**共享块**全队 1 份 → **角色块**每个角色 1 份（同角色复用）→ **实例块**每个 agent 1 份（区分同角色实例）。例：coder-1 的 CLAUDE.md = 共享块 + coder 角色块 + “你负责 backend、Bun HTTP server”实例块。

三段式只是“内容如何来”，与“最终以什么形式交给 agent”无关——下面维度 B 的每个方案都可以消费这套三段式拼装结果。

待决策（维度 A 内部）：

- **模板存哪**：`templates/shared.md` + `templates/role-<role>.md` 独立目录 vs 内嵌进 `task.yml`（如 `roles:` 段）。独立目录利于版本管理和 diff；内嵌让“一个团队=一个文件”更自洽。
- **实例块来源**：`task.yml` 里给每个 agent 加字段（如 `instructions:` 或 `focus: backend`）vs 每个 agent 一个单独文件。字段适合一两行的差异；文件适合长内容。

### 维度 B：送达载体 ← 这是“是否一定要把文件写到磁盘上”的核心

现状是“写一份完整 CLAUDE.md 到每个 agent 文件夹”。这不是唯一办法。Claude Code 提供了几条不落盘或少落盘的注入路径，可选项如下：

**选项 B1：每个 agent 文件夹一份 CLAUDE.md（现状，可改为 start 时生成）。**
start 把三段式拼好，写进 `<cwd>/CLAUDE.md`，Claude Code 启动时自动读取。
- 优点：可在磁盘上查看/手改；`--resume` 重启天然还在；调试时一眼能看到 agent 当时拿到的指令。
- 缺点：在用户仓库里铺一堆生成文件，需要管理“覆盖还是追加”“是否纳入 .gitignore”“收尾要不要清理”；三段式的真相被复制成 N 份落盘副本。

**选项 B2：`--append-system-prompt` 启动时注入，不落盘。**
start 把拼好的角色+实例文本，作为参数传给 `claude --append-system-prompt "<text>"`，叠加在 Claude Code 默认系统提示之上；共享块仍可用一份项目级 CLAUDE.md 承载。
- 优点：每个 agent 的角色指令零落盘；三段式拼装结果只存在于启动命令里，没有要清理的生成文件。
- 缺点：磁盘上看不到、不能手改；`--resume` 时必须重新传一遍（不会自动续上）；命令行变长，文本里的引号/换行要转义；与 CLAUDE.md 的优先级/叠加关系需实测确认。
- 备注：`--system-prompt` / `--system-prompt-file` 会**替换**整个默认系统提示，一般不用；要叠加就用 append 变体。

**选项 B3：一份共享 CLAUDE.md + 运行时角色查询。**
全队共用一份 CLAUDE.md（甚至就放仓库根），内容是“你是 synapse 团队的一员，启动后先跑 `synapse whoami` / 读 `task.yml` 里你这一行，按返回的角色行事”。agent 靠已注入的 `$SYNAPSE_AGENT` 环境变量认出自己（start 已经在传这个 env），角色/实例内容作为**数据**留在 `task.yml` 或 DB 里，运行时拉取。
- 优点：磁盘上只有一份文件；角色内容单一真相源（task.yml / DB），不复制；新增角色只改数据不碰文件。
- 缺点：多一跳运行时调用，依赖 agent 真去执行那条查询（落在“问题二：触发”上）；需要新增 `synapse whoami <name>` 子命令吐出角色指令。

**选项 B4：作为首条对话消息注入（与问题二合流）。**
不进系统提示，直接把角色指令当作第一条用户消息 `send-keys` 进去（或 `claude "<指令>"` 作为初始 prompt）。
- 优点：和“踢第一脚”用同一条通道，少一套机制。
- 缺点：占对话上下文而非系统提示，长指令会一直留在 history 里；多轮 `--resume` 后不易复现。

对比速览：

| 方案 | 落盘 | 单一真相源 | --resume 自动续 | 可手改/可见 | 需新增机制 |
|------|------|-----------|----------------|------------|-----------|
| B1 文件夹 CLAUDE.md | 是(N份) | 否 | 是 | 是 | 生成+清理 |
| B2 append-system-prompt | 否 | 是 | 否(需重传) | 否 | 文本转义 |
| B3 共享+运行时查询 | 一份 | 是 | 是 | 部分 | `synapse whoami` |
| B4 首条消息 | 否 | 是 | 否 | 否 | 复用问题二 |

### 顺带：agent 一定要各自的文件夹吗？

“各自文件夹”当前承担两件事：(1) 作为 cwd 决定 Claude Code 的 project slug → transcript jsonl 路径（monitor 用它做空闲检测）；(2) 放各自的 CLAUDE.md。

但 transcript 实际是按 **session-id** 分文件的（`<slug>/<session-id>.jsonl`），而 synapse 已经用 `--session-id` 给每个 agent 指定了唯一 id。也就是说，即便多个 agent 共用同一个 cwd，它们的 transcript 仍按 session-id 各自成文，monitor 仍能区分。

推论：**如果采用 B2/B3/B4（CLAUDE.md 不再每文件夹一份），per-agent 文件夹就不再是技术必需**，可以让所有 agent 都从仓库根启动，仅靠 `--session-id` + `$SYNAPSE_AGENT` 区分。保留独立文件夹此时只剩“给每个 agent 一个干净 cwd / 工作区隔离”的便利价值，是取舍而非约束。这一点值得和维度 B 一起拍板。

---

## 问题二：初始指令如何触发（“踢第一脚”）

现状：agent 启动后停在空提示符等输入，没有“启动即自动执行”。核心约束是 **Claude Code 目前没有“启动时自动跑某条指令”的原生钩子**，所以触发要么靠外部打字，要么靠 agent 自己读完指令后主动行动。

**方案 A：`tmux send-keys` 直接打入 window（现状思路的强化）。**
start / monitor 等 Claude Code 加载完成后，把初始 prompt（可以很简单，如 `synapse pending <name>`）send-keys 进去。
- 优点：最直接、已验证可行（monitor 投递 TASK 走的就是这条路）。
- 缺点：时机难控——必须等 Claude Code 完全加载才能发，发早了丢键。现有 nudge `"hi"`（3 秒）就是在硬编码这个时机，脆。需要更可靠的“就绪信号”（如轮询 transcript 首行出现，再发）。

**方案 B：在 CLAUDE.md 里加 `## On Start` 段，让 agent 读完自行执行。**
依赖 Claude Code 启动后是否会“主动开干”。
- 优点：零外部时序，纯靠指令。
- 缺点：Claude Code 读完 CLAUDE.md 默认仍停在提示符等输入，不保证自动迈步；行为不稳定，需实测。

**方案 C：`task.yml` 加 `init_prompt` 字段，start 读取后注入。**
把“第一脚的内容”从代码/CLAUDE.md 里抽到配置。注入仍走 A（send-keys）或作为初始 prompt。
- 优点：每个 agent 的初始动作可配置、可见；与“目标=TASK”机制解耦。
- 缺点：只是把“内容来源”配置化，没解决 A 的时机问题——仍要叠在 A 之上。

时机问题（贯穿 A/C）：可靠的就绪判定建议不靠固定 sleep，而靠**轮询该 agent 的 transcript 是否已出现首行**（start 里已有 `waitForSessionId` 在等新 jsonl，可复用同一信号），出现后再发第一脚。

---

## 问题三：三者的职责划分

把三件事各归其位，能让上面两个问题的方案自然咬合：

- **CLAUDE.md / 角色指令（问题一）描述“怎么做”**——协议、职责、工作流。静态。
- **初始指令（问题二）触发“开始做”**——可以极简，如 `synapse pending <name>`，让 agent 自己去取任务。
- **`task.yml` 定义“做什么”**——团队构成、每个 agent 的 `focus`/实例配置，以及（可选）`goal` / `init_prompt`。

这个划分下，第一脚的内容可以非常薄：agent 一被踢，就去 DB 拉自己的 pending 消息，真正的任务内容走既有的 `messages` 表（operator→manager TASK）流转，而不必把任务塞进系统提示。这也正好让问题一的 B3/B4 更顺——“怎么做”静态注入一次，”做什么”始终从 DB 取。

---

## 问题四：团队生命周期（team = 一个任务）

模型：当前没有“任务”这个一等概念。约定 **一个 team ⟷ 一个根任务**——每开一个新任务就 `synapse start --goal` 拉起一支队伍，这支队伍只为这一个任务存在；任务完成，队伍自动解散。要定义的环节：

**(1) 完成信号——什么算“做完”。** 根任务是 `operator → manager` 的 TASK（ref_id null），做完的标志是 **manager（责任者）** 给出终态。但 STATUS 既表“进度”也表“完成”，需把“完成/放弃”这个终态显式化，而非去猜 STATUS body。
- 方案 a（推荐）：manager 收尾时显式调用 `synapse done [--status done|failed] "<summary>"`，写入终态标记并把最终 STATUS 发回 operator。
- 方案 b：monitor 从“出现一条 ref_id=根任务、to=operator 的 STATUS”推断——需额外约定如何区分完成与中间进度，较脆。

**(2) 谁执行解散。** manager 不宜杀掉自己所在的 session。`synapse done` 只落定 run 终态并把最终 STATUS 发回 operator；**monitor** 观察到终态后保持运行并继续投递 operator 后续消息，不杀 team，方便 operator 检查现场或补充信息继续同一 session。最终解散由 **UI/operator ACK** 显式触发：各 agent window 置 stopped 并 kill → kill tmux session。operator（人）始终保留手动强制解散的兜底。

**(3) 解散动作与保留物（沿用 `synapse-spec.md` §6.5）。** ACK 后 kill 各 agent window、kill session（monitor 所在 window 随 session 一起结束）；**DB 与 audit 日志不删**，跑完/中止后仍可复盘。

**(4) 任务是否升为一等实体。** 1:1 下最小做法是“根 TASK 消息 + 这个 session 即任务”，无需新表。但为记录结果/时序、支持“列出历史运行”，建议加一张轻量 `runs` 表：
```sql
CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session    TEXT NOT NULL,
  goal       TEXT,
  status     TEXT NOT NULL DEFAULT 'running', -- running|completed|failed|aborted
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at   TEXT
);
```

**(5) session 命名与并发。** 现状 session 固定 `team` 且 start 会“复用已存在的 team”。team 变一次性后，两个任务若重叠则固定名冲突。建议 **每个 run 唯一 session 名**（如 `run-<id>`），把“复用已存在”改为“上一支队伍已解散”。若严格串行（同时只跑一个任务），固定名也可，但需调整复用语义。

**(6) 失败/中止。** manager 无法完成时 `synapse done --status failed "<reason>"`，走同一条解散路径，只是记录的 outcome 不同。

## 待拍板清单

| # | 决策点 | 选项 | 状态 |
|---|--------|------|------|
| 1 | 角色指令送达载体 | B1 文件夹CLAUDE.md / B2 append-prompt / B3 共享+运行时 / B4 首条消息 | ✓ 已定 **B1** |
| 2 | 是否保留 per-agent 文件夹 | 保留(隔离) / 取消(根目录启动) | ✓ 已定 **保留** |
| 3 | 三段式模板存放 | `templates/` 目录 / 内嵌 task.yml | ✓ 已定 **`templates/` 目录** |
| 4 | 实例块来源 | task.yml 字段 / 单独文件 | ✓ 已定 **task.yml 字段（手动填）** |
| 5 | 生成的 CLAUDE.md 覆盖还是追加 | 覆盖 / 追加 | ✓ 已定 **覆盖（幂等）** |
| 6 | 第一脚触发方式 | A send-keys 极简 `synapse pending` / B On-Start段 / C init_prompt | ✓ 已定 **极简第一脚**（内容=`synapse pending <name>`；通道见 #7） |
| 7 | 就绪时机 + 发送通道 | 固定 sleep / 轮询 transcript 首行 / 启动时初始 prompt | ✓ 已定 **`claude` 启动时初始 prompt**（已实测通过） |
| 8 | 任务完成信号 | a 显式 `synapse done` / b monitor 从 STATUS 推断 | ✓ 已定 **a 显式 `synapse done`** |
| 9 | 解散执行者 | monitor 自动 / 仅 operator 手动 | ✓ 已定 **monitor 自动**（手动兜底） |
| 10 | 是否加 `runs` 表 | 加（记录 outcome/时序） / 不加（root 消息即任务） | ✓ 已定 **加 `runs` 表** |
| 11 | session 命名 | 每 run 唯一 `run-<id>` / 固定 `team`（串行） | ✓ 已定 **每 run 唯一 `run-<id>`** |
| 12 | 每 session 责任者 | 必有恰一个 manager | ✓ 已定 **必须有** |
| 13 | manager 与 planner | 合并（改名 `manager`） / 拆分成两角色 | ✓ 已定 **合并并改名 `manager`** |
| 14 | 流程定义位置 | CLAUDE.md（共享块+角色块） / task.yml 加 field | ✓ 已定 **CLAUDE.md** |

## 未来工作（deferred，不在本轮）

- **角色间交接走文件，而非 message / prompt。** 工作产物（设计稿、代码、diff、评审意见等）在角色之间的交接以**文件**为载体：交付方把内容写进约定路径的文件，接收方读文件；`messages` 表只携带“完成 + 文件指针/路径”这类轻量通知，不承载正文。动机：现有投递走 `tmux send-keys`，对长文本有长度/转义限制，大产物塞进消息或 prompt 既不可靠也污染上下文；文件交接把“通知”与“内容”解耦——消息保持短、内容可任意大且可独立留存复盘。待定细节（实现时再议）：交接目录约定（如 `.synapse/handoff/<from>-<to>/` 或挂在 `ref_id` 上）、文件命名与版本、读完是否归档。

## 实现概要（七项均已拍板）

决策齐全，可进入实现。落地改动集中在 `synapse start` / `launchAgentWindow`：

1. **三段式模板**：新建 `templates/shared.md` + `templates/role-<role>.md`；实例字段加进 `task.yml`（每个 agent 一行，如 `focus: backend`）。
2. **生成 CLAUDE.md**：start 时按 共享块 + 角色块 + 实例块 拼装，**覆盖**写入每个 `<cwd>/CLAUDE.md`（幂等）。
3. **第一脚**：启动命令改为 `claude --session-id <id> "synapse pending <name>"`；移除 nudge `hi` 与靠 transcript 轮询凑时机的逻辑。
4. **任务流转不变**：真正的任务仍走 `messages` 表（operator→manager TASK），第一脚只触发 agent 去 DB 自取。
5. **角色改名已完成**：`task.yml` 的 role 值、`templates/role-manager.md`、`.synapse/manager/CLAUDE.md`，以及 `synapse.ts` 里 `config.agents.find(a => a.role === "manager")`（初始 goal 投递对象）等所有处均已改为 `manager`。
6. **生命周期**：新增 `runs` 表与 `synapse done [--status done|failed]` 子命令（写终态、更新 `runs.status/ended_at`）；session 名由固定 `team` 改为 `run-<id>`，并把“复用已存在 team”逻辑改为“按 run 新建”；monitor 增加“观察到终态 → 解散”分支（kill 各 window、自身退出、kill session，保留 DB/audit）。
7. **无人值守前置（两道独立闸，必须都解）**：
   - **Workspace trust**（“trust this folder”弹窗）会卡死无人值守启动。`--dangerously-skip-permissions` **不**清这道（已知 bug）；`git init` 在部分版本也不管用。对策：信任状态存在 `~/.claude.json` 的 `.projects["<绝对 cwd>"].hasTrustDialogAccepted`——`cmdStart`/`launchAgentWindow` 在启动每个 agent 的 `claude` 前，**用绝对 cwd 预置该标记为 `true`**（顺带 `.hasCompletedOnboarding=true`）。**路径键必须是符号链接解析后的规范路径**：macOS 上 `/var` 软链到 `/private/var`，Claude Code 按规范路径记录 trust，所以要用 `fs.realpathSync`（而非仅 `path.resolve`，后者不解析软链）；否则 key 不匹配、trust 照弹。
   - **工具权限**（每次 bash/编辑要批准）：启动命令加 `--dangerously-skip-permissions` 跳过（该 flag 在 root/sudo 下会拒绝启动）。若想更克制可改用 permission-mode / auto 模式而非全量跳过。
   - 启动命令最终形态：`cd <cwd> && claude --session-id <id> --dangerously-skip-permissions "synapse pending <name>"`，外加启动前对 `~/.claude.json` 的 trust 预置。
   - **注意持久化 bug**（#36403/#9113）：部分版本接受 trust 后并不写回、或对子目录不认预置。实现时先验证“手动接受一次 → `~/.claude.json` 是否真的多出该条目”，确认可读可写后再依赖预置；否则退路是把 agent 跑在已信任的目录或换权限模式。

**已实测通过**（`tests/probe-initial-prompt.sh`，2026-06-28）：bare 与 `script(1)+tmux` 两种方式下，`claude --session-id <id> --dangerously-skip-permissions "<prompt>"` 都能自动执行初始 prompt；配合按**规范路径**预置 `~/.claude.json` 的 trust，不再卡 trust 弹窗。两道前置（trust 预置 + 跳过工具权限）确认有效，可全量实现。
