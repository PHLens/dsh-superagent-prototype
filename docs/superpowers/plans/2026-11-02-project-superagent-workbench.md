# 项目型 Superagent 工作台实施计划

日期：2026-11-02（Asia/Shanghai）

状态：本次需求校正后的唯一实施计划。此提交只保存规格、历史源码审计和计划，产品实现从原型基线重新开始。

依据：[产品规格](../specs/2026-11-01-project-superagent-workbench-design.md)、[原型复用审计](../specs/2026-11-01-superagent-prototype-reuse-audit.md)。本文件取代旧 implementation plan 和 execution-ready plan；旧提交及试做代码保留在 Git tag `archive/dev-before-workbench-replan-2026-11-02`，不是当前依赖。

## 1. 目标与边界

用户从手机或电脑打开统一首页，进入某个项目，与该项目的 Superagent 讨论并确认目标。Superagent 自己安排后台执行，把成果和需要用户决定的问题带回来。用户管理项目、目标和决定，不管理 Session、worker、任务清单文件或调度脚本。

KORAM 是一个研究项目，其调研、代码、实验和写作共享项目背景。GitHub 仓库是可选资源；没有 GitHub 的项目也能创建、对话和执行文件任务。所有服务和数据运行在一台 Mac，经 Tailscale 私网访问；Mac 离线时暂时不可用。一个飞书机器人以私聊承担跨项目通知和回复入口。

最终主流程：

```text
创建或进入项目 → 对话、轻量调查 → 保存方案 → 用户确认一次
    → coordinator 形成内部 Assignment 图
    → 应用验证范围与依赖 → 调度 worker → 登记成果与报告
    → 引擎推进已登记的依赖、复核和完成条件
    → 需要新判断时唤醒 coordinator；成果与待决事项回到项目入口
```

外部自动派发曾用于绕过旧 router 无法处理整个实施计划的限制，属于临时开发工具。OAuth sender、Feishu 任务注入、外部 manifest、dispatcher/watch/launchd 都不是产品架构或发布前置，不再安排 D0–D4 开发任务。开发期间可以人工提交边界明确的实现任务，也可使用已有本地工具；不得把这种交付方式变成最终用户流程。

## 2. 保留的底座与必须改变的行为

| 保留 | 改造要求 |
| --- | --- |
| SQLite、事务、Effects、Outbox 和状态目录锁 | 增加项目归属、方案授权和可恢复执行；保持单写者 |
| Ticket / Assignment 引擎 | 产品 Task 使用同一个 Ticket 身份和聚合，不创建第二套独立任务状态机 |
| DSH Session / Workspace / executor | 项目 coordinator 按需建立，Assignment/attempt 显式绑定 Session/cwd，不再由 Ticket 名称推断 |
| Source / Channel、现有面板组件 | Web 项目对话是完整入口；飞书是另一输入和通知渠道，不能承担内部任务队列 |
| 提示词组合、revision 和模型选择机制 | router 改为能讨论、形成方案和拆解的 coordinator；worker 使用通用交付规则 |

共同合同：

- 项目、消息、方案、授权、任务、执行和成果均有服务端固定的归属；工具、查询、缓存和文件访问按归属检查。
- 应用数据库保存业务事实；DSH 保存执行现场；工作文件保存实际内容。清单是数据库导出，不恢复或扩张授权。
- 普通讨论无需创建 Ticket。方案可以在草稿 Task/Ticket 上修订；没有有效 Authorization 时引擎不派发。
- PlanRevision 不可变，Authorization 绑定方案版本、稳定用户身份和确认意图。确认重发只产生一个执行目标；过期确认不授权新版本。
- Task 的用户状态由同一聚合投影，Assignment 是正式工作分工，attempt 是一次执行尝试。新旧模式的 Ticket 可区分，legacy Mandate 不转换成新方案授权。
- 用户确认目标、范围、资源、完成标准和成本边界；范围内的拆分、依赖推进和常规修复不逐步骤再审批。扩大范围才修订方案并请求确认。
- 用户暂停/停止跨重启保持。普通消息、外部评论、子执行回报和渠道重连不隐式恢复任务。
- 完成以全部必要成果及验证为准；旧 attempt 的报告不能更新新尝试。不能确认的外部操作先核对，不盲目重跑。
- 已登记流程由引擎自主推进，不等待 coordinator 对每份报告再次审批。coordinator 暂时不可用时，只等待需要新判断的步骤；其单写者约束不串行化 worker、报告接收或其他项目。
- 按角色和阶段提供技能候选，正文按需读取并记录版本；技能不增加授权。不同执行者不自动继承完整历史或技能正文。
- 应用逻辑隔离不等于 OS 沙箱。复用当前用户身份运行，不重新建设 Agent runtime 或跨机系统。
- 实现不部署现有服务、不改机器人凭证和当前运行状态。代码工作交付到 `dev` 的可审阅 PR；部署和迁移在最后的独立验收中处理。

## 3. 内部任务拆解的责任与接口

拆解是项目 coordinator 的职责。模型提出有结构的分工，应用验证并持久保存，现有引擎执行；不引入另一个依赖飞书发信的调度服务。复杂规划或专业复核可以委派给正式 worker，主会话只接收必要摘要、证据和选择，不承担全部调查与规划细节，也不增加一层常驻规划 Agent。

### 3.1 判断、执行与业务事实的分工

| 职责 | 负责方 | 进入条件 |
| --- | --- | --- |
| 理解目标、比较方案、提出或调整分工、解释结果 | 项目 coordinator，可委派规划/复核 worker | 用户对话、明确的决策门或需要新判断的异常 |
| 校验报告与成果、放行既定依赖、分配执行槽、执行已登记重试及完成规则 | 应用引擎和执行适配器 | 持久状态满足既有授权、证据、预算和运行条件 |
| 调研、代码、实验、验证及范围内常规修复 | worker | 服务端已登记并调度的 Assignment |

“调研 A、B 完成后启动汇总 C”只需登记一次。A、B 的已约定证据通过后，引擎直接放行 C；它不为这次放行调用模型。若下一步取决于研究结论或需要比较新方案，必须事先登记决策门或在报告核对时进入待判断状态，只阻塞受它影响的分支。

确定性推进不能把 `ready` 或自由文本当作充分完成证据。方案/Assignment 中必须明确必要成果、检查或复核、已登记的自动重试条件及上限；需要语义验收的结果使用明确的复核 Assignment 或决策门。任务完成由全部必要条件聚合决定，不能以 coordinator 最后一条回复或最后一个 worker 的 `ready` 代替。

复核 Assignment 完成与被复核成果通过是不同事实。复核/决策门在现有 Assignment 或协作记录中独立保存 `passed`、`changes_required` 或 `needs_judgment` 结论及证据，绑定项目/任务/门、被检查的 Artifact id 与内容版本、验收条件版本，以及服务端解析的已登记判断者和有效执行/协调代次。只有匹配该门当前绑定版本的 `passed` 才能放行；报告齐全但结论不通过时不能完成。返工、门的目标成果版本或验收条件变更后重新复核，不把旧结论迁移到新版本。既有下游已固定的输入版本保持显式引用，不能借更新文件静默替换。

`changes_required` 仅沿已登记、仍在授权与预算内的修复路径接续，否则转为持久待判断；`needs_judgment` 保持相应分支等待。结论按稳定操作 id 幂等提交，过期版本、旧执行和无权判断者不能覆盖当前结论；重启/重投不重复放行。这里复用既有记录和事件，不新增一套复核任务引擎。

应用操作合同如下，实际命名可顺应现有模块。这些操作不等于向 coordinator 开放全权工具：确认只接受服务端验证过的用户意图，报告与成果处理绑定实际执行者，模型不能自行确认方案或伪造执行身份。

| 操作 | 输入与持久结果 |
| --- | --- |
| `savePlan` / `confirmPlan` | coordinator 提交方案版本；用户确认由应用解析已验证来源，绑定 actor、版本和意图，事务返回原 Task/Authorization 或明确冲突 |
| `createAssignments` | 在服务端固定的 Task/Authorization 下登记 Assignment 及依赖；同一操作重试返回相同结果 |
| `reviseAssignments` | 按当前图版本调整尚未执行的分工，拒绝过期写入并保留历史和已消费成果；不覆盖运行中的执行范围，扩大范围需先获得修订授权 |
| `requestAttention` / `answerAttention` | 保存问题版本及回答来源；回答生效后只接续一次 |
| `acceptReport` / `registerArtifact` | 应用验证实际 worker 的 attempt、lease、归属、成果版本与证据；提交状态和后续 Effects，既定推进不等待 coordinator |
| `recordAcceptanceDecision` | 已登记的复核执行者或判断者提交结构化结论；应用核对目标/验收条件版本与有效身份，只让匹配当前门的通过结论参与依赖和完成聚合 |

每个 Assignment 至少包含目标、输出、完成标准、资源引用、输入成果版本、依赖、写入范围和成本限制。应用校验同项目/同任务、授权资源和预算、依赖无环、输入版本明确及写入冲突；不得让模型通过传入 projectId 或 authorizationId 切换执行身份。

小任务可以只有一个 Assignment。较大目标可在同一 Task 下拆成多个 Assignment，不强迫用户接受复杂任务树。确认前展示的是可理解的方案摘要；确认后的分工调整留在任务详情，范围不变时自主推进。

报告、成果和相关待处理事件先事务落盘，由引擎检查既定依赖和完成条件。普通进展留在任务记录，面向 coordinator 的事件按项目和任务合并，只有新判断、语义汇总或用户决定需要时才调用模型；用户打开进展查询时读取业务投影，不要求它阅读所有执行日志。下游消费已登记版本，不读取尚在修改的半成品。

### 3.2 coordinator 故障时的推进与恢复

以下保证针对仅 coordinator 会话/模型调用异常、而数据库、引擎、宿主及所需 worker 能力仍可用的情况：

- 已启动 worker 继续执行，报告与成果继续接收，已授权的依赖、复核和预算内重试按规则推进。新判断形成持久等待项，不隐式暂停整个项目；其他项目保持可用。缺少新判断时不虚构结论。
- coordinator 错误、待判断、用户暂停和宿主离线分别显示。共享模型提供方、数据库、DSH 进程或 Mac 故障可能影响多个执行者；单 Mac 方案不承诺这些共享基础设施故障下持续运行。
- 同项目只串行化 coordinator 的语义决策写入。数据库事务和调度锁不跨模型调用持有；一个项目的慢调用不能占用其他项目的决策锁或阻塞报告接收。
- 持久保存待处理判断、输入/事件进度和 coordinator 映射代次；恢复或替换前核对尚未确认的工具操作，原子切换当前代次。旧 Session 的迟到工具写入按代次/状态版本拒绝，避免两个决策写者。
- 从项目记录、确认方案、当前 Assignment/成果和待判断摘要重建上下文，重复事件不重复派工。恢复不自动重发整份方案、不重跑已知完成工作，也不把已有授权扩成新的范围。

恢复能力降低会话故障的影响，不保证模型判断正确；应用仍检查授权和结构，方案中要求的专业复核仍须执行。

增量 1 建立这一合同并运行单 Assignment；增量 2 完成自动多 Assignment 拆解与依赖协调。不能用“DAG 验证器通过”替代“真实 coordinator 能从用户目标组织执行”的验收。

## 4. 交付顺序

每项任务提交一个聚焦的 PR，合入 `dev` 时使用 squash，避免为合并上游计划、任务编号或清单顺序产生额外 merge 提交。依赖表示接口可用，不以固定 PR head、PR 编号或外部 manifest 判断产品运行状态。

| 阶段 | 用户可检查的结果 | 实施任务 |
| --- | --- | --- |
| 增量 1A：先能对话 | 创建项目后立即进入主对话；两个项目历史独立，无 GitHub 门禁 | T1 → T2 |
| 增量 1B：能完成任务 | 确认方案后完成文件任务、查看成果；暂停与重启可核对，备份可隔离恢复 | T2 → T3 → T4 → T5 |
| 增量 2：能自己组织工作 | 一个目标由 coordinator 拆分、安排 worker 并汇总；研究与代码可组合，手机远程可用 | T6、T7、T8、T9 |
| 增量 3：飞书闭环 | Web 发起的任务可通知飞书，回复回到正确项目/问题，跨入口重试不重复执行 | T10 → T11 |

T7 可在 T2 后独立推进，T8 在 T6 的预算与身份合同可用后启用，T9 的界面工作可随 T2 开始；发布验收再检查相应依赖。一个能力失败只阻塞使用它的功能，不把所有开发卡在统一 Task 0。

宿主核验随消费者完成：T2 验证真实 Session/cwd、本地身份和浏览器加载；T4 验证执行、报告和停止；T7/T8 验证技能与后代执行范围；T9 验证真实 Tailscale 认证和传输；T10 验证主动通知和回执。优先使用最小隔离 profile/状态，不另造通用探针平台。fixture 与类型检查不能冒充真实宿主证据；失败记录影响范围、修复和重测入口。

## 5. 可执行实施任务

以下是实现边界；新增文件是计划中的落点，并非声明当前已存在。先检查实际模块，必要的同职责文件调整写进 PR，避免为满足旧文件表机械创建重复模块。测试覆盖外部行为和失败边界，不为复制实现而增加测试。每项完成后运行相关测试、类型检查和构建，记录实际结果。

### T1 · 项目身份、存储与无 GitHub 启动

依赖：原型基线。

- 改动：`src/core/model.ts`、`src/core/ports.ts`、`src/core/memory.ts`、`src/app/store.ts`、`src/app/migration.ts`、`src/deployment.ts`、`src/app/setup.ts`、`src/app/runtime.ts`。新增 `src/core/projects.ts`、`src/app/project-store.ts`。
- 在现有 Ticket 聚合上明确 projectId、草稿/待确认阶段和后续 Assignment 归属；项目名称和目录变更不改变身份。不要照搬旧试做中彼此独立的 ProjectTask/Ticket 状态。
- 分离基础实例就绪与资源就绪。未配置 GitHub/飞书也能启动项目服务；相关 CLI/env 只在相应资源被使用时解析，保留已有凭证清理和目录锁。
- 使用全新的开发状态。保留旧 schema 读取/迁移边界；迁移既有数据库前产生一致性快照，失败回滚；不猜测 legacy 项目和授权，不把旧 Effects 导入新项目。
- 验证：`tests/project-store.spec.ts`、`tests/no-github-startup.spec.ts` 及既有 store/migration/runtime 测试。覆盖重启落盘、两个项目隔离、无来源配置启动、迁移失败和旧库不获新授权。
- 可验收结果：不配置任何外部账号即可通过应用接口创建和读取两个项目。

### T2 · 项目主对话与第一个可见界面

依赖：T1。

- 改动：`src/app/runtime.ts`、`src/app/sessions.ts`、`src/app/api.ts`、`src/app/http.ts`、`src/app/tools/main.ts`、`src/client/route.ts`、`src/client/app.tsx`、`src/client/api.ts`。新增 `src/app/project-coordinator.ts`、`src/app/conversation-store.ts`、`src/client/project-home.tsx`、`src/client/project-conversation.tsx`。
- 名称和一句目标即可创建项目；提供项目首页与持续对话。用户输入先事务保存，再派发；已完成助手消息保存后才显示已保存，流式草稿另行标识。
- 由 Project 固定 coordinator Session/workspace/cwd 映射和代次，同项目只有一个语义决策写者。恢复或替换 Session 前核对未完成操作，保留旧映射与原因；工具写入拒绝旧代次和过期状态，模型调用期间不持有数据库事务或全局协调锁。
- coordinator 可以讨论、阅读已允许的少量资料并形成方案。同步改写 `prompts/orchestrator.md`、`prompts/dispatch.md` 中“仅路由、不能制定方案”的规则，提供受限项目读取工具；不向它默认绑定全部技能。
- 所有接口复用并实际验证 DSH 登录身份、项目归属和请求来源保护；现有自定义请求 header 不能充当认证。
- 验证：`tests/project-conversation.spec.ts`、`tests/project-panel.spec.tsx`、`tests/coordinator-recovery.spec.ts`。在真实隔离宿主创建两个项目、分别讨论、刷新和重启；让一个 coordinator 超时，另一个项目仍可处理对话且输入可落盘。覆盖替换后旧 Session 迟到写入被拒绝，普通讨论未派发 worker。
- 可验收结果：用户现在就能打开页面与项目 Superagent 对话；不等待完整任务引擎、知识库或飞书实现。

### T3 · 方案确认与内部派工入口

依赖：T2。

- 改动：`src/core/tickets.ts`、`src/core/intake.ts`、`src/core/engine.ts`、`src/app/project-store.ts`、`src/app/tools/main.ts` 和项目对话/任务视图。新增 `src/core/plans.ts`。
- 实现第 3 节的方案与确认操作，保存原始消息和稳定用户身份；普通赞同与明确实施指令分别处理，唯一方案的自然语言确认与按钮走同一服务。
- coordinator 提交结构化分工，由应用登记在同一 Ticket 的 Assignment 内。先支持一个 Assignment，保留依赖和成果输入合同；输入归属、授权和重复操作在服务端校验。
- 方案修订、过期确认、撤销、明确再运行一次、重复消息和同操作 id 内容冲突分别处理。用户不需要填写任务 manifest 或逐步骤批准。
- 验证：`tests/plans.spec.ts`、`tests/authorization.spec.ts`、`tests/project-assignment-intake.spec.ts`。用两个不同消息确认同一方案，只创建一份授权和一个执行目标；未绑定身份、过期版本、跨项目输入不派发。
- 可验收结果：项目内讨论能形成可审阅方案，并通过一次确认进入排队；此时即使执行器尚未接通也显示真实等待原因。

### T4 · 一个通用 worker 的执行与成果闭环

依赖：T3。

- 改动：`src/core/assignments.ts`、`src/executor/dsh.ts`、`src/app/sessions.ts`、`src/app/tools/executor.ts`、`src/app/execution-environment.ts`、`src/app/prompts.ts`、`prompts/worker.md`、`prompts/work.md`。新增 `src/app/execution-attempts.ts`、`src/app/artifact-store.ts`、`src/app/report-acceptance.ts`。
- 明确 Assignment/attempt/lease/Session/workspace/cwd；执行目录在项目下独立定位，每次检查 prepare 证据和 realpath。路径存在、失败留下非空目录都不等于准备成功。
- 通用报告包含已完成内容、证据、成果及未决事项；PR 是可选扩展。去除工具 schema、提示词和执行环境对全局 GitHub 身份/PR 的无条件依赖。
- 报告绑定服务端解析的执行身份和稳定操作 id，拒绝迟到报告；应用聚合必要成果/检查后决定完成，语义验收使用明确决策门及第 3.1 节的独立版本化结论。报告接收、成果落盘和既定完成规则不依赖 coordinator 可用；文件写入与成果登记中断后先核对现场。
- 记录实际角色规则、项目约定、模型、工具/资源范围与已加载技能版本。首个文件 worker 使用最小受管能力，未具备合同的 subagent 入口关闭。代码交付规则明确人工合并，不继承旧自动合并/强推/自动关闭 PR 政策。
- 验证：`tests/project-execution.spec.ts`、`tests/artifact-recovery.spec.ts` 及 executor/runtime 回归。真实宿主中完成“整理一份资料并写 Markdown 文件”，Web 可查看成果，无 GitHub、无 Feishu、无外部 dispatcher；让 coordinator 暂时不可用，已启动 worker 仍能提交报告/成果，任务状态按已约定检查更新。
- 可验收结果：用户确认一次方案后，文件任务后台完成并回到项目主对话；关闭浏览器不影响执行。

### T5 · 暂停、恢复、待决问题与备份验收

依赖：T4。

- 改动：`src/core/tickets.ts`、`src/core/assignments.ts`、`src/core/intake.ts`、`src/app/runtime.ts`、`src/app/effects.ts`、`src/app/outbox.ts` 及任务页面。新增 `src/app/backup.ts`。
- 持久保存暂停意图和检查点，区分暂停中/已暂停、停止请求/已确认退出；失败重试创建新 attempt，普通补充信息不复活已结束任务。
- Attention 绑定问题版本，回答事务保存后接续；通知已发出不代表问题已处理。
- 启动先核对 Session、运行作业、文件和外部结果。界面显示核对中及最后已知时间；不确定结果保持待核对，不自动重跑。按第 3.2 节恢复待判断和 coordinator 代次，保留用户暂停意图，恢复不重启已完成步骤。
- 一致性恢复点覆盖 DB、工作文件、附件及成果、Session/执行映射、可还原 prompt/skill 版本和外部资源清单。默认每日七份为可调建议，目的地未连接时如实显示；凭证单独保护。
- 验证：`tests/project-lifecycle.spec.ts`、`tests/project-backup.spec.ts`、`tests/increment1-acceptance.spec.ts`。故障注入覆盖输入提交、派发、成果登记与通知边界；恢复到禁止执行和外发的隔离环境，检查两个项目的对话、授权、暂停和成果链接。
- 增量 1 发布标准：T2 的早期对话界面和 T4 的真实文件闭环都可用，T5 恢复演练通过。

### T6 · Superagent 内部多 worker 拆解、调度与反馈

依赖：T4、T5 的执行与恢复合同。可提前实现纯领域验证。

- 改动：`src/app/project-coordinator.ts`、`src/app/tools/main.ts`、`src/core/engine.ts`、`src/core/assignments.ts`、`src/core/ports.ts`、`src/core/memory.ts`、`src/app/store.ts`、`src/app/passes.ts`、`src/executor/dsh.ts`。新增 `src/core/dependencies.ts`、`src/app/scheduler.ts`、`src/app/events.ts`。
- 实现第 3 节的多 Assignment 操作与 coordinator 提示词/工具：从用户目标提出分工、识别依赖和决策门，复杂规划可委派 worker。引擎负责安排已确定的可并行工作，只在需要新判断时请求 coordinator 调整或解释；不能仅实现静态 DAG 校验，也不能为每个节点增加模型审批。
- 引擎查询显式活跃 Assignment/attempt，替换“latest 就是唯一活跃项”的索引、停止、报告、恢复和完成逻辑；每个写执行使用独立目录或 worktree。
- 用同一数据库事务保存报告、成果交接、版本化验收结论和待处理事件，已有 Effects 分别驱动确定性推进和按需模型判断；后者按项目合并和退避，不阻塞前者。依赖使用明确 Artifact/验收条件版本，复核完成不等于成果通过；自动重试限于已登记条件、原授权和预算，结果未知时先核对。
- 实例总预算和项目公平调度覆盖模型、worker 与后台 shell/实验作业；等待原因可见，发出停止后确认退出。模型不能通过创建更多分工绕过预算。
- 验证：`tests/task-decomposition.spec.ts`、`tests/assignment-dependencies.spec.ts`、`tests/coordinator-feedback.spec.ts`、`tests/project-scheduler.spec.ts`。fixture 验证图/幂等后，真实 coordinator 接收一个目标并登记“两项独立调查 → 汇总报告”；随后使 coordinator 调用失败，调查和已登记汇总 worker 仍可完成。另测决策门只阻塞关联分支、其他项目推进、预设重试上限及 `ready` 缺少证据不能完成。必须覆盖：成果和复核报告齐全但结论不通过时不放行；成果/验收条件旧版本的通过结论不能放行新版本；无权判断者和旧执行结论被拒绝；返工后当前版本复核通过才接续，重投/重启不重复接续。
- 可验收结果：用户只提交一个目标并确认一次，系统自己组织多个 worker；无需逐条消息、预写 manifest 或外部发信服务。必要结果未齐时不能宣告完成。

### T7 · 项目知识、资料、技能与代码资源

依赖：项目知识/浏览从 T2 开始；可执行资源接入依赖 T4，协作代码验收依赖 T6。

- 改动：`src/app/resources.ts`、`src/app/cache.ts`、`src/app/prompts.ts`、`src/app/sessions.ts`、`src/app/execution-environment.ts`、`src/infra/commands.ts`、`src/infra/environment.ts`、GitHub source 模块和项目页面。新增 `src/app/knowledge-store.ts`、`src/app/skill-catalog.ts`。
- 已确认知识带不可变版本和来源，手工编辑作为待核对材料；实际使用的规则/技能正文版本可恢复。候选按角色、阶段、资源和依赖筛选，正文读取再授权；真实宿主中核验全局技能和工具旁路的实际边界。
- 资源按稳定 id 登记规范化路径，原位关联仓库/数据；受认证的浏览、预览和下载逐次检查 realpath、符号链接、当前权限和大小，缓存/分页绑定内容版本，撤销关联立即生效。
- CLI/env/Git identity 按执行固定，项目设置不改写其他运行执行的全局环境。GitHub 身份贯穿 account/resource/repository/number、游标、缓存、报告、通知和反馈绑定。
- 验证：`tests/project-knowledge.spec.ts`、`tests/skill-catalog.spec.ts`、`tests/project-resources.spec.ts`、`tests/multi-repository.spec.ts`。覆盖跨项目、同号 PR、同仓库多项目、技能越权、快照失效、文件越界和规则重启还原。
- 可验收结果：KORAM 同一项目内完成调研与一个小型代码验证，交付可审阅变更及证据；成果能追溯到方案、来源、版本和配置。

### T8 · 有记录的协助、复核与 subagent

依赖：T6 的父执行、预算、成果与依赖合同，以及 T7 的技能/资源范围。

- 改动：`src/app/project-coordinator.ts`、`src/app/sessions.ts`、`src/core/assignments.ts`、`src/app/skill-catalog.ts`。新增 `src/app/delegations.ts`。
- 正式协助/复核使用同一 Task 的 Assignment；临时局部委派登记父执行、稳定 id、Session、范围、上下文和结果处理状态，不复制 DSH 的完整子任务状态机。
- 子执行范围取父授权和角色范围的交集；祖先不明时拒绝本应用操作。暂停/停止后不新建委派，必要结果核对前不完成；长期委派提升为 Assignment 时复用已有结果。
- 验证：`tests/project-collaboration.spec.ts`、`tests/subagent-scope.spec.ts`。覆盖独立上下文、预算、重投、重启、停止后委派拒绝和结果未收齐。对真实宿主权限/技能继承做最小集成验证。
- 可验收结果：用户无需管理执行会话即可完成有交接和复核的工作；未通过的 subagent 能力保持关闭，不阻塞已可用的正式 worker。

### T9 · 完整 Web、持久事件与 Tailscale

依赖：页面可随 T2 开发；任务/成果使用 T4–T7 合同，完整协作发布检查 T6/T8。

- 改动：`src/app/api.ts`、`src/app/http.ts`、`src/app/events.ts`、`src/client/api.ts`、`src/client/route.ts`、`src/client/app.tsx`、`src/client/client.css` 及项目页面。
- 首页先展示待决事项，再展示项目；项目内提供主对话、任务、资料/成果和约定。任务详情与对话引用同一规范化消息，不复制历史；区分 coordinator 不可用、某分支待判断、用户暂停和整机离线，展示继续运行的 worker 与最后核对时间。
- 项目深链接、刷新、返回和多标签页保留显式归属；持久事件带序号/版本，客户端从 cursor 重接、去重、过期取快照，允许 polling 降级。
- 后端仍监听 loopback，使用 Tailscale Serve 和唯一 HTTPS publicOrigin；精确 Host/Origin、原生登录与真实流式连接/下载一起验收，不使用通配域名或公网 Funnel。
- 验证：`tests/project-navigation.spec.tsx`、`tests/project-events.spec.ts`、`tests/tailscale-acceptance.spec.ts`。真实手机检查输入/确认、软键盘、长文本、掉线草稿与操作重试；从另一台 tailnet 设备验证认证、读写、成果访问和重接，错误来源仍被拒绝。
- 增量 2 发布标准：内部拆解、研究/代码工作和远程 Web 都有真实端到端证据；兼容性验证按已使用能力记录。

### T10 · 一个飞书机器人的私聊通知与回复

依赖：T3/T5 授权与待决合同、T6 事件、T9 已认证详情链接。

- 改动：`src/sources/feishu.ts`、`src/sources/feishu-trigger.ts`、`src/sources/feishu-channel.ts`、`src/sources/feishu-read.ts`、`src/sources/feishu-loops.ts`、`src/sources/kind.ts`、`src/app/outbox.ts`、`src/app/store.ts`。新增 `src/app/channel-routing.ts`、`src/app/notifications.ts`。
- 将已验证 Web/飞书身份绑定到稳定用户，保存 NotificationTarget；Web 发起的任务也可主动通知，无需伪造 Feishu Trigger 或新增 OAuth 用户发信服务。
- 原生回复映射优先，其次显式项目，归属不明时保存并询问；不默认上一个项目，历史/附件也逐消息过滤，自己发出的通知不变成新任务。
- Delivery 保存幂等键、原生回执及项目/任务/执行/问题/方案映射。发送结果未知时核对，不能直接重发；Attention 状态独立于投递状态。
- 附件保留来源、持久对象、项目成果与 DSH 引用关系，纳入备份和权限。不同通知目标只接收允许字段，私聊资料不随模板发布到 GitHub。
- 验证：`tests/feishu-project-routing.spec.ts`、`tests/notification-delivery.spec.ts`、`tests/cross-channel-confirmation.spec.ts`。真实私聊验证 Web 任务通知、回复接续、迟到答案、跨渠道确认去重、回执中断恢复及附件访问。
- 可验收结果：一个机器人跨项目通知和处理回复，用户不用为每个项目创建机器人或群；不改生产入口来代替隔离验收。

### T11 · 完整验收与单次部署切换

依赖：三个增量分别通过；未使用能力可明确保持禁用。

- 整理可重复构建、实际 DSH 版本/插件兼容、运行设置、资源覆盖清单和恢复说明；更新现有服务脚本和健康语义，不另造运维产品。
- 在隔离环境恢复 DB、Session 映射、工作文件、版本和附件，确认无外发/执行；验证 macOS 实际启动、登录/解锁条件、异常重启和 Tailscale 行为，不默认修改系统安全设置。
- 切换前备份并核对旧任务，导入用户确认的 KORAM 目标/约定和资源；旧历史保留只读，不推测归属或导入旧自动执行队列。
- 机器人正式切换始终只有一个接收者。先停旧入口再启新入口；回退先停新入口再恢复旧入口，禁止两套服务消费同一输入或写同一状态。
- 验收证据覆盖：项目创建/对话、单次方案确认、内部多 worker 拆解与结果聚合、coordinator 故障时既定流程和其他项目继续且待判断不丢失、旧协调代次写入拒绝、暂停恢复、无 GitHub 文件任务、KORAM 研究/代码、手机 Tailscale、飞书回复、跨项目/跨渠道去重和完整恢复。
- 实现 PR 不自动执行这次部署；切换具体配置和备份结果准备好后，按届时用户的部署指令执行。

## 6. 开发和验收约定

- 唯一计划就是本文件；产品行为以规格为准，审计只说明原型事实。实现中发现缺口时就地修订相关合同，不再增加另一份竞争性总计划或外部任务 DAG。
- 每个任务先针对关键行为复现失败，再实现最小改动并运行相关检查；原型已有测试优先复用。命令使用 `pnpm exec vitest run <相关测试>`、`pnpm typecheck`、`pnpm build`；增量发布运行 `pnpm check` 和列明的真实场景。
- 记录 fixture、真实宿主、真实远程/飞书结果各自的证据和限制。环境变量或 native binding 问题按复现结果修复，不为绿灯跳过真实失败。
- 历史 PR #7/#8/#9 已停止沿旧计划交付。其分支和归档 tag 可以作为参考；复用必须按当前聚合、范围和验收重新审查，不能仅凭旧测试通过直接导入。
- 当前计划提交不是功能完成、部署完成或宿主兼容声明。下一项实现是 T1，最早的用户可见验收点是 T2。
