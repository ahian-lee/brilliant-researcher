# Changelog / 更新记录

## 0.2.0 — 2026-10-15

- Native parent/child orchestration records ownership and action/revision, bounds child creation and concurrency, and waits for child shutdown before review or a new direction. / 原生父子协调记录归属及动作/修订，限制子会话与并发，在审核或新方向前确认子会话停止。
- Finite continuation and format-only recovery preserve artifacts and surface real blocked reasons; uncertain sends are not replayed. Project scheduling uses independent bounded ticks and backoff. / 有限继续执行和仅重述格式的恢复保留成果，展示真实受阻原因，不重放结果不明的发送；项目独立调度并有限退避。
- All free, selected-skill and full-workflow modes offer managed execution → independent Codex review → repair. ARIS research instructions remain selected explicitly; managed orchestration replaces nested reviewer/repair loops. Direct execution remains available without automatic independent acceptance. / 自由、单项技能及完整流程均可选执行→独立 Codex 审核→返修；显式选择 ARIS 研究指令，宿主协调替代内部审核/返修循环；直接执行不自动获得独立验收。
- Project budget editing and per-round approved caps cover duration, repairs, tokens, USD, concurrency and total child sessions. Native usage remains unknown when unreported, rather than zero. / 项目预算与轮次上限覆盖时间、返修、tokens、美元、并发和累计子会话；未报告的原生用量保留未知，不记作零。
- EN/中文 overview separates human decisions from automatic permission review, puts artifacts and matching review beside the summary, folds long plans, and preserves drafts and redo scope. / 双语概览区分人工决定与自动权限审核，摘要旁展示成果及匹配审核，折叠长计划，保留草稿与重做范围。
- Interactive `connect`, no-model `doctor`, combined `start --with-runtime`, and source-based rebuild/upgrade instructions preserve existing local configuration and project registration. / 交互连接、不调用模型的诊断、联合启动和源码重建升级保留已有本机配置与项目注册。
- Native metadata replacement tolerates brief Windows sharing locks; persistent save failures are visible and prevent unsaved dispatch. Restart recovery reacquires the original native owner without replaying uncertain sends. Proven empty Codex threads can recover while retaining the BRI session binding. / 原生元数据保存容忍 Windows 短暂共享锁，持续失败明确显示并阻止未保存的派发；重启时恢复原生 owner，不重放结果不明的发送；已证明为空的 Codex 线程可恢复并保留 BRI 会话绑定。
- Windows agent launches restore a missing `PATHEXT`; connection setup supports Node CLI entries for either agent. Streaming replies are labelled as generation using actual message progress. / Windows 启动补齐缺失的 `PATHEXT`，连接向导支持两种 agent 的 Node CLI 入口；流式回复按真实消息进展显示“正在生成回复”。
- Project summaries reuse shared report reads within each call and avoid a duplicate overview scan; subsequent requests still read current files with the same containment checks. / 项目摘要在单次调用内复用共享报告，避免概览重复扫描；后续请求仍读取最新文件并保留路径安全检查。

**Representative live acceptance passed.** Native DSH execution and two actual DSH/Codex child sessions, independent rejection and automatic repair, in-flight direction synchronization, native question answering, six passing component tests, browser behavior, figure preview, result export and budget stops were exercised. This does not validate every ARIS skill, model or scientific workflow. Boundaries are in [English README](README.md#validation-status) and [中文 README](README_CN.md#已验证范围).

**代表性真实验收已通过。** 已实跑 DSH 原生执行、DSH/Codex 两个真实子会话、独立拒绝与自动返修、中途方向同步、原生问答、组件 6 项测试、浏览器行为、图表预览、成果导出和预算停止。这不代表全部 ARIS 技能、模型和科研流程已验证。

The public source includes selected MIT-licensed ARIS files from commit `2132036060e03e8d0df69a4b21e5971819c0c2d6`, with local integration adaptations and retained attribution. / 公开源码包含来自该 commit 的部分 MIT 许可 ARIS 文件、本地集成适配与保留的来源声明。
