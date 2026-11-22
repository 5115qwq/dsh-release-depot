# Changelog

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