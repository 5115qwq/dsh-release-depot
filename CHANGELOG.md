# Changelog

## 1.1.5

### 修复

- 修正 npm 2FA 设置页链接：`/settings/~/two-factor-authentication` 在 npm 上是 404，正确路由是 `/settings/~/tfa`。确认框里的「去开启 2FA」和错误提示里的链接都已修正。
- 增加回归测试，校验错误对象里的 2FA 链接不再指向 404 路由。

### 说明

- 纯链接修复，无行为变更。

## 1.1.4

### 界面与交互

- 插件详情页的「打开工作台」按钮改为「左侧栏『发布仓』」开关，默认打开；关闭后隐藏左侧栏入口，开关会保存到本机偏好。
- 移除 Settings 里的「发布仓」宿主入口；设置页只保留发布默认值、网络诊断与安全说明。
- npm 账号卡片移到「npm 包库」顶部，GitHub 账号卡片移到「GitHub 仓库」顶部。
- npm 账号卡新增头像占位、用户名主页、Token 名称、Token 权限、scopes、包数量、连接时间；GitHub 账号卡新增公开仓库数、主页、连接时间、认证方式与 scopes。
- 工作台移除「发布就绪 / 选择项目」大卡片；三个统计卡片改为横向排版。
- 发布记录合并到工作台，移除单独的「发布记录」标签；工作台展示完整记录，支持刷新与清空。
- Bypass 2FA Token 的包列表降级提示改为说明性文字，不再显示成「读取失败」；公开搜索模式会明确标注「私有包不显示」。
- npm 删除确认框内增加动态码输入（放在弹窗里，不再被遮住），并说明去哪里取 6 位码。
- 修复「危险操作 → 删除」点击无反应：移除已删除的 `unpublish.otp` 字段读取，弹窗恢复显示。
- 修复「账号未启用 2FA」被误导成「验证码错误」：npm 在账号无 2FA 时返回 403 且不校验证码，现在单独识别为 `E2FAACCOUNT` 并说明填码无效。
- 错误提示改为可点击链接：npm Token 页、npm 2FA 页、npm 包页、GitHub Token 页。
- 区分「没填验证码」和「验证码不对/已过期」两种 2FA 失败，不再一律说 Token 不行。
- GitHub 权限不足（403 + admin/delete_repo）单独识别为 ESCOPE，并给出准确加权限的入口。
- GitHub 仓库列表增加「删除」按钮，必须输入完整 `owner/repo` 确认；GitHub Release 删除继续保留。
- npm Token 账号卡增加「同步 Token 信息」，替换 Token 后可立即刷新 Bypass 状态/权限/到期日。
- 包列表降级提示如实说明：Granular Token 无法调用 npm 的账号包列表接口，私有包需按包名查看。

### 说明

- 补丁版本，发布协议、AI 工具与数据格式保持兼容。

## 1.1.3

### 修复

- npm publish 返回 `202 Accepted` 时，面板和 AI 工具明确显示“已受理，registry 同步中”，不再直接称为“发布完成”。
- GitHub Release 的自动安装段只在 npm 目标确实成功时出现，避免链接到不存在的包版本。
- 删除整个 npm 包现在在 `version: '*'` 和“仅剩一个版本”两种情况下都强制要求 `confirmName`，防止误删整包。
- 修复 AI 工具 `add-owner` / `remove-owner` 的变量遮蔽错误（之前两个动作都会抛 ReferenceError）。
- npm 访问级别统一为 `public` / `restricted`，与 npm `access set status` 协议一致；面板、工具、协议不再出现 private/restricted 混用。
- 代理 URL 中的用户名/密码在诊断信息中打码，不再进入面板或 AI 工具输出。
- 工具结果改为结构化 `data` 对象，去掉重复 JSON 编码；超长文本附带截断标记。
- npm Token 列表改为跟随分页，Token 数量超过一页时仍能匹配到期日。
- 修复 GitHub 仓库列表缓存忽略 `limit` 的问题；dist-tag/access/owner 操作后 npm 包列表缓存会失效。
- 发布预检在“仓库不存在且未勾选自动创建”时返回失败，不再让向导误判为可发布。
- 发布更新日志支持 `## [1.2.3]`、`## v1.2.3`、`## 1.2.3 — date` 等标题格式。
- 无效 dist-tag 直接报错，不再静默替换为 latest；`v1.2.3` 这类不规范 package version 在打包阶段拒绝。
- 删除 GitHub Release 现在需要 `force: true`；同时删除 tag 时必须提供 tag 名称。
- 主题与目录选择器改为注入服务，避免一次性读取导致深色主题或目录选择器失效。
- `npm_registry info` 支持按 `version` 查询指定版本；`github_publish release` 增加 `generateNotes`。
- README 增加版本更新日志入口。

### 说明

- 补丁版本，发布协议与目标不变。

## 1.1.2

### 修复

- GitHub Release 自动文案不再包含本地目录、用户名或维护者信息，改为版本更新日志 + 安装命令。
- 面板底栏、HTTP User-Agent、服务默认版本统一到 `1.1.2`，不再出现版本号不一致。
- AI 工具返回结果会移除 `dir` / `storage` / `lastDir` 等本机路径，避免模型输出泄露机器路径。

### 说明

- 这是补丁版本，不新增发布目标，不改变 npm / GitHub 协议行为。

## 1.1.1

### 修复

- 重新发布 1.1.0：首次发布时 npm CDN 在产物就绪前缓存了 tarball 404，导致 `npm install dsh-release-depot@1.1.0` 短暂失败。
- 1.1.1 与 1.1.0 功能一致；已用 `pnpm add dsh-release-depot@1.1.1` 验证安装。

## 1.1.0

### 新增

- 产品更名为 **发布仓 / Release Depot**，包名 `dsh-release-depot`；旧 `.dsh-ship-deck` 凭据自动迁移。
- npm Token 到期日自动读取（`/-/npm/v1/tokens`），剩余 21 天提醒，并提示 Bypass 2FA Token 将在 2027-01 被撤销。
- npm 访问级别管理（public/private）与 maintainer 添加/移除，面板与 AI 工具均可操作。
- 发布目标新增/完善：npm、GitHub Packages、GitHub Release（可自动建仓、推送目录、附带 tarball）。
- 发布向导支持 dry run 预检、OTP、GitHub 仓库自动创建、Release 附件。

### 优化

- GitHub 空仓库推送修复：自动初始化首个提交、创建 `main` 并设为默认分支。
- npm 错误分类：版本已存在、Bypass Token 账号操作限制、stage-only、WebAuthn/TOTP。
- 面板：自动跟随 DSH 日间/夜间主题、四边圆角与硬阴影、隐藏滚动条。
- 入口：左侧栏、设置 → 发布仓、插件详情页均可打开工作台。
- AI 工具 `npm_registry list` 改为快速列表，不再逐个拉取 packument。

## 1.0.0

### 首个版本

- 在 DeepSeek Harness 内连接 npm 与 GitHub 账号。
- 发布向导：npm / GitHub Packages / GitHub Release，4 步确认 + 强制预检。
- npm 包管理：dist-tags、废弃/取消废弃、删除单版本/整包。
- GitHub 仓库/Release：列表、创建仓库、通过 Git Data API 推送目录、创建/删除 Release。
- 本地发布记录（最多 200 条）。
- 5 个 AI 工具：`release_status`、`npm_registry`、`npm_publish`、`github_publish`、`publish_package`。