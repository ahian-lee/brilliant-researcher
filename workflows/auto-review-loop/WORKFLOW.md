# 评审—修订—再评审循环（适配自 ARIS `/auto-review-loop`）

出处：<https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/main/skills/auto-review-loop/SKILL.md>，MIT License，Copyright (c) 2026 wanshuiyin。核验日期 2026-09-28，逐字读完全文（main 分支，1138 行）。与上游的逐条差异、以及「主管验收」这一称谓的适用范围见 `../research-pipeline/DELTA.md`。

上游原文对自己的定义：「Autonomously iterate: review → implement fixes → re-review, until an independent reviewer gives a policy-approved positive assessment or MAX_ROUNDS is reached」。本流程保留这个骨架和它的有限轮次约束，替换三处角色：评审人是**当前主持者**（落地为 Codex Desktop，宿主绑定见 `../../docs/codex-event-bridge.md`），修复动作改由主持者向 Pi 派发，评审历史落在现有 SQLite 的 `decision` 序列上。执行侧的调用与取消语义沿用 `../experiment-bridge/WORKFLOW.md`。

命名约定同 `../research-pipeline/WORKFLOW.md`：「主持者」是角色名，「执行者」指 Pi；`codex-desktop`、`bri_*` 是固定取值或接口名。

## 1. 循环本体

```
待评审产物
   ↓
Codex 核查（直接读源文件 + 必要重算）
   ↓
bri_record_decision(task_id, verdict, reason, evidence_ref)
   ├─ accepted 且上一轮未解决问题清空 → 退出的是**本评审循环**，不是研究回合：按
   │     ../research-pipeline/WORKFLOW.md §5 第 6 步推进下一项或回到第 2 步继续
   ├─ revise → 同回合内 bri_submit_task 派发修订 → Pi 修订任务 → 新产物
   │           ↓
   │      对照上一轮未解决问题清单再评审（不重置审查历史）
   └─ rejected → 重规划或请求用户决定
```

循环的运行单位是**产物变化**，不是时间。上游在文件开头就用一条禁令把这件事说死：

> Do not wrap this skill in `/loop`, `/schedule`, or `CronCreate`. It already loops internally (review → fix → re-review) and the reviewer carries round-to-round memory in one `threadId` (`codex-reply`). An external timer re-enters from the top each tick — fresh `threadId`, reviewer memory reset — firing the verdict on wall-clock time instead of on artifact change: zero new signal, full token cost. If you want to schedule something, schedule the *external wait that precedes it*.

本项目把这条落成 §3 第 6 条的硬性要求。

## 2. 常量与停止条件

| 项 | 上游取值 | 本项目取值 | 性质 |
|---|---|---|---|
| 轮次上限 | `MAX_ROUNDS = 4`；`/research-pipeline` Stage 3 同样写「up to 4 rounds」 | **默认 4 轮**，作为工作流授权配置，可在项目授权里调整；调整后写进计划（`bri_publish_plan`）并在 `bri_publish_update` 的 `next_step` 里说明 | 与上游同值；可配置是本项目决定 |
| 停止条件 | `score >= 6/10` **AND** `verdict ∈ {ready, almost}`，两个条件必须同时成立；verdict 词表是 `{ready, almost, not ready}`，高分但 `not ready` 不停止循环 | `bri_record_decision(verdict = accepted)` **AND** 上一轮未解决问题清单为空。`bri_record_decision` 的 verdict 词表是 `accepted/revise/rejected`，状态库没有分数字段，分数只作为 `reason` 里的可核对表述出现 | **本项目决定**（载体差异，不是放宽） |
| 评审人 | `REVIEWER_MODEL = gpt-6-astra` + `model_reasoning_effort: xhigh`；`REVIEWER_BACKEND` 有 `auto/copilot-native/copilot/codex/manual/oracle-pro/agy` 多种路由，靠 `review_gate.py` 做状态转移 | 评审人是当前主持者（落地为 Codex Desktop），不写模型名与 reasoning 档位，不搬 backend 路由与 gate | 本项目决定，见 `DELTA.md` 第 5 项 |
| 累计评审记录 | `review-stage/AUTO_REVIEW.md`（cumulative log）+ `review-stage/REVIEWER_MEMORY.md`（append-only，评审人自有）+ `review-stage/REVIEW_STATE.json`（每轮 Phase E 覆写，只保留最新一轮状态） | `decision` 表逐条记录（含 `reason`、`evidence_ref`、`plan_version`、`created_at`）+ `<cwd>/review-stage/AUTO_REVIEW.md` 累计日志 | 载体替换，见 §7 |
| 人工检查点 | `HUMAN_CHECKPOINT = false`，默认全自动；`true` 时每轮评审后暂停，展示分数与弱点，等用户回复再实施修复 | 授权范围内的修订不新增确认；超出已授权的阶段、资源范围或动作才需要人点头（`docs/architecture-v1.md` §4、`docs/aris-autonomous-workflow-plan.md` §6） | 语义一致，表述不同 |
| 反驳回合 | `REVIEWER_DIFFICULTY = hard/nightmare` 才有辩论协议：执行者最多反驳 3 条，评审人裁 SUSTAINED / OVERRULED / PARTIALLY SUSTAINED 并改分 | 采用同一动作但换主体：Pi 在修订报告里可以指出评审意见的事实性误读（读错文件、用错指标、wrong split），Codex 必须自己复核该反驳指向的行与产物后再改判，不能凭 Pi 的陈述改判 | 本项目决定 |

## 3. 七条硬性要求

### 3.1 评审从产物开始，不从报告开始

上游给评审模型的原文：「Review the work directly from its artifacts — executor notes are not evidence, so read the files yourself rather than trusting my framing」，以及「Trust nothing the author tells you — verify everything yourself」；nightmare 档把这条做实——「Verify that reported numbers match what's actually in the output files」「check if evaluation metrics are computed correctly (ground truth, not model output)」。

落点：

- **关键结论由 Codex 直接读源文件并作必要重算。** 读 `<cwd>` 里的实现、`results/*.json`、日志与表，按结论性质重算：计数、求和、比例、口径一致性、样本与 seed 范围。重算命令与实测数字写进 `evidence_ref`。
- **Pi 的摘要只能导航，不能自证。** `bri_read_report` 用来定位文件、判断这一回合做了什么，其工具契约本身就要求「报告里的每个关键数字在用于结论前必须自己复核一遍」。`bri_inspect_run` 的事件时间线用来对照 Pi 声称的每次工具调用是否真发生过。
- Pi 报告里的「通过」「验证正确」「结果好」一律算作者主张（`../experiment-bridge/WORKFLOW.md` §3 第 3 条）。`decision.reason` 里出现的判定依据必须是 Codex 自己走到的位置或自己跑的命令。

### 3.2 复审必须对照上一轮未解决的问题，不能每轮重置审查历史

上游用三样东西保证这件事：`mcp__codex__codex-reply` 复用同一个 `threadId`（「Use `mcp__codex__codex-reply` for follow-up rounds (reuse threadId)」）；`REVIEWER_MEMORY.md` 「Append-only — never delete, never truncate. The file is a reviewer-owned audit trail. The executor must never summarize, curate, or edit prior rounds' content」；第二轮起的提示词原文「Since your last review these files changed — read them yourself; do not take my word for what changed or whether it worked」。hard 档提示词还直接要求「Check whether your previous suspicions were genuinely addressed or merely sidestepped」。

落点，每轮评审的开头三步不可省略：

1. 取回上一轮未解决问题清单：`bri_overview(project_id)` 的 `decisions`（最近 20 条）或 `bri_inspect_run` 的 `decisions`，找到本 `task_id` 链上最后一条 `revise`，把它的 `reason` 拆成逐条待核问题。清单跨阶段时同时读 `<cwd>/review-stage/AUTO_REVIEW.md` 的前几轮。
2. 逐条判定：已解决（给复核到的文件与数字）/ 未解决（给仍然错在哪）/ 问题已变形（说明变成了什么）。
3. 新的 `decision.reason` 按这份逐条判定写。高分式的整体好评不覆盖未解决项；「本轮重新通读了一遍、看起来没问题」不是对上一轮问题的回答。

本项目决定：审查历史以 `decision` 序列 + `AUTO_REVIEW.md` 承载，不引入 `threadId`、`REVIEW_STATE.json`、`REVIEWER_MEMORY.md` 这些第二套状态。轮次游标（`bri_changes` 的 `since`）只记「处理到哪儿」，不是审查历史；游标推进不等于问题关闭。

### 3.3 `revise` 必须实际派发修订任务

上游 Key Rules：「Implement fixes BEFORE re-reviewing (don't just promise to fix)」。本项目 `bri_record_decision` 的工具契约同时写明「revise 只登记判断，不会自动启动修订；后续由主管显式提交新任务」，因此这条要落到动作上：

- 登记 `revise` 的**同一回合内**必须 `bri_submit_task` 派发修订任务，`depends_on` 关联被修订的 `task_id`，`brief` 把要更正的具体缺陷逐条写进去，并带上上一轮 `reason` 原文。
- 只写建议、只留一条 `revise` 记录而不派发任务的回合，视为该轮未完成，不得对外表述为「已进入修订」。
- 需要写能力或长超时的修订用重新 `bri_submit_task` 并显式给 `tools`/`timeout_ms`，不用 `retry`——`retry` 会把工具集与超时回落到 Controller 默认值（`../experiment-bridge/SAFETY.md` §6）。
- 无需重做已验证且不受本次修改影响的工作（`bri-supervisor`）。
- 修订产物落回 §7 的记录位置，新 attempt 的 `run_id` 与 `task_id` 写进累计日志，使下一轮能定位到「改了哪里」。

### 3.4 同一错误重复发生：换具体处理方案，或明确标为受阻

上游 Key Rules 的「Exhaust before surrendering」：把任何评审关切判为「无法处理」之前，(1) 至少试 2 条不同的解决路径，(2) 实验问题就调超参或换一条替代 baseline，(3) 理论问题给出更弱的版本或替代论证，(4) 到这一步才允许收窄承认并界定影响范围；「Never give up on the first attempt」。

本项目决定，把它做成可核对的判据：

- **同一问题的定义**：同一 defect 定位（同一文件与行、同一断言、同一数字口径、同一缺失产物）在连续两轮的 `decision.reason` 里再次出现。
- **第三次派发必须改变具体处理方案**之一：改评价口径的实现方式、换 baseline 或换数据集切分、换获取原文的途径、把结论收窄到实际支撑得住的范围。方案变化写进新 `brief`。
- 拿不出新方案时，`bri_publish_update` 记 `schedule_status = blocked`、`direction_status` 按事实，`next_step` 写成需要人提供的具体输入（凭据、原文、授权扩大、放弃某条主张）。
- 重跑同一 attempt、刷新轮次计数、扩大 `timeout_ms` 都不算换方案。「大量重试不自动等于研究进展，Type-A 修复预算用尽后继续投入要靠 Codex 决策」（`../experiment-bridge/WORKFLOW.md` §3 第 4 条）。上游实验侧的同一失败 2 次打补丁 + 2 次干净重写预算照此保留。

### 3.5 达到预算是「预算耗尽」，不是「成功」

上游 Key Rules：「If Stage 3 ends at round 4 without positive assessment, stop and report remaining issues. Do not loop forever」；Termination 第 6 步要求列出 remaining blockers、逐条估计所需工作量、并建议手工继续还是转向。`/research-pipeline` 对同一预算的两处表述一致：Stage 3 写「up to 4 rounds」，阶段报告模板写「Review rounds: N/4」。

落点：

- 轮次、时间或资源预算用尽时，**最后一条 `decision` 保持 `revise`，或在结论被证伪时记 `rejected`；不得写 `accepted`**。
- `bri_publish_update`：`schedule_status = blocked`；`direction_status` 按事实（通常是 `at_risk` 或 `needs_decision`）；`next_step` 写「预算耗尽，需要人决定 A 或 B」；`evidence_ref` 指向最后一轮的 `decision` 与阶段报告的未满足项。
- 阶段报告的完成条件对照里，逐条列出未满足项与各自所需工作量。
- 没有模型用量数据时 `unknown` 如实写，不把缺失当零成本（`docs/aris-autonomous-workflow-plan.md` §6）。

### 3.6 纯日志重复不能重开评审

本项目决定，落实 §1 引用的上游禁令：

- **新一轮评审的唯一触发条件是产物发生变化**：修订任务的新 attempt 进入终态、`<cwd>` 里出现新的结果文件或报告、上一轮 `decision` 的未解决项被实际改动。
- 同一个 `run_id` 的事件在 `bri_changes` 里重复出现不构成新事实；同一 attempt 不重复评审；已有 `accepted`/`rejected` 结论且无新结果时不再评审（`bri-supervisor`）。
- `needs_decision` 是提示，不能作为唯一筛选条件：成功结果也可能仍待验收，失败结果也可能带可用产物。
- 游标只推进到本轮真正处理过的最大 `seq`；分页未读完就继续读，不直接跳到 `lastChangeSeq`。
- 主管自己写回状态库的动作同样会进变化流，它们不是新结果。按 `packages/core/src/db.ts` 的 `noteChange` 与 `packages/core/src/repo.ts` 的调用点，`change_log.kind ∈ project / plan / task / run / run_unreachable / decision / supervisor_update`：`decision` 恒为 `needs_decision=0`，`supervisor_update` 只在 `direction_status=needs_decision` 或 `schedule_status=blocked` 时置 1，`plan`、`task`、`run` 启动与取消都是 0；`run` 只在进入终态时写变化，且仅终态为 `failed` 或 `unknown` 置 1，`succeeded` 与 `canceled` 置 0；`run_unreachable` 由采集侧置 1，重新可观测后清回 0。能触发新一轮评审的事实只有 `run` 终态伴随的**新产物**；`decision` 与 `supervisor_update` 是上一轮动作的回写，不把它们再次当作新结果触发自己（`docs/aris-autonomous-workflow-plan.md` §4.2 触发表末行）。

### 3.7 结论可追溯，负向结果如实记录

上游 Key Rules：「Be honest — include negative results and failed experiments」「Do NOT hide weaknesses to game a positive score」。与 `../experiment-bridge/SAFETY.md` §1 的幽灵结果条款同源：每个被主张的数字必须能追溯到真实输出文件。落点：`evidence_ref` 必填实义（`host:path` 或 `run_id+seq`，或可重跑的复核命令）；tracker 仍是 TODO 却声称完成、样本量小却写「robust / extensive / across settings」这类，直接记 `revise` 并把定位写进 `reason`。

## 4. 一轮的具体动作

```
1  取回上下文   bri_overview(project_id)
                → decisions（本 task 链上最后一条 revise 的 reason = 待核问题清单）
                → tasks（该阶段的 task 与各 attempt 的 run_status）
2  确认有新事实  bri_changes(project_id, since=<上次真正处理过的 seq>)
                无产物变化 → 本轮不评审，只更新游标，不发汇报
3  读产物       bri_inspect_run(run_id, after, project_id)
                bri_read_report(run_id, project_id)          # 仅用于导航与定位
4  直接核查     读 <cwd> 内源文件与结果文件；对关键结论重算；逐条判定 §3.2 的三类结果
5  落结论       bri_record_decision(task_id, verdict, reason, evidence_ref)
6  派发修订     verdict = revise → bri_submit_task(...)      # 同回合内，见 §5
7  汇报         bri_publish_update(project_id, current_stage='review', ...)
8  收口         游标推进到本轮处理过的最大 seq；未读完继续读
```

`revise` 的登记与派发参数样例（字段名以 `integrations/codex/plugins/bri-research/mcp/server.mjs` 为准）：

```json
{
  "task_id": "task_xxx",
  "verdict": "revise",
  "reason": "上一轮问题 1（评测 GT 来源）已解决：改用 ImageNet val 官方标签，见 results/val.json 的 label_source 字段。问题 2 未解决：报告称 12 个 run 全部 ok，实测 ok 结尾为 11 行，末行是完成标记；问题 3 未解决：top-1 与脚本 stdout 的 78.4 不一致，results/val.json 记 76.1",
  "evidence_ref": "run_xxx#seq=318; ssh example-host 'grep -c ok$ resume.log'; ssh example-host 'cat results/val.json'"
}
```

```json
{
  "project_id": "sf6n2",
  "title": "M2 修订：核对 run 计数与 top-1 口径",
  "brief": "上一轮评审（task_xxx）未解决问题两条：(1) refine-logs/EXPERIMENT_RESULTS.md 声称 12 个 run 全部 ok，实测 resume.log 中 ok 结尾 11 行；(2) 同一文件记 top-1 78.4，results/val.json 实为 76.1。本轮任务：逐 run 核对完成判据并把实际计数写进 tracker 第 5–16 行；把 top-1 的口径统一定为 results/val.json 字段，如要保留 78.4 需给出它的来源文件与计算方式。允许修改范围：refine-logs/EXPERIMENT_RESULTS.md、refine-logs/EXPERIMENT_TRACKER.md、results/ 下的汇总脚本输出。不得改动 results/val.json 与评测脚本的指标实现。交付：更新后的两个文件 + 一份逐 run 对照表。验收口径：报告里每个数字都能指向 results/ 或 resume.log 的具体行。停止条件：需要改动评测口径或新增实验时停下上报，不要自行扩大范围。",
  "cwd": "/home/user/<project>",
  "stage": "review",
  "tools": "read,grep,find,ls,bash,edit,write",
  "timeout_ms": 1800000,
  "depends_on": "task_xxx",
  "accept_hint": "逐 run 给出日志行号与 results 字段定位；两个数字（11/12 与 76.1/78.4）都要有明确结论",
  "start": true
}
```

## 5. 修订工作的取舍顺序

沿用上游 Phase C 的优先级规则，落到本项目的派发上：

- 需要超出预算的算力才能解决的关切：标为人工跟进（`schedule_status` 与 `next_step` 写清），不擅自扩大资源。
- 需要拿不到的外部数据或原文：明确留空并写原因，这是本项目文献试点阶段的正常交付形态（`docs/aris-autonomous-workflow-plan.md` §3）。
- 分析口径修正与新实验两者都能回应同一关切时，优先前者。
- 廉价的补充指标照常加。
- 上游「超过 30 分钟的实验先起再并行处理其他修复」在本项目改为：长进程登记与续采由 Controller 承担，不把长实验塞进 Pi 回合的 `timeout_ms` 里等（`../experiment-bridge/SAFETY.md` §6）。

评审范围约束沿用上游 Phase 2.5 / auto-review-loop 各档提示词末尾的 SCOPE LIMITS 五条加信任边界例外，已在 `../experiment-bridge/REVIEW-REQUEST.md` §2 落了一份，本文件不重复；作用对象相同：限定提出来的**处理方案**范围，不限定去查什么。正确的地方直说，不制造发现——上游原文「Say plainly when something is correct. Do not manufacture findings」。这条在本项目的作用是防止轮次在虚构缺陷上空转。

## 6. 结束条件

| 结束方式 | 判据 | 必落的调用 |
|---|---|---|
| 通过 | `verdict = accepted`，且上一轮未解决问题清单为空，每条判定都有 Codex 自己复核到的文件与数字 | `bri_record_decision`、`bri_submit_task`（下一项已授权工作）、`bri_publish_update` |
| 判否 | 结论不成立或计划本身错，重跑同一 task 无意义 | `bri_record_decision(verdict=rejected)`、`bri_publish_plan`（授权范围内重规划）或向人列出需要决定的问题、`bri_publish_update` |
| 预算耗尽 | 达到 §2 的轮次/时间/资源上限仍未通过 | `bri_record_decision(verdict=revise)` 保持真实结论、`bri_publish_update(schedule_status=blocked)`、阶段报告写未满足项与工作量估计 |

未修正的错误不能被接受。这一条是 `docs/aris-autonomous-workflow-plan.md` §7 3C 的通过标准之一，也是本循环存在的意义。

## 7. 评审记录

`<cwd>/review-stage/AUTO_REVIEW.md` 每轮**只追加**，不改写、不压缩前几轮（对应上游 REVIEWER_MEMORY.md 的 append-only 规则）。每轮条目：

```markdown
## Round <N> — <日期>
- 被评审对象：task <id> / run <id> / attempt <n>
- 本轮对照的上一轮未解决问题：<逐条，含上一轮 decision_id>
- 逐条判定：已解决（复核到的文件:行 或 数字）/ 未解决 / 问题已变形
- Codex 实际读过的文件与重算命令
- decision：<dec_id> <verdict> reason 摘要 evidence_ref
- 派发的修订：task <id> / brief 要点
- 状态：继续第 N+1 轮 / 通过 / 判否 / 预算耗尽（<已用轮次>/4）
```

本项目决定：上游模板里的「Reviewer Raw Response」（评审模型原文逐字保存）换成「Codex 实际读过的文件与重算命令」——本项目的评审人就是执行核查的 Codex 会话，没有一段外部模型的原文可存。上游对原文与 trace 的坚持（「the raw text is the primary record」「The memory file is a summary; the trace is evidence」）在本项目由 `bri_inspect_run` 的事件时间线、远端 `logPaths` 与 `evidence_ref` 承担。

## 8. 本循环不产出什么

不产出分数、不产出跨模型独立评审、不产出论文工件（`CLAIMS_FROM_RESULTS.md`、`/render-html`、飞书推送都不移植）。核查由同一主管完成，一律称**主管验收**；不得表述为通过了 ARIS 的独立审查。命名边界与依据见 `../research-pipeline/DELTA.md` 第 2 节。
