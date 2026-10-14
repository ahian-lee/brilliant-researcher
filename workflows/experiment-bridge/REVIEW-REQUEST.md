# 评审请求与验收记录模板

出处：改造自 ARIS `/experiment-bridge` 的 Phase 2.5 评审提示词与 `skills/shared-references/reviewer-independence.md`，二者均在
<https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep>（MIT License，Copyright (c) 2026 wanshuiyin）。
删去的角色假设：原提示词由执行者（Claude 会话）通过 `mcp__codex__codex` 直接发起，并粘贴脚本正文；本项目改为 Pi 只落一份请求文件，评审人固定是 Codex Desktop。

依据上游 `reviewer-independence.md` 的明确规定——内容必须不过滤地到达评审人，执行者只提供文件路径和评审目标——本模板只列路径与目标，不写 Pi 的摘要、结论、修改说明或引导性问题。上游 Phase 2.5 提示词里「paste the experiment scripts」的写法与这条协议相冲突，本项目采用协议一侧：粘贴执行者选剪的正文，等于让评审人读执行者的框架而不是代码本身。

## 1. Pi 写入 `refine-logs/REVIEW_REQUEST.md`

```markdown
# Review Request — <里程碑 / Block 名> <日期>

## 评审目标
判断这份实验实现是否正确执行了计划，以及在进入下一里程碑前是否存在会导致错误结论的缺陷。
不要以我的判断为前提。

## 待审文件（请自行完整阅读）
- 计划：refine-logs/EXPERIMENT_PLAN.md（Block <N>，Claim <Cn>）
- 方法描述：refine-logs/FINAL_PROPOSAL.md
- 实现：<script_train.py> / <script_eval.py> / configs/<run>.yaml
- 结果：results/<run>.json，日志 logs/<run>.log
- 运行记录：tracker 第 <N> 行；run_id <run_xxx>，事件游标 --after=<seq>
- 评测 ground truth 来源：<数据集与 split 的具体路径>

## 请逐条回答
1. 实现是否忠实于 FINAL_PROPOSAL.md 描述的方法？
2. 计划里声明的超参是否全部进入实现？有没有实现中凭空出现的值？
3. 有无逻辑缺陷（损失函数、数据切分、漏评、评测与训练用了不同 split）？
4. 评测指标的计算是否正确？归一化是否覆盖了 baseline 而不只是本方法？
5. CRITICAL：评测对照的是数据集自带 ground truth，还是另一个模型 / backbone 的输出？
6. 有无 OOM 风险、数值不稳定、seed 未固定？

每条缺陷标 CRITICAL / MAJOR / MINOR，并指出具体文件与行。
```

Pi 不在这个文件里写「我认为问题在于…」「建议改成…」「这个结果说明…」，也不写上一轮评审意见的转述、自己改了什么。同一请求里不夹带对自己结论的辩护。

## 2. Codex 的评审范围约束

保留自上游 Phase 2.5 的 SCOPE LIMITS，作用对象从评审模型换成评审人自己，用于把评审限制在「这份实验对不对」：

1. 这是研究工作流的实现评审，不是安全审计；假设是同一个人自己的机器与自己的代码。
2. 不提议加 hash / 指纹绑定式的校验机制。
3. 不做推测性建设：不要求加特性开关、兼容层、包装器，除非有当前缺陷或既有不变量作为证据。
4. 不为罕见边角场景展开：能证明这条路径在本实验里会发生，才提。
5. 需要判断清单时用可读的句子，而不是没人维护的打分表。

例外：会执行远端命令、起网络服务、安装依赖的代码属于凭据与影响面边界，这类发现照常提，默认从严。

正确的地方直说。不制造发现。

## 3. Codex 回写验收

评审落在状态库里，一条 `decide`：

```bash
node integrations/bri.mjs decide --file=decision.json
```

```json
{
  "taskId": "task_<被评审任务的 taskId>",
  "verdict": "accepted",
  "reason": "评测对照 ImageNet val 官方标签，12 个超参与计划逐一对应，seed 固定；results/val.json 的 top-1 与脚本输出一致",
  "evidenceRef": "run_<xxx>#seq=<n>; refine-logs/EXPERIMENT_RESULTS.md#M1; grep -c '^acc' results/val.json"
}
```

- `verdict` 只有 `accepted|revise|rejected` 三值，作用于 task 的研究结论，与 run 的进程状态互不覆盖。
- `reason` 写「依据什么判定」，不写「感觉可以」。
- `evidenceRef` 至少给一条能重跑的复核命令或产物定位，让第三方能确认这次验收不是执行者自评。
- `revise` 时在同一句里点名要改的具体缺陷，随后按 `WORKFLOW.md` 的 B7 提交带 `stage:"review"` 的修订任务。
- `rejected` 用于结论不成立或计划本身错：此时不重跑同一 task，回到 B0 由 Codex 修计划，必要时向人说明放弃理由。

## 4. 交给 Codex 之前必须存在的字段

请求缺以下任一项时，Codex 直接以 `revise` 退回补齐，不进入实质评审：

- 结果 JSON 的路径与字段样例；
- 评测 ground truth 的具体来源（数据集名 + split + 文件路径）；
- 声明的评测类型（`real_gt` / `synthetic_proxy` / `self_supervised_proxy` / `simulation_only` / `human_eval`）；
- 每个数字可回溯的产物文件或复核命令；
- tracker 已回写的真实状态。
