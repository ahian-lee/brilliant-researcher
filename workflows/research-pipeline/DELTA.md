# 与上游 ARIS 的差异清单（`/research-pipeline` 与 `/auto-review-loop`）

本文件是 `research-pipeline/WORKFLOW.md` 与 `auto-review-loop/WORKFLOW.md` 共用的差异说明。理由：两条流程来自同一上游仓库，触发改写、修复改写、状态载体替换、未移植件这四类差异对两者成立且内容相同，分两份会各自漂移。

出处：
- <https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/main/skills/research-pipeline/SKILL.md>
- <https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/main/skills/auto-review-loop/SKILL.md>

许可：MIT License，`LICENSE` 原文 `MIT License. Copyright (c) 2026 wanshuiyin.`。

核验日期 2026-09-28。方式：从 `raw.githubusercontent.com` 的 `main` 分支取两个文件原文并逐字读完（`research-pipeline` 391 行 / 22,866 字节；`auto-review-loop` 1138 行 / 70,309 字节），本文件里标「上游原文」的表述都出自这两份文本。`experiment-bridge` 及其 shared-references 的核验记录见 `../README.md` 与 `../experiment-bridge/SAFETY.md`。按 `docs/aris-autonomous-workflow-plan.md` §2，实施时再次核对实际版本并保留来源与许可，不额外建立 hash 或冻结流程。

本文件只做角色与状态载体的适配说明，不删减原条款的约束强度：每一条被替换的上游机制在两份 `WORKFLOW.md` 里都有一个承担者，每一条标为「不移植」的上游机制都不承担本项目任何验收职责。

引用约定：形如 `research-pipeline/WORKFLOW.md`、`auto-review-loop/WORKFLOW.md` 的写法是 `workflows/` 目录下的路径（与 `docs/aris-autonomous-workflow-plan.md` §7 3C 的交付路径一致）；形如 `../experiment-bridge/…`、`../README.md` 的写法相对本文件所在的 `workflows/research-pipeline/`。两者指同一批文件。

## 1. 触发：上游 agent 直接启动评审 → Controller 记变化，Codex 核查

上游的评审由**执行者自己发起**。`auto-review-loop` 的 `allowed-tools` 直接列 `mcp__codex__codex`、`mcp__codex__codex-reply`、`mcp__manual_review__review`；Reviewer Calling Convention 规定「If REVIEWER_BACKEND = `codex`: Use `mcp__codex__codex` for new review threads. Use `mcp__codex__codex-reply` for follow-up rounds (reuse threadId)」；`/research-pipeline` Stage 2 第 3 步写「Cross-model code review — GPT-6-Astra xhigh reviews the implementation … before any GPU time is spent」。也就是说，写代码的会话同时是那个决定何时请评审、并决定评审是否通过的会话。

| 上游 | 本项目 |
|---|---|
| 执行者会话在循环内部直接调用评审 MCP 工具 | Pi 不调用 Codex，也不调用任何评审工具。Pi 落 `refine-logs/REVIEW_REQUEST.md` 并提交任务 |
| 评审时机由执行者的进度判断决定 | Controller 把终态、产物变化、失败、`unknown` 写进 SQLite 的 `change_log`；主管回合读 `bri_changes(project_id, since)` 后进入核查 |
| 执行者自己决定评审是否通过 | 只有 `bri_record_decision(task_id, verdict, reason, evidence_ref)` 能写结论，只有 Codex 调用它 |
| 上游允许 overnight `/loop` / `CronCreate` heartbeat 唤醒 | 事件到主管会话的连接属 3A/3B，尚未验证；当前由用户在 Codex Desktop 触发回合。`bri-supervisor` 明确 MCP 不是自动唤醒服务，`docs/aris-autonomous-workflow-plan.md` §4.1 禁止假定同聊天可控 |

依据 `docs/architecture-v1.md` §13 第 6 点（首版禁止未经授权再向 Codex 委派，避免递归协调），Pi → Codex 方向只有「提交产物 + 等待验收」一条路径。

## 2. 修复：上游执行者自己实施修复 → Codex 向 Pi 派发修订

上游 Phase C「Implement Fixes」由执行者自己写/改实验代码、`SSH + screen/tmux` 部署到 GPU、跑分析、更新表格；Phase D 由执行者自己 `Monitor remote sessions for completion`，W&B 配置时调 `/training-check`。

| 上游 | 本项目 |
|---|---|
| 评审意见直接由执行者实施 | `bri_record_decision(verdict=revise)` 只登记判断，**不会自动启动修订**（工具契约原文）；同一回合内由 Codex `bri_submit_task` 派发修订任务，`depends_on` 关联被修订 task，`brief` 逐条写入要更正的具体缺陷 |
| 执行者自主决定改到什么程度 | Codex 定修订边界与允许修改范围；改评价口径、新增计划外实验、扩资源、`cwd` 外写入、`git` 写操作一律停下上报（`../experiment-bridge/WORKFLOW.md` §5） |
| 执行者自己轮询远端 session | Runner 15 秒事件采集 + `change_log` 增量；`bri_run_control(run_id, type=get_state/steer)` 看进展与纠偏，终止只走 `bri_cancel_run`（有进程组退出验证） |
| 新 attempt 可能是同一会话的延续 | 远端 wrapper 固定 `--no-session`，无会话恢复；新 attempt 是一次全新完整执行（`../experiment-bridge/WORKFLOW.md` §4） |

保留的上游强度：「Implement fixes BEFORE re-reviewing (don't just promise to fix)」原文照搬为 `auto-review-loop/WORKFLOW.md` §3.3——登记了 `revise` 而没派发任务的回合不算完成。

## 3. 阶段状态：上游 `.aris/runs` 状态文件 → 本项目 SQLite 业务状态

上游 `/research-pipeline` 的 RESUMABLE 条款：「the pipeline records per-stage state to `.aris/runs/<run_id>.json` so a crashed/interrupted run can resume via `/research-pipeline — resume <run_id>`」，通过 `run_state.py start/set/accept/resume` 维护；阶段序列 `idea-discovery, experiment-bridge, auto-review-loop, summary, paper-writing`；状态 `running / done / accepted / failed`；`accept` 必须带 `verdict id + reviewer`，并注明 durable handle（codex thread/trace id 或确定性校验报告的 path/sha）。`auto-review-loop` 另有一套 `review-stage/REVIEW_STATE.json`（每轮覆写）+ `ACQUITTAL_LOG.jsonl`（append-only 免罪回执）+ `review-stage/REVIEWER_MEMORY.md`。

本项目不在仓库里维护第二套会分叉的阶段状态库。逐条落到现有表和列（`packages/core/src/projectViews.ts`、`packages/core/src/repo.ts`、`apps/controller/src/server.ts` 的当前实现）：

| 上游字段/动作 | 本项目载体 | 读 | 写 |
|---|---|---|---|
| `run_state.py set <phase> running` | `run.status = starting/running` | `bri_overview` → `tasks[].run_status` | Controller |
| `done`（executor finished writing） | `run.status = succeeded`，来自 `PI_RESULT_JSON.success`；`final_report` 事件 | `bri_inspect_run`、`bri_read_report` | Controller |
| `accepted`（stage gate passed）+ `verdict id + reviewer` | `decision(action='accepted', reason, evidence_ref, author, plan_version, created_at)`；`author` 固定 `codex-desktop`（`repo.ts` `recordVerdict` 默认值） | `bri_overview` → `decisions`、`bri_inspect_run` → `decisions` | `bri_record_decision` |
| phase ∈ 五个上游阶段 | `task.stage ∈ literature\|plan\|experiment\|review\|writing` | `bri_overview` → `tasks` | `bri_submit_task(stage=…)` |
| `<run_id>` 与 per-invocation 绑定 | `project.id` + `project.plan_version`（决策记录带 `plan_version`，旧计划不能覆盖新计划） | `bri_overview` → `project` | `bri_publish_plan(expected_version)` |
| `REVIEW_STATE.json` 的 round / last_score / last_verdict / pending_experiments | 轮次与结论 = `decision` 序列；未解决问题 = 最后一条 `revise` 的 `reason`；进行中的工作 = `run_status ∈ starting/running` 与 `unknown` | `bri_overview`、`bri_changes` | `bri_record_decision` |
| resume（从第一个非 `accepted` 阶段继续） | 重启后同时核对未评审终态任务与 `queued` 派发；游标只推进到真正处理过的 `seq` | `bri_changes(since)` | — |
| `REVIEWER_MEMORY.md` / `AUTO_REVIEW.md` 累计评审记录 | `decision` 序列 + `<cwd>/review-stage/AUTO_REVIEW.md`（每轮只追加） | 同上 | Codex 写日志 |
| `run_id` 幂等（上游靠文件与 run_state） | 一个任务只存在一个活动 attempt（`createRun` 查到活动运行即抛错）、启动请求以 `run_id` 去重、事件按 `(run_id, source_seq)` 去重；任务提交侧的调用标识属 3B | — | — |

**语义保留**：上游那句「Stage status splits `done` (executor finished writing) from `accepted` (the … verifier passed)」和「Mark `accepted` ONLY after the stage's gate passes — never on the executor's own say-so」在本项目原样成立，承担者是 `run.status` 与 `task.verdict` 两个互不覆盖的字段（`../experiment-bridge/WORKFLOW.md` §3）。

**未移植**：`run_state.py`、`iteration_log.py`、`save_trace.sh`、`.aris/traces/`、watchdog 的 STALE 登记。`docs/aris-autonomous-workflow-plan.md` §5 提出的 `workflow_run` / `workflow_step` / `supervisor_dispatch` 三张表与 §7 3B 的工作流 `start/status/pause/resume/stop` 入口尚未实现；当前阶段状态由上表的现有记录组合，本文件不把它写成已有能力。

一处上游文本内部不一致，如实记录并给出本项目取值：`research-pipeline` Stage 2 第 4 步把 sanity 自查写成「auto-debugs failures (up to 3 attempts, with `/codex:rescue` fallback)」，而 `experiment-bridge` 的预算是同一失败 2 次打补丁 + 2 次干净重写共 4 次。本项目沿用已在 `../experiment-bridge/SAFETY.md` §4 落定的 2+2=4，不引用前一个数字（本项目决定）。

## 4. 停止判据：分数阈值 → 三值 verdict

上游停止条件：`score >= 6/10` **AND** `verdict ∈ {ready, almost}`，两个条件同时成立才停，且上游自己修正过早先的 `or` 写法与过期词表（原文：「the `AND` form is authoritative」）；判定由 `tools/review_gate.py` 的状态转移表执行，`tests/test_review_gate.py` 覆盖九条用例，helper 解析不到就发 `REVIEW_UNAVAILABLE` 而不是即兴判定。

本项目 `bri_record_decision` 的 verdict 词表是 `accepted/revise/rejected`，状态库没有分数字段。停止条件改为 **`accepted` 且上一轮未解决问题清单为空**（`auto-review-loop/WORKFLOW.md` §2）。本项目决定：这是载体差异，不是放宽——分数不进状态库，判定依据改由 `reason`（含实测数字与出处）和 `evidence_ref`（Codex 亲自复核的位置或可重跑命令）承担。schema 里只有 `reason` 必填，但 `bri_record_decision` 的契约原文是「accepted 只有在 reason 写明了你亲自复核过的具体、可核对证据后才提交；执行者自评的 success 不构成证据」，因此本项目把两者都按必填执行。同样保留的是「高分但 verdict 为 not ready 不停止」的等价形式：`run.status = succeeded` 不产生任何推进权限。

## 5. 不移植的上游机制

| 上游机制 | 出处 | 不移植的原因 |
|---|---|---|
| 模型硬编码与 backend 路由：`REVIEWER_MODEL = gpt-6-astra`、`model_reasoning_effort: xhigh`、`auto / copilot-native / copilot / codex / manual / oracle-pro / agy` 路由、`.github/agents/<profile>.agent.md`、`copilot --agent` 子进程、`codex exec` 的 nightmare 档、`rubber-duck` 原生子 agent | `auto-review-loop` Constants、Reviewer Calling Convention、Phase A | 评审人固定为 Codex Desktop。`docs/aris-autonomous-workflow-plan.md` §2 明确不照搬模型硬编码 |
| 模型身份与免罪记账：`REVIEW_STATE.json` 的 `executor_model` / `reviewer_model` / `family_relation` / `identity_assurance` / `independence_verified` / `native_evidence_id`、`ACQUITTAL_LOG.jsonl` 只追加回执、`REVIEW_UNAVAILABLE` 终止态、`review_gate.py --native-evidence` | `auto-review-loop` State Persistence、Append-Only External-Finalizer Receipt、Phase B.5.1 | 这些字段描述的是跨模型免罪回路，本项目没有该回路。不出现、也不借用它们指代本项目做过的检查（见 §6） |
| 云实例与远程执行：`/run-experiment` 的 SSH + `screen`/`tmux`、`local/remote/Vast.ai/Modal` 四类环境、实例租用与 `auto_destroy`、`/experiment-queue` 的 OOM 重试与 `queue_state.json`、`MAX_PARALLEL_RUNS = 4`、里程碑 ≥10 job 自动改路由 | `research-pipeline` Stage 2 第 5 步与常量注、`auto-review-loop` Phase C/D | 主机由 Controller 固定为 `BRI_SSH_ALIAS` 一台；租用、销毁、跨机调度不在授权范围内；队列与并发属阶段 2（`docs/architecture-v1.md` §11 与 `../README.md`） |
| 写作与投稿链：`/paper-writing`、`VENUE`（ICLR/NeurIPS/…）、Gate 2、`/paper-plan → /paper-figure → /paper-write → /paper-compile → /auto-paper-improvement-loop`、`/result-to-claim` 与 `CLAIMS_FROM_RESULTS.md`、`verify_paper_audits.sh`、BibTeX 反幻觉链（DBLP → CrossRef → `% [VERIFY]`） | `research-pipeline` Stage 5、Resumable 表、`auto-review-loop` Key Rules 与 Termination | `docs/aris-autonomous-workflow-plan.md` §2、§7 3E：写作与投稿不作为第一条自主闭环的前置要求 |
| 通知插件：`~/.claude/feishu.json` 的 `review_scored` / `pipeline_done` 推送与 interactive 门、W&B 自动插桩与 `/training-check`、`/render-html`（含 `--no-review`、嵌入源文件 SHA256） | 两个文件的 RENDER_HTML 常量、Feishu Notification 段、Stage 2 第 6 步 | 外部凭据不进项目文档与页面（`docs/architecture-v1.md` §7）。对外呈现是只读 Dashboard 与 `bri_publish_update` |
| 输出协议三件：versioning（先写时间戳文件再复制固定名）、manifest（`MANIFEST.md`）、language（项目语言设置） | 两个文件的 Output Protocols 段 | 本项目产物落点由 `research-pipeline/WORKFLOW.md` §6 的表固定，状态与索引在 SQLite；语言设置由写作约束（中文）承担 |
| overnight heartbeat 的 stall 检测与 forced structural pivot（`iteration_log.py note`，`stale ≥ 2` 换结构约束、`stale ≥ 4` 上报人）、watchdog 的 `loop` 型登记 | `research-pipeline` 开头横幅与 "Overnight heartbeat" 段 | 该机制依赖上游自带工具链。同类规则由本项目的「同一错误重复发生要换具体处理方案或明确标为受阻」承担（`auto-review-loop/WORKFLOW.md` §3.4），触发侧由 §3.6 的产物变化条件承担，程序侧不唤醒模型做判定 |

保留的强度：上游对 heartbeat 的定性——「A heartbeat may say "keep going," never "good enough"」、watchdog「only detects — it never acquits」——原样映射为本项目的职责边界：Controller 只决定「是否有新情况值得处理」，Codex 决定「证据是否成立、下一步值得做什么」。

## 6. 跨模型独立评审：本项目未实现，因此不声称通过

上游的独立评审不是修辞，是一套具体的跨模型机制：

- 评审人必须与执行者属于**不同模型家族**。`auto-review-loop` 的 copilot 路由按 `executor_family` 强制反向选择 profile（`openai → aris-reviewer-claude`、`anthropic → aris-reviewer-openai`），家族未知即 fail closed 发 `REVIEW_UNAVAILABLE`；同一模型的不同分支不构成独立意见。
- 通过判定需要可核对的外部回执：`review_gate.py` 的状态转移表、`ACQUITTAL_LOG.jsonl` 的 append-only 免罪记录、host-event 证据或 caller-declared 身份，并要求身份字段如实保留（原文规则「never promote different strings to independent attestation」）。
- nightmare 档让另一个模型用自己的读权限直接读仓库（`codex exec`），原文说明这是「the closest analog to a real hostile reviewer」，因为它绕开了执行者对上下文的过滤。
- `experiment-bridge` 的代码评审由 GPT-6-Astra 独立评审 Claude 写的实验代码，`/experiment-audit` 承担实验完整性评审。

本项目**没有实现**上述任何一项：

- 参与方法设计与实验规划的主管，和做核查与验收判断的主管，是同一个 Codex 会话。
- 不存在第二模型家族对本项目产物的独立评审回路，也没有 gate 状态机或免罪回执。
- `shared-references/reviewer-independence.md` 的「内容不过滤到达评审人」由 `../experiment-bridge/REVIEW-REQUEST.md` 以「Pi 只给路径与评审目标」的方式承接；`experiment-integrity.md` 的「写实验代码的模型不得判断实验的完整性」由 **Codex Desktop** 承担判定，判定依据从「另一模型家族的报告」换成「产物文件与 Codex 自己的复核命令」——这一点 `../experiment-bridge/SAFETY.md` §1 已经记录，本文件不改动它的表述。

由此两条硬规则（本项目决定；依据 `docs/aris-autonomous-workflow-plan.md` §3 末段与 §2「不能声称通过了未执行的 ARIS 审查」）：

1. **任何交付都不得声称通过了 ARIS 的独立审查或跨模型评审。** 文档、主管汇报、`decision.reason`、阶段报告、页面文案里不出现「独立评审」「跨模型评审」「jury」「acquittal」「independence verified」这类表述来描述本项目做过的检查；不引用 `REVIEW_UNAVAILABLE`、`identity_assurance`、`ACQUITTAL_LOG` 等上游术语暗示这些机制存在。上游评分与阈值不得直接代替本项目的具体完成标准。
2. **由同一主管做的方法与结论检查，一律称「主管验收」**（英文表述用 `supervisor acceptance`）。重要科学结论所需的独立上下文——未参与方法与实验规划的第二方——另行保留为后续工作，未执行就写未执行，不冒充已有跨模型验证。

这条命名规则不降低验收强度。主管验收仍然必须：直接读源文件而不是读摘要（`auto-review-loop/WORKFLOW.md` §3.1）；对关键结论作必要重算；`evidence_ref` 指向自己走到的位置或重跑的命令；`revise` 后实际派发修订（§3.3）；不接受未修正的错误（§6 结束条件）；阶段推进只在 `bri_record_decision` 之后发生。它限定的是这些检查应当被叫作什么。

## 7. 原样保留、未削弱的上游条款

| 上游条款 | 本项目落点 |
|---|---|
| `done` 与 `accepted` 分离；不凭执行者自评标记 accepted | `research-pipeline/WORKFLOW.md` §2、§4 |
| MAX_ROUNDS 有限；到轮次上限未通过就停止并报告遗留问题，「Do not loop forever」 | `auto-review-loop/WORKFLOW.md` §2、§3.5 |
| 不用外部定时器从头重开评审（wall-clock 触发 = 零新信号 + 全额 token） | `auto-review-loop/WORKFLOW.md` §1、§3.6 |
| 复审对照上一轮，评审历史 append-only 不重置 | `auto-review-loop/WORKFLOW.md` §3.2、§7 |
| 评审直接读产物，作者陈述不是证据 | `auto-review-loop/WORKFLOW.md` §3.1 |
| 修复先实施再复审，不只写承诺 | `auto-review-loop/WORKFLOW.md` §3.3 |
| Exhaust before surrendering：判「无法处理」前至少两条不同路径；「Never give up on the first attempt」 | `auto-review-loop/WORKFLOW.md` §3.4 |
| 如实记录负向结果与失败实验；不为分数掩盖弱点 | `auto-review-loop/WORKFLOW.md` §3.7 |
| SCOPE LIMITS 五条加信任边界例外；「Say plainly when something is correct. Do not manufacture findings.」 | `auto-review-loop/WORKFLOW.md` §5、`../experiment-bridge/REVIEW-REQUEST.md` §2 |
| 实验完整性禁令（假 GT、归一化造假、幽灵结果、范围不足、评测类型声明） | `../experiment-bridge/SAFETY.md` §1 |
| Type-A / Type-B 门禁划分；执行者不自判 Type-B | `../experiment-bridge/WORKFLOW.md` §3 |
| `AUTO_PROCEED` 的「沉默不等于同意」：上游原文「Never implement auto-proceed as "ask, then continue if there is no response." Once a turn ends, silence cannot resume the pipeline.」 | `docs/architecture-v1.md` §4「验收不是每个工具调用的前置门禁」+ `research-pipeline/WORKFLOW.md` §8：需要人决定时明确停下并写进 `next_step`，不把无人回复当作放行 |
| 预算意识与超出预估即上报 | `../experiment-bridge/WORKFLOW.md` §5 第 6 条、`research-pipeline/WORKFLOW.md` §8 第 1 项 |

## 8. 本目录文件索引

- `research-pipeline/WORKFLOW.md`：阶段编排、阶段与回合的两层关系、状态与产物落点、一轮主管回合的动作、完成与停止条件、第一条试点阶段。
- `auto-review-loop/WORKFLOW.md`：评审—修订—再评审循环、七条硬性要求、每轮动作与派发样例、结束条件、评审记录格式。
- `DELTA.md`（本文件）：逐条差异、未移植件、主管验收的命名边界。
- `../experiment-bridge/*`：执行侧流程本体、评审请求模板、保留的上游安全措施。执行器与取消语义只此一份，两个新流程都指向它。

本目录只做工作流适配，不改 Controller、MCP 适配器或页面代码。文中所有工具名、参数名与枚举值取自 `integrations/codex/plugins/bri-research/mcp/server.mjs`、`apps/controller/src/server.ts`、`packages/core/src/projectViews.ts`、`packages/core/src/repo.ts` 的当前实现。
