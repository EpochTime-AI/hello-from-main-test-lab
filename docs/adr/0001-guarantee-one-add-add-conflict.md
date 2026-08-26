# Guarantee one meaningful add/add conflict

Hello from Main 让 Contributor 与 Integration Bot 分别创建同一 Card 路径的两个有效版本，保证 Contributor Rebase 到 Integration Branch 时会遇到一次 `add/add` Conflict。教程会明确说明这个碰撞是有意设计的，同时确保每个 Git 事件和冲突两边的内容都真实有用；相比等待偶然冲突或加入无意义的 marker 文件，确定性 Conflict 更符合教学目标。

## Consequences

首次 Tutorial Run 必须包含 Rebase 和人工组合双方版本。后续 Card 更新使用普通 PR，不重复制造该练习。
