# Hello from Main

把一句自己的话，经过一次真实的 GitHub 协作，留在 `main`。

## Good First Conflict

这是一次性的、全自动的 Git 与 GitHub 协作教程。你会完成一次 Tutorial Run：Fork、Branch、Commit、Pull Request、Rebase、Conflict、Review 和 Merge，最后让自己的 Card 进入 `main`。

## 参与 Tutorial Run

1. Fork 本仓库，克隆自己的 Fork，并配置上游仓库：

   ```bash
   git clone https://github.com/<你的 GitHub login>/test-lab.git
   cd test-lab
   git remote add upstream https://github.com/c-w-xiaohei/test-lab.git
   git switch -c add/<你的 GitHub login>
   ```

2. 只新增 `people/<你的 GitHub login>.md`，先填写自己的三段内容：

   ```md
   # 你的昵称

   最近在折腾：你最近在折腾什么

   > 你想留在这里的一句话
   ```

   不要添加链接、外部图片、HTML、额外文件或自由 Markdown 结构。

3. `git add`、`git commit`、`git push -u origin add/<你的 GitHub login>`，然后向本仓库的 `main` 创建 Contribution PR。等待 Integration Bot 创建 Integration Branch 并在 PR 中给出下一步指引。

4. 按评论配置 `upstream`、执行 `git fetch upstream` 和指定的 `git rebase upstream/feature/card-<你的 GitHub login>-source-<Contribution PR 编号>`。解决 `people/<你的 GitHub login>.md` 的有意 `add/add` Conflict，保留双方有效内容，删除所有 conflict marker，再执行 `git add`、`git rebase --continue` 和 `git push --force-with-lease`。

5. 最终 Card 必须保留 Project Shell 的 GitHub 来源元数据，并包含你的昵称、最近在折腾什么和一句留言。检查 Integration PR 中自己的 Card 后提交 GitHub Approval；Approval 只确认 Card，不授予合并权限，也不代表审批生成的 README。

## Canary 设置

- 默认分支必须是 `main`。Contributor 分支使用 `add/<login>`；Integration Bot 使用 `feature/card-<login>-source-<Contribution PR 编号>`。
- 在仓库 Settings 的 Variables 中设置 `HELLO_FROM_MAIN_COMMENT_OWNER_ID`（评论操作者的正十进制 GitHub 用户 ID）和 `HELLO_FROM_MAIN_COMMENT_OWNER_TYPE`（精确填写 `Bot` 或 `User`）。这是非 secret 配置，不要添加或记录 token；工作流使用 GitHub 提供的 `GITHUB_TOKEN`。

## 来自 main 的留言

<!-- cards:start -->
<!-- generated from people/*.md; do not edit manually -->
<!-- cards:end -->
