# T4 通用 worker 与成果闭环开发检查记录

本地开发记录从属于 [规范总计划](2026-11-02-project-superagent-workbench.md) 的 T4，仅记录本次实现和验证，不新增规范或审批步骤。真实 native/browser 验收由 Root 完成。

## 范围与实现

Ticket/Assignment 仍是唯一业务聚合；execution-attempts 保存运行现场与 lease，artifact-store 保存不可变内容和操作日志，report-acceptance 按登记条件完成聚合。项目 worker 使用独立 Session/cwd 和最小文件工具，与旧仓库 worker 共享 WorkerSlots；coordinator 不参与报告接收或确定性推进。

只实现 T4，不扩展资源图调度、通用恢复平台、转包或远端 Web。关闭无合同的 subagent；无 GitHub/飞书可运行；人工合并；不部署、不改运行宿主。

- [x] PlanContent 增加可确认的完成规则，缺省独立语义复核；显式 registered-files 才按全部登记输出、checksum 和未决项确定性完成。可在已确认方案中固定输入成果的精确内容版本。
- [x] schema15 执行、成果、报告、独立门结论表，复用 Store 事务迁移和 WAL 快照。
- [x] 服务端分配 attempt、lease、实际 Session/workspace/cwd；prepare 先登记再独占创建；未知现场阻塞核对，每次校验 realpath；使用现有执行槽派发。
- [x] 稳定操作 id 写入日志、不可变 SHA256 版本、fsync 后登记；中断后按原操作重试核对；拒绝跨归属、旧 lease、越界路径和非登记输入。
- [x] 报告包含完成摘要、证据、成果和未决事项；语义结论绑定报告、成果版本、条件版本、执行代次及认证 owner；报告和主对话返回原子保存。
- [x] 原生 Session guard 允许终态精确报告/成果回执进入服务判重，新增及冲突操作仍拒绝；其他工具保持活跃授权检查。记录规则、工具、资源、技能及实际 request/header 模型配置。
- [x] Web 展示成果、精确版本文本、完成策略、真实等待状态及显式语义复核；证据必填，失败决定不虚报完成。
- [x] 真实完成后应用/coordinator 历史确认、另一消息重复确认保留原 target/Assignment；新显式认证 rerun 创建新授权并打开同一 Ticket，保留旧版本、报告和历史；普通讨论、非 owner、停止和未知未完成效果不得重开。
- [x] 注册工具及 guard 回归、两项目 maxWorkers=1、固定版本输入、写入中断/重开恢复、schema14→15 成功/失败/WAL、Web、旧 executor/runtime 回归。
- [x] `env -u GIT_CONFIG_GLOBAL pnpm check`：typecheck、74 个测试文件/1304 项测试、build 均通过。检查子进程移除宿主继承的该变量，是为了满足既有运行时测试的初始环境约定，不改变宿主配置。
- [x] `git diff --check` 通过。

## 交付和边界

按指定身份提交并 REST 创建 `dev` PR；HEAD 与 PR 链接以最终交付报告为准。排除 `.pnpm-store/` 等依赖缓存，不合并、不部署。

文件写入恢复要求以原 operation id 显式重试，不提供启动时全盘自动接管；未知 prepare 目录保留为 reconciliation，不自动采用。语义复核由认证 owner 明确给出结论；原生宿主/浏览器实测以及独立固定 HEAD 审查由 Root 完成。本地测试和构建不替代该验收。
