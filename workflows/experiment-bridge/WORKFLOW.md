# 实验桥：从实验计划到初始结果（适配自 ARIS Workflow 1.5 `/experiment-bridge`）

出处：<https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/main/skills/experiment-bridge/SKILL.md>，MIT License，Copyright (c) 2026 wanshuiyin。角色假设的删改范围见 `../README.md`，原样保留的安全措施见 `SAFETY.md`。

本流程覆盖「已有实验计划 → 实现 → 冒烟 → 部署 → 采集初始结果 → 提交评审」。它不覆盖选题、方法精炼与写作：进入本流程的前提是 `refine-logs/EXPERIMENT_PLAN.md` 已经存在并被 Codex 认可。

## 1. 职责

| 角色 | 承担 |
|---|---|
| 人类 | 定研究方向与资源上限，读 Codex 的解释后决定是否继续 |
| Codex Desktop | 写实验计划与 brief、按里程碑顺序提交任务、读证据、下 verdict、要求修订、执行 git 与主机层面的动作 |
| Pi | 在单个 `cwd` 内实现代码、跑冒烟与正式实验、调试、回写 tracker、写结果与评审请求 |
| Controller / Runner / Dashboard | 启动与续读事件、进程组终止、主机采样、增量变化、只读展示。不判断科学价值 |

Codex 与 Pi 之间只有 Controller 状态库这一条通道。Pi 不直接呼叫 Codex，Codex 也不直接读 Pi 的聊天轨迹，只读 `inspect` / `report` 返回的事件与产物路径。

## 2. 阶段与调用方式

计划与结论类产物写在实验项目的 `cwd` 内，沿用上游文件名，便于将来与上游其它 skill 对齐；数据库只索引路径与状态，不复制全文。

| 产物 | 位置 | 作者 |
|---|---|---|
| `refine-logs/EXPERIMENT_PLAN.md` | `<cwd>/refine-logs/` | Codex（Claim Map、Block、Run Order 与 Decision Gate、GPU-hours 预算） |
| `refine-logs/FINAL_PROPOSAL.md` | 同上 | Codex，方法描述，作为实现的对照物 |
| `refine-logs/EXPERIMENT_TRACKER.md` | 同上 | Codex 建表，Pi 逐条回写真实状态 |
| 实验脚本、`results/*.json`、`results/*.csv`、`*.log` | `<cwd>/` 内 | Pi |
| `refine-logs/EXPERIMENT_RESULTS.md` | `<cwd>/refine-logs/` | Pi，初始结果汇总（模板见 B5） |
| `EXPERIMENT_LOG.md` | `<cwd>/` | Pi，逐条运行记录（配置、指标、判定、复现命令） |
| `refine-logs/REVIEW_REQUEST.md` | `<cwd>/refine-logs/` | Pi，见 `REVIEW-REQUEST.md` |
| `<run_id>/{prompt.txt,run.conf,out,err,meta,pgid,launch.log}` | 远端 `BRI_REMOTE_BASE`（默认 `/home/user/bri-runs/<run_id>/`） | Runner，运行证据，不是科研产物 |

`submit` 的 body 为 `{title, brief, cwd, tools, timeoutMs, acceptHint, stage, dependsOn, start}`；`brief` 与 `cwd` 必填，`stage` 取 `literature|plan|experiment|review|writing`（缺省 `experiment`），`tools` 缺省取 Controller 配置 `BRI_PI_TOOLS`（默认 `read,grep,find,ls`），`timeoutMs` 缺省取 `BRI_PI_TIMEOUT_MS`（默认 1800000 即 30 分钟）。成功登记并启动返回 `{taskId, runId, attempt, pgid, status:"starting"}`；`start:false` 只登记不启动，返回 `status:"drafted"`；启动失败返回 `status:"failed_to_start"` 并带 `error`。

### B0 计划装载

Codex 写 `EXPERIMENT_PLAN.md`，逐项确认每个 Block 有 Dataset/split、Compared systems、Metrics、Setup、Success criterion、Priority，Run Order 每个里程碑有 Decision Gate 与成本估计。缺 Success criterion 的 Block 不进入执行。

### B1 实现前勘察（只读）

```bash
node integrations/bri.mjs submit --file=b1-survey.json
```

```json
{
  "title": "M-勘察：盘点可复用脚本与入口",
  "brief": "阅读 EXPERIMENT_PLAN.md 与项目现有脚本，报告每个里程碑可直接复用的文件、缺失的部分、数据与权重是否就位、评测脚本用的是哪个 ground truth 来源。只读，不要修改任何文件。",
  "cwd": "/home/user/<project>",
  "tools": "read,grep,find,ls",
  "timeoutMs": 900000,
  "stage": "plan",
  "acceptHint": "逐里程碑给出文件路径与缺失项；每个数字或路径都能对应到实际存在的文件；明确评测的 ground truth 来源",
  "start": true
}
```

Pi 产出实现清单。Codex 用 `inspect` 抽查它点名的路径是否真实存在。这一轮刻意不给 `bash`，用 `read,grep,find,ls` 的四件套；一旦勘察需要跑 shell 统计命令，写能力就随 `bash` 一起进来，只读的保证只能靠 brief 与收回结果时的改动核对，不靠工具名。

### B2 代码实现（含写）

```json
{
  "title": "M1：baseline 脚本实现",
  "brief": "按 refine-logs/EXPERIMENT_PLAN.md 的 Block 1 实现训练与评测脚本。全部超参走 argparse，seed 固定可控，结果写 results/*.json，评测必须对照数据集自带 ground truth。优先扩展现有脚本而不是新写。不得 git commit/push，不得改计划与 tracker 之外的文档。",
  "cwd": "/home/user/<project>",
  "tools": "read,grep,find,ls,bash,edit,write",
  "timeoutMs": 2700000,
  "stage": "experiment",
  "dependsOn": "task_<B1 的 taskId>",
  "acceptHint": "给出新增/修改文件清单与逐文件改动意图；给出 results JSON 的字段样例；自评标出所有来自计划的超参是否落进 argparse"
}
```

写工具的确切名称以远端实际安装的 Pi 版本为准，本文件不假定其拼写；需要写能力时按该版本列出真实工具名，不要为省事把整套工具一次放满。

B2 的产物用 `control <run_id> --type=get_state` 观察进展，不靠重发任务。B1 与 B2 之间的顺序由 Codex 保证：`dependsOn` 只作为登记信息写入 task 表，Controller 不在提交时校验依赖，带 `start:true` 的提交会立即启动。

### B3 冒烟（sanity）

一个里程碑只跑最小最快的一条，`acceptHint` 写清通过标准（进程退出 0、loss 有下降、metrics 落盘且能被解析、显存占用在界内）。

失败时 Pi 在授权预算内自行修复：同一失败最多 2 次打补丁 + 2 次干净重写。预算用尽、或两次干净重写成同一种失败，Pi 停止并在最终报告里写清尝试过的修法与错误原文，由 Codex 判断是计划错还是环境错。这类停止是上游保留下来的措施，不是失败。

### B4 正式部署

按 Run Order 逐里程碑提交，一个里程碑一个（或几个）task，Codex 在前一里程碑 `verdict=accepted` 后才提交需要该结论的后续任务；只依赖「任务跑完」的步骤可以直接排。

超过 30 分钟的训练进程不要塞进一个 Pi 回合的 `timeoutMs` 里等：Pi 回合结束不等于实验结束。Pi 用 `nohup`/后台方式起长任务并把 pid、日志路径、结果路径写进报告，Controller 侧持续观测主机；长实验与独立训练进程的登记在阶段 2 接入 `experiment` 表，当前由 Codex 在 brief 中固定日志与结果路径。

同一 task 同时只允许一个活动 attempt：`createRun` 查到活动运行即抛错，因此 `retry` 不会造出第二个 attempt。当前 retry 路由不捕获该异常，调用方会看到 500 而不是干净的拒绝信息——等前一运行进入终态再重试。

### B5 采集与回写

Pi 解析 `results/*.json`，回写 `EXPERIMENT_TRACKER.md` 的 Status 与 Notes，追加 `EXPERIMENT_LOG.md` 的逐条记录，写 `EXPERIMENT_RESULTS.md`，最后写 `REVIEW_REQUEST.md`。汇总模板（沿用上游 Phase 5）：

```markdown
# Initial Experiment Results
**Date** / **Plan**: refine-logs/EXPERIMENT_PLAN.md
## Results by Milestone
### M1: Baselines
| Run | System | Key Metric | Status |
## Summary
- [X/Y] must-run 完成
- 主要结果：正向 / 负向 / 不确定
- 评测类型声明：real_gt | synthetic_proxy | self_supervised_proxy | simulation_only | human_eval
- 是否可进入评审：是 / 否，理由
```

先给原始数字，再给解释；比较只在同 dataset、同 split、同 config、同 seed 集合的条件下并列。

### B6 Codex 验收

```bash
node integrations/bri.mjs overview                 # 取 lastChangeSeq 与 inbox
node integrations/bri.mjs changes --since=<lastChangeSeq>
node integrations/bri.mjs inspect <run_id> --after=0
node integrations/bri.mjs report <run_id>           # 只输出最终报告正文
```

`changes` 每项含 `{seq, kind, ref_id, summary, needs_decision, created_at}`。当前实现里 `needs_decision=1` 只标两类：运行终态为 `failed`，以及采集进入 `unknown`（无法观测、保持追踪不判结局）。`succeeded` 与 `canceled` 会以 `needs_decision=0` 进入变化流，验收动作由 Codex 自己按里程碑触发，不靠页面提醒。`inspect` 返回 `{run, task, events, decisions, logPaths}`；事件按 `source_seq` 游标续读，CLI 只暴露 `--after=<seq>`，服务端每次默认给 200 条、上限 500 条。库内 `final_report` 摘要截断到 4000 字符（`docs/stage01-review.md` 的 P2 项，修复前）：结果较长时以 `logPaths.out` 原文为准。

verdict 用 `decide`，body `{taskId, verdict, reason, evidenceRef}`，`verdict ∈ accepted|revise|rejected`，`reason` 必填。它只改 task 的研究结论状态，与 run 的进程状态分开记录。

```json
{
  "taskId": "task_xxx",
  "verdict": "revise",
  "reason": "报告称 12 个 run 全部 ok，实测 resume.log 中 ok 结尾为 11 行，末行是完成标记",
  "evidenceRef": "run_xxx#seq=318; ssh example-host 'grep -c ok$ resume.log'"
}
```

`evidenceRef` 写成运行加事件序号，或写成可重跑的复核命令。执行者自报的完成与数字不能替代测量结果。

### B7 修订

`verdict=revise` 后 Codex 针对具体缺陷提交新 task，`stage:"review"`，`dependsOn` 指向被修订的 task。新 attempt 是一次全新的完整执行，不是续跑（见 §4）。

## 3. 验收语义

门禁划分沿用上游 `shared-references/acceptance-gate.md` 的两类，本项目按角色落到两个不同主体上：

- **Type-A，执行/客观门禁**——退出码、文件存在、job 数、指标能解析、NaN 有无、预算计数。Pi 自行判定。有确定性检查时用检查结果，不用 Pi 的自我感觉。
- **Type-B，质量/正确性/验收门禁**——结论是否成立、评测口径是否正确、结果是否够强、是否可进入下一研究阶段。只能由 Codex（在人的方向负责之下）判定。Pi 永不自判，即使它同时满足了全部 Type-A 条件。

由此固定四条口径：

1. `run.status = succeeded` 只表示 Pi 这一回合收敛并提交了产物，来自 `PI_RESULT_JSON.success`。它不等于研究结论成立。
2. `verdict = accepted` 是研究结论的唯一状态来源，只有 Codex 能写。
3. Pi 在报告里说「通过」「验证正确」「结果好」都算作者主张，需要 `evidenceRef` 指向产物或复核命令才进摘要。
4. 大量重试不自动等于研究进展。Type-A 修复预算（2 打补丁 + 2 重写）用尽后，继续投入要靠 Codex 决策，Pi 不得自行扩大重试次数、资源范围或修改评价口径。

## 4. 取消语义

```bash
node integrations/bri.mjs cancel <run_id>
node integrations/bri.mjs control <run_id> --type=get_state
node integrations/bri.mjs control <run_id> --type=steer --message="停止 M3 的部署，先复核 Block 2 的评测口径"
node integrations/bri.mjs retry <task_id>
```

- **作用域**：取消只针对该 run 记录的进程组（`kill -TERM -<pgid>`，未退出则 `kill -KILL -<pgid>`），不触碰同机其它使用者或其它 run。
- **成功条件**：只有验证该进程组已退出才返回 `canceled_verified`。无法观测时返回「未确认取消」，不写 canceled 状态；`unknown` 是「看不到」，不是「已结束」。
- **竞态处理**：取消信号发出到进程真正退出之间，如果远端已经写出终态结果，Controller 先排空尾部输出，把该 run 按 `succeeded`/`failed` 收尾，并在 `exit_reason` 记 `result_arrived_during_cancel`，此时不覆盖成 `canceled`。
- **控制通道**：`control` 往该 run 的 `ctl` 管道里写一条 RPC 命令，wrapper 收尾后管道已删除，返回 `ok:false`。`--type=abort` 也只写入管道、不验证进程退出，因此终止一律用 `cancel`。
- **没有续跑**：远端 Pi 固定 `--no-session`，无会话恢复能力。中断或取消后要再做同一件事，走「新 attempt 重跑」或「重新 `submit`」，不存在接着上次上下文继续。
- **`retry` 的回落**：`retry <task_id>` 用原 task 的 `brief` 与 `cwd`，但 `tools` 与 `timeoutMs` 回落到 Controller 默认值（只读工具集与 30 分钟）。B2、B3、B4 这些需要写能力和长超时的阶段不要用它，重新 `submit` 并带 `dependsOn`。

## 5. 必须停下来交给 Codex 判断

出现以下任一情况，Pi 在报告中停下并说明原因，不得自行推进：

1. 需要改变研究问题、评价口径、Success criterion，或计划里没有的实验。
2. 需要改变 `cwd` 之外的文件、执行 `git commit`/`git push`/发布、删除或大范围改写数据、checkpoint、结果。
3. 需要超出 `submit` 给定的 `timeoutMs`，或需要在 `BRI_SSH_ALIAS` 之外的机器上跑。
4. 自动调试预算（同一失败 2 次打补丁 + 2 次干净重写）用尽，或两次干净重写成同一种失败。
5. 评测口径问题——发现 ground truth 不是数据集自带、不同方法用了不同 GT、或用了另一个模型的输出当 GT。上游把这条列为 CRITICAL，本项目它必然属于 Type-B。
6. 单 run 实测耗时或显存超过计划估算 2 倍，或预算接近计划 GPU-hours 上限。
7. 结果与预期反向、出现 `NaN`、或数字无法从产物文件复现。
8. 需要访问凭据、外部账号、云实例租用或销毁。

这些请求写进该次运行的最终报告。运行本身仍以 `succeeded` 收尾，因此它进变化流时 `needs_decision=0`、不会自动出现在收件箱——升级事项靠 Codex 按里程碑读 `changes` 与 `inspect` 发现，这正是 B6 的读取节奏要求的由来。Pi 不通过委派另一个 agent 来绕过 Codex。

## 6. 最小命令序列

一个里程碑从下发到收口的完整动作：

```bash
# 1. 下发实现任务（B2）
node integrations/bri.mjs submit --file=b2.json          # -> {taskId, runId, attempt, pgid, status:"starting"}

# 2. 运行期间看进展（不调用模型）
node integrations/bri.mjs control <runId> --type=get_state
node integrations/bri.mjs inspect <runId> --after=<上次 seq>

# 3. 取增量与终态
node integrations/bri.mjs overview                        # -> lastChangeSeq, inbox
node integrations/bri.mjs changes --since=<lastChangeSeq> # -> [{seq,kind,ref_id,summary,needs_decision,...}]

# 4. 读结论与证据
node integrations/bri.mjs report <runId>
node integrations/bri.mjs inspect <runId>                 # run / task / events / decisions / logPaths

# 5. 验收（研究结论的唯一写入点）
node integrations/bri.mjs decide --file=d1.json           # {taskId, verdict, reason, evidenceRef}

# 6a. 结论成立 -> 提交依赖它的下一里程碑（B4）
node integrations/bri.mjs submit --file=b4.json           # dependsOn 指向上一个 taskId

# 6b. 需要修订 -> 提交带 stage:"review" 的应答任务（B7）
# 6c. 跑偏或超预算 -> 终止该运行的进程组，验证退出后才算取消
node integrations/bri.mjs cancel <runId>                  # -> {ok:true, detail:"canceled_verified"}
```

阶段 0 的三条验收判据对应：调用方式是上面 1–6；产物是 §2 的产物表；取消语义是 §4。
