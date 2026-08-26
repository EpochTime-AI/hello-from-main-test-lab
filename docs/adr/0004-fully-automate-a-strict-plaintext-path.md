# Fully automate a strict plaintext contribution path

正常 Tutorial Run 的关键路径不包含人类 Maintainer，因此第一版只接受一张预期 Card、三个严格结构的纯文本字段，以及由可信自动化派生的 GitHub 元数据。外部 Fork 内容一律作为被动的不可信数据处理，绝不在高权限 workflow 中执行；项目接受表达能力受限，以换取确定性校验、安全自动发布和随时可完成的教程。

## Consequences

链接、外部图片、HTML、额外文件和自由格式 Markdown 都会被拒绝。严格结构只能降低而不能消除自然语言滥用，因此人类 Maintainer 仍保留发布后删除和紧急控制能力。
