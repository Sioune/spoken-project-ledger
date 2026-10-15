# 项目簿 · 口述项目待办

本人私有的项目和任务状态库。文字模拟转写 → 预览明确变更 → D1原子保存 → 独立读回 → 可信回执。浏览器草稿不作正式记录。

完整对接、鉴权、状态边界和父dot联调步骤见 [HANDOFF.md](HANDOFF.md)，验收证据见 [evidence/validation.json](evidence/validation.json)。规划原件：Library `libfile_92c474c75d908191b4f458bf9aec8634`。

## 已实现

- 今天要做、等待别人、待确认、已完成；项目、任务、子任务和依赖。
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
node tests/d1-proof.mjs
node tests/http-proof.mjs
```

HTTP测试需要本机预览；D1测试在独立目录使用真实workerd。浏览器验收使用本机已有Edge和临时安装的Playwright Core：

```text
npm install --prefix .sites-runtime/browser-qa playwright-core --no-audit --no-fund
node tests/browser-proof.mjs
node tests/browser-detail-proof.mjs
```

测试用虚构更新不进入生产库。内部截图、本地状态、浏览器档案、临时依赖均在Git忽略目录中。

## 当前边界

语音权限未申请，真实语音→父dot→写入未联调；MVP解析是保守规则，复杂句子在详情页人工核对。父dot需要在其自身环境连接本应用私有插件后实测，不能把共享聊天记忆当集成。

附件本体仍在Library，应用只保存索引。定时备份、物理删除、关闭网页后的推送、自动催人、外发和版权提交均未启用。撤销若存在任何后续编辑会阻止自动覆盖，需先核对差异。

私有Site身份、版本、部署回执见交付文件。没有新账号、付费服务或硬编码密钥。
