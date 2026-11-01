# Superagent 原型复用与改造审计

日期：2026-11-01（Asia/Shanghai）

状态：源码审计与设计补充，不授权实施、部署或切换现有服务。

对照规格：[项目型 Superagent 工作台设计](2026-11-01-project-superagent-workbench-design.md)。审计基线：本地 `main` 的 `fa7f657`；该检出当时领先 origin/main 四个文档提交。本报告只记录当前检出，不代表实时上游。

## 1. 结论与证据边界

应保留现有任务执行引擎、持久 Effects/Outbox、事务存储、原生 DSH Session 和渠道适配机制，在其上改造身份、授权与执行合同。无需再造 Agent 运行时或第二套任务状态机。产品层的项目、主对话、方案授权、资料成果和实时工作台则需要新增。

改造深度来自六个贯穿系统的旧假设：部署对应一个仓库、全局一个协调 Session、每 Ticket 一个 worker Session/目录、只有最新 Assignment 活跃、Source Thread 决定输入归属、全局环境与配置影响所有执行。这些假设散布在领域、存储索引、调度、工具、提示词、通知和 UI；只加 projectId 或项目列表无法完成改造。

分类含义：**保留机制**表示算法或组件可以沿用，仍需接入新身份；**改造合同**表示可沿用模块但必须改变语义；**新增**表示当前没有所需产品能力。不能将某个机制存在等同于目标能力已经实现，也不按代码行数估算复用百分比。

证据来自源码、配置、提示词与测试断言阅读。主审覆盖部署、启动、环境、服务脚本和构建，并交叉核对领域/执行/渠道三个独立只读审计。未读取或输出任何凭证内容，未操作现有 profile、机器人或外部仓库。

实际验证结果：

- 通过仓库脚本运行 TypeScript `tsc --noEmit`，成功退出；这只证明当前开发依赖下的静态类型检查。
- 随后运行 `vitest run`，在加载测试前退出，错误为 Rolldown `Cannot find native binding`，缺少 `@rolldown/binding-wasm32-wasi`/`rolldown-binding.wasi.cjs`。没有得到测试用例通过结果；未删除、重装或升级依赖。
- 未运行 build、生产故障注入、备份恢复、真实 DSH 权限/技能继承、飞书/GitHub 或 Tailscale 集成验收。读到的测试只作为已有行为依据。

## 2. 可以保留的底座

| 范围 | 已有可复用机制 | 证据与复用限制 |
| --- | --- | --- |
| 任务领域 | Ticket、Assignment、Input、Attention、Mandate、follow、评估与报告状态转换 | [model.ts](../../../src/core/model.ts#L125)、[engine.ts](../../../src/core/engine.ts#L69)、[evals.ts](../../../src/core/evals.ts#L70)；需改变授权、归属、多执行与完成语义 |
| 事务存储 | SQLite WAL/FULL、savepoint、afterCommit、活动工作集索引 | [store.ts](../../../src/app/store.ts#L64)；扩展 schema 与活动索引，保持单写者 |
| 持久调度 | Effects 的 kind/key 合并、generation、防覆盖、顺序、退避与 Later | [effects.ts](../../../src/app/effects.ts#L43)、[passes.ts](../../../src/app/passes.ts#L17)；不是项目公平调度或外部精确一次保证 |
| 通知队列 | Outbox 稳定业务消息 ID、顺序、receipt、暂停与 Source 未就绪处理 | [outbox.ts](../../../src/app/outbox.ts#L17)、[store.ts](../../../src/app/store.ts#L251)；缺原生消息映射与未知结果核对 |
| DSH 执行 | 原生 Session、稳定请求去重、报告事务、执行槽、事件订阅与收尾 | [sessions.ts](../../../src/app/sessions.ts#L162)、[dsh.ts](../../../src/executor/dsh.ts#L264)、[executor.ts](../../../src/app/tools/executor.ts#L89)；当前身份仍按 Ticket 推导 |
| 设置与提示词 | 版本、组合、预览、revision 冲突、来源检查、角色默认模型 | [prompts.ts](../../../src/app/prompts.ts#L35)、[settings.ts](../../../src/app/settings.ts#L41)、[role-models.ts](../../../src/app/role-models.ts#L14)；已有防护应保留，版本还不是执行快照 |
| 渠道适配 | SourceKind/registry/host、事件规范化、轮询、历史分页、重试、图片校验 | [kind.ts](../../../src/sources/kind.ts#L27)、[registry.ts](../../../src/sources/registry.ts#L13)、[feishu-loops.ts](../../../src/sources/feishu-loops.ts#L18)、[feishu-image.ts](../../../src/sources/feishu-image.ts#L11)；归属决策移到应用服务 |
| 展示与运维 | card/view 投影、分页、错误分类、重启探测、独立 profile 服务控制 | [cards.ts](../../../src/app/cards.ts#L26)、[api.ts](../../../src/client/api.ts#L16)、[provider.tsx](../../../src/client/provider.tsx#L85)、[服务脚本](../../../scripts/dsh-superagent#L1)；旧管理面板不能代替项目产品界面 |

## 3. 必须修改的实现点

### 3.1 项目、授权与任务领域

**A01 · 全链路项目归属和业务记录【改造合同＋新增】**

现有 [Repositories](../../../src/core/ports.ts#L105)、[schema](../../../src/app/store.ts#L70) 和 [Ticket](../../../src/core/model.ts#L276) 没有 Project、主对话、知识、不可变方案授权、成果、Delivery 等完整合同。现有 [DomainEvents](../../../src/core/ports.ts#L85) 是事件接口，不是可查询的持久业务历史。

新增规格实体及其存储/投影；任务、Assignment、输入、Attention、资源、成果、通知、事件、缓存和工具请求都必须从服务端固定上下文解析归属。主对话与任务详情引用同一规范化消息，DSH transcript 保留执行细节。增量 1 即以两个项目验证交叉查询和操作被拒绝，不能推迟到 UI 完成后补字段。

**A02 · 跨入口身份不是 Source actor【改造合同＋新增】**

[Actor](../../../src/core/model.ts#L5) 是 source-local 身份；“人类消息”也不等于有实施授权的本人。应用需要将 Web 登录主体、已绑定飞书用户及可选 GitHub 身份映射到稳定授权主体，无法验证的来源仅作资料或待核对输入。Authorization 保留应用 actorId、原生身份与来源证据，不凭显示名或 `human` 标志授权。

**A03 · Mandate 不等于方案授权【改造合同＋新增】**

[Mandate](../../../src/core/model.ts#L125) 和 [Eval](../../../src/core/evals.ts#L70) 已有 gate、basis、policyVersion、actor 与重复接受防护，可复用其来源记录方法；当前 accept 语义不能直接代表用户确认了具体方案。

新增不可变 PlanRevision/Authorization，事务唯一键为 `(projectId, planRevisionId, actorId, confirmationIntent)`，并绑定同一 Task。普通赞同、过期确认、被替代方案、重复消息与“明确再运行一次”分别处理。增量 1 即建立业务幂等，Web 重试只创建一个执行目标；增量 3 接入飞书时复用同一合同，跨入口重发确认也不能重复派发。

**A04 · 单任务多 Assignment 涉及索引和整个执行适配器【改造合同】**

[store 活动索引](../../../src/app/store.ts#L31)、[memory](../../../src/core/memory.ts#L42) 只看最新 Assignment；[executor](../../../src/executor/dsh.ts#L207) 的排队、停止、slot、latest 检查和恢复也按 Ticket 组织。目前并发是多个 Ticket 并发，不能证明同一 Task 内多 Assignment 并发。

需要显式执行单元、attempt、依赖、整合责任、独立目录、lease/取消/报告身份，查询所有活跃执行而非最后一项。增量 1 可仍只运行一个 Assignment，但 schema/索引不能把“最后一项就是唯一活跃项”固化成产品合同；完整并行与成果聚合在增量 2 验证。

**A05 · 补充消息不能隐式复活任务【改造合同】**

[Intake](../../../src/core/intake.ts#L19) 会在特定人类 follow-up 下重新唤醒已结束 Ticket。新产品需分别处理补充信息、Attention 答案、明确恢复、重试和新的执行目标；用户暂停/停止意图跨重启保存，普通协作输入、外部评论和历史回填不能解除它。Attention 回复还须绑定问题版本，不由迟到答案覆盖已使用答案。

**A06 · 报告绑定执行身份，完成由必要结果聚合【改造合同＋新增】**

[报告工具](../../../src/app/tools/executor.ts#L75) 主要按 Ticket 报告，[assignments.report](../../../src/core/assignments.ts#L99) 选 running/latest Assignment，ready 在没有后续 follow 时可结束 Ticket。当前报告 schema **已经允许没有 PR 的 ready**；问题是启动/身份/默认流程仍强依赖 GitHub，不能误报“所有 ready 必须有 PR”。

报告必须绑定服务端解析的 Assignment/attempt、授权、有效 lease 和稳定操作 id，拒绝旧执行迟到报告写入新尝试。任务完成需核对约定成果、验证证据、依赖和必要子执行结果，不能由最后一个 ready 覆盖其他未完成工作。这是设计缺口，未复现实际错绑事故。

### 3.2 调度、启动与资源环境

**A07 · 全局调度需要项目公平性与可解释等待【改造合同】**

[Engine](../../../src/core/engine.ts#L69) 和 [Passes](../../../src/app/passes.ts#L17) 执行全局扫描；[Effects](../../../src/app/effects.ts#L103) 按 kind 并发/顺序处理，不能直接满足项目级公平。沿用持久任务和 pass 合并，增加 project-aware 队列、实例总预算、项目占用、依赖/资源等待原因及饥饿防护。项目 coordinator 同时只能有一个决策写者，不能用全局模型锁让所有项目互相阻塞。

**A08 · GitHub 就绪门禁贯穿启动和工具【改造合同】**

[resolveDeployment](../../../src/deployment.ts#L87) 强制 repository、CLI、登录与推送权限；[Setup.resolve](../../../src/app/setup.ts#L76) 无条件解析 GitHub；[runtime.initialize](../../../src/app/runtime.ts#L204) 未完成 setup 不安装 Sessions/executor；[报告 schema](../../../src/app/tools/executor.ts#L82) 读取 GitHub login；执行环境和技能注册也有同类假设。

拆开基础实例就绪、账号健康和项目资源可用性。无仓库项目可创建、讨论、形成方案并执行文件任务；仓库失效只阻塞需要它的工作。保留凭证验证，但改为相应资源激活/使用的门禁，而非整个系统的启动前提。

**A09 · 进程级环境不能用来切换项目【改造合同】**

[writeEnvironment/applyEnvironment](../../../src/infra/environment.ts#L79) 写 state-wide worker-bin/config 并修改 process.env；[Commands](../../../src/infra/commands.ts#L59) 持有全局 Deployment，API 固定一个 repository。[Setup](../../../src/app/setup.ts#L91) 和 [Source 设置页](../../../src/client/source.tsx#L145) 的配置变更还可能影响全局服务。

保留清理继承 token/Git 环境、CLI 路径验证、非交互设置、原子写入、外来文件保护、API 路径约束、超时与错误脱敏。每次执行必须显式获得 account/resource/cwd/env/Git identity 的固定快照；项目设置不能通过修改进程环境重定向其他运行任务。区分实例设置与项目资源配置的生效/重启范围。

**A10 · 目录存在不等于 prepare 成功【改造合同＋新增】**

[dsh.launch](../../../src/executor/dsh.ts#L434) 对任何成功 stat 都跳过 prepare；失败 prepare 留下非空目录后，重试可能当作已完成；已有目录还会跳过 prepare 后的 [verifyDirectory](../../../src/infra/environment.ts#L149)。这条路径甚至没有以“确为目录”作为充分前提。

持久记录资源归属、规范化 realpath、准备配方/版本、进行中/完成/失败、完成标记和工作区证据。每次启动都核对类型、owner、worktree/仓库与禁止的 Git 配置；路径存在但证据不全进入核对，不盲目复用、重跑配方或删除用户内容。验收覆盖部分准备失败、非空残留、符号链接、错误仓库和既有 worktree。

### 3.3 Session、工具、技能与后台生命周期

**A11 · Session/cwd 必须显式索引并在恢复时验证【改造合同】**

[workerSessionId](../../../src/executor/dsh.ts#L24) 使用 `worker-<ticketId>`；后续 Assignment 继续旧上下文。[Sessions.ensure](../../../src/app/sessions.ts#L138) 只在创建时绑定 workspace，恢复已有 Session 未比对 cwd，随后重新设 permission preset 和标题。[transcript](../../../src/app/resources.ts#L114) 也按 Ticket 推导 Session。

持久保存 Project→coordinator 和 Assignment/attempt→sessionId/workspaceId/cwd 的映射，核对实际归属与位置；不一致进入修复/核对流程，不能靠改名完成重绑定。新旧会话和 attempt 保留替代关系，未核对操作不与新执行并行重跑。

**A12 · router 改成项目协调者需要重写合同【改造合同】**

[shared](../../../prompts/shared.md)、[dispatch](../../../prompts/dispatch.md)、[admission](../../../prompts/admission.md)、[team scope](../../../prompts/team/scope.md) 限制调查/方案行为；[主工具](../../../src/app/tools/main.ts#L17) 的短 routing note 也不是方案服务。不能只改角色名字或提示词末尾加“支持研究”。

按共同规则、项目约定、角色、按需能力、任务上下文组合；新增保存方案/授权/知识/交接的项目工具。保留 [settings](../../../src/app/settings.ts#L148) 已有 revision/model/origin 防护，并加入 actor/project/authorization 校验。coordinator 允许已授权轻量调查，普通讨论无需伪造 Ticket。

**A13 · 版本号不是可恢复的执行快照【改造合同＋新增】**

[Sessions 请求装饰](../../../src/app/sessions.ts#L328) 每次请求使用最新 prompt 并重新绑定 skills；[Prompts](../../../src/app/prompts.ts#L76) 内置正文来自当前二进制；[role model](../../../src/app/role-models.ts#L14) 对已有 Session 不重新选择默认模型。当前机制不能证明恢复了当时上下文。[相关测试](../../../tests/runtime.spec.ts#L1033) 明确覆盖逐请求更新，目标行为需要调整。

ExecutionContextManifest 保存实际已解析规则正文或可还原的内容哈希/正文版本、项目约定、模型选择与关键运行参数、工具/资源范围、候选目录、实际加载技能和来源版本；不能只记 revision 数字和 latest 路径。普通变更在新尝试或明确检查点切换；权限撤销及时由服务端执行，另记记录，不被快照冻结。

**A14 · 技能目录过滤必须与正文读取授权配套【改造合同＋新增】**

[Prompts skills](../../../src/app/prompts.ts#L145) 将全部应用技能提供给会话，[Sessions](../../../src/app/sessions.ts#L314) 绑定技能；[preset](../../../cordis.patch.yml) 还加载原生 filesystem/tool-skill 插件。共享正文库可保留，但需要稳定 id/version/角色/阶段/依赖/冲突元数据、执行级候选快照和服务端读取校验，验证 resourceBase/路径。

隐藏目录项不等于不可读；已加载正文也不能从上下文中可靠卸载。真实 DSH 的全局技能可见性、读取工具、子执行继承与一般 read/bash 路径必须集成验证。技能不扩张授权；冲突技能适配或禁用，不能对已确认方案重复启动审批。

**A15 · 子委派需持久合同和失败时收束边界【改造合同＋新增】**

[Sessions parent 检查](../../../src/app/sessions.ts#L303) 只遍历已加载 Agent，最多八层；找不到 Ticket 时不应用本插件额外的 Ticket 检查。[workOnly](../../../src/app/sessions.ts#L289) 也不是 project/attempt/授权交集检查。不能据此推断原生 DSH 完全没有权限限制；原生边界尚未验证。

登记 delegationId、父执行、Session、范围、上下文版本、结果处理状态和预算。子执行权限取父范围与本角色范围交集；祖先或归属无法确认时阻止本应用相关操作，进入核对。暂停/停止后禁止新委派，必要结果核对后才完成，长期工作提升为正式 Assignment 时复用已有结果。

**A16 · maxWorkers 不是全部运行成本【改造合同＋新增】**

[dsh 后台移交](../../../src/executor/dsh.ts#L583) 可让等待人工的作业继续存在并释放 worker slot；[超时收尾](../../../src/executor/dsh.ts#L629) 对 shell job 与 children 处理不同。[background](../../../src/executor/background.ts#L36) 的 Promise.race 超时本身不取消底层操作，子执行停止与收尾还需分别核对。

分别核算模型并发、委派、shell/实验/服务进程；持久记录 project/task/attempt owner、用途、期限、健康、清理与停止确认。不能把“已发停止”当作“已退出”；有长期服务能力的任务在启动前验证适配器能否追踪/恢复。保留已有 join、订阅、drain，扩充实例预算及项目公平性。

**A17 · 工具掩码与 PATH shim 不是 OS 沙箱【改造合同＋验证】**

[Sessions](../../../src/app/sessions.ts#L61) 有角色工具列表，恢复时设置 [danger-full-access](../../../src/app/sessions.ts#L152)，[环境 shims](../../../src/infra/environment.ts#L79) 也只是工作流护栏。项目/工具访问检查必须由应用执行，不能宣称限制了任意用户进程的文件或网络访问。采用当前用户 OS 身份是规格边界；原生权限、工具与技能继承需实测，并把保证表述限定在实际可验证范围。

**A18 · 资源授权、分页与证据缓存要一起改【改造合同】**

[resources](../../../src/app/resources.ts#L202) 对 Feishu/Trigger 有 Ticket reachability 检查，而 [GitHub handler](../../../src/app/resources.ts#L209) 没有对应检查；[CLI 订阅规则](../../../prompts/cli.md) 也不能替代读资源授权。分页缓存按 Session/resource，offset 0 会刷新快照；[transcript](../../../src/app/resources.ts#L271) 使用派生 Session 和事件数组下标。[TextCache](../../../src/app/cache.ts) 的逐出策略及单个超大项也不等于严格总内存上限。

所有资源先校验 project/attempt/resource，再读缓存；缓存键包含归属、内容版本/快照、可见范围，权限撤销后不可绕过。cursor 绑定稳定 snapshot/version/expiry，明确过期；transcript 使用 Session+稳定事件引用，限制可见内容与大小。补充单资源/总量上限、TTL/逐出、截断与大文件策略，防止模型上下文和 Web 证据错页或无限积累。

### 3.4 渠道、反馈与通知

**A19 · Thread 不是项目边界【改造合同＋新增】**

[SourceContext](../../../src/app/source-context.ts#L53)、[poll](../../../src/sources/poll.ts#L17) 按全局 source/thread 获取订阅与 Ticket；[Feishu](../../../src/sources/feishu-trigger.ts#L16) 生成原生 thread id，但同一私聊及回复链可跨项目。不能将原生 Thread 永久绑定唯一项目，也不能把后续消息广播给所有订阅 worker。

先持久保存 ChannelMessage，再按已知回复映射→显式项目→待归属询问处理，冲突先核对。历史、around、附件、轮询回填与模型上下文都执行逐消息归属过滤，不能仅过滤新事件入口。保留 bot 自发消息排除、规范化和稳定原生 ID 去重。

**A20 · 主动通知与原始回复 Channel 分离【改造合同＋新增】**

[feishu-channel](../../../src/sources/feishu-channel.ts#L18) 依赖已有 messageId 回复；[SourceChannel.send](../../../src/sources/kind.ts#L105) 只返回 sent/gone，并未暴露原生发送回执。已有 Outbox receipt 因而不能可靠建立“机器人消息→项目/任务/Attention”索引。

新增稳定 NotificationTarget、Delivery、原生 messageId 与 project/task/attempt/Attention/PlanRevision 映射，Web 任务可主动通知已绑定 DM。保留稳定幂等键；发送成功但映射未落盘时按原生幂等/查询补齐，否则标记 unknown/待核对，收到无映射回复先保存。通知已发送不等于 Attention 已解决。

**A21 · 多仓库身份必须覆盖所有索引【改造合同】**

[githubChannel](../../../src/sources/github-trigger.ts#L8) 的 thread 只有 `github:<number>`；[githubAddress](../../../src/sources/github-trigger.ts#L13) 只认一个 repository；[PR binding](../../../src/sources/github-pull.ts#L18) 与通知使用同类身份；[cursor](../../../src/sources/github.ts#L452) 只按 number 保存。单仓库内可用的 key 在同 Source 的多仓库模式下会冲突。

使用结构化 account/resource/repository+number 身份，贯穿 Trigger/Thread/ChannelRef、订阅、PR 绑定、回复 URL、查询、缓存、轮询 cursor、receipt 和报告；同仓库被多个项目关联时仍需明确 Task/Assignment 归属。保留 ETag、overlap/horizon、逐流失败隔离，但 cursor 带流类型和资源命名空间；改变仓库不能沿用另一仓库进度。

**A22 · 附件与通知需可持久访问的成果合同【改造合同＋新增】**

[Feishu 图片](../../../src/sources/feishu-image.ts#L47) 返回 DSH attachment 引用并清理临时目录，不等于用户已拥有 Artifact 或可从手机下载。关联 ChannelMessage、原始附件、存储对象、项目资源和成果版本，覆盖备份、保留和权限校验。

[checkedImText](../../../src/sources/feishu-channel.ts#L18) 的平台长度检查可保留；通知增加明确项目/任务、目标允许字段、内容长度与摘要/认证详情链接。私有资料不能因为共用模板转发到 GitHub 等外部渠道。无需为首版增加复杂隐私系统，但各目标的可见内容边界要明确。

**A23 · 旧代码交付副作用规则不能悄悄继承【改造合同】**

[work](../../../prompts/work.md#L29) 默认提交/推送/PR；[team delivery](../../../prompts/team/delivery.md#L9) 有小变更自动合并规则，另有 [重写提交、强推、同 tree 继承 approval](../../../prompts/team/delivery.md#L17) 和 [自动关闭被人类工作覆盖的 PR](../../../prompts/team/delivery.md#L26)。这些是实际内置政策，不能作为“只拆分 GitHub 技能”而原样传给新任务。

新版本按已确认的人工合并约定替换；提交、推送、重写历史、关闭 PR 和其他外部变更必须符合实际授权与当前远端状态。不能用技能、旧提示词或 same-tree 推断替代用户授权/真实审核状态。历史版本保留追溯；旧执行切换须经过检查点与现场核对。

### 3.5 Web、HTTP、文件与构建

**A24 · 新增项目产品 API 和读模型【新增】**

[API](../../../src/app/api.ts#L20) 只有旧 state/overview/source/settings/thread/ticket/executor 等；[overview](../../../src/app/views/overview.ts#L61) 是全局管理概览。[客户端路由](../../../src/client/route.ts#L7) 和 [shell](../../../src/client/app.tsx#L179) 没有项目主对话。

新增项目首页/创建、项目主对话、方案确认、知识/约定、任务/Attention、资源/Artifact、Delivery API 与 UI。所有写入有 clientOperationId/版本冲突处理，所有读模型保留归属和稳定引用。项目深链接、刷新、浏览器返回与多标签页不能依赖旧 sessionStorage 路由或“上一个 Session”猜归属。

**A25 · 实时事件不能靠旧 polling 证明【新增】**

[usePoll](../../../src/client/api.ts#L60) 是定时 fetch；[provider](../../../src/client/provider.tsx#L85) 只探测重启，没有项目 query cache、持久事件 cursor 或对话实时链路。服务端 DomainEvents 和 Effects 不能直接充当浏览器可恢复的事件 API。

持久事件至少覆盖规范化消息、Task/Assignment/Attention、成果、Delivery、健康与恢复状态；带稳定 eventId/sequence、projectId、aggregate/version。客户端按 project/resource/params 缓存并定向失效，选定一种流式传输实现持久 cursor 重接、去重、过期补快照与轮询降级。流式草稿与已落盘消息分开，不能把未完成 token 当作已保存答复。

**A26 · 手机文件访问是新服务【新增】**

[textPage](../../../src/app/cards.ts#L88) 与 [既有 HTTP 路由](../../../src/app/http.ts#L220) 不是目录/下载服务。新增 Resource/Artifact 登记、目录元数据、文本/Markdown 分页预览、二进制下载；每次按真实路径、登记范围与项目权限校验，包括符号链接、撤销关联、大文件、Content-Type/Disposition 和安全渲染。浏览器通过已认证的应用 URL 访问，不暴露 Mac 绝对路径作为可用下载链接。

**A27 · Host/Origin 标记不等于登录认证【改造合同＋验证】**

[sameOrigin](../../../src/app/http.ts#L75) 和 [registerHttp](../../../src/app/http.ts#L230) 仅面向 loopback；[客户端](../../../src/client/api.ts#L32) 的 `x-orchestrator-request` 是请求保护标记，不是用户身份。不能因此断言 DSH host 没有认证，也不能推断插件天然受完整保护，原生层尚需核验。

按规格配置唯一 HTTPS publicOrigin、精确 Host/Origin、本机受信代理和 DSH 登录/CSRF 边界；真实 SSE/WS、Cookie、下载与资源 URL 同样验证。保持 loopback 后端与 Tailscale Serve，无 Funnel。从真实 tailnet 设备覆盖读写/重连/错误来源/未认证请求，首页 200 不是验收结论。

**A28 · 复用组件，重新验收产品交互【改造合同＋新增】**

旧面板的列表、错误恢复、文本分页、健康组件可以封装复用；项目首页、主对话/输入框、方案确认、待决事项与成果摘要必须新增。窄屏 320–430px、软键盘、长文本/代码、深链接、返回和掉线后草稿/提交状态应实际检查。不能仅凭 React 组件存在断言手机可用，也不必在首版做复杂桌面日志分析器。

**A29 · 保留 DSH 插件构建，先确认版本兼容【改造合同＋验证】**

[package](../../../package.json#L30) 定义 DSH bundle/client 注入；[tsdown](../../../tsdown.config.ts#L1) 构建 Node ESM 和由 `window.__ModuleLoader__` 加载的浏览器插件，React/DSH 为外部依赖。工作台继续使用该宿主集成，不能假设另起独立 Vite 页就更新了 DSH GUI。

[开发依赖](../../../package.json#L87) 固定 DSH `0.2.1-alpha.2`，peer/engine 也基于该系列；既有环境盘点的安装版为 `0.2.1-rc.5`，需在隔离 profile 验证 Session/Workspace、工具、skill、client slots、附件和 web auth API。类型检查通过不证明 RC 宿主兼容。实现交付需可重复安装、原生依赖、服务端/客户端构建及版本清单；本轮绑定缺失是验证环境限制，不能归因于业务逻辑。

### 3.6 运维、备份与迁移

**A30 · 保留单写者和停机顺序，扩展服务健康【改造合同】**

[runtime](../../../src/app/runtime.ts#L90) 先锁状态目录再开 SQLite，关闭时排空执行并在关库后释放锁；[服务脚本](../../../scripts/dsh-superagent#L1) 有 profile 隔离、重复进程拒绝、主动停止标记、温和停止、健康端点与日志保留。均可保留。

健康模型区分实例就绪、项目资源缺失、通知未就绪、旧状态/核对中、任务失败和服务不可达；更新脚本与 API 合同而不是另造不兼容的守护进程。macOS 启动还需验证实际登录、磁盘解锁、PATH、凭证可用性、睡眠/重启与 Tailscale 服务，不自行修改系统安全设置或替换现有服务。

**A31 · 备份恢复是新增端到端能力【新增】**

现有 SQLite/Session 持久化不能证明已有应用级一致性备份、异机副本或可恢复成果索引。按设计覆盖 DB、DSH 状态、工作文件/未提交变更、附件、外部资源清单与可还原的 prompt/skill/knowledge 版本；凭证单独保护。检查点协调数据库与文件版本，备份不完整时明确标记。隔离恢复默认禁执行/外发，并实测所有关键链接可读；每日七份等默认建议仍随书面规格评审。

**A32 · 新 schema 与旧历史不能自动等价转换【改造合同＋新增】**

[migration](../../../src/app/migration.ts#L20) 对历史库只提供 schema 10→11，不是通用版本迁移；旧记录没有可靠项目/方案/授权证据。保留现有版本检查与事务化迁移机制，新增实体需独立 schema/fixture、迁移前原库快照和失败回退合同。

首版按规格使用隔离新状态，保留旧库/Session 只读参考；仅导入用户核对的项目知识。不能凭目录、标题或 `worker-<ticketId>` 推断授权/归属；旧 Mandate 只能保留 legacy provenance，不能伪造成用户确认的新方案。不导入可自动执行的 Effects/Outbox。需要全量历史迁移时另列范围，切换机器人始终只有一个消费者，回退先停新入口。

## 4. 新能力与三个增量的依赖

本表是审计依赖和验收边界，不是实施任务计划；写作计划仍等待设计书面评审。

| 增量 | 在现有底座上必须补齐的能力 | 不可跳过的依赖 |
| --- | --- | --- |
| 1：无 GitHub 文件任务闭环 | 项目/主对话持久化、稳定 actor、PlanRevision/Authorization、项目 coordinator、通用 worker/report、Artifact、Web 内通知、执行 Manifest、基本技能目录/读取控制 | 解除全局 GitHub/setup/env 假设；两项目归属；attempt/Session/cwd/prepare 合同；报告身份与完成门槛；暂停和恢复；先完成相关备份/故障验证 |
| 2：完整 Web 与 KORAM | 项目导航/深链接、知识/资料/成果服务、实时事件与缓存、任务/待决 UI、多 Assignment 依赖/复核、subagent 管理、实例预算与公平调度、代码资源适配、Tailscale | 项目固定资源环境；多仓库全命名空间；可恢复委派与后台生命周期；人工合并及新代码交付规则；真实宿主兼容、手机/远程认证与传输验收 |
| 3：共享飞书 DM | 主动通知绑定、逐消息路由、待归属输入、原生 Delivery 回执与回复索引、规范化会话同步 | 统一身份/授权和事件去重；消息历史/附件归属；发送 unknown 核对；单机器人消费者；恢复回放不外发或重复授权 |

每个增量都沿用现有 Effects、Outbox、DSH 适配层，不增加独立 Agent 聊天总线；新增协作记录只承担归属、依赖和交接，不复制原生 Session 运行明细。

## 5. 验收与测试缺口矩阵

现有测试是回归材料；部分明确断言了需要替换的旧语义，应根据新的外部合同修改，不能为了“原测试全绿”保留错误假设。

| 验收场景 | 现有材料与不足 | 新增判定标准 |
| --- | --- | --- |
| 无仓库项目 | [runtime tests](../../../tests/runtime.spec.ts#L372) 已支持 ready 无 PR，但不是启动无 GitHub | 完全未配置 GitHub 时讨论、文件任务、成果和重启闭环 |
| 项目隔离 | [cards](../../../tests/cards.spec.ts#L184)、[views](../../../tests/views.spec.ts) 都围绕旧全局模型 | 两项目的查询、工具、缓存、文件、事件、通知和迟到报告不串属 |
| 方案确认与身份 | [core engine](../../../tests/core-engine.spec.ts) 覆盖旧准入 | 多入口重复确认只一份授权/任务；过期确认、未绑定 actor 与操作 id 内容冲突拒绝 |
| 暂停与恢复 | [outbox](../../../tests/outbox.spec.ts#L17)、[runtime concurrency](../../../tests/runtime-concurrency.spec.ts) 有局部行为 | checkpoint 后持久暂停，普通输入不恢复，明确恢复后只接续一次 |
| Session 与 prepare | [runtime](../../../tests/runtime.spec.ts#L1079) 覆盖已存在目录复用，需改变其证据前提 | cwd/owner/worktree/配方不符或残留准备进入核对，用户文件不被删 |
| Manifest/技能 | [runtime](../../../tests/runtime.spec.ts#L1033) 覆盖逐请求更新的旧规则 | 版本可还原，目录隐藏与正文越权均拒绝，撤销即时，子执行不继承过量目录 |
| 并行与后台 | [runtime concurrency](../../../tests/runtime-concurrency.spec.ts)、[runtime](../../../tests/runtime.spec.ts#L853) 不能证明同任务并行 | 独立 attempts/worktrees/leases/预算；必要成果未齐不完成；停止未确认不伪装退出 |
| 飞书路由与投递 | [sources](../../../tests/sources.spec.ts)、[feishu read](../../../tests/feishu-read.spec.ts)、[image](../../../tests/feishu-image.spec.ts) 是适配器局部覆盖 | 共享 DM 跨项目、回复冲突、历史过滤、主动通知、原生回执丢失后恢复 |
| 多仓库与反馈 | [github read](../../../tests/github-read.spec.ts)、[cards](../../../tests/cards.spec.ts#L128) 使用旧身份 | 两仓库相同 number、同项目多仓库、同仓库多项目时游标/绑定/反馈不串属 |
| HTTP 与实时 | [http](../../../tests/http.spec.ts#L70) 只证明旧 loopback 拒绝，客户端只有 polling | 真实 tailnet HTTPS 的 DSH 认证、精确 Origin、读写/下载/事件重接及错误来源拒绝 |
| 文件与移动端 | [client](../../../tests/client.spec.tsx#L129) 有不可达分类；不是项目手机交互验收 | realpath/符号链接越界拒绝，授权撤销，大文件；窄屏对话/确认/返回/重试可用 |
| 副作用故障边界 | [effects](../../../tests/effects.spec.ts)、[outbox](../../../tests/outbox.spec.ts) 是机制回归 | 输入落盘、派发、外部已成功未落回执、报告、成果登记边界中断后不盲重放 |
| 迁移与恢复 | [migration](../../../tests/migration.spec.ts#L16) 是 10→11 和拒绝更旧版本 | 原库可回退，legacy 不获新授权，隔离恢复禁执行/外发，DB/Session/成果/版本链接可读 |
| 构建与宿主 | [服务脚本测试](../../../tests/service-script.spec.ts#L1) 使用临时/伪服务；本轮 typecheck 通过、Vitest 启动失败 | 匹配真实宿主的可重复构建，插件加载、workspace、技能、附件、认证与 profile 控制实测 |

## 6. 本轮补入规格的约束

规格同步补入：统一 actor 与历史来源边界、同任务活跃 Assignment/attempt、报告身份与聚合门槛、准备完成证据与 Session/cwd 核对、资源环境/配置生效隔离、可还原 Manifest、资源快照/缓存授权、持久 Web 事件合同、子执行/后台预算、全仓库命名空间、附件与渠道可见内容、旧代码交付规则迁移、真实宿主兼容与隔离历史导入。原有三增量、Mac/Tailscale、单机器人私聊和书面评审边界保持有效。

待真实集成才能关闭的问题包括 DSH 原生认证/权限/全局 skill 继承、RC 宿主兼容、Feishu 主动私聊/回执核对能力、远程流式连接、macOS 启动与完整恢复演练。这些目前是明确的验证项，不能在设计或文档完成时标为已通过。
