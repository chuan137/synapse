# Progress 直发机制 Spec

Status: draft, no implementation yet.

## 结论（一句话）

允许 `coder/reviewer/tester` 直接发 `PROGRESS` 给 `operator`，但仅限 `start`/`done`（可选
`blocked`）三种节点信号，用 body 前缀标记并在 `cmdSend` 里做硬校验；`TASK/REPLY/QUESTION`
维持 hub-and-spoke 不变；manager 的 relay 义务不取消，而是收窄到"需要综合判断"的内容，并
用一个 `pending` 检查点兜底防止遗漏；UI 的活动信号必须按 `from_agent` 分组显示角色来源。

四个问题分别对应决策 1–4，均为结论性選擇，不是并列方案。

---

## 现状核查（结论的依据，非猜测）

1. **hub-and-spoke 从来不是代码强制的，只是协议约定。** `cmdSend`
   （`src/commands.ts:108-164`）对 `from`/`to` 没有任何角色校验——谁都可以
   `synapse send operator PROGRESS "..."`，唯一存在的校验是 body 格式（编号列表拒绝，
   `commands.ts:118-127`）和 `QUESTION` 必须带 `--options`（`commands.ts:128-135`）。
   也就是说"是否允许直发"从来都是**协议文本问题**，不是能力问题——现在改，不需要动
   schema。
2. **`PROGRESS` 语义本就和 `TASK/REPLY/QUESTION` 不同类。** `templates/shared.md:57-60`
   已经定义它是 "one-way UI signal; no reply expected"，不进入 `ref_id` 决策链。manager
   对 `TASK/REPLY/QUESTION` 的中转是因为它要做决策、要追 `ref_id`；这个理由对一个纯活动
   信号不成立。
3. **UI 目前完全没有渲染 `from_agent`。** `buildActivityMarker`
   （`public/app.js:479-500`）只渲染 `icon + to_agent + time + body`，没有发送者字段。这
   在"PROGRESS 只可能来自 manager"的旧假设下是安全的省略，一旦允许多来源直发就会失真
   ——这是问题 4 必须回答"是"的直接证据，不是推测。
4. **`managerActivityForRun` 的 SELECT 也没取 `from_agent`。**
   （`src/ui.ts:173-183`），同样的问题存在于后端查询层。

---

## 决策 1：允许直发，范围严格限定为节点信号

`coder/reviewer/tester` 可以直接 `synapse send operator PROGRESS ...`，但只用于：

- **`start`** — 接受一个 `TASK` 并开始执行时（对应原本 manager 代发的"已分派"信号）。
- **`done`** — 发送 `REPLY` 给上级（manager 或 coder）**之前**。
- **`blocked`**（可选）— 遇到需要等待外部输入但还不到升级为 `QUESTION` 的程度。

`TASK/REPLY/QUESTION` 不变——依然必须经过 manager（coder→reviewer 的 `REVIEW TASK` 除外，
现状本就是 peer-to-peer，不受本次改动影响）。

**为什么不是"要么都不许要么都许"：** manager 阻塞在等待某个 `REPLY`（等 reviewer 的
verdict，或等 operator 回答一个 `QUESTION`）时，是**结构性**收不到消息、发不出 relay——
它当下没有 turn 在跑，不是"忘了转发"。任何"提醒 manager 记得转发"的方案（决策 3）只能
解决"忘记"这一类失效，解决不了"当下阻塞、物理上转不了"这一类失效。这正是需求里第 2 条
指出的痛点，只有直发通道能覆盖它。

---

## 决策 2：反刷屏——前缀约定 + `cmdSend` 硬校验

不靠"agent 自觉遵守 CLAUDE.md"，理由：代码里已经有先例证明"重要的路由规则要写成校验，
不能只写文档"——`QUESTION` 到 operator 必须带 `--options` 就是靠 `cmdSend` 拒绝，不是靠
自觉（`commands.ts:128-135`）。同样的模式套用到这里：

```ts
// cmdSend() 内，MESSAGE_TYPES 校验之后
if (type === "PROGRESS" && to === "operator" && frm !== "manager") {
  if (!/^\[(start|done|blocked)\]/.test(body)) {
    fail(
      "direct PROGRESS to operator from a non-manager agent must lead with " +
      "[start], [done], or [blocked] — this path is for lifecycle markers only. " +
      "Process narration (\"trying X\", \"still working on Y\") goes to your " +
      "supervisor via PROGRESS/REPLY, not to operator.",
    );
  }
}
```

- 一个 `TASK` 生命周期内每个角色最多两条直发（`start` + `done`），`blocked` 之外没有第三种
  出口——这就是防刷屏的硬上限，不靠自觉执行。
- body 依然遵守 shared.md 现有的"一行、指向证据而非复述"规则（`shared.md:62-65`）。

### 这条规则该定义在哪——不是三选一，是三层，各管各的

`assembleClaudeMd()`（`src/commands.ts:532-556`）已经把这个问题的答案钉死在架构里：每个
agent 的 `CLAUDE.md` 是 `SHARED_MD + ROLE_TEMPLATES[role]` 拼出来的三段式（shared 段 + role
段 + instance focus 段），不是单一文件，也不是代码里内嵌的字符串。新规则照抄这个已有结构，
不要另起一套：

1. **规则本体 → `templates/shared.md`。** 语义定义（直发只能是 `start/done/blocked`、前缀
   格式、为什么存在）写一次，放进现有"## Message types"小节。理由不是"图方便"，是
   `shared.md` 会被逐字拼进**每一个**角色的 `CLAUDE.md`（同一份文本，四个角色共享）——写
   在这里天然保证 coder/reviewer/tester/manager read 到的是同一句话，不会出现"reviewer 版
   本"和"tester 版本"措辞不一致、后续各自漂移的问题。

   反例就在同一个仓库里：`docs/synapse-spec.md` 顶部写着 "Status: draft, no implementation
   yet"，它的 message type 词表还是 `TASK/STATUS/REVIEW/ACK/INFO`（旧版），跟实际代码里
   `MESSAGE_TYPES = TASK/QUESTION/PROGRESS/REPLY`（`commands.ts:29`）已经对不上了。
   `docs/synapse-spec.md` 是历史设计稿，**不是**运行时协议来源；`templates/shared.md` 才是
   ——因为只有后者会被 `synapse start` 实际读取、拼装、写进每个 agent 的 CLAUDE.md。不要把
   新规则写进 `docs/` 下的设计稿就当作"约定过了"，那只是留痕，agent 读不到。

2. **触发时机 → 各自的 `templates/role-*.md`。** 规则本体不重复，但"我在自己工作流第几步
   调用它"必须逐角色写，因为时机天然不同（coder 是接受 TASK 后 vs REPLY 给 manager 前；
   reviewer 是收到 review TASK 后 vs REPLY 给 coder 前）。这也是抄现有模式——`role-coder.md`
   已经把 `synapse send manager REPLY` 嵌进它自己编号的 Responsibilities 步骤 7-8 里，而不是
   只在 shared.md 里说"完成时要 reply"就完事。只放中心规则、不落到每个角色文件的具体步骤
   里，等于把"该在哪一步调用"这件事丢给 agent 自己去推断——这正是决策 3 想避免的"记得才做"
   模式，不能在决策 2 上又犯一次。

3. **硬校验 → 代码（`cmdSend`，见上）。** 前两层都是文本，agent 仍可能读错或跳过；只有这
   一层是运行时真正拦得住的。这里有个连带发现值得记录：`role-coder.md:41-44` 和
   `role-reviewer.md:17-21` 都写了"the harness will hold further work and send you back to
   this step if the message is missing"，但仓库里搜不到任何对应的校验代码或 hook
   （`.claude/settings.local.json` 只有权限白名单，没有 stop hook）——这句话目前是**没有代码
   背书的承诺**。新前缀规则不要重蹈这个坑：要么像本节这样在 `cmdSend` 里真正实现校验，要么
   在文档里如实写"约定，未强制"，不要写"harness 会拦"这种听起来像强制、实际没有的话。

---

## 决策 3：manager 的 relay 义务收窄，但不取消，并加检查点

直发只覆盖"活动发生了"这个事实，不覆盖需要**综合判断**才能生成的内容——这些依然只能
由 manager 产出，直发替代不了：

- `role-manager.md:94-95` 的"implemented & reviewed (LGTM|issues)"——这是合并 coder 的
  `done` 信号和 reviewer 单独发来的 verdict 之后的结论，reviewer 自己发不出这句话。
- workflow deviation、blocker 升级为 `QUESTION`、tester fail 后的重新分派决定——都需要
  manager 的判断，不是转述。

因此 `role-reviewer.md:22-27` 里 reviewer→manager 的 `PROGRESS`（决策输入，manager 靠它
决定下一步）**保留不变**，和 reviewer 新增的 operator 直发 `[done]`（纯展示）是两个不同
用途的消息，不是重复。

**但**：`role-manager.md:91-92`"Subtask delegated — pointer only"这条 PROGRESS 现在是
多余的——coder 直发 `[start]` 已经覆盖了这个信号，manager 侧应删除这条 relay 义务，净减少
manager 的转发负担。

### manager 当前所有 PROGRESS→operator 场景的完整清单，逐条核对是否与新规则重复

`role-manager.md` 里 manager 发给 operator 的 `PROGRESS`（不算 `REPLY`/`QUESTION`）只有这
四处，`shared.md` Rule 2 是驱动这四处存在的总纲。逐条核对：

| 场景（`role-manager.md` 行号） | 现有 body 示例 | 新增的下级直发信号 | 重复程度 | 结论 |
|---|---|---|---|---|
| Subtask delegated（91-92） | `-> <agent> (task <id>)` | coder/reviewer/tester 的 `[start]` | **完全重复**——同一事实、同一时间点 | 删除，见上 |
| Coder done + review verdict（94-95） | `<agent>: implemented & reviewed (<LGTM\|issues found>) — <path>` | reviewer `[done]`（REPLY 给 coder 前）+ coder `[done]`（REPLY 给 manager 前） | **部分重复**——"完成"这个事实被下级 `[done]` 抢先说了，但 LGTM/issues 的**结论**只有 manager 能给 | 保留，但改写措辞：去掉复述"完成"的前缀，只保留判断结论——`review: LGTM — <path>` |
| Tester verdict（100-102） | `tester: PASS — <n>/<n> cases` | tester `[done]`（REPLY 给 manager 前） | **部分重复**——"测试完成"被 `[done]` 抢先说了，但 PASS/FAIL 和用例数是**结论**，`[done]` 里没有 | 保留原样——PASS/FAIL/用例数本身就不是"完成"的复述，重复程度低到可以不改 |
| Workflow deviation（104-106） | `Deviation: <what changed and why>.` | 无对应下级信号 | 不重复 | 不变 |

第二行是需要动手改的地方：`role-manager.md:94-95` 的示例命令要从

```bash
synapse send operator PROGRESS "<agent>: implemented & reviewed (<LGTM|issues found>) — <file/commit or review path>" --ref-id <task_msg_id>
```

改成

```bash
synapse send operator PROGRESS "review: <LGTM|issues found> — <file/commit or review path>" --ref-id <task_msg_id>
```

去掉 `<agent>: implemented &` 是因为"这个 agent 做完了"这件事，operator 已经从 coder 自己
发的 `[done]` 里看到了（同一个 `--ref-id`）；manager 这条消息此时唯一还没被说过的信息只剩
审阅结论本身。这跟 `role-manager.md:82-83` 自己写的原则是同一条逻辑的延伸："Don't retype
content that's already visible on its own"——以前这条原则只管 TASK，现在下级也能直发
`PROGRESS` 了，同一条原则自然覆盖到这里，不是新发明的规矩。

**`shared.md` Rule 2 的措辞也要跟着改**（`shared.md:103-106`）。原文"On task started, ...
or task complete, send a one-line PROGRESS/REPLY (manager sends to operator)"，括号里这句
默认了"发给 operator 的 started/complete 信号只能来自 manager"——这个假设在决策 1 之后不
成立了。改法：把"task started / task complete"拆出来注明——对**自己负责的子任务**，
started/complete 是该角色自己直发 operator 的责任（`[start]`/`[done]`）；manager 的
PROGRESS/REPLY 义务收窄为"key decision"和"blocker"，以及上表里那些带判断结论的场景。不改
这句话的话，manager 还是会照着旧措辞去发一条纯粹复述"完成"的 PROGRESS，决策 2/3 做的收窄
就白做了。

**检查点（防止"记得才转"）：** 在 `cmdPending`（`commands.ts:260-315`）manager 拉取
pending 消息时，追加一条检查——`ref_id` 链已被下级 `REPLY` 关闭、但同一 `ref_id` 上没有
manager→operator 的 `REPLY`/`PROGRESS`：

```sql
SELECT DISTINCT ref_id FROM messages
WHERE to_agent = 'manager' AND ref_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM messages m2
    WHERE m2.from_agent = 'manager' AND m2.to_agent = 'operator'
      AND m2.ref_id = messages.ref_id
  )
```

结果非空时在 `synapse pending manager` 的输出里加一行提示（不需要新表，纯查询）。这把
"manager 记得才转"变成"manager 每次被唤醒时被动提醒"，成本接近零。

---

## 决策 4：UI 按发送者角色分组显示

结论是"是"，且已有具体证据（见"现状核查"第 3、4 点），不是推测性的"最好这样"。改动点：

| 位置 | 现状 | 改动 |
|---|---|---|
| `src/ui.ts:173-183` `managerActivityForRun` | `SELECT` 未取 `from_agent` | 加入 `m.from_agent` |
| `public/app.js:479-500` `buildActivityMarker` | 只渲染 `to_agent` | 加渲染 `from_agent`，按角色给徽章/头像色（复用已有的 `initials()`） |
| `public/app.js:480` `icons = { TASK, PROGRESS }` | `PROGRESS` 统一用 `•` | 按 body 前缀映射图标：`[start]` → `▶`，`[done]` → `✓`，`[blocked]` → `⚠`，manager 的旧式 relay PROGRESS（无前缀）继续用 `•` |

角色徽章的意义不只是好看：一旦同一条活动信号流里混入 manager 的综合结论和 coder/reviewer/
tester 的原始节点信号，operator 需要一眼分清"这是谁说的、是不是已经被 manager 消化过"。

---

## 协议文本变更清单

- `templates/shared.md`：在 `PROGRESS` 定义后补充直发规则、前缀约定、"仅节点信号"的边界；
  Rule 2（`shared.md:103-106`）改写括号说明，"task started/complete"对自己的子任务是该角色
  自己直发的责任，manager 的 PROGRESS/REPLY 收窄为判断类内容。
- `templates/role-coder.md`：任务开始/完成时各加一条 `synapse send operator PROGRESS
  "[start]/[done] ..."`。
- `templates/role-reviewer.md`：`[done]` 直发追加在现有 manager PROGRESS 之后，两条并存。
- `templates/role-tester.md`：同上。
- `templates/role-manager.md`：删除"Subtask delegated — pointer only"relay 条目；
  "Coder done + review verdict"示例改写为 `review: <LGTM|issues found> — <path>`（去掉复述
  完成状态的 `<agent>: implemented &` 前缀）；"Tester verdict"示例不变（PASS/FAIL + 用例数
  本身就不是完成状态的复述）；补充"检查点"说明。

## Out of scope

- `blocked` 直发是否需要单独升级路径（例如超时后自动转 `QUESTION`）——留待后续，先落地
  `start/done`。
- operator 端是否需要"折叠同一 `ref_id` 下的多条直发信号"这类聚合 UI——等真实使用数据出
  来再评估，属于锦上添花而非本次范围。
