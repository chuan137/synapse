# Synapse 重置 + 重启 Runbook（start over）

在 synapse 项目根目录执行。下面命令都是给**你在 Mac 终端里**跑的——我（沙箱）无法操作你的
tmux / 终端。

> ⚠️ 重要：跑实测时，**不要用外部工具打开 `.synapse/synapse.db`**（它是 WAL 模式）。从另一台
> 机器 / 挂载 / sqlite 浏览器并发访问会触发 `disk I/O error`，今天 monitor 那次崩溃很可能就是
> 我从沙箱读这个库造成的。让 synapse 自己的进程独占这个库。

---

## A. 全部停掉

```bash
tmux kill-server                       # 干掉所有 tmux 会话（含崩溃的 run-9 / 旧 run）
pkill -f 'synapse (monitor|ui)' 2>/dev/null   # 兜底：清掉残留的 monitor / ui 进程
pkill -f 'src/synapse.ts' 2>/dev/null         # 如果你是从 source 跑的
```

## B. 清理脏状态

```bash
rm -f .synapse/monitor-*.pid           # 清掉残留的 monitor 锁文件
rm -f .synapse/"SELECT body,status FROM messages WHERE to_agent='coder-1' ORDER BY id DESC LIMIT 1"
                                       # 删掉那个手滑重定向生成的 0 字节垃圾文件
```

**可选——彻底清空历史**（保留备份，从干净 DB 重来）：

```bash
mv .synapse ".synapse.bak-$(date +%s)"   # 整个数据目录挪走做备份
# 不用手动建目录，下一步 init 会自动建
```

## C. 编译

```bash
make build                             # 用 bun 编译出 bin/synapse
```

> 用编译后的 `bin/synapse` 跑是**推荐路径**：`synapse start` 会自己在 run 的 `monitor` 窗口里
> 拉起 monitor，路径解析正确。直接 `bun src/synapse.ts start` 时，它给 monitor 拼的命令指向的是
> `.ts` 源文件，容易出问题——所以 start 用二进制更稳。

## D. 起 UI（前台，单开一个终端窗口）

```bash
./bin/synapse ui --port 7700
```

想要热重载 + 直接在终端看到堆栈报错（调 UI 时有用）：

```bash
SYNAPSE_DEV=1 SYNAPSE_DB=.synapse/synapse.db bun src/synapse.ts ui --port 7700
```

## E. 起一个新 run（它会自动带起自己的 monitor）

```bash
./bin/synapse start templates/task.example.yml --goal "<你的目标>"
```

- 这会新建 run-N、拉起 manager / coder / reviewer 各自的 tmux 窗口 + 一个 monitor 窗口，
  并把 goal 作为 TASK 发给 manager。
- 看进展：浏览器开 http://localhost:7700，或 `tmux attach -t run-N`。
- **“start over” 就是再跑一次这条**——每个 run 都是 ephemeral 的，会拿到新的 run-id 和新的
  tmux 会话，不会和旧 run 冲突。只有想清空历史时才需要做 B 的“彻底清空”。

## F. 实测时排查

```bash
tail -f .synapse/monitor.log           # monitor 的 stdout/stderr 都 tee 在这里
tmux capture-pane -pt run-N:manager    # 看某个 agent 窗口当前在干嘛（manager/coder-1/reviewer/monitor）
```

把上面任意输出贴给我，我来帮你判读。

---

## 验证新 instruction 是否生效

这次改了 `templates/shared.md`（新增 Rule 4：对 operator 的“提问”是阻塞的）和
`templates/role-manager.md`（Start 步骤先判断 goal 是否清晰）。

- 从 **source** 跑 `start` 会实时读 templates；用**编译二进制**则需要先 `make build` 把模板打进去。
  既然 D/E 用二进制，记得改完模板**先 `make build` 再 `start`**，否则新指令不会生效。
- 验证方法：用一个故意模糊的 goal（比如 `--goal "优化一下"`）起 run。预期 manager 只发一条 INFO
  问 operator，然后**停住等你回复**，不会自己去派活——这正是今天 run-9 没做到的点。
