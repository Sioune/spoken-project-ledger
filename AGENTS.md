# 项目簿维护约定

## 当前用户授权

2026-10-20，用户明确将 Windows 已开发并发布到 Sites 的项目交由此 Mac 工作目录继续维护。之后用户提出的网站修改，完成开发和验证后默认更新发布到原 Sites 项目；若该次明确要求仅本地、暂不发布或先讨论，按该次要求执行。正常更新不额外增加聊天发布确认；原生工具审批仍适用。

本次迁移基线整理只记录本机适配与维护方式，没有新的业务功能发布需求。

## 唯一项目与数据源

- Mac 工作目录：`/Users/siounex/Documents/ChatGPT/项目簿`。
- 原 Sites project_id：`appgprj_6ad06c5b63048191b46a8f7dec3a3d77`，以 `.openai/hosting.json` 为准。
- 原站：`https://spoken-project-ledger.siounexzhao.chatgpt.site`。
- 原 MCP 与 OAuth resource：`https://spoken-project-ledger.siounexzhao.chatgpt.site/mcp`。
- 保留原私有权限、D1 绑定 `DB`、四表 schema、既有迁移与七个 MCP 工具；R2 未启用。
- 正式 D1 是业务状态库。本机 D1、桥缓存、IndexedDB 草稿和历史交接快照不能代替正式库。测试只写隔离本机库；不向生产初始化 seed、恢复历史快照或导入本机数据库。

## 源码基线与 Git

已通过当前 Sites 官方 source helper 取回原仓库历史并将其接入本目录，基线提交为 `dce45a768517282be1f632315804f8f5ff23f69b`，不是从 ZIP 人工伪造的提交。维护分支为 `codex/mac-maintenance`；后续分支默认用 `codex/` 前缀。不要覆盖其他目录的已有工作或强推原仓库。

`.handoff/` 保留已校验的交接材料；此前 Mac 试点位于 `/Users/siounex/Documents/Codex/2026-10-19/task/spoken-project-ledger-mac`，仅供比较，不作为当前维护入口。交接材料中的“首次只读、不部署”描述当时交接范围，不能覆盖用户之后的开发与发布授权。历史 revision 和测试数只是时点记录，实时状态须重新读取。

本机适配范围：固定且验证 OpenAI 签名的 Mac 官方 CLI 路径、最小环境、Mac 桥状态目录、平台路径测试断言，以及原生 transport 测试的进程组终止注入。没有因此改变业务模型、迁移或生产数据。

## 本机运行与检查

依赖按保留的两份锁文件安装：`npm run install:ci` 和 `npm --prefix scripts/codex-bridge ci`。已验证 Darwin arm64、Node v24.15.0；以当前机器实测为准。

- 预览：`node scripts/run-framework.mjs dev --port 5188`，仅 loopback。本地开发登录为 `/signin-with-chatgpt?return_to=/`，身份 Seedy 与生产身份不同。
- 桥：`node scripts/codex-bridge/run.mjs`，固定 `127.0.0.1:5197`，仅允许原私有站 Origin。本机 5188 预览不在允许范围内。
- 当前后台 PID、日志和核验证据在 `.sites-runtime/mac/`；没有开机自启。启动前核对端口及进程来源，不按旧 PID 停止进程。另一个旧副本占用的 5186 服务保持独立。
- 桥状态目录：`~/Library/Application Support/SpokenProjectLedgerCodex`，不能删除墓碑、失败编号或次数来重试。
- 类型检查：`node node_modules/typescript/bin/tsc --noEmit --incremental false`。
- 构建：`npm run build`。
- 离线回归：`node --test --test-concurrency=1 tests/*.test.mjs`。native transport 的 mock 必须同时隔离 spawn 和进程组终止；不可让 fake PID 调用真实 POSIX kill。
- 涉及持久化时运行 `node tests/d1-proof.mjs`；浏览器 proof 仍有 Windows 路径与端口假设，运行前按具体脚本检查并适配。选择与改动相关的验证，不把模拟通过称为真实识图通过。

官方 CLI 复用正常 ChatGPT 登录，不读、复制或打印认证文件，不另建 OAuth，不静默切换付费 API。保留工具禁用、结构校验、临时目录清理、取消和超时、幂等及账户一致性约束。真实图像模型调用须有用户提供待测图及相应请求。

## 后续开发和 Sites 发布

1. 阅读当前已安装的 Sites 技能；用 `.openai/hosting.json` 的原 project_id 调用 `get_site` 核对线上版本、权限和 MCP，再通过官方临时凭据与 source helper 打开/同步源码。凭据仅在内存及隐藏 stdin 传递，不能落盘、写入命令参数或 Git 配置。
2. 保留本机改动；若远端有更新，先比较并合并，不 reset/clean 或直接覆盖。用户授权的正常代码更新完成后，用适用检查和浏览器验证确认结果。
3. 发布前通过原生 `ledger_read` 取得正式数据基线，不为证明接通而写生产任务。使用当前官方 helper 推送准确源码、构建与打包同一提交；保存后部署到原站，保留原 audience 和绑定。不要复用旧 dist、Windows helper 路径或过期凭据，不新建站点。
4. 按原生工具结果核对部署终态、站址、原 MCP 与正式数据读回。数据可能有用户并发更新，不能要求 revision 必须不变或据此回滚。报告实际发布版本、提交、验证和未验证项。

日常业务更新继续遵循 `ledger_read → ledger_commit`（或同一完整请求的 `ledger_commit_json`）`→ ledger_receipt + 独立 ledger_read`。超时先查原编号回执；409 先读新状态，不换号重复创建、不强制覆盖。
