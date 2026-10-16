# 项目簿 · 口述项目待办

本人私有的项目和任务状态库。文字模拟转写 → 预览明确变更 → D1原子保存 → 独立读回 → 可信回执。浏览器草稿不作正式记录。

完整对接、鉴权、状态边界和父dot联调步骤见 [HANDOFF.md](HANDOFF.md)，验收证据见 [evidence/validation.json](evidence/validation.json)。规划原件：Library `libfile_92c474c75d908191b4f458bf9aec8634`。

## 已实现

- 今天要做、等待别人、待确认、已完成；项目、任务、子任务和依赖。
- 前序任务可从详情或编辑页点击进入，查看完整内容并在自己的详情完成；全部前序完成后自动解锁后续，不自动完成后续。现有任务的依赖在普通编辑页只读，新建任务仍可选择依赖。
- 日历包含“每日登记”和“项目周期”：前者按首次登记的上海日期归类，后者自动展示项目内每项任务的节点，关联原任务详情和前序流程。项目支持实际进场、计划完成与实际完成日期，三者可分别留空。
- 初始六项真实工作；制作完成与反馈等待分开，未核实进度保持待核。
- 幂等提交、事件日志、revision冲突、迟到事实保护、反向撤销。
- 保存后读回验证；离线、超时、失败保留原文与编号；不假报保存成功。
- Library文件引用、历史版本、最新与正式采用；不外发或自动上传附件。
- Asia/Shanghai，每2小时整点、工作时段配置；默认关闭；没有后台推送或新增提醒。
- JSON导出与确认恢复，恢复不重放提醒历史。
- 私有Site及7个MCP工具，浏览器与工具均使用同一D1库；显式结构化提交和JSON保底提交共享权限、校验和幂等回执。
- 图片录入：选原图、补充说明、视觉识别或手动填写、可编辑预览、查重、确认保存、独立回执读回。未经配置和授权时不会调用视觉服务，页面明确显示手动模式。
- 今天／明天分别列执行任务和活动；预约不是已完成任务，活动日期不使用上传日期。旧的“已预约活动｜”记录只读兼容，不自动改写数据。

## 运行

需要Node >=22.13、Git。使用保留的 `package-lock.json` 安装依赖。Windows若npm包装无法识别路径，可通过Node直接执行系统npm-cli.js。

```text
npm ci --prefer-offline --no-audit --no-fund
node scripts/run-framework.mjs build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_outstanding_ultimatum.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_sharp_yellowjacket.sql
node scripts/run-framework.mjs dev --port 5186
```

本机入口 `http://127.0.0.1:5186`，通过 `/signin-with-chatgpt?return_to=/` 使用starter的仅开发模拟身份。生产不包含模拟登录，使用Sites正式身份和owner-only访问名单。开发库与生产D1相互独立。

## 检查

```text
node node_modules/typescript/bin/tsc --noEmit
node --test tests/repository.test.mjs
node --test tests/preview-rounds.test.mjs
node --test tests/dependency-lock.test.mjs
node --test tests/calendar.test.mjs
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
node tests/calendar-flow-proof.mjs
node tests/calendar-ui-proof.mjs
```

四项写入回归顺序为 HTTP → MCP → browser → browser-detail。默认本机端口 5186 被占用时，使用另一个端口启动项目簿并设置 `LEDGER_QA_BASE=http://127.0.0.1:该端口`；只接受本机 HTTP，并在写入前核对项目簿 MCP 服务身份。可读性测试同端口通过 `QA_BASE` 设置。

测试用虚构更新不进入生产库。内部截图、本地状态、浏览器档案、临时依赖均在Git忽略目录中。

视觉改版使用深绿导航、明亮工作区、20px任务标题、16px下一步和14px状态；主按钮48px高。手机首屏直接展示当前可推进的任务。`readability-proof.mjs` 在1440/390/320宽度使用虚构数据，拦截所有写请求，测量字体、点击区域、实际文字对比度及溢出。`visual-capture.mjs` 同样隔离API，仅从指定站点读取前端资源；私有访问令牌只经隐藏stdin传入，不写入文件。

## 当前边界

父dot原生入口已实际完成用户语音变化→MCP提交→回执→独立读回，原验收见 [线上验收证据](evidence/production-acceptance.json)。本次视觉改版前只读核对正式状态为revision5；改版的部署与前后数据对比单独保存在交付回执。网页直接录音未启用、麦克风权限未申请。MVP解析是保守规则，复杂句子在详情页人工核对；共享聊天记忆仍不能代替数据库回执。

`completed_at`当前表示用户口述报告被记录的时间，实际更早完成时刻未知。呈现时应称“口述记录时间”，不可当作已核实的现实发生时刻。当前界面没有单独展示该字段为“实际完成时间”；交接已注明语义。本次视觉改版只调整前端展示，未更改模型、写入、MCP、数据库迁移或权限逻辑。

既有Library附件仍只保存索引；图片录入确认保存的原图另存于现有私有D1，按本人身份读取。定时备份、物理删除、关闭网页后的推送、自动催人、外发和版权提交均未启用。撤销若存在任何后续编辑会阻止自动覆盖，需先核对差异。

私有Site身份、版本、部署回执见交付文件。没有新账号、付费服务或硬编码密钥。

## 图片事项录入与视觉配置

在“手动模式 → 记一条新进展”中选择PNG、JPEG或WebP原图，单张不超过1,500,000字节。不接受SVG、GIF或伪造文件类型，不缩小图片后冒充原图。未保存图片、说明、预览字段和待确认问题保留在本机IndexedDB，按已认证的本人作用域隔离；可清除本机草稿。上传校验时间、首次登记时间与活动/事实发生时间独立。

识别将新增任务、已有任务进展、已预约活动、完成凭证与参考资料分开。日期缺年、时间来源不明、说明与图片冲突或意图不清时保留空值及确认问题。完成凭证不直接完成原任务；识别无权预约、付款、发消息或设置推送。图片文字和识别输出均视为不可信资料，模型没有工具，服务端只接收固定结构字段。

预览不写业务库。精确重复默认只查看；需要为既有事项补原图时明确选择“仅关联原图”，不改原事项日期/状态。保存时原图、事项和操作回执在一个D1事务中提交；失败或版本冲突不留孤立图片。相同操作编号和原请求重试沿用原回执；相同原图及同日期时间/地点的预约有额外重复保护。确认前不保存原图到服务端，识别结果缓存不代表事项已保存。

可选视觉服务固定为OpenAI GPT‑4.1 mini，只有获得用户付费及授权确认后，才通过OpenAI Developers插件的密钥授权流程配置服务端秘密 `OPENAI_API_KEY`，并设置服务端 `VISION_ENABLED=true`；不得把密钥放前端、Git或聊天记录。未配置/未启用时提供手动填写及明确错误，不伪装已识别。`/api/intake/capabilities`只返回是否配置及服务说明，不返回密钥。

启用后每位本人每天（上海时区）最多10次新识别，单次最多1500输出token。公开费率：输入$0.40、输出$1.60/百万token，图片折算输入token，实际费用以账单为准。失败尝试计入每日上限，网络超时可能已计费。同一识别编号不会再次调用；成功的同图同说明结果可复用7天缓存。改变图片或说明要明确发起新识别。原图、说明和项目名称会发送至OpenAI，现有任务内容不外传；每次发送前页面要求勾选知情同意。

请求使用 `store:false` 且不创建Files文件，这不等于零保留；API数据默认不用于训练，滥用监测通常最长保留30天，法律、安全及图像审核有例外，详见[官方数据政策](https://developers.openai.com/api/docs/guides/your-data)。本站仅缓存结构化识别结果/安全错误码7天，在下一次识别访问时清理过期缓存。确认保存的原图长期保存在现有私有数据库，撤销事项不物理删除原图，以便原回执核对。未保存草稿由用户清除或浏览器清理；本机共享设备需考虑浏览器存储可见性。

新增迁移0001仅创建图片和识别缓存表，不修改既有表数据、owner或MCP路由。已有本机库只应用尚未应用的0001；全新库按顺序各应用一次。原7个dot工具保持名称与鉴权，仅增加可选事项元数据；工具不能上传任意图片字节或取得服务端密钥。

图片专项验证：`node --test tests/intake-model.test.mjs tests/image-intake.test.mjs tests/vision.test.mjs`；本机端到端用 `node tests/image-intake-flow-proof.mjs`，纯模拟视觉/失败恢复UI用 `node tests/image-intake-ui-proof.mjs`。前者只允许经身份核验的本机地址，原图由 `LEDGER_QA_IMAGE_PATH` 指定且不入Git；后者不调用真实视觉服务。模拟测试通过不能称为真实视觉API已通过。

## 日历日期语义

日历入口支持 `?view=calendar`，月份、选中日、模式和项目筛选会保存在地址参数。新项目和任务的首次登记时间由服务端生成，后续编辑不能修改；已有记录从本人操作回执按全库版本顺序分页推导，超过最近100条历史仍会继续查找。无法确认首次登记的记录单独列为未知，不以最近更新时间替代。读取日历不会回填、重写或迁移原有数据。

项目周期自动包含每项任务。任务登记、计划日期、硬截止和口述完成记录使用不同标签；`completed_at`仍然只是口述完成被记录的时刻。实际进场、计划完成、实际完成由用户明确填写，完成日不自动归档或关闭任务。修改项目日期沿用版本冲突、幂等保存、回执及独立读回流程。所有日历测试只写本机隔离库或使用拦截API的虚构夹具。
