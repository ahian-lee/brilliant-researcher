# 保留的上游安全措施

出处：以下条款改写或节选自
[ARIS](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep) 的
`skills/shared-references/experiment-integrity.md`、`skills/shared-references/acceptance-gate.md`、
`skills/shared-references/reviewer-independence.md`、`skills/experiment-bridge/SKILL.md`、
`skills/run-experiment/SKILL.md`、`skills/monitor-experiment/SKILL.md`。
许可：MIT License，Copyright (c) 2026 wanshuiyin。
本文件只做角色重分配后的落点说明，逐字引用部分用引号标出，不删除原条款的约束强度。

移植时删的是「谁来执行」的假设，不是约束本身。下表每一条都能在删改后的流程里找到承担者。

## 1. 实验完整性（experiment-integrity.md）

核心原则原文：**「写实验代码的模型不得判断实验的完整性」**。本项目承担者从「另一个模型家族」换成 Codex Desktop，判断依据从 Pi 的报告换成产物文件与复核命令。

| 上游禁令 | 本项目落点 |
|---|---|
| 假 ground truth：用模型输出造参考、用 baseline 输出当 GT | B2 的 brief 固定写入该要求；`REVIEW_REQUEST.md` 第 5 条为必答项；GT 来源路径是提交评审的必填字段 |
| 归一化造假：用本方法自身输出的极值归一化以掩盖差结果 | Codex 复核归一化是否覆盖全部受比方法；原始分与归一分并列展示 |
| 幽灵结果：**「每个被主张的数字必须能追溯到真实输出文件」**；tracker 仍是 TODO 却标 DONE | `evidenceRef` 必须给产物定位或可重跑命令；`inspect` 的事件时间线可对照 Pi 声称的每次工具调用 |
| 范围不足：小样本用「robust」「extensive」「across settings」 | 汇总必须写明确切范围：N 个场景、N 个 seed、N 个配置；标签限定为 pilot / preliminary |
| 评测类型必须声明，并带主张上限 | `EXPERIMENT_RESULTS.md` 的 Summary 固定 `real_gt` / `synthetic_proxy` / `self_supervised_proxy` / `simulation_only` / `human_eval` 之一；`synthetic_proxy` 只允许「proxy consistency」级主张 |

原文的执行—评审分工（执行者收集文件路径，评审者自己读代码与结果）由 `REVIEW-REQUEST.md` 承担。

## 2. 验收门禁（acceptance-gate.md）

原文一句话原则：**「目标或循环可以 DRIVE，不能 ACQUIT」**——推进可以自主，免罪判定不行。

- Type-A（执行/客观）：退出码、文件存在、job 计数、指标可解析、无 NaN、预算计数耗尽。Pi 自行判定，有确定性检查时优先用检查结果而不是 Pi 的自我陈述。
- Type-B（质量/正确性/验收）：结论成立、评测口径正确、结果够强、可进入下一阶段。Pi 永不自判，判定动作只有 `decide`，只有 Codex 能写。
- 复合门禁要拆开：`WORKFLOW.md` §2 的 B3/B4 通过条件写成 Type-A 事实清单，里程碑放行条件写成 Type-B，不合并。
- 原文判据：**「如果去掉跨模型评审后循环仍然可以自行决定停止，那这个循环在自我免罪」**。本项目的对应结构是：Pi 回合收敛只产生 `succeeded`，不产生任何阶段推进权限；阶段推进只发生在 `decide` 之后。
- 原文的 fan-out 警告：同一模型的多个分支是「戴着陪审团外衣的相关性盲区」，多个一致意见不能充当 Type-B 结论。因此重试与并行不增加验收权重，只有 `verdict` 增加。
- 原文对 PASS 的定位：异源二次意见不是外部真值，绿灯降低风险而不转移责任。这条与技术方案 §1「研究方向始终有人负责」一致。

## 3. 评审独立性（reviewer-independence.md）

原文核心：**内容必须不过滤地到达评审人；执行者指向文件并说明评审目标，评审人自己读、自己判断。**

可传给评审人的：评审角色、评审目标、文件路径、结构性元信息、场地约束。
禁止的「主观干预」，本项目全部作为 `REVIEW_REQUEST.md` 的写作约束保留：执行者的摘要或转述、对结果的解读、建议或结论、抽取出的要点、引导性提问、上一轮评审意见的转述、「我改了 X/Y/Z」、断言当前方案优点的表述。

## 4. 执行侧硬规则（experiment-bridge / run-experiment / monitor-experiment 的 Key Rules）

| 上游规则 | 本项目落点 |
|---|---|
| 跟随计划，不自加计划外的实验；觉得缺什么只记录不添加 | `WORKFLOW.md` §5 第 1 条：需要新增实验即停下上报 |
| sanity first，未验冒烟不部署整批 | B3 先于 B4，B4 的提交由 Codex 在冒烟 `accepted` 后发起 |
| 结果一律存可解析的 JSON/CSV | B2/B5 的 `acceptHint` 固定该要求 |
| 每个数字先给原始值再解释；比较必须同配置同 baseline | B5 汇总模板与 §1 的范围声明 |
| 结果可疑时先查训练日志再下结论 | Pi 的报告需附日志路径（`logPaths` 与项目内 `*.log`） |
| 复用现有代码，先扫项目再写脚本 | B1 勘察任务的唯一产出物 |
| 自动调试预算：同一失败最多 2 次打补丁 + 2 次干净重写；两次重写成同一种失败即停止上报 | B3 与 §5 第 4 条，数字未放宽 |
| 丢弃只针对本次尝试自己生成的脚手架；计划、tracker、用户源码、数据、结果不可删 | §5 第 2 条：删除或大范围改写需上报 |
| 部署前必查 GPU 可用性，不盲目指派卡 | 由 Controller 的主机采样（`host-sample.sh`，30 秒一次）与 Codex 在 brief 中固定设备承担；Pi 不自行选择机器 |
| 预算意识：跟踪 GPU-hours，接近上限告警 | §5 第 6 条：超计划 2 倍耗时或逼近预算即停 |

上游「超过预估时间 2 倍就标记并继续下一里程碑」在本项目收紧为标记并停下等 Codex：静默跳过会让后续里程碑在未验收结论上继续花资源。

## 5. 委派与授权边界（既有措施，未削弱）

- 不得让 Pi 自行 `git commit` / `git push` / 发布 / 删除大范围路径 / 替用户决定未说明的架构与产品问题。收回结果后 Codex 必须检查实际改动并按风险运行验证。出处：`docs/reference/pi-agent/AGENTS.md`（远端原工作区规则，只读快照）。
- 首版禁止未经授权再向 Codex 委派，避免递归协调。出处：`docs/architecture-v1.md` §13 第 6 点。落点：Pi 到 Codex 的方向只有「提交产物 + 等待验收」一条路径，评审调用见 `REVIEW-REQUEST.md`。
- 不为集成绕过既有隔离措施。工具名不等于权限：`read,grep,find,ls,bash` 里的 `bash` 具备写入能力，要求只读时用不含 `bash` 的集合，并在收回结果时核对改动。出处：`docs/architecture-v1.md` §13 末段。
- 凭据不进网页与项目文档；页面只读不等于可公开暴露实验数据。出处：同上 §7。

## 6. 本项目新增的两条执行侧措施

不是上游条款，是为了对上 `WORKFLOW.md` §4 的取消语义与技术方案 §13 的实测事实而加：

1. 长实验不塞进 Pi 回合的 `timeoutMs` 里等待。wrapper 默认总超时 30 分钟，超时发 abort 后 SIGTERM，源码没有完整的进程组清理与 SIGKILL 升级路径，靠回合超时收尾会留下不可知的子进程状态；终止只走 `cancel`，它有进程组退出验证。
2. `retry` 会把工具集与超时回落到 Controller 默认值，因此需要写能力的阶段改用重新 `submit`。这条来自 `apps/controller/src/server.ts` 的 retry 路由实现，目的是避免修订轮次在只读工具集下反复失败。

## 7. 未移植的上游可选件

`/experiment-queue` 的 OOM 感知重试与 `queue_state.json` 断点续跑、Vast.ai 实例租用与 `auto_destroy`、Modal 无服务器 GPU、W&B 自动插桩、飞书推送。前两项涉及并发编排与外部计费资源，分别推到阶段 2 与「需 Codex 决策的授权外动作」；后三项需要外部凭据，按 §5 最后一条不进入本项目。
