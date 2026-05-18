# File IO

DigitalAgent 可以通过文件读写在 agent 间传递中间状态或生成可检查产物。

适用场景：

- 用户要求把过程写入文件。
- 多个 agent 需要读取同一份状态、日志、清单或中间产物。
- 验收要求检查某个文件是否存在、是否包含指定结构或内容。

计划建议：

- MissionPlan 应说明文件名、写入规则、读取规则和最终检查方式。
- HR 应避免让所有角色无序写同一个文件；需要设计记录者、校验者或协调者。

## 可用工具

- `file_read({ path })` — 读取 mission 工作区中的文件。返回 `{ exists, content, sizeBytes }`。文件不存在时返回 `exists: false`、`content: ""`,**不抛错**(适合"接龙第一棒,文件还不存在"的场景)。
- `file_write({ path, content, mode })` — 写入文件。`mode` 为 `"overwrite"`(默认,完全覆盖)或 `"append"`(追加到末尾)。`path` 必须相对,如 `chain.txt` 或 `subdir/log.md`。

## 约束

- `path` 不能是绝对路径,不能包含 `..`(防越界)
- 单次读 / 写最大 1 MB
- 单个 mission 工作区最多 100 个文件(超过后 `file_write` 拒绝创建新文件)
- 工作区目录懒创建:首次 `file_write` 自动 `mkdir -p`
- Mission 删除时工作区跟着清理