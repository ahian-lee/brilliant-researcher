# BRI & CUE-Agent 研究结果 / Research Results

截至 2026-11-23 · Results through November 23, 2026 · [English](#english)

**主要发现**：核对用户要求、授权和环境证据，能发现固定得分遗漏的错误。现有实验尚未证实历史经验复用提高完整任务成功率，也尚未证实 BRI 比单独使用 Codex 更有效率。

## 中文

| 实验 | 已取得的结果 |
| --- | --- |
| VitaBench 回执盲区 | 在构造的开发候选中，95.0% 的规格不符调用仍返回看似成功的回执。基于回执的无标签探针未显示预测力，按该探针筛选也未降低固定覆盖率下的风险。 |
| VitaBench 需求核对 | 在历史留出划分上，37 个任务、342 条主评估决策，确定性需求规则的任务宏 AUROC 为 **0.658 对 0.518**，相对信任回执提升 0.140，95% 配对 bootstrap 区间为 [0.100, 0.179]。PR-AUC 为 **0.289 对 0.158**。对手写规则的非劣检验未通过（差 −0.013，p=0.400）。重组 数量、商家重叠等扰动的压力测试复用了 74/74 个旧开发锚点，结果显示与手写规则的差异对候选构成敏感。留出集实际评估两次，偏离原协议。首次结果文件已被覆盖，修复前后主指标相等无法独立复核。 |
| 合成调度与轻量判别 | 调度实验中，带反例条件和无经验的 Mini 同为 **7/8**，逐例动作一致，手写规则为 **8/8**。AnyJev 探索的 51 条合成诊断中，加相同示例的单次概率读出与短 JSON 均为 **42/51**，但分别错误放行 **6/24** 与 **3/24** 违规例。AnyJev L0 为 **36/51**。这批数据未建立准确率或端到端速度优势。 |
| τ² 零售经验复用 | 十个开发目标中四个拥有完整三组对照，六个保留不完整结果，来源共六组。原规则在八个已执行选择点全部弃权。固定 LLM 选择器在一个重复案例中多用 **15,988 token**，固定分与最终数据库相同。统一执行层下，七个实际注入对照中五个同时满足目标一致与回放对齐，零个能核实完整任务效用差。研究状态为 **证据不足，未训练选择器**（INSUFFICIENT_SIGNAL / NO_TRAIN）。 |
| τ-bench 与 ToolSandbox 复现 | 原版 τ-bench 对「已登记且扣款待核实」和「已扣款」均给满分，漏做换货时给 0。六条同任务归档均得到满分却缺扣款证据。接入 ToolSandbox 后，证据检查还能区分未授权写入、事后确认、错退款方式与回复前缺交易证据。另一项四条归档中，调用顺序检查从 **0/4 到 4/4**，52 份工具回执与完整终态匹配。 |
| 零售执行可靠性 | **86 条开发回放、735 份原工具回执**与完整终态匹配，19 条试点回放另行核对。修复覆盖逐笔派发、已提交步骤的恢复、报价和确认核对、撤回与独立退货，以及区分申请、账本记录与到账。退款压力测试中，用户确认退 0.82 美元后，旧流程会登记退 0.32 美元或扣 0.18 美元。修复后四个价格变化用例均拦在写入前，金额不变的两例照常执行。 |
| ReasoningBank 接入 | 用核验结果走原版提取入口，13 条归档中 **7 条**改变了成功或失败提示词的选择，缺证据的对照保留未知。再以人工归纳经验、本地词频排序和原版候选选择例程做 12 条回放，逐条匹配 100 份工具回执。按文本使用经验误改了一笔有记录的付款。加订单证据约束后，全部答复与直接核对相同，未测到额外收益。原版模型提取和嵌入检索尚未验证。 |
| BRI 与单 Codex | 两类合成任务、三种配置，每格一次。首轮 60,000 token 阈值下，五次超限，零个在阈值内完整通过。第二轮 200,000 token 上限下，只有单 Codex 的配对分析在预算内通过（145,538 token）。四个 BRI 运行均超限，配对分析的两份 BRI 产物通过确定性评分，事务任务中同模型 BRI 的产物通过，DSH/Codex 产物仍有重复提交问题。小样本、协作开销和模型差异限制解释。 |
| BRI 故障接管 | 真实 SQLite、脚本角色的组件对照共 **16 次检查**达到各自的预期。开启接管后，额度错误与 503 两个可恢复场景完成后续审核，每次数据库只提交一次。回执丢失的情况保留未知。这组结果验证了组件行为，真实模型恢复表现仍待验证。 |

上述结果区分真实模型小试、模拟器回放与组件测试。回放使用保存的回复与模拟数据，历史留出集的数字来自已有报告。尚缺可信的任务级收益标签、独立泛化验证，以及实测的同预算协作优势。

## English

**Main finding.** Checking user intent, authorization, and environment evidence reveals failures missed by fixed scores. The experiments have yet to establish either a whole-task gain from experience reuse or an efficiency advantage for BRI over Codex alone.

| Study | Findings |
| --- | --- |
| VitaBench receipt blind spots | 95.0% of specification-mismatched calls in the constructed development candidates returned success-looking receipts. Unlabeled receipt probes showed no predictive value, and their gate did not reduce risk at fixed coverage. |
| VitaBench requirement checks | On the historical held-out split, 37 tasks contributed 342 primary decisions. The deterministic requirement check reached task-macro AUROC **0.658 vs. 0.518** for trusting receipts, a difference of 0.140 with paired bootstrap 95% CI [0.100, 0.179]. PR-AUC was **0.289 vs. 0.158**. Non-inferiority to the handwritten baseline failed (difference −0.013, p=0.400). A composition stress test reused all 74 development anchors and showed sensitivity to candidate composition. The held-out set was evaluated twice, departing from the protocol. The first result file was overwritten, leaving the reported pre/post-fix equality unverified. |
| Synthetic scheduling and lightweight judging | Mini with and without counterexample conditions produced identical actions and scored **7/8** in the corrected scheduling study; a handwritten rule scored **8/8**. In a 51-item AnyJev diagnostic, prompted single-pass readout and short JSON generation each agreed on **42/51**, but falsely allowed **6/24** and **3/24** violations, respectively. AnyJev L0 agreed on **36/51**. An end-to-end speed or accuracy advantage remains unproven. |
| τ² retail experience reuse | Four of ten development targets had complete three-arm comparisons across six source groups. The original rule abstained at all eight observed selection points. In one repeated case, the fixed LLM selector cost **15,988 additional tokens** with the same fixed score and terminal database. With a shared execution layer, five of seven actual injections had aligned replay and matching annotated goals; zero yielded a verifiable whole-task utility difference. Status remains **INSUFFICIENT_SIGNAL / NO_TRAIN**. |
| τ-bench and ToolSandbox | The original τ-bench grader gave full credit to both a qualified reply and an unsupported charge claim, and correctly failed an omitted exchange. Six archived branches from one task passed despite unsupported charge claims. ToolSandbox-based evidence checks distinguished unauthorized writes, late consent, wrong refund destinations, and missing pre-reply transaction evidence. In another case, the tool-order check went from **0/4 to 4/4**, with 52 receipts and all terminal states matching. |
| Retail execution reliability | **86 development replays and 735 original receipts** matched terminal databases. A separate audit covered 19 pilot replays. Fixes covered serialized dispatch, recovery without replaying completed steps, quote and consent checks, withdrawal and independent returns, and distinguishing requests from settlement. In a refund stress test, the old flow could reduce a confirmed $0.82 refund to $0.32 or turn it into a $0.18 charge. The fix blocked all four changed-price cases and preserved both unchanged-price cases. |
| ReasoningBank integration | Verified outcomes changed the original success/failure prompt routing for **7 of 13 archived branches**. Cases with missing evidence stayed unknown. Twelve replays with a manually summarized memory, local lexical ranking, and the original selector matched 100 receipts. Text-only application altered a supported payment claim. Adding transaction evidence reproduced the direct evidence rule's replies without observable extra gain. Model-based extraction and embedding retrieval remain untested. |
| BRI vs. Codex alone | Two synthetic tasks and three configurations, one run per cell. At 60,000 tokens, five runs exceeded the threshold and zero fully passed within budget. At 200,000 tokens, only the standalone Codex analysis passed within budget (145,538 tokens). All four BRI runs exceeded the cap. Both BRI analysis artifacts passed deterministic grading. The same-model BRI transaction artifact passed, while the DSH/Codex transaction artifact failed duplicate-write checks. |
| BRI failure recovery | A scripted component comparison on real SQLite met the expected outcomes in **16 checks**. Recovery enabled subsequent review after a quota error and an HTTP 503, with one database commit per case. Lost acknowledgements remained unknown. Real-model recovery performance remains unmeasured. |

The findings cover live-model pilots, simulator replays, and component checks at their stated scopes. Replays used saved drafts and simulated state. Historical held-out values came from existing reports. Reliable whole-task utility labels, independent generalization evidence, and a measured same-budget collaboration advantage remain open.

