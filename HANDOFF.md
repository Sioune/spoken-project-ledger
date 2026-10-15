# 父 dot 接口交接

本项目位于 `C:\Users\赵元章\Documents\Codex\2026-10-15\task-2\spoken-projects`，与选题网站、造角室无代码或数据库共享。

规划依据为已完整读取的8页Word：`libfile_92c474c75d908191b4f458bf9aec8634`。完整可读正文保存在上一级 `PLANNING.md`。

## 集成路径

预定私有入口：`https://spoken-project-ledger.siounexzhao.chatgpt.site`。仅在部署回执确认成功后可用；当前进度以 `DEPLOYMENT.json` 为准。

浏览器接口：

| 路径 | 行为 |
| --- | --- |
| GET `/api/state` | 最新正式状态、全库revision、服务端身份 |
| POST `/api/initialize` | 幂等导入用户授权六项初始工作 |
| POST `/api/preview` | `{text,source_event_id,occurred_at}` →明确changes、questions、base_version |
| POST `/api/operations` | 提交一个原子操作组 |
| GET `/api/operations/{operation_id}` | 查询原提交与读回验证 |
| GET `/api/operations` | 最近100条审计记录 |
| POST `/api/undo` | `{operation_id,base_version,idempotency_key}` →新反向事件；有后续修改则409 |
| GET `/api/export` | JSON备份；恢复通过confirmed restore操作完成 |

MCP入口：`POST /mcp`，协议 `2026-07-28`，工具 `ledger_read`、`ledger_initialize`、`ledger_preview`、`ledger_commit`、`ledger_receipt`、`ledger_undo`。

鉴权：Sites 私有访问边界和 ChatGPT 登录；应用从服务端 `oai-authenticated-user-id` 获取身份，数据库另绑定唯一所有者。客户端不能自报 owner_id。浏览器正常登录；父dot应安装/连接发布时Sites生成的个人插件，并用原生工具调用。**不能靠共享记忆、普通聊天文字或复制浏览器Cookie冒充集成。**未认证读取401；其他身份403；跨站浏览器写入403。文件只存Library索引，原文件访问继续由Library校验。

## 父dot实测步骤

1. 原生连接可用后调用 `ledger_read`；未初始化时在用户已有授权范围调用 `ledger_initialize`。
2. 用用户的一条真实任务更新调用 `ledger_preview`。保留原消息ID作为 `source_event_id`；多独立组使用 `消息ID:组ID`。明确部分可提交，歧义留pending。原始音频不留存。
3. `ledger_commit` 参数示例（ID和时间必须实际生成）：

```json
{
  "operation_id": "由调用方生成的UUID",
  "idempotency_key": "同一次请求固定UUID",
  "source_event_id": "原消息ID:组ID",
  "base_version": 1,
  "occurred_at": "含时区的真实事件时间",
  "raw_text": "用户原话",
  "changes": [{"type":"update","id":"t-teaser-feedback","values":{"status":"waiting","waiting_for":"松叶","expected_result":"等待teaser反馈"}}],
  "confirmed": true
}
```

4. 调用 `ledger_receipt` 查询原编号，再独立 `ledger_read` 比较实际revision和关键字段。只有state=verified才能说应用已保存；若当前已有更新版，分别报告本次版本与当前版本。
5. 同一请求原样重放3次必须返回原回执且duplicate=true。同key异payload409。超时先查原编号，不重建任务。

当前实现支持人工粘贴文本模拟转写和结构化MCP写入。真实语音→父dot→本库链路尚需父dot自身实测；浏览器未申请麦克风权限。安装/连接本应用个人插件若未自动完成，需要用户在原生界面操作。无新服务账号或持久密钥。

## 行为边界

- teaser制作、发送为done，反馈独立waiting；松叶与宋业不合并。
- 补材包交付完成不代表正式提交或上线；选题网站执行状态未核、不接管外部开发。
- 全库revision保证原子一致，任务也有独立版本。撤销采用保守冲突策略：原操作后任何编辑都会阻止直接撤销，用户可核对差异后手动更正。
- 一个commit为一个原子组；多个独立组分别提交、分别报告成功/失败。相近标题提示候选，不自动合并。解析覆盖有限，结构化详情可完成全部维护。
- 提醒默认关闭；Asia/Shanghai，每2小时整点及工作时段仅配置。可用渠道仅网页打开时显示到期信息。后台、外部推送尚未授权或接通，已送达不得伪报。没有创建或修改任何已有提醒。
- 文件仅绑定既有Library引用；版本历史、最新和正式采用独立。应用不上传到公开位置、不外发。
- 备份通过JSON导出和明确确认恢复。恢复不重发历史提醒；MVP不自动执行定时备份或物理删除。

## 本地运行与测试

依赖已安装，开发预览命令：`node scripts/run-framework.mjs dev --port 5186`，仅 `127.0.0.1`。

本地登录使用Sites starter的开发模拟身份，仅开发构建含此功能；线上保留Sites正式身份校验。

```text
node node_modules/typescript/bin/tsc --noEmit
node --test tests/repository.test.mjs
node tests/d1-proof.mjs
node tests/http-proof.mjs
node scripts/run-framework.mjs build
```

`d1-proof`使用隔离D1测试库，验并发CAS/事务回滚/持久重开；`http-proof`使用本机预览库。依赖下载、workerd与本机网络在此宿主需要原生沙箱批准。Sites安装/构建助手的npm包装在此Windows路径报错；直接Node调用同一锁文件npm及starter build已可执行，没有替换生产框架。

正式部署数据存Sites D1；本地 `.wrangler/`、测试 `.sites-runtime/`、草稿和日志不进入源码包。部署版本、源码commit及验收结果见随附回执。
