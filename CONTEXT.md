# Hello from Main

Hello from Main 是一个一次性、全自动的 Git 与 GitHub 协作教程。参与者完成一条真实的贡献链路，并在 `main` 中留下一张可见的留言卡作为完成结果。

## Language

**Tutorial Run（教程流程）**:
一个 GitHub 账号首次从创建个人分支到留言卡进入 `main` 的完整过程。每个账号只能完成一次 Tutorial Run。
_Avoid_: Course, community membership, yearbook entry

**Contributor（参与者）**:
正在完成 Tutorial Run，并拥有该流程中个人内容的人。
_Avoid_: Student, member, card owner

**Contribution（个人贡献）**:
Contributor 写下的昵称、最近在折腾什么和一句留言。这部分内容的表达权属于 Contributor。
_Avoid_: Profile, biography, configuration

**Card（留言卡）**:
Contribution 与项目补充的 GitHub 来源信息整合后形成的 Markdown 文件。Card 是 Tutorial Run 的公开完成结果，不是教程产品本身。
_Avoid_: Yearbook profile, account, postcard

**Project Shell（项目外壳）**:
Integration Bot 为一张 Card 创建的标准结构和 GitHub 来源元数据。它与 Contribution 都是完整 Card 的必要组成部分。
_Avoid_: Bot version, verified profile

**Integration Bot（集成机器人）**:
由项目维护者开发和授权、在单次 Tutorial Run 中执行确定性集成协议的自动化。它不代替项目维护者的治理和开发职责。
_Avoid_: Maintainer Bot, AI maintainer

**Integration Branch（集成分支）**:
Integration Bot 为一次 Tutorial Run 创建的隔离分支。Project Shell 先进入该分支，Contribution 随后通过 Contribution PR 被接纳。
_Avoid_: User branch, main

**Contribution PR（贡献 PR）**:
从 Contributor 的 Fork 分支指向其 Integration Branch 的 Pull Request，表达“把我的个人工作接入这次集成”。
_Avoid_: Final PR, publication PR

**Integration PR（集成 PR）**:
从 Integration Branch 指向 `main` 的 Pull Request，展示 Card 和 README 的最终集成结果。
_Avoid_: Contributor PR, release PR

**Contributor Confirmation（参与者确认）**:
Contributor 对自己 Integration PR 提交的 GitHub Approval，表示其检查并确认了最终 Card。它不授予 Contributor 仓库合并权限，也不表示其审批整个生成的 README。
_Avoid_: Maintainer approval, merge permission

**Completion Wall（完成墙）**:
README 中由所有已进入 `main` 的 Card 生成的公开展示区域。当前中文标题为“来自 main 的留言”。
_Avoid_: Product, community, yearbook

**Publisher（发布器）**:
串行刷新 Integration Branch、重建 Completion Wall 并将已确认结果自动合入 `main` 的可信自动化。刷新不得丢失已经接纳的 Contribution 历史。
_Avoid_: Human maintainer, contributor
