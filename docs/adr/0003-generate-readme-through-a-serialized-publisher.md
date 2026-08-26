# Generate README through a serialized Publisher

公开 Card 继续展示在 README，但 `people/*.md` 是唯一事实源，README 标记区域是自动化独占维护的生成结果。已确认的 Integration PR 串行发布；每次 Merge 前，Publisher 都把最新 `main` 安全整合进分支，保留已经接纳的 Contribution 历史和已经确认的 Card blob，确定性重建 README，并在 base 变化时安全重试。

## Consequences

参与者不需要处理偶发的 README Conflict，并发 Tutorial Run 也不会相互覆盖 Completion Wall。Contributor Approval 的对象是自己的 Card，而不是可变化的聚合输出。发布队列必须能从仓库当前事实恢复，不能只依赖 workflow concurrency。
