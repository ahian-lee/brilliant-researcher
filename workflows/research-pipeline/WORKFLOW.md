# 研究流水线：目标 → 阶段 → 执行 → 评审 → 去向（适配自 ARIS `/research-pipeline`）

出处：<https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/main/skills/research-pipeline/SKILL.md>，MIT License，Copyright (c) 2026 wanshuiyin。核验日期 2026-09-28，逐字读完全文（main 分支，391 行）。与上游的逐条差异、以及「主管验收」这一称谓的适用范围见 `DELTA.md`。

执行侧的阶段动作、产物目录、验收语义与取消语义沿用 `../experiment-bridge/WORKFLOW.md` 与 `../experiment-bridge/SAFETY.md`，本文件不重复实现执行器。评审—修订循环的动作序列见 `../auto-review-loop/WORKFLOW.md`。

命名约定：本文件与 `../auto-review-loop/WORKFLOW.md` 是**宿主中立**的流程文件——「主持者」指承担规划、核查、验收与去向决定的角色，「执行者」指 Pi。当前落地的主持者是 Codex Desktop，宿主绑定、安装与唤醒方式不写在这里，见 `../../docs/codex-event-bridge.md` 与 `../../integrations/codex/`。状态库里的 `author`、`codex-desktop`、`bri_*` 是固定取值或接口名，不是角色名。

## 1. 覆盖范围

上游 `/research-pipeline` 把自己定义为编排层，串起最多四个 workflow：

```
/idea-discovery → /experiment-bridge → /auto-review-loop → /paper-writing (optional)
├─ Workflow 1 ──┤├─ Workflow 1.5 ───┤├─ Workflow 2 ─────┤ ├── Workflow 3 ──┤
```

本项目移植这一编排层的**阶段语义**（阶段产物、继续、完成、`done` 与 `accepted` 的区分），不移植它的端点：

- 入口是一次授权的可检验阶段目标，不要求从找 idea 开始。上游 Stage 1（`/idea-discovery`、`idea-stage/IDEA_REPORT.md`、Gate 1 的 idea 选择）不在本闭环内。
- 出口是阶段报告，不强制走到论文。上游 Stage 4 的 `NARRATIVE_REPORT.md` 收敛为本项目的阶段报告，Stage 5（`/paper-writing`、`VENUE`、Gate 2）不搬。
- 依据：`docs/aris-autonomous-workflow-plan.md` §3（先做「已有目标/已有产物 → 执行 → 评审 → 修订 → 再评审 → 阶段报告」）与 §7 3E（idea-discovery、实验计划、长期实验监控、可选论文写作留待闭环稳定后逐步适配）。

本项目的阶段序列：

```
待执行 → Pi 执行 → 待评审 → Codex 核查
                              ├─ accepted → 授权范围内下一项 / 阶段完成
                              ├─ revise   → 明确修订任务 → 新产物 → 再评审
                              └─ rejected → 授权范围内重规划 / 请求用户决定
```

## 2. 两层结构：研究阶段与执行回合

阶段和回合是两层，粒度、状态载体和推进者都不同。混用这两层是本流程最主要的失败模式。

| 层 | 粒度 | 状态载体 | 谁能推进 | 结束判据 |
|---|---|---|---|---|
| 研究阶段 | 一个授权目标里的一段（文献交付 / 计划 / 实验 / 评审 / 写作），对应 `task.stage` | `project.plan_version` + 该阶段全部 task 的 `decision` + `supervisor_update` | Codex | 阶段完成条件（§7）逐条满足 |
| Pi 任务 | 一份自足 brief，一个 `taskId`，属于一个阶段 | `task` 行：`stage`、`verdict`、`depends_on` | Codex 创建，Pi 交付 | 有终态 `decision` |
| 执行回合 attempt | 一次 Pi 进程，一个 `run_id` | `run.status`：`queued → starting → running → succeeded/failed/canceled`，连接丢失单记 `unknown` | Controller / Runner | 进程收敛并写出 `final_report` |
| 长实验进程 | 一个训练或采集进程，寿命可远超回合 | `experiment` 表属阶段 2；当前由 Codex 在 brief 里固定日志与结果路径 | Runner 主机采集 | 实验自己的结果完成条件 |

由此固定两条禁止的推断：

1. **不得用 Pi 回合结束推断长期实验结束。** `run.status = succeeded` 只说明这一回合收敛并提交产物，来自 `PI_RESULT_JSON.success`；Pi 用 `nohup`/后台起长任务时，回合可能先于实验结束。出处：`docs/architecture-v1.md` §4 第 3 点、`../experiment-bridge/WORKFLOW.md` §2 的 B4。上游同样区分这一点：Stage 2 要求「Wait for `/experiment-bridge` to complete and report its handoff summary before proceeding」，长任务观测走独立的 `/monitor-experiment`。
2. **不得用全部进程 succeeded 推断阶段通过。** 上游把阶段状态拆成 `done`（executor finished writing）与 `accepted`（the stage's cross-model gate / deterministic verifier passed），并规定「Mark `accepted` ONLY after the stage's gate passes — never on the executor's own say-so」。本项目的同一区分由两个互不覆盖的字段承担：`run.status = succeeded` 对应 `done`，`task.verdict = accepted` 对应 `accepted`，后者只有 `bri_record_decision` 能写。

`unknown` 是观测不到，不是失败，也不是结束。持续核对，不把观测失败当执行结论。

## 3. 阶段状态机的可用动作

| 状态 | 进入条件 | 本状态允许的动作 | 离开条件 |
|---|---|---|---|
| 待执行 | 阶段目标与完成条件已进入计划 | `bri_submit_task`（可带 `start:false` 先登记） | 至少一个任务有活动 attempt |
| Pi 执行 | attempt 处于 `starting`/`running` | `bri_run_control`（`get_state` 看送达确认、`steer` 追加要求）、`bri_cancel_run` | attempt 进入终态 |
| 待评审 | attempt 终态且该 task 尚无终态 `decision` | `bri_inspect_run`、`bri_read_report`，直接读 `cwd` 内源文件并按需要重算 | 写出 `decision` |
| Codex 核查 | 有新产物或上一轮问题需复核 | 同上，加上取回上一轮未解决问题清单（`../auto-review-loop/WORKFLOW.md` §3 第 2 条） | `accepted` / `revise` / `rejected` |
| 修订派发 | `verdict = revise` | 同回合内 `bri_submit_task` 派发修订 | 修订 attempt 终态 → 回到待评审 |
| 重规划 | `verdict = rejected` | `bri_publish_plan`（带 `expected_version`）改写范围，或向人提问 | 新计划生效，或明确等待用户决定 |
| 受阻 | 预算耗尽、权限不足、宿主连接不可用 | `bri_publish_update`（`schedule_status = blocked`） | 人给出决定，或授权扩大 |

`failed` 与 `timeout` 的 attempt 可以有有价值的文件：按可用性判定，既不直接丢弃，也不把部分文件包装成完整交付（`docs/aris-autonomous-workflow-plan.md` §6 第 3 点）。

## 4. 阶段状态落在哪里

阶段状态由现有 SQLite 业务状态组合而成，`refine-logs/`、`review-stage/` 下的文件是产物与证据，不承担状态库职责。

| 事实 | 载体 | 读 | 写 |
|---|---|---|---|
| 目标、授权范围、资源约束 | `project.goal` / `constraints` / `plan_version` | `bri_overview` → `project` | `bri_publish_plan(goal, constraints, expected_version, project_id)` |
| 阶段归属 | `task.stage ∈ literature\|plan\|experiment\|review\|writing` | `bri_overview` → `tasks`（含 `run_id`、`run_status`、`attempt`、`event_count`，按 `created_at` 倒序，上限 100 条） | `bri_submit_task(..., stage)` |
| 进程事实 | `run.status`、`exit_reason`、`run_event` | `bri_inspect_run(run_id, after, project_id)` | 由 Controller 写 |
| 阶段结论 | `decision(action, reason, evidence_ref, plan_version, created_at)` | `bri_overview` → `decisions`（最近 20 条）、`bri_inspect_run` → `decisions` | `bri_record_decision(task_id, verdict, reason, evidence_ref)` |
| 当前阶段与去向的对外表述 | `supervisor_update` | `bri_overview` → `supervisorUpdates`（最近 20 条） | `bri_publish_update(...)` |
| 事件游标 | `change_log.seq` | `bri_overview` → `lastChangeSeq`；`bri_changes(since, limit, project_id)`，`limit` 默认 200、上限 500 | 由 Controller 写 |

本项目决定：不维护上游 `.aris/runs/<run_id>.json` 那样的第二套阶段状态文件。上游用它记 `phase ∈ {idea-discovery, experiment-bridge, auto-review-loop, summary, paper-writing}` 与 `running/done/accepted/failed`，并通过 `run_state.py accept` 要求记 `verdict id + reviewer`；这些语义在本项目全部落到上表的现有表和列，`accept` 的「不能凭执行者自评」要求落到 `bri_record_decision` 的 `reason` + `evidence_ref`。逐条对应关系见 `DELTA.md` 第 3、4 项。

阶段 3 已实现 `workflow_run` / `workflow_step` / `supervisor_dispatch` 及工作流管理入口；真实 Desktop 共享连接仍未验证。当前可采用同一 Desktop 回合模式：用户授权持续推进后，主管派发 Pi，调用 `bri_wait_runs` 等待，收到结果后验收并继续；不要求先创建事件工作流，也不伪造 dispatch ACK。Controller 持续采集并保存状态；主管回合结束后仍不承诺自动唤醒。实际行为及边界以 `docs/codex-event-bridge.md` 为准。

## 5. 一轮主管回合要完成的动作

对应 `docs/aris-autonomous-workflow-plan.md` §6 的六步，全部使用现有工具。多项目环境下每个调用都显式带 `project_id`：省略时后端按默认项目查，非默认项目的回合会返回不存在。

```
1  确认作用域   bri_overview(project_id)
                → project.goal / plan_version / constraints、tasks、decisions、supervisorUpdates、lastChangeSeq
                有人接管或阶段目标已变 → 停在本步，转 §8

2  取新事实     bri_changes(project_id, since=<上次真正处理过的 seq>, limit)
                游标只推进到本轮处理过的最大 seq；分页未读完就继续读，不直接跳到 lastChangeSeq
                needs_decision 是提示，不能作为唯一筛选条件——成功结果也可能仍待验收

3  读产物       bri_inspect_run(run_id, after, project_id)   # run / task / events / decisions / logPaths
                bri_read_report(run_id, project_id)          # 完整最终报告正文，自动跨页不截断
                活跃或 unknown 的 attempt 不重复启动

4  核查         直接读 cwd 内源文件与结果文件，对关键结论作必要重算
                read_report 的工具契约本身要求：报告里每个关键数字用于结论前必须自己复核一遍

5  落结论       bri_record_decision(task_id, verdict, reason, evidence_ref)
                reason 含实测数字与出处；evidence_ref 给 Codex 亲自走到的位置或可重跑的复核命令

6  落实去向     accepted → bri_submit_task(下一项已授权工作, depends_on=<本 task_id>)
                revise   → 同回合内 bri_submit_task(修订任务, brief 点名具体缺陷) —— 见 ../auto-review-loop/WORKFLOW.md §3 第 3 条
                rejected → bri_publish_plan(在授权范围内重规划) 或列出需要用户决定的具体问题
                等待中   → 写清在等哪些 task_id / 哪个实验的结果完成条件

                派发之后回到第 2 步继续取新事实，**不在 accepted 处结束回合并交还用户**：持续授权
                仍然有效时，控制权只在「下一轮产物到达」与「§8 停止条件成立」之间流转。
                本轮任务全部 accepted 不等于研究完成——按 §7 逐条核对工作流目标，未满足就继续下一项。

7  汇报         bri_publish_update(project_id, summary, current_stage, direction_status, direction_reason,
                                   schedule_status, schedule_reason, next_step, evidence_ref)
                方向状态 ∈ on_track|at_risk|needs_decision|unknown；进度状态 ∈ on_track|at_risk|blocked|unknown
                一次单纯读取或分页不发布汇报；不从某个任务成功推断项目方向或进度
```

派发任何任务时，`bri_submit_task` 的 `brief` 必须自足：目标、必要背景与涉及文件、允许修改范围、交付产物、验收口径、停止条件；`cwd` 是远端绝对路径；默认工具只读，需要写能力时显式给 `tools`，`bash` 不保证只读。`start=false` 只登记不启动。提交返回 `run_id` 后保存它；超时或连接失败不盲目重复提交，先查 overview/changes 是否已登记或启动。

## 6. 每阶段产物落点

产物写在实验项目的 `cwd` 内。以下文件名沿用上游或沿用 `../experiment-bridge/WORKFLOW.md` §2 已确立的约定；标「本项目决定」的是本流程新定的落点。

| 阶段（`task.stage`） | 产物 | 位置 | 作者 | 进入评审的条件 |
|---|---|---|---|---|
| `plan` | 阶段目标与完成条件、授权范围、预算 | 项目计划（`project.goal`/`constraints`/`plan_version`），需要展开时 `<cwd>/refine-logs/RESEARCH_BRIEF.md`（上游同名，`RESEARCH_BRIEF.md` 在项目根） | Codex | 完成条件可逐条核对 |
| `plan` | 实验计划 | `<cwd>/refine-logs/EXPERIMENT_PLAN.md`（Claim Map、Experiment Blocks、Run Order、Decision Gate、成本预算） | Codex | 每个 Block 有 Success criterion，缺则不进入执行 |
| `literature` | 来源与实验条件表、原文抽验结果、留空项与原因 | `<cwd>/refine-logs/LITERATURE_SURVEY.md`（本项目决定；上游该阶段的对应物 `idea-stage/IDEA_REPORT.md` 属 idea 发现，不移植） | Pi | 每条出处可定位；拿不到的数据明确留空并写原因 |
| `experiment` | 实现、结果、逐条运行记录 | `<cwd>/` 内脚本与 `results/*.json`、`results/*.csv`、`*.log`；`<cwd>/EXPERIMENT_LOG.md`；`<cwd>/refine-logs/EXPERIMENT_TRACKER.md`（Codex 建表，Pi 逐条回写真实状态）；`<cwd>/refine-logs/EXPERIMENT_RESULTS.md` | Pi | 结果可解析；每个数字先给原始值再解释 |
| `review` | 评审请求 | `<cwd>/refine-logs/REVIEW_REQUEST.md`（见 `../experiment-bridge/REVIEW-REQUEST.md`） | Pi | 只给路径与评审目标，不给摘要、结论、引导 |
| `review` | 累计评审日志 | `<cwd>/review-stage/AUTO_REVIEW.md`（上游同名同目录） | Codex | 每轮只追加，不改写前几轮 |
| 阶段收口 | 阶段报告 | `<cwd>/review-stage/STAGE_REPORT.md`（本项目决定；上游对应 Stage 4 的 `NARRATIVE_REPORT.md`） | Codex | 见下 |
| — | 运行证据 | 远端 `BRI_REMOTE_BASE`（默认 `/home/user/bri-runs/<run_id>/`）的 `{prompt.txt,run.conf,out,err,meta,pgid,launch.log}` | Runner | 运行证据，不是科研产物 |

阶段报告必须包含（内容清单沿用上游 Stage 4 对 `NARRATIVE_REPORT.md` 的要求，收敛到阶段粒度）：问题陈述与核心主张、方法概述、带证据的量化结果（每条主张指向具体产物或复核命令）、图与表的清单（哪些已存在、哪些需人工制作）、限制与遗留项，外加本项目要求的完成条件对照：逐条写出已满足项与未满足项。

## 7. 完成条件

**阶段完成**，四个条件同时成立：

1. 该阶段计划内列出的每个任务都有终态 `decision`，且需要的都是 `accepted`；`revise` 或 `rejected` 意味着阶段未完成或已重规划。
2. 每个 `accepted` 的 `evidence_ref` 指向 Codex 亲自读过的源文件、产物定位或可重跑的复核命令。
3. 该阶段产物已在 §6 的位置落盘，阶段报告已写，完成条件对照无未满足项。
4. 下一步已落实为一个明确去向：派发了下一项已授权工作、或明确在等哪些 `task_id` 与实验的结果完成条件、或明确写出需要什么人工输入。

**工作流目标完成**：目标里的完成条件逐条对应到已 `accepted` 的产物。回合数、任务数、进程成功率都不是完成条件。上游 `acceptance-gate` 的判据在本项目仍然成立——去掉评审之后循环若能自行宣告停止，那个循环就在自我免罪；本流程里阶段推进只发生在 `bri_record_decision` 之后。

## 8. 停止条件

出现以下任一情况，停止自动推进并落到 `bri_publish_update`，不靠刷新轮次继续转：

1. 修订轮次、时间或资源预算用尽。这是**预算耗尽**，不是成功：最后一条 `decision` 保持 `revise` 或按结论记 `rejected`，`schedule_status = blocked`，`next_step` 写清需要人决定的具体问题与每项的估计工作量。出处：上游 Key Rules「If Stage 3 ends at round 4 without positive assessment, stop and report remaining issues. Do not loop forever.」与 Termination 第 6 步。

   项目级循环同样受**授权信封**约束：总 Pi 回合数、单回合超时、整体墙钟、修订轮次上限。这四个数字在授权时写进 `project.constraints`（或当轮 `bri_publish_update` 的 `schedule_reason`），是启动参数，不靠事后追认；到限即在此停止，**不得为了做完而静默延长**。注意与 §7 不冲突：这些数字是循环的**上限**，不是完成条件——没到限不构成完成，到了限也不构成成功。
2. 同一个未解决问题在连续轮次里以同一定位重复出现，且本轮已无新的具体处理方案（`../auto-review-loop/WORKFLOW.md` §3 第 4 条）。
3. 需要超出授权范围：改变研究问题、评价口径或 Success criterion、新增计划外的实验、扩大资源、`cwd` 之外的写入、`git commit`/`push`/发布、删除数据或 checkpoint、`BRI_SSH_ALIAS` 之外的机器。这些一律上交，不由 Pi 自行推进，也不由 Codex 自动改成宽权限（`docs/architecture-v1.md` §4、`../experiment-bridge/WORKFLOW.md` §5）。
4. 现有权限阻断了某个动作：呈现被卡住的具体动作，不绕过。
5. 宿主会话不可用：保持「等待连接」，不用高频模型轮询冒充事件驱动。
6. 人工接管：立即停止自动派发。是否取消已在跑的 Pi 由用户指令决定，`bri_cancel_run` 只在确认后使用。

无模型用量数据时 `unknown` 如实呈现，不把缺失当零成本。

## 9. 第一条试点阶段

`docs/aris-autonomous-workflow-plan.md` §3 建议的第一条真实试点：SF6/N2 项目里一个小范围文献数据交付——整理指定范围的来源与实验条件，抽验可获取原文，拿不到的数据明确留空并注明原因。这是计划，尚未执行。两条范围约束照原样保留：本阶段范围需由项目主管结合现有工作确认，不自动接管当前正在协调的研究，也不重跑已有任务；文献阶段不套用机器学习评测的 ground-truth 字段，出处、数字与完整性检查照做。

对应到本流程：`stage = literature`，产物落 `refine-logs/LITERATURE_SURVEY.md`，完成条件是「每条主张有可定位出处 + 缺口清单 + 留空原因」，验收全部走主管验收（称谓适用范围见 `DELTA.md` 第 2 节）。
