# 项目簿 · 口述项目待办

本人私有的项目和任务状态库。文字模拟转写 → 预览明确变更 → D1原子保存 → 独立读回 → 可信回执。浏览器草稿不作正式记录。

完整对接、鉴权、状态边界和父dot联调步骤见 [HANDOFF.md](HANDOFF.md)，验收证据见 [evidence/validation.json](evidence/validation.json)。规划原件：Library `libfile_92c474c75d908191b4f458bf9aec8634`。

## 已实现

- 今天要做、等待别人、待确认、已完成；项目、任务、子任务和依赖。
- 前序任务可从详情或编辑页点击进入，查看完整内容并在自己的详情完成；全部前序完成后自动解锁后续，不自动完成后续。现有任务的依赖在普通编辑页只读，新建任务仍可选择依赖。
- 初始六项真实工作；制作完成与反馈等待分开，未核实进度保持待核。
- 幂等提交、事件日志、revision冲突、迟到事实保护、反向撤销。
- 保存后读回验证；离线、超时、失败保留原文与编号；不假报保存成功。
- Library文件引用、历史版本、最新与正式采用；不外发或自动上传附件。
- Asia/Shanghai，每2小时整点、工作时段配置；默认关闭；没有后台推送或新增提醒。
- JSON导出与确认恢复，恢复不重放提醒历史。
- 私有Site及7个MCP工具，浏览器与工具均使用同一D1库；显式结构化提交和JSON保底提交共享权限、校验和幂等回执。

## 运行

需要Node >=22.13、Git。使用保留的 `package-lock.json` 安装依赖。Windows若npm包装无法识别路径，可通过Node直接执行系统npm-cli.js。

```text
npm ci --prefer-offline --no-audit --no-fund
node scripts/run-framework.mjs build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_outstanding_ultimatum.sql
node scripts/run-framework.mjs dev --port 5186
```

本机入口 `http://127.0.0.1:5186`，通过 `/signin-with-chatgpt?return_to=/` 使用starter的仅开发模拟身份。生产不包含模拟登录，使用Sites正式身份和owner-only访问名单。开发库与生产D1相互独立。

## 检查

```text
node node_modules/typescript/bin/tsc --noEmit
node --test tests/repository.test.mjs
node --test tests/preview-rounds.test.mjs
node --test tests/dependency-lock.test.mjs
node tests/d1-proof.mjs
node tests/http-proof.mjs
```

HTTP测试需要本机预览；D1测试在独立目录使用真实workerd。浏览器验收使用本机已有Edge和临时安装的Playwright Core：

```text
npm install --prefix .sites-runtime/browser-qa playwright-core --no-audit --no-fund
node tests/browser-proof.mjs
node tests/browser-detail-proof.mjs
node tests/mcp-submit-proof.mjs
node tests/readability-proof.mjs
node tests/settings-preview-proof.mjs
node tests/dependency-flow-proof.mjs
```

四项写入回归顺序为 HTTP → MCP → browser → browser-detail。默认本机端口 5186 被占用时，使用另一个端口启动项目簿并设置 `LEDGER_QA_BASE=http://127.0.0.1:该端口`；只接受本机 HTTP，并在写入前核对项目簿 MCP 服务身份。可读性测试同端口通过 `QA_BASE` 设置。

测试用虚构更新不进入生产库。内部截图、本地状态、浏览器档案、临时依赖均在Git忽略目录中。

视觉改版使用深绿导航、明亮工作区、20px任务标题、16px下一步和14px状态；主按钮48px高。手机首屏直接展示当前可推进的任务。`readability-proof.mjs` 在1440/390/320宽度使用虚构数据，拦截所有写请求，测量字体、点击区域、实际文字对比度及溢出。`visual-capture.mjs` 同样隔离API，仅从指定站点读取前端资源；私有访问令牌只经隐藏stdin传入，不写入文件。

## 当前边界

父dot原生入口已实际完成用户语音变化→MCP提交→回执→独立读回，原验收见 [线上验收证据](evidence/production-acceptance.json)。本次视觉改版前只读核对正式状态为revision5；改版的部署与前后数据对比单独保存在交付回执。网页直接录音未启用、麦克风权限未申请。MVP解析是保守规则，复杂句子在详情页人工核对；共享聊天记忆仍不能代替数据库回执。

`completed_at`当前表示用户口述报告被记录的时间，实际更早完成时刻未知。呈现时应称“口述记录时间”，不可当作已核实的现实发生时刻。当前界面没有单独展示该字段为“实际完成时间”；交接已注明语义。本次视觉改版只调整前端展示，未更改模型、写入、MCP、数据库迁移或权限逻辑。

附件本体仍在Library，应用只保存索引。定时备份、物理删除、关闭网页后的推送、自动催人、外发和版权提交均未启用。撤销若存在任何后续编辑会阻止自动覆盖，需先核对差异。

私有Site身份、版本、部署回执见交付文件。没有新账号、付费服务或硬编码密钥。
