# ARIS 工作流适配

技术方案 §11 阶段 0 要求「选择 ARIS 的一个工作流适配」，验收方式是「明确调用方式、产物与取消语义」。本目录是这项交付。

## 选定的上游工作流

**ARIS Workflow 1.5 `/experiment-bridge`（实验桥）**，取自上游仓库 `skills/experiment-bridge/SKILL.md`。

上游把它定义为「读实验计划 → 实现实验代码 → 跨模型代码评审 → 冒烟 → 部署到 GPU → 采集初始结果」，是 ARIS 里唯一真正落在执行侧的闭环：它上接 `/idea-discovery`（Workflow 1），下接 `/auto-review-loop`（Workflow 2），正文里直接调用 `/run-experiment`（部署）、`/experiment-queue`（大批量编排）、`/monitor-experiment`（观测）、`/training-check` 与 `/ablation-planner`；实验完整性评审在上游由 `/experiment-audit` 承担（见 `shared-references/experiment-integrity.md`、`acceptance-gate.md`）。选它是因为执行、监控、评审这三件事正好是本项目要重新分配角色的部分，适配它一次能覆盖 `docs/dashboard-design.md` 末节表格里「实验方案 / 实验执行 / 评审迭代」三行。

上游工作流编号来源 `docs/SKILLS_CATALOG.md`：Workflow 1 `/idea-discovery`、1.5 `/experiment-bridge`、2 `/auto-review-loop`、3 `/paper-writing`，端到端由 `/research-pipeline` 串起。本项目只移植 1.5，不移植调度层。

## 出处与许可

- 仓库：<https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep>
- 主文件：<https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/main/skills/experiment-bridge/SKILL.md>
- 许可：MIT，`LICENSE` 原文 `MIT License. Copyright (c) 2026 wanshuiyin.`
- 核验日期：2026-09-27。方式为实读上游 README、目录树与下列文件原文，不做转述推测。

本次逐字读过的上游文件：

| 文件 | 用于 |
|---|---|
| `skills/experiment-bridge/SKILL.md` | 流程本体、常量、阶段划分、Key Rules、自动调试预算 |
| `skills/run-experiment/SKILL.md` | 部署动作与 pre-flight 规则（判定哪些留、哪些删） |
| `skills/monitor-experiment/SKILL.md` | 观测动作（本项目整体替换为普通程序采集） |
| `skills/shared-references/experiment-integrity.md` | 实验完整性禁令，原样保留 |
| `skills/shared-references/acceptance-gate.md` | Type-A / Type-B 门禁划分，原样保留 |
| `skills/shared-references/reviewer-independence.md` | 评审输入不过滤，原样保留 |
| `templates/EXPERIMENT_PLAN_TEMPLATE.md` | 输入契约（Claim Map / Experiment Blocks / Run Order / Compute Budget） |
| `docs/SKILLS_CATALOG.md` | 工作流编号 |

## 保留了什么

1. **claim 驱动的计划作为唯一入口**。上游要求实验代码服从 `EXPERIMENT_PLAN.md` 的 Claim Map 与 Success criterion，不允许执行者自加实验。这条完整保留，并且是 Codex 验收时的对照物。
2. **里程碑顺序与决策门**：sanity → baseline → main → ablation，每个里程碑带 Decision Gate 与 GPU-hours 预算。
3. **sanity first**：不跑通最小最快的一条就不部署整批。
4. **自动调试预算**：同一失败最多 2 次打补丁 + 2 次干净重写，共 4 次；两次干净重写成同一种失败即停止上报。丢弃只允许作用于本次尝试自己生成的脚本，计划、tracker、用户源码、数据、结果不可删。
5. **结果必须可解析**：JSON/CSV 落盘，terminal 输出不算结果；tracker 逐条回写真实状态。
6. **全部安全措施**，见 `experiment-bridge/SAFETY.md`：评测必须用数据集自带 ground truth（上游标为 CRITICAL）、禁止 phantom results / 归一化造假 / 小样本冒充全面评估、评审输入只给路径不给摘要、执行者不得自判 Type-B。

## 删改了哪些角色假设

上游默认「执行者驱动 + 独立模型评审」，且执行者自己就是那个能发起评审、能 SSH、能起云实例的会话。这些假设在本项目按职责重新分配：

| 上游假设 | 本项目 |
|---|---|
| 执行者（Claude 会话）直接 `mcp__codex__codex` 发起跨模型代码评审，并自己决定评审是否通过 | Pi 不调用 Codex。Pi 写 `refine-logs/REVIEW_REQUEST.md` 并完成任务提交，Codex Desktop 从 `changes` 读到待验收、用 `inspect` / `report` 读证据、用 `decide` 落 verdict |
| 执行者自己 `ssh`、`screen -dmS`、`rsync`、`git clone`、`git add -A && git commit && git push` | Pi 只在 `submit` 给定的单个 `cwd` 内工作。代码同步与 git 写操作移出授权范围：需要提交或推送时由 Pi 停下上报，Codex 执行 |
| 执行者用 `/monitor-experiment` 轮询 `screen -ls`、`hardcopy`、`tail` 来观测 | 观测由 Runner 的 15 秒事件采集与 Controller 的 `change_log` 承担，页面上直接看，Pi 不为「还在跑吗」花 token |
| `MAX_PARALLEL_RUNS=4`、里程碑内 ≥10 job 时改路由 `/experiment-queue`、`queue_state.json` 断点续跑 | 首版一个 `submit` 一个任务一个活动 attempt，多里程碑由 Codex 按 `dependsOn` 手工串接。队列编排与并发属于阶段 2 |
| 计算环境可选 local / remote / Vast.ai / Modal，含实例租用与 `auto_destroy` | 主机由 Controller 配置固定为 `BRI_SSH_ALIAS` 一台。租用、销毁、跨机调度不在授权范围内 |
| W&B 自动插桩、飞书推送通知 | 移除。凭据不进项目文档与页面（技术方案 §7） |
| `CODE_REVIEW` 常量的评审模型写成具体模型名与 reasoning effort 档位 | 删掉模型路由，评审人是 Codex Desktop；`decide` 的 `reason` 与 `evidenceRef` 承担可追溯职责 |
| `/experiment-bridge` 结束时自动串到 `/auto-review-loop` | 改为向人类与 Codex 汇报下一步建议，是否进入修订循环由 Codex 决定 |

按技术方案 §13 第 6 点，首版禁止 Pi 未经授权再向 Codex 委派，避免递归协调；上表第一行就是这条规则的落地方式。同时按 `docs/reference/pi-agent/AGENTS.md` 的原工作区规则，不得让 Pi 自行 commit / push / 发布 / 删除大范围路径，也不得为集成扩大工具授权。

## 追加适配：研究流水线与评审修订循环（阶段 3C）

`docs/aris-autonomous-workflow-plan.md` §7 3C 要求的交付路径是 `workflows/research-pipeline/WORKFLOW.md` 与 `workflows/auto-review-loop/WORKFLOW.md`，两条都取自上游仓库：

| 文件 | 上游出处 | 复用的是什么 |
|---|---|---|
| `research-pipeline/WORKFLOW.md` | [skills/research-pipeline/SKILL.md](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/main/skills/research-pipeline/SKILL.md) | 阶段编排、阶段产物、继续/完成的语义；`done` 与 `accepted` 分离；有限轮次与预算停止 |
| `auto-review-loop/WORKFLOW.md` | [skills/auto-review-loop/SKILL.md](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/main/skills/auto-review-loop/SKILL.md) | 评审—修复—再评审；累计评审记录；`MAX_ROUNDS = 4`；它明确反对用定时器反复从头开启评审 |

核验日期 2026-09-28，方式为从 `raw.githubusercontent.com` 的 `main` 分支取原文逐字读完（`research-pipeline` 391 行，`auto-review-loop` 1138 行）。许可同上 MIT，`Copyright (c) 2026 wanshuiyin`。

上游工作流编号沿用 `docs/SKILLS_CATALOG.md`：`/research-pipeline` 是端到端编排层，`/auto-review-loop` 是 Workflow 2。这两条按 §2 的复用边界做了三处接入改写——评审触发改为 Controller 记变化后由 Codex 核查、修复动作改为 Codex 向 Pi 派修订、上游 `.aris/runs` 阶段文件状态映射到现有 SQLite 业务状态；模型硬编码、云实例管理、投稿与通知插件不移植。逐条差异与「主管验收」这一称谓的适用范围见 `research-pipeline/DELTA.md`。

执行、监控与取消语义只此一份：两条新流程都指向 `experiment-bridge/`，不再实现第二份执行器。

## 主持者接口要求（宿主中立）

未来任何一种主持者——第二个宿主、另一个模型，或人手动操作同一套 CLI——接入这套流程只需要下面这组能力，不需要也不应依赖任何宿主私有接口：

| 能力 | 现有实现入口 | 要求 |
|---|---|---|
| 读取项目、计划与变化 | `bri_list_projects`、`bri_overview`、`bri_changes` | 显式定位项目；恢复时先查在途工作 |
| 发布计划、派发任务 | `bri_publish_plan`、`bri_submit_task` | 产物、验收要求、资源与 `depends_on` 写清 |
| 等待、读取产物 | `bri_wait_runs`、`bri_inspect_run`、`bri_read_report` | 程序等待；读完整报告与必要文件 |
| 记录评审与汇报 | `bri_record_decision`、`bri_publish_update` | 如实记证据；登记判断不等于已派发 |
| 纠偏与停止执行 | `bri_run_control`、`bri_cancel_run` | 保留授权与取消确认语义 |

同一组能力在 `integrations/bri.mjs` 有 CLI 等价入口（`overview` / `changes` / `submit` / `wait` / `inspect` / `report` / `decide` / `plan` / `control` / `cancel`），业务实现与 MCP 共用——等待逻辑在 `integrations/lib/waitRuns.mjs`，两处 import 同一份。**工具未加载时用 CLI 继续已授权工作**，不因为聊天里看不到工具就判定能力不存在。

明确列为**未支持**：会话结束后的跨回合自动唤醒。Codex Desktop 的 app-server 控制 socket、共享宿主 proxy、`thread/load` 都是宿主私有实现，不是本流程的基础接口；没有它们时保持「等待连接」状态，不用定时轮询或另起隐藏主持者冒充事件驱动。

## 文件索引

- `experiment-bridge/WORKFLOW.md`：适配后的流程本体——阶段、职责、产物落点、真实命令、验收与取消语义、必须上交判断的情形。
- `experiment-bridge/REVIEW-REQUEST.md`：Pi 提交评审请求与 Codex 回写验收记录的模板。
- `experiment-bridge/SAFETY.md`：从上游原样保留的安全措施清单及每条在本项目的执行者。
- `research-pipeline/WORKFLOW.md`：阶段编排、阶段与执行回合的两层关系、状态与产物落点、主管每轮动作、完成与停止条件。
- `auto-review-loop/WORKFLOW.md`：评审—修订—再评审循环与它的硬性约束。
- `research-pipeline/DELTA.md`：上述两条与上游的逐条差异、未移植件、跨模型独立评审的缺失声明。

本目录只做工作流适配，不改 Controller、适配器或页面代码。文中所有命令字段与状态值取自 `integrations/bri.mjs`、`integrations/codex/plugins/bri-research/mcp/server.mjs`、`apps/controller/src/server.ts`、`packages/core/src/repo.ts`、`packages/core/src/projectViews.ts`、`packages/adapters/src/piRunner.ts`、`apps/controller/src/config.ts` 的当前实现。
