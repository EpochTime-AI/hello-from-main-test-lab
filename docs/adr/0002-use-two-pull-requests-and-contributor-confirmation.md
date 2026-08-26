# Use two Pull Requests and Contributor Confirmation

每次 Tutorial Run 使用一张进入隔离 Integration Branch 的 Contribution PR，以及一张从该分支进入 `main` 的 Integration PR。Bot 负责合入两张 PR，原始 Contributor 则 Review 并 Approve Integration PR，只确认自己的最终 Card；这既符合公开仓库的真实权限，也能在不授予参与者写权限、不依赖人类 Maintainer 的情况下同时练习提交与 Review。

## Consequences

只有原始 Contributor 的 Approval 能推进对应 Tutorial Run。其他公开 Review 不产生状态效果；Approval 之后，Publisher 只有在已确认 Card blob 保持不变时才能刷新生成的 README。
