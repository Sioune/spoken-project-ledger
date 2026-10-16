# 项目簿独立 Codex 接手启动指令

用户自行新开普通、独立的 Codex 对话，选择下方本机目录；若该环境不能访问本机文件，先授权/选择项目或从 Library 导入现有交付包源码。不要把 dot 子任务当成独立会话。下方整段可直接复制为新对话第一条消息。

```text
请接手维护我已有的“项目簿”，使用这个独立 Codex 对话负责网站开发，dot 继续负责口述整理和正式任务更新。

本机项目目录：
C:\Users\赵元章\Documents\Codex\2026-10-15\task-2\spoken-projects

先确认你确实能访问这个目录，完整阅读 HANDOFF.md、START_HERE.md、README.md、DOCUMENT_FIELDS.md，以及最近的 AGENTS.md（若有）。若无法访问，请明确说明需要我选择/授权该项目，或读取我提供的 Library 交付包，不要凭聊天记忆猜源码。

原私有站点：
https://spoken-project-ledger.siounexzhao.chatgpt.site
保留 .openai/hosting.json 的原 project_id、原 D1、owner-only、/mcp、OAuth resource、插件和全部工具契约。不要新建站、重置数据、导入 seed、恢复旧快照，或改动选题网站/造角室等其他项目。

先做只读接手核验：检查 Git 状态和源码基线，核对现有部署与本地运行/测试方式；原生 MCP 可用才 ledger_read。交接时实读 revision8、8项目21任务2文档只是快照，以你读取到的实时库为准。四个10月16日新 todo 已存在：中外文采信源、teaser新一轮修订同步宋晔、项目簿实用性测试、语义引力登录注册设计；不要重复新增或覆盖前轮 teaser done/waiting。宋晔的晔是左日右华。

dot 的既有路径必须继续可用：
ledger_read → ledger_commit（或完整原请求的 ledger_commit_json）→ ledger_receipt + 独立 ledger_read。
保留全库revision冲突、稳定幂等编号/来源编号/原时间、重复检测、原子组、保守撤销、文件版本和验证回执；失败或 pending_verification 不得报成功。不要用复制Cookie、自造身份头或持久密钥绕过原生授权。

网站测试只写本机隔离库，四项写入回归顺序跑，不得改为生产URL。网页直接录音和外部推送尚未启用；不要擅自申请权限、开外部服务或扩大分享。后续按我的具体需求在本项目迭代，需要发布时更新原私有站点并核对数据不丢、MCP仍可用。

先告诉我：你实际读到的路径/HEAD/工作树状态、实时库可读情况、已实现和已知限制，以及接下来可执行的实用性检查；不要在接手核验阶段写生产任务或部署。
```

