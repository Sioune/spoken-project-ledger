# 项目簿：独立 Codex 接手交接

维护说明：第 2、3 节和历史验收中的版本/数量是接手时快照。后续修复与发布以实际源码、Sites 回执及新的 ledger_read 为准，不据旧快照恢复正式库。

更新日期：2026-10-16。此文件是接手说明，不是数据库备份，也不授权重置正式数据。本轮只更新交接文档和 Library 交付包，没有改应用代码、部署网站或写生产任务。

## 1. 接手对象与分工

用户将亲自新开一个独立、普通 Codex 对话维护这个项目。不要创建新的 dot 子任务、复制出另一个站点，或把子任务冒充用户的独立对话。

- 独立 Codex：负责项目簿网站代码、实用性检查、本地隔离测试和用户后续明确要求的改进。
- dot：继续负责日常口述整理，调用原生 `ledger_read → ledger_commit → ledger_receipt / 独立 ledger_read`，核对后报告保存结果。
- 应用的正式 D1 库是唯一正式状态库。聊天内容、这份文件、初始 seed、截图、导出文件和本机测试库都不能覆盖它。
- 选题网站 / 2.0、造角室及其他项目继续由各自对话维护。本项目只记录它们的工作状态和成果引用，不接管它们的源码或数据库。

## 2. 已核实的路径、源码与站点身份

本机项目根目录：

```text
C:\Users\赵元章\Documents\Codex\2026-10-15\task-2\spoken-projects
```

交接文件：本目录 `HANDOFF.md`；可复制启动指令：本目录 `START_HERE.md`。
相邻交付目录：`C:\Users\赵元章\Documents\Codex\2026-10-15\task-2\deliverables`。

| 项目 | 核实值 |
| --- | --- |
| 原私有运行入口 | https://spoken-project-ledger.siounexzhao.chatgpt.site |
| Site project_id | `appgprj_6ad06c5b63048191b46a8f7dec3a3d77` |
| 当前发布版本 | Sites 版本 3 |
| 已发布源码 commit | `3ecb235dfe70bfebbc3fc6b6ba6e09213b42e6e5` |
| 本轮开始时本地 HEAD | 同上；当时工作树干净 |
| 已成功部署 ID | `appgdep_6ad085c393ec81918514faf749fb34b2` |
| 已发布 version_id | `appgprj_6ad06c5b63048191b46a8f7dec3a3d77~appgver_0770b28803448191b68db1d6d2397558` |
| 原生 MCP 地址 / OAuth resource | https://spoken-project-ledger.siounexzhao.chatgpt.site/mcp |
| 原插件 ID | `plugin_asdk_app_sites_4e856e302c84819195eb6888eb101ab3` |
| 分享边界 | custom owner-only；一个本人账号，零外部访客，无群组授权 |
| 正式存储 | Sites D1，绑定名 `DB`；R2 未启用 |

源码中的 `.openai/hosting.json` 必须保留原样的项目身份和能力：

```json
{
  "d1": "DB",
  "r2": null,
  "capabilities": ["mcp"],
  "project_id": "appgprj_6ad06c5b63048191b46a8f7dec3a3d77"
}
```

这次交接完成后，工作树只应有交接文档变更；不要因为它们未进入上述运行版本就执行 reset/clean 或丢弃文件。运行代码基线与文档修改应分别报告。

本机路径只有在新对话确实连接这台电脑并有文件权限时才可读。若新环境不能访问，先选择/授权该本机项目，或从 Library 取现有交付包在新环境恢复源码；不得声称仅凭路径或聊天记忆已经接管。不要自动重建 `project_id`。新会话的 MCP 工具也不会因共享聊天记忆自动可用，须按原生连接状态核验。

## 3. 正式库的最新只读快照

本轮 2026-10-16 只读核对得到 **revision 8，8 个项目、21 项任务、2 份文档**。父线程此前读到 revision 7；以此次实时结果为准。版本可以继续增长，接手和每次写入前都要重新 `ledger_read`，不要把 8 写死为提交版本。

这些是当前已有的四项新 todo，不能再插入一次，也不能误关闭前轮事项：

| 任务 ID | 项目 | 当前任务 |
| --- | --- | --- |
| `t-topics-sources-20261016` | `p-topics` | 扩充选题网站的中外文采信源 |
| `t-teaser-round-20261016` | `p-teaser` | 10月16日 teaser 新一轮修订及同步宋晔 |
| `t-ledger-usability-20261016` | `p-ledger` | 打磨和测试项目簿功能实用性 |
| `t-gravity-login-20261016` | `p-gravity` | 增补语义引力登录与注册页面设计 |

宋晔的“晔”是左“日”右“华”。当前正式库前轮 `t-teaser-send` 为 done，`t-teaser-feedback` 为 waiting，等待对象为宋晔；`t-teaser-edit` 仍为 done。新一轮修订是另一项 todo。保留原始话语、历史回执中的松叶 / 宋业等写法，不擅自合并联系人或改写历史；当前字段以读回结果为准。

其他必须保留的业务边界：

- 合同审核、发给罗莱家纺是前后两步，不能绕过依赖。
- 语义引力原 UI 设计与发送张锦华已 done，跑通反馈仍 waiting；登录注册设计是新 todo。
- 杨浦公司注册材料、谈判对象、实际注册分步保存，不凭“推进”标注册完成。
- 选题网站旧闭环 / 2.0 状态仍有待核实的记录，不等于其外部开发已被本项目接管。
- 凤阙补材现有任务表示文书待确认主体和送审范围；3 张真实制作过程截图已在正式库标 done。正式提交及审核上线仍有阻塞记录，不能把文书交付或截图完成说成已提交、已上线。
- 无用户明确提供的日期，不增设截止时间；不能从记录时间倒推出实际发送或完成时刻。

`lib/model.ts` 的 seed 只是最初导入模板，仍含最早的任务状态和联系人疑问。它不是最新状态；不得再用 seed、旧文档或旧截图“校正”当前库。

## 4. 技术结构与主要文件

框架是 Sites 的 Vinext starter：React 19、TypeScript、Vinext、Vite、Tailwind、Cloudflare Workers、Drizzle/D1。本机已核对 Node v24.14.0、Git 2.55.0.windows.2；项目要求 Node >=22.13。保留 package-lock.json，不随意升级依赖或替换框架。

| 路径 | 职责 |
| --- | --- |
| `app/ledger-client.tsx` | 今天/项目/待确认/成果文件/设置/历史、编辑弹窗、保存/回执/冲突与草稿逻辑 |
| `app/globals.css` | 当前大字高对比度界面及响应式样式 |
| `app/layout.tsx`、`app/page.tsx` | 页面入口 |
| `app/api/[...path]/route.ts`、`lib/api.ts` | 浏览器 REST 接口、鉴权上下文和错误映射 |
| `app/mcp/route.ts`、`lib/mcp-contract.ts` | 原生 MCP 的 7 个工具、显式 schema、JSON 保底入口 |
| `lib/model.ts` | 数据模型、变更校验、保守文本解析、重复候选与依赖释放 |
| `lib/repository.ts` | 所有者隔离、CAS revision、原子提交、持久幂等、回执和保守撤销 |
| `app/chatgpt-auth.ts` | 读取 Sites 服务端注入的 ChatGPT 身份 |
| `db/schema.ts`、`drizzle/` | ledgers / operations 两张表及既有迁移 |
| `vite.config.ts`、`build/sites-vite-plugin.ts` 等 | 必须保留的 Sites 构建与身份集成 |
| `scripts/run-framework.mjs` | portable / managed-linux 的启动构建入口 |
| `DOCUMENT_FIELDS.md` | 文档引用、版本与正式采用字段规范 |
| `tests/`、`evidence/` | 回归脚本与带日期的历史验收记录 |

状态主体以 JSON 保存在 `ledgers.data`；`ledgers.revision` 是全库 CAS 版本，`operations` 存操作和回执。不要改成浏览器 localStorage 作为正式库，也不要换一个数据库重新开始。任务的 `version` 与全库 `revision`、Sites 发布版本、MCP serverInfo.version 是四种不同版本。

## 5. 已实现与未实现

已实现：

- 今天要做 / 等待别人 / 待确认 / 已完成；项目、任务、子任务、依赖、搜索和结构化维护。
- 文本模拟转写 → 预览 → 人工核对保存 → 持久提交 → 回执与独立读回。
- 全库 revision 冲突、迟到输入保护、原子组、幂等重试、标题重复检测、审计历史和受限撤销。
- Library 文件索引、版本列表、最新版本与正式采用版本分开；项目/任务关联。
- 失败、离线、超时保留原话与操作号；本机只保存未提交草稿，不把它当正式成功。
- JSON 导出与明确确认后的快照恢复。
- 原私有站点、原生 MCP，以及 dot 的真实语音内容整理后提交、回执、独立读回通路。
- 桌面及手机布局；任务标题 20px、下一步 16px、状态 14px、主按钮高 48px、图标触控区至少 44×44px。

边界与已知限制：

1. **网页直接录音未启用**，没有申请麦克风权限。dot 已打通的语音整理入口不等于网页能全自动录音、识别并写入。
2. **外部推送与后台提醒未启用**。配置、页面渠道能力文字、待授权和历史送达计数必须区分；不能说关网页仍能推送，不能把配置保存当作已送达。本次未创建或改动任何现有提醒。
3. 后端提醒时区固定 Asia/Shanghai，只接受 `intervalHours:2` 及合法的同日工作起止时间。2026-10-16 修复后，UI 也仅显示每 2 小时整点，保存配置仍不代表后台推送已启用。
4. 文本解析是保守规则，不是通用自然语言智能体。2026-10-16 修复后，teaser 从实时项目、任务关系、明确日期/轮次和当前联系人定位；多轮歧义、未知对象及复合任务的部分完成只生成待确认问题，不回退修改旧轮次。dot 仍须先读库并选对目标 ID，使用结构化提交；原始话语与历史姓名保持不变。
5. 重复检测不是通用语义去重，详见下一节。可能是“旧任务更新”还是“新一轮任务”的歧义应确认。
6. 文件只保存索引，不自动上传正文、不校验版权或内容真伪、不向外发送。Library ID 格式正确不代表文件存在、内容已验真或访问已获授权。
7. 没有独立联系人实体/自动归一化、自动催人、版权提交、物理删除、定时备份或新的外部服务。
8. 导出包含当前快照和**最近100条** operations，不应称作全量事件归档。恢复只还原 Ledger 快照并清空提醒日志，不导入导出文件中的 operations 历史。
9. 已有文件版本按 `library_ref` 去重。同一 Library 文件若原位换了新版本但 ID 未变，当前模型不能单靠该 ID 区分，应如实说明，不能捏造版本校验值。

## 6. 必须兼容的 dot / MCP 接口

保持原 URL、`POST /mcp`、OAuth resource、插件 ID、工具名、字段及错误语义。协议发现/初始化当前返回 `2026-07-28`，serverInfo.version 为 `1.0.1`；不要误改成站点发布版本 3。

| 工具 | 入参与用途 |
| --- | --- |
| `ledger_read` | `{}`；返回 initialized、revision、data、identity.displayName |
| `ledger_initialize` | `{}`；仅最初授权导入使用，已有库返回原状态，不是重置接口。接手现有库不要调用 |
| `ledger_preview` | text 必填；source_event_id、occurred_at 可选；返回 changes/questions/summary/base_version 等，本身不保存 |
| `ledger_commit` | 结构化提交；字段见下 |
| `ledger_commit_json` | 仅 `{payload_json: JSON.stringify(完整原请求)}`；原生网关不能转交嵌套参数时使用 |
| `ledger_receipt` | `{operation_id}`；查原操作，并重新验证读回 |
| `ledger_undo` | `{operation_id,base_version,idempotency_key}`；生成反向操作 |

两种 commit 入口必须共用权限、契约、持久库和幂等校验。公开 MCP 变更类型仅 `create/update/project/settings/document/pending`，不公开 `restore` 或 `undo_of`；不能以 JSON 入口绕过限制。调整显式字段 schema 及 source_ref 支持后，原生重试通过；未单独证实网关根因。不要退回任意自由对象而未经原生联调。

提交字段：

- operation_id：调用方为这次逻辑操作生成、固定保存的唯一编号。
- idempotency_key：同一次逻辑请求固定不变的幂等键。
- source_event_id：稳定的原消息/事件编号；多独立组用“消息ID:组ID”。
- base_version：刚读到的**全库 revision**，不是 task.version 或 Sites 版本。
- occurred_at：调用方提供的事件/报告时间，建议完整含时区 ISO8601；同一次请求重试不能更新。
- raw_text：用户原话；不能换成开发测试文字去写生产。
- changes：有序的变更数组，最多100项；`id` 在 change 顶层，`values` 是允许字段。
- confirmed：可选布尔值；现有恢复/项目归档要求明确确认。它不是外部事实已经核实的证明，也不能替代 verification_state。

dot 日常路径：

1. `ledger_read` 取得实际对象 ID、状态、全库 revision，匹配用户这次说的任务与轮次。
2. 内容明确且已在用户授权范围时整理结构化 changes；有歧义才确认。可选 preview，但其解释和 pending 变更仍需核对并正式提交。
3. 保存完整原请求，再 `ledger_commit`。网关转交失败时，可将**同一完整请求**交给 ledger_commit_json。
4. 按原 operation_id 查 `ledger_receipt`，再独立 `ledger_read` 核对版本和关键字段；只有验证明确时才报告应用已保存。
5. 报告应用保存与现实动作分别成立：saved/verified 不代表文件已发给别人、正式材料已提交、网站已上线或真实工作已完成。

普通 Codex 若没有这套原生工具，不得改用复制 Cookie、自造鉴权头、硬编码密钥或共享聊天记忆冒充接通。由用户在原生连接界面授权原插件，或交给 dot 做正式任务操作；网站开发测试先在本地完成。

## 7. revision、幂等、重复口述、回执与撤销的精确语义

- 每个新提交是一个全库原子组。D1 batch 同时做带 owner/revision 条件的 UPDATE 和操作 INSERT；失败不能部分保存或假报成功。
- 同一 operation_id、idempotency_key 或 source_event_id 命中已有操作时，比较 payload 哈希。哈希包含 source_event_id、base_version、occurred_at、raw_text、有序 changes、内部 undo_of。相同内容返回原回执并带 duplicate:true；不同内容返回 `409 IDEMPOTENCY_MISMATCH`。
- 超时/断线先查原编号，仍需重试时原样复用全部参数。不要换新 ID 再插任务，也不要刷新原请求的时间、版本或 raw_text。
- `409 REVISION_CONFLICT` 返回 current_revision/current_data。先读最新状态，核对差异；旧请求不得强制覆盖。经重新核对形成的新逻辑请求应使用新编号和新基线，不能用旧幂等键塞新内容。
- 标题规范化为 NFKC、小写、去部分空格/标点。创建时同项目同规范化标题、且非 cancelled 的记录会跳过新增；包含关系只提示 POSSIBLE_DUPLICATE。preview 的完全匹配可跨项目，不能当全语义查重。
- 标题重复跳过或 update 值相同可能导致 effective changes 为空；**新的操作仍可记录并 revision+1**。这不等于幂等回放 duplicate:true，不要混为一谈。
- update 若发生时间早于任务 updated_at 超过1秒，会 `409 STALE_EVENT`；发生时间超前服务端5分钟会拒绝。不能通过伪造时间绕过迟到事实保护。
- 前序完成只让 blocked 转为 todo，或在已有 waiting_for 时转为 waiting；不会自动完成后续。未完成依赖不能直接进入 doing/waiting/done；父子与依赖均不能成环。
- 任务初次创建为 done 或转入 done 时，completed_at 取调用方 occurred_at；已 done 仅补来源保留旧值，包括未知的 null。它不是固定的服务器 created_at，更不能无证据当作现实完成时刻。展示和解释时注明来源及“口述/报告时间”的语义。
- 回执主要含 state、operation_id、result_version、created_at、occurred_at、timezone、changes、before、after、source_event_id、raw_text，可附 duplicate、undo_of、current_revision、verification。没有 record_url 字段。
- HTTP 200 或 MCP isError:false 不保证已验证，仍可能 state=pending_verification。state=verified 且 verification=current_fields_match 时，当前数据与该次 after 一致；historical_commit_current_is_newer 只证明历史提交存在，当前内容须独立读库。
- 历史列表是原来存储的 saved 回执；receipt 才重新计算验证结果。失败请求不一定留下持久失败事件，不能把“历史里没失败”当作所有请求都成功。
- 撤销仅允许**全库最后一次操作**。任何后续编辑，即便另一任务的编辑，也会 UNDO_CONFLICT；不能任意回滚某条历史记录。成功撤销产生新的事件和 revision，不删除历史，也不能撤回现实邮件、材料提交或外部发送。

## 8. 浏览器接口、文件字段与鉴权

| 方法/路径 | 行为 |
| --- | --- |
| GET /api/state | 正式状态、revision、服务端身份 |
| POST /api/preview | text/source_event_id/occurred_at → 预览 |
| POST /api/operations | 提交原子操作组 |
| GET /api/operations/{operation_id} | 回执与读回验证 |
| GET /api/operations | 最近100条操作 |
| POST /api/undo | 保守撤销 |
| GET /api/export | 当前快照及最近100条操作 |
| POST /api/initialize | 仅首次导入；现有生产库禁止拿来接手初始化 |

REST 错误为相应 HTTP 状态和 `{error,message,...details}`；MCP 工具错误通常是 HTTP200 中 `result.isError:true`，需要检查 structuredContent。未知方法/工具可返回 JSON-RPC -32601。UI 必须继续区分“未保存”“保存待验证”“已验证”，保留原文和原操作编号。

生产经过 Sites 私有访问及正式身份注入；应用读取服务端 oai-authenticated-user-id / email，D1 另绑定唯一 owner。客户端不能自报 owner_id。无身份401，另一身份403，浏览器跨站写入403。保持 owner-only，不可为调试改公开、不加开发者白名单、不暴露绕过入口。localhost 的模拟登录仅开发用，不能部署为生产鉴权。

文件详见 DOCUMENT_FIELDS.md：新增 document 要 project_id、filename、library_ref；task_id 可选且须属同项目。新增版本用 change.id 指既有文档，library_ref 指真实 Library 文件；accepted_version 必须是该文档已有 versions[].id，不是 libfile ID。不要写入客户端自造 created_at/version_id/checksum；最新与正式采用独立，索引保存不代表文件已外发或已验真。

## 9. 本机启动、构建与隔离测试

此节是给接手后的开发者运行，本轮没有再次启动预览、跑写测试或构建发布。先确认当前执行环境和项目指令，读取最近的 AGENTS.md（若存在）。

当前 Windows checkout 为 portable 模式；`.sites-runtime/execution-profile.json` 是忽略的本机选择。干净源码缺少它时 scripts/execution-profile.mjs 默认 portable；换到托管 Linux 应按当前 Sites 技能配置，不能复制旧本机目录假装兼容。

依赖已在本机安装。只有缺失或依赖输入改变才重新安装；保留锁文件：

```powershell
Set-Location -LiteralPath 'C:\Users\赵元章\Documents\Codex\2026-10-15\task-2\spoken-projects'
node --version
git status --short
git rev-parse HEAD
npm ci --prefer-offline --no-audit --no-fund
node node_modules/typescript/bin/tsc --noEmit
node scripts/run-framework.mjs build
node scripts/run-framework.mjs dev --port 5186
```

本机入口 `http://127.0.0.1:5186`；开发模拟登录 `/signin-with-chatgpt?return_to=/`。预览在上轮已停止，本轮没有启动。本机模拟用户和本地 D1 与生产不同；页面若有旧 QA 数据属于本机测试记录，不能同步回正式库。

仅全新、确认尚无表的本地测试 DB，才可在构建后运行：

```powershell
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_outstanding_ultimatum.sql
```

该迁移含 CREATE TABLE，不是重复应用的种子脚本。已有本地表无需重跑；严禁把 --local 改成 --remote 对生产做初始化、导入或清空。生产 schema 变化要保留原 D1，并单独设计可兼容、非破坏迁移。

测试命令：

```text
node --test tests/repository.test.mjs
node tests/d1-proof.mjs
node tests/http-proof.mjs
node tests/mcp-submit-proof.mjs
node tests/browser-proof.mjs
node tests/browser-detail-proof.mjs
node tests/readability-proof.mjs
```

- repository：隔离 SQLite 验证保存、幂等、状态边界、权限、撤销等。
- d1-proof：独立本地 Miniflare/workerd D1，验并发CAS、原子回滚、重开持久与外部身份拒绝。
- HTTP、MCP、browser、browser-detail 四个脚本会写**本机**预览库；默认 http://127.0.0.1:5186，端口被占用时可设置 LEDGER_QA_BASE 为另一本机 127.0.0.1 HTTP 端口，并用同一端口启动项目簿。脚本先核对项目簿 MCP 服务身份和七工具；生产主机、凭据、查询和非根路径会被拒绝。四脚本保持顺序跑，避免 revision 冲突，不能将 QA 指向生产。
- MCP 测试已使用每次独立编号及本地事件时间；不要复用历史生产请求。
- 浏览器测试用本机已有 Edge，Playwright Core 位于忽略目录 `.sites-runtime/browser-qa/node_modules/playwright-core`；该临时依赖不在源码 ZIP。缺失时可按 README 安装本地测试依赖，需要原生联网批准就走批准流程，不绕过。
- readability-proof 使用完全虚构 API fixture 并在发送前拦截写入，验1440/390/320、导航、任务、文件、弹窗滚动可达、字号/点击区/对比度/溢出。它不能代替真实写入与回执验收。
- visual-capture 读取指定前端并替换为虚构 API，私有 token 只经隐藏 stdin；不能把 token 写入参数、文件或交接包，不要误称截图展示真实生产任务。
- Node 包装路径问题可使用 Node 直接执行现有系统 npm-cli.js；不要因此改锁文件、框架或权限。workerd/Edge/loopback 在该宿主可能需要原生沙箱批准。不要盲目杀旧 lock 里的 PID，先核实进程与监听端口。

## 10. 最近的实际验收证据

这些是2026-10-15改版交付时已通过的结果，本轮只核实已有证据，没有把它们冒充2026-10-16重跑：

- TypeScript 与生产构建通过；repository 13项通过。
- 真实本地 D1：CAS、回滚、身份隔离、重开持久、回执验证通过。
- HTTP 10项、MCP 8项、浏览器主流程11项、详情/文件4项通过。
- 可读性34屏：1440/390/320，无水平溢出、无页面异常、无写请求；最低正文对比5.18:1，主标题12.14:1，手机详情/编辑弹窗底部可达。
- 改版前后生产 revision5 数据哈希相同；这是那次部署的保护证据，不是今日 revision8 的备份。

证据在 evidence/design-validation.json、evidence/production-acceptance.json，以及相邻 deliverables 的 deployment-receipt-readability.json、production-data-comparison-readability.json 和交付包 screenshots。旧证据里的 revision2/3/5 是历史验收版本，不能替代实时读库。

## 11. 后续部署方式：保留原站点，保持 dot 通路

本轮不部署。将来用户要求网站修改时：

1. 读当前 Sites 技能与 .openai/hosting.json；get_site 核对原 project_id、owner-only、当前版本。不要 create_site 或把原站点 remix 成新站代替。
2. 通过原生 Sites 工具取得短期源码写凭据，放会话内存；用当前官方 site-workflow helper 打开原源码、核对 HEAD 与本地改动。凭据仅隐藏 stdin，不进参数、日志、Git、环境示例、文档或 Library。
3. 保留 sites() 构建集成、DB 绑定、MCP capability、原 /mcp 路径和鉴权。运行必要隔离回归、类型与构建，再由官方 helper 同步源码、记录完整 commit SHA 并打包同一源码的构建输出。
4. 已确认 owner-only 时使用 save_version_and_deploy_private；按实际返回处理已有 saved_version_id / deployment_id，非终态再查状态。不能发布源码未推送的包，也不能把过期 dist 当新代码。
5. 发布前后只读比较生产 revision、关键字段/文件引用、操作历史与权限。开发者没有真实业务写入授权时，生产只读；不要重放样例以证明发布成功。
6. 最后确认原生 ledger_read 可用，必要时由 dot 用用户新授权的真实变更验证 commit→receipt→独立read，不能拿 HTTP200 代替验收。
7. 保留发布回执、源码、Library身份和版本；不付费、不注册新服务、不创建或输入持久凭据、不扩大分享范围。需要这些能力时先用原生授权界面，由用户批准。

上一轮 Windows 的已知工具问题：官方源码 helper 已成功 commit/push，但打包 cpSync 报 EIO。之后通过官方打开流程重新核实远端 HEAD，再用同一 dist 的 PowerShell Copy-Item 与 Windows tar 打出构建包，验证 dist/.openai/hosting.json、dist/server/index.js 和既有 drizzle 迁移后由原生私有部署成功。不要看到 EIO 就认定 push 没发生而反复提交/建站。优先按当前 Sites 故障指引处理；若仍使用此已验证的打包替代，应记录来源和 SHA，不改变权限或 D1。

当时官方 helper 的本机路径如下，仅供定位；版本可能变化，应从当前已安装 Sites 技能解析，不下载或硬编码另一个服务：

```text
C:\Users\赵元章\.codex\plugins\cache\openai-curated-remote\sites\1.0.2-remix-b.1\scripts\site-workflow.mjs
```

Windows tar 归档与 Sites 接收/重封装后的存储哈希可能不是同一层，比较时注明对象，不把两个不同层哈希误判为源码不同。

## 12. 数据保护与接手验收清单

接手先只读，不能拿初始化代替读取。不要删除/替换 D1、恢复旧 JSON、运行 seed、重建 owner、改分享模式、把本机测试库上传生产、硬编码凭据，或改 unrelated 项目。

上线前兼容性至少覆盖：

- 新建 → 持久保存 → 独立读回 → 回执；重复原请求不重复插入。
- 明确区分旧 teaser done/waiting 与新一轮 todo，按读出的 ID 更新。
- 保存503/超时不报成功、草稿与原编号保留；409显示冲突。
- 保守撤销不覆盖后来编辑；依赖释放不自动完成后续。前序列表可导航到真实任务详情并返回；已有任务普通编辑不重写依赖/项目归属。状态晋级不能在同一组通过清空或替换原未完成前序绕过，原前序必须真实完成；独立、明确的结构化依赖维护仍保留原契约。
- 文件关联、历史版本和正式采用独立；手机布局/表单/弹窗滚动可用。
- 无身份/外部身份隔离，跨站拒绝，MCP JSON 保底与结构化入口兼容。
- 原数据/owner-only/原MCP地址和插件继续保留；页面不擅自申请麦克风或通知权限。

本轮只读确认的 revision8 是快照。即使文件里某个状态过时，也应使用新的 ledger_read 与用户事实，不做“按交接文档恢复”。

## 13. 规划、Library 与交付包

规划原件（已完整读取）：Word `libfile_92c474c75d908191b4f458bf9aec8634`；PDF `libfile_9cb8da4a776c81918e3035cfd23c197c`。原规划可读正文为项目上一级 PLANNING.md；交付包会附这份上下文。

沿用的 Library 包身份：`libfile_a995b2d52fb08191ac2971f5063eb35d`，路径“/口述项目待办-MVP交付.zip”。本轮前版本为3；本轮仅增补交接文档和只读核验，写回后的实际版本以随附 Library 回执为准，不新建替代包。

源码基线 ZIP 保留已发布 commit；本轮另附包含最新 HANDOFF.md / START_HERE.md 的接手源码 ZIP，两者明确区分。所有 .git、node_modules、dist、本机 .wrangler/.sites-runtime、草稿、日志、临时浏览器配置和凭据都不得进入接手源码包。已发布构建 tar 保留为历史回退工件，不代表本轮重新部署。

这份文档与启动指令将作为独立 Library 文件交付。具体文件ID和更新后的包版本由最终交付回执提供。没有新服务、持久凭据、真实音频、浏览器Cookie或身份绕过 token。

## 14. 日历与项目周期

日历提供每日首次登记清单及项目周期两种视角。按用户选择，项目内每项任务自动作为节点；点击复用任务详情及前序跳转。项目日期字段为 `start_date`（实际进场）、`target_end_date`（计划完成）、`completed_date`（实际完成），均为可空真实日期，结束不得早于进场，不自动变更任务状态或项目归档。

新项目/任务 `created_at` 仅由服务端生成；客户端不能设置或修改。旧记录没有登记日时，`GET /api/calendar` 按本人回执的全库 `result_version` 因果顺序分页只读查找，且限定于本次状态版本，不受操作历史页面100条上限影响。只认明确新建/初始化；首次已存在、恢复或撤销引入不能伪装为新登记。未知登记日单列，`history_complete` 表示历史查询成功结束，并不表示全部日期已知。没有数据库迁移或自动回填。

任务完成节点标明“口述完成记录”，不推断现实完成时刻。备份恢复不能用文件伪造新登记时间；既有对象保留服务端登记时间，重新引入对象通过旧历史判断。MCP保持原7工具及提交/回执/独立读回路径，日期字段为可选增量字段。上线不写生产样例、不初始化、不恢复快照，应重新比较实时生产状态。
