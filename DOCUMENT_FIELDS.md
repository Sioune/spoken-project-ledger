# document 变更正式字段规范

所有文件操作都通过 `ledger_commit`，或将相同完整请求JSON传入 `ledger_commit_json.payload_json`。权限、base_version、operation_id、source_event_id和幂等规则完全相同。

## 新关联一份成果

```json
{
  "type": "document",
  "id": "调用方生成且固定的文档ID，可省略由服务端生成",
  "values": {
    "project_id": "p-copyright",
    "task_id": "t-package",
    "filename": "实际文件名称.docx",
    "library_ref": "libfile_真实Library编号",
    "summary": "这份文件的结果、版本或修改摘要"
  }
}
```

新建必填：`project_id`、`filename`、`library_ref`。`task_id`、`summary`可省略。`id`属于change顶层，不放入values；建议调用方生成固定ID便于继续关联后续版本。

`project_id`须是已有项目；`task_id`如提供，须属于同一项目。`library_ref`只接受既有本人Library的 `libfile_…` 编号，不接受公开URL、本地路径或伪造ID。应用保存索引，不复制文件或授予访问；引用本体是否可读仍由Library核验，不能把索引已保存当作文件内容已验真。

## 给既有文档增加版本

```json
{"type":"document","id":"上次返回的文档ID","values":{"library_ref":"libfile_另一真实版本","summary":"这一版本改了什么"}}
```

同一文档下同一个Library引用不会重复增加版本。新引用产生不可变的新 `versions[].id` 和服务端 `created_at`，更新 `current_version`；不会改 `accepted_version`，也不会改已发送事实。项目、任务、文件名在创建时确定，此操作不修改其归属。

## 指定正式采用版

```json
{"type":"document","id":"上次返回的文档ID","values":{"accepted_version":"该文档versions数组中已有的id"}}
```

`accepted_version`是服务端版本ID，**不是**Library编号。应先读回文档版本，再提交采用操作；此操作无需library_ref。它只标记采用，不会外发或触发现实提交。

## 回执与现有项目

从回执 `after.documents` 或 `ledger_read.data.documents` 取得文档ID、版本ID、`current_version`和`accepted_version`。服务端没有接受客户端自报的created_at、version_id或checksum字段，不要传这些字段。

初始项目/交付任务：合同 `p-contract / t-contract-review`；语义引力 `p-gravity / t-ui`；杨浦注册 `p-registration / t-research`；选题网站 `p-topics / t-topics`（仅记录，不接管）；凤阙补材包 `p-copyright / t-package`；teaser `p-teaser / t-teaser-edit`或`t-teaser-send`。
