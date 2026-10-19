# 架构

[English](architecture.md) · [中文首页](../README_CN.md) · [工作台指南](research-workbench_CN.md)

Brilliant Researcher（BRI）在本地项目工作台中使用 ARIS 研究技能。默认路径由 DSH 原生会话执行，Codex 独立审核。历史 Direct/Pi 路径保留作兼容用途。

## 组件

```mermaid
flowchart TB
    Browser[本地浏览器工作台] --> Controller[本地 HTTP 控制器]
    Controller --> Core[项目范围、协作、审批与迭代]
    Controller --> Reader[ARIS 状态与成果读取]
    Controller --> Runtime[本地原生后台]
    Runtime --> DSH[DSH profile 与原生会话]
    Runtime --> Codex[Codex app-server 与原生线程]
    DSH --> Workspace[项目工作目录]
    Codex --> Workspace
    Reader --> Workspace
    Core --> State[本地项目注册与协作状态]
    Skills[随仓库提供的 ARIS 技能与助手] --> DSH
```

| 组件 | 源码 | 职责 |
| --- | --- | --- |
| 浏览器 | [apps/dashboard](../apps/dashboard) | 项目概览、对话、阶段、问答、图表、导出与历史 |
| 控制器 | [apps/controller](../apps/controller) | 本地 API、项目协调与构建后界面服务 |
| 核心 | [packages/core](../packages/core) | 项目状态、协作、迭代规划与范围判断 |
| 原生后台 | [runner/native-runtime-host.ts](../runner/native-runtime-host.ts) | 通过本地 HTTP 接口提供原生会话操作 |
| DSH driver | [dshDriver.ts](../packages/adapters/src/native/dshDriver.ts) | DSH 原生事件、提示、恢复、模型选择与交互 |
| Codex driver | [codexDriver.ts](../packages/adapters/src/native/codexDriver.ts) | Codex app-server 线程、回合、审批与问题 |
| ARIS 读取器 | [arisReader.ts](../packages/adapters/src/arisReader.ts) | 读取原生运行、审核与 trace 信息 |
| 工作目录读取器 | [arisWorkspace.ts](../packages/adapters/src/arisWorkspace.ts) | 在已注册根目录中发现技能定义、阶段成果和图表 |
| 导出 | [projectExport.ts](../packages/adapters/src/projectExport.ts) | 按明确排除规则打包支持的项目成果 |
| 研究基础 | [upstream/aris](../upstream/aris) | 随仓库提供的 ARIS 技能、流程定义与辅助工具 |

ARIS 文件来源于 commit `2132036060e03e8d0df69a4b21e5971819c0c2d6`。本次发布选取公开文件，并包含本地集成适配，不是完整未修改的上游 checkout。归属说明见 [NOTICE](../NOTICE)。

## 原生会话与协作

后台使用 DSH、Codex 原生会话标识与事件。每个 DSH 会话拥有独立进程和原生写入租约；Codex 通过 app-server 协议连接。BRI 保留本地会话元数据，用于重新连接或恢复对应的原生记录。记录持久化不表示停止的进程还在运行。

[NativeDriver](../packages/adapters/src/native/types.ts) 定义模型发现、打开/读取/发送、打断、配置、问题和权限答复，以及关闭操作。DSH 与 Codex 已实现该接口。接入其他 coding agent 需要编写 adapter 并验证这些操作；填写一个 provider 名称不会自动完成接入。

[workbenchCollaboration.ts](../apps/controller/src/workbenchCollaboration.ts) 将项目协作连接到 [collaborationLoop.ts](../packages/core/src/collaborationLoop.ts)。默认循环为 DSH 执行 → Codex 独立审核 → 返修或验收。新迭代可以从 Codex 审计与计划开始。方向调整会同步到已绑定会话并替代旧轮次，之前的结果不能作为调整后任务的验收。

普通工作可在已声明的项目范围内推进。范围、费用、资源和方向问题仍由用户决定。权限复核与问题使用现有项目对话。包括 full access 在内的宽泛执行能力不增加用户授权。

### 父子会话生命周期

原生协作桥提供 `create_agent`、`get_agent`、`wait_agent` 与 `send_agent_prompt`。登记的子会话记录父会话、协作、动作、方向修订和任务，并继承项目工作目录。协作写请求标明发起动作与修订，过期任务不能获得后续动作权限。子会话创建受整轮累计数量和项目并发限制。父会话交付后先确认子会话停止，再独立审核。暂停与调整方向会撤销旧权限、请求打断并等待可观测空闲；会话记录与成果保留。

恢复沿用原会话与动作，继续执行和仅重述格式分别有有限次数。发送结果不明不重放；真实受阻带原因停止，传输或状态读取失败保持可见。控制器通过有限并发和退避独立调度各项目，单项目不可用不应阻塞所有项目。

### 预算与计量

项目默认预算保存在工作台控制信息中，每个新协作轮次复制其已批准上限。修改默认值不会静默扩大活动轮次预算。时间和返修默认有限，可另设 tokens、美元、并发和累计子会话上限。后台派发与核心状态观测检查受管理动作及登记子会话的范围，工作台直接发送也附带范围。检查不替代提供方计费上限，也无法取消已经发起但尚未计量的消耗。

后台 `native-session-delta` 汇总绑定会话和子会话在本轮的用量增量。缺失 tokens 或费用仍是未知，设置上限却无法计量时阻止后续受管理派发。界面的会话用量与本轮用量是不同视图，不能叠加。保存默认预算不会恢复已耗尽轮次。

## 状态与证据

- 送达确认表示收到请求。
- 完成的回合或 `done` 阶段描述执行状态。
- `accepted` 表示对应成果通过所配置的独立审核。
- `audited` 配合 `no_change` 计划表示只完成审计，没有新增执行或新的科学验收。
- 收纳项目只是把项目放入已完成列表，不会验收成果或停止活动会话。

流程定义是计划，不是结果。读取器检查原生成果和审核记录，不会把所有声明的阶段自动视为完成。模型目录也不同于真实回合记录的实际模型，界面分别展示配置和运行观测。

之前的轮次与成果保持可查。阶段进展依据适用的验收记录，重做影响的阶段会在新轮次中更新。软件验收不代替领域专家对科学主张的判断。

## 本地配置与启动

`npm run setup` 创建缺失的本地配置，不覆盖已有配置或项目注册。`npm run connect` 交互选择可执行文件、现有 agent home/profile 与后台端口，保存前展示改动并保留无关设置；不安装 agent、不读取凭据。`npm run doctor` 不调用模型，只检查设置、健康与提供方发现，不验证认证或推理。

`npm start` 在 8791 提供工作台，`npm run dev` 使用 Vite。`npm start -- --with-runtime` 可同时启动两项服务；同端口后台报告另一配置时拒绝复用，保留已有后台。启动器清理自己启动的后台，已运行且配置匹配的后台仍由原宿主管理。也可独立启动 `npm run runtime`，默认端口 8793。高级配置见 [examples](../examples)。

直接执行 TypeScript 与使用 `node:sqlite` 需要 Node.js 24。ARIS 助手需要 Python 3。Windows 下看板/控制器和原生后台直接运行，基于 Bash 的 ARIS 助手通过 WSL 调用。具体技能可能需要额外的软件包、工具、凭据和数据集。离线看板运行验证网页应用，不会验证模型调用。

界面通过顶部栏的 **EN / 中文** 按钮切换英文和中文，具体实现在 [i18n.tsx](../apps/dashboard/src/i18n.tsx)。语言切换只影响界面文案，保留项目内容、agent 输出、成果和上游技能的原语言。核心使用文档提供两种语言版本；MIT 法律文本和上游技能不做全量翻译。

### 源码与部署

启动器所用的源码 checkout 是唯一部署来源：除非显式指定 `--no-build`，启动时按当前源码重建界面。更新另一 checkout 或复制界面构建不能更新正在运行的控制器与后台。按 [README](../README_CN.md#从源码升级) 更新实际安装，重启归属它的进程，再确认页面版本与后台连接。原地保留本机配置、项目根目录和原生会话 home；不随源码公开，也不使用另一安装的状态覆盖。当前不提供自动更新器或跨安装状态迁移。

### Windows 后台托管

需要进程脱离启动终端的 Windows 用户，可使用 [DashboardWindowsHost.cs](../runner/DashboardWindowsHost.cs)、[dashboard-readonly.ps1](../runner/dashboard-readonly.ps1) 与 [native-runtime-service.ps1](../runner/native-runtime-service.ps1) 提供的托管组件。使用前查看参数并适配本机安装。这是高级部署方式，终端快速启动不需要它。

看板宿主使用 detached 子进程和 Job Object，把清理行为绑定到拥有进程的宿主。服务脚本管理计划任务启动和恢复。关闭浏览器不同于停止服务；主动停止时应使用服务的 stop 操作。Vite 开发页面仍能访问不能证明控制器正常。

Linux、macOS 是兼容目标，但完整服务和真实 agent 流程尚未全部实测。当前 GitHub CI 在 Ubuntu、Node 24 上执行软件检查；Windows 服务行为与真实提供方访问仍需本机验证。

## 信任与数据边界

控制器与原生后台面向可信机器上的本地使用。原生后台拒绝来自浏览器 Origin 的调用，并要求内部请求头；该请求头不是身份认证密钥。服务没有面向互联网的身份边界，请保持绑定 localhost。

工作目录读取器把成果访问限制在已注册项目根目录内，包括符号链接解析后的路径。导出排除已知凭据、原始会话、依赖和缓存路径，并明确报告限制或错误。分享前检查 ZIP：研究文档和数据自身仍可能包含敏感内容。

本地配置、模型凭据、研究项目和原生会话记录不进入公开发布。原生 agent 可能把提示与选定项目内容发送给配置的模型提供方；本地托管不意味着离线推理。详见 [SECURITY.md](../SECURITY.md)。

## 验证边界

[README](../README_CN.md#已验证范围) 与[工作台说明](research-workbench_CN.md#验证范围) 记录了真实 agent 实跑的版本与场景。[tests](../tests) 包含后台、协作、恢复、预算、调度、界面、工作目录与导出软件检查。隔离测试、提供方列表或构建成功不能证明真实执行或科学验收；代表性实跑也不能证明所有 ARIS 技能、模型服务或操作系统已验证。
