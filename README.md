# 发布仓 · Release Depot

[![npm](https://img.shields.io/npm/v/dsh-release-depot.svg)](https://www.npmjs.com/package/dsh-release-depot)
[![license](https://img.shields.io/npm/l/dsh-release-depot.svg)](LICENSE)

在 DeepSeek Harness（DSH）里连接 **npm** 与 **GitHub**，用一块粗野主义面板完成后端发布管理：打包、发布、建仓库 / Release、改 dist-tag、设置访问级别、维护 maintainer、废弃或删除版本、查看本地发布记录；同一套操作也以 **5 个 AI 工具**暴露给模型。

![发布仓界面示意](docs/preview.svg)

> 一次安装，面板与 AI 工具共用同一个 Host 服务：UI 里能做的事，模型也能做；模型做过的发布，面板里看得到。

---

## 为什么用它

- **一个面板管两个发布目的地**：npm、GitHub Packages、GitHub Release 在同一个发布向导里，支持一次多目标发布。
- **不是“模拟发布”**：自己实现了 npm registry 协议（tarball、integrity、dist-tags、deprecate、unpublish、owner、access、OTP），发布前强制预检，发布后写本地记录。
- **AI 能真正操作**：`publish_package` 可一次完成 npm 发布 + GitHub 推送 + Release + 附件；工具和 UI 调用同一个 service，不会出现两套逻辑。
- **入口不抢输入框**：左侧栏「发布仓」、设置 → 发布仓、插件详情页均可进入；跟随 DSH 日间/夜间主题。
- **本地优先**：令牌只存本机 DSH home；AI 工具的目录参数被限制在工作区内。

---

## 功能

### 账号

- **npm**：Granular Access Token 登录、自动验证、自定义 registry；自动读取 Token 的 **到期日**、**Bypass 2FA** 状态与名称（npm Token Info API），剩余 ≤21 天时在工作台提醒。
- **GitHub**：OAuth 设备流（需自己的 OAuth App Client ID）或 Personal Access Token；记住 Client ID；支持 `repo`、`workflow`、`write:packages` 等 scopes。
- 令牌仅保存在本机；面板、RPC、AI 工具都不会返回明文。

### 发布

- **发布向导（4 步）**：选目录 → 校验 `package.json` → 选目标与参数 → **强制预检** → 确认。
- **目标**：
  - npm 官方 registry（或自定义 registry）；
  - GitHub Packages（`npm.pkg.github.com`）；
  - GitHub 仓库 + Release（可自动创建仓库、推送目录、把 tarball 作为 release asset）。
- **预检**：真实打包、计算 sha512/sha1、检查版本是否已存在、检查账号与仓库状态；不会写入任何数据。
- **发布后**：每个目标返回链接、耗时与错误；成功/失败/部分失败都会写入本地记录。

### npm 包库

- 列出账号可管理的包，搜索/过滤、查看 README、版本列表、dist-tags、maintainers、废弃状态。
- 修改/删除 dist-tag；设置 **public/private** 访问级别；添加/移除 maintainer（`npm owner add/rm` 协议）；废弃/取消废弃；删除单版本或整包（二次确认 + OTP）。
- 自动识别 2FA、WebAuthn、stage-only 权限与常见 registry 错误并给出可操作提示。

### GitHub 仓库 / Release

- 列出仓库、创建仓库（个人 / 组织、public / private）。
- 通过 **Git Data API** 推送目录为一次提交：`replace` 镜像（会二次确认）或 `merge` 合并；尊重 `.gitignore` / `git ls-files`。
- Release 列表、创建、删除；可将 npm tarball 附到 Release。

### 发布记录

- 本机最多 200 条；包含包名、版本、目标、耗时、链接、错误、warnings、dry run 标记。
- 记录只用于本地追踪，不上传。

---

## 安装

### 从 npm 安装（推荐）

```powershell
dsh plugin --profile desktop add dsh-release-depot
```

也可以在 **设置 → 插件 → 安装插件** 里填：

```text
dsh-release-depot
```

安装完成后**完全退出并重新打开 DSH**（Host 半是 ESM 模块，重启最稳）。左侧栏出现「发布仓」；也可以在 **设置 → 发布仓** 打开。

### 从 GitHub 安装

```powershell
dsh plugin --profile desktop add github:5115qwq/dsh-release-depot
```

### 本地目录安装（开发）

```powershell
dsh plugin --profile desktop add link:<本目录绝对路径>
```

> 桌面版 profile 名是 `desktop`；命令行版通常是 `web`。

### 依赖

`undici` 用于代理与系统 CA；缺失时自动退回全局 fetch。安装时 pnpm 会拉取，无构建脚本。

---

## 使用

1. 打开「发布仓」→ **设置**：
   - **npm**：打开
     `https://www.npmjs.com/settings/~/tokens`（登录后 `~` 就是当前账号）创建 **Granular Access Token**；
     Permissions 选 **Read and write (publish and stage)**。
     如果账户使用 TOTP，建议**不要**勾 **Bypass two-factor authentication**（npm 会在 2027-01 撤销这类 Token），发布时在向导里填 6 位 TOTP。
     如果账户只能用 WebAuthn/passkey，本插件无法完成浏览器验证，请使用 npm CLI 或 trusted publishing。
     Expiration 通常最多 90 天；登录后面板会自动读取 npm 记录的到期日并提醒。
   - **GitHub**：设备流（OAuth App Client ID，无需回调地址）或 fine-grained PAT（目标仓库 Contents: write；GitHub Packages 需要 packages: write）。
2. **工作台 → 打开发布向导**：
   - 目录需要合法 `package.json`（name / version / 非 private）；
   - 选择目标；GitHub Release 可自动创建仓库并附带 tarball；
   - 预检会真实打包并读取 registry；确认后才写入。
3. 发布后到 **npm 包库** / **发布记录** 查看结果与链接。

### 目录与打包规则

- 与 `npm publish` 对齐：`files` 字段优先，否则 `.npmignore` → `.gitignore`；`node_modules`、`.git`、lockfile、`.npmrc` 等永不发布；`package.json`、README、LICENSE、`main`/`bin` 始终包含。
- 符号链接跳过；单文件、总大小、文件数有上限（可配置）。
- tarball 是自实现的 ustar + gzip，包含 sha512 integrity 与 sha1 shasum；已用 `pnpm add ./pkg.tgz` 验证可安装。
- **不执行生命周期脚本**：不会运行 `prepack` / `prepare` / `prepublishOnly`；发布前请先自行构建。
- GitHub 推送优先用 `git ls-files` 尊重仓库 `.gitignore`；通过 Git Data API 逐文件上传，不使用本地 git 凭据。

---

## AI 工具

所有工具与面板共用同一套 Host service。

| 工具 | 作用 |
| --- | --- |
| `release_status` | 账号连接状态、Token 到期天数、发布默认值、最近记录 |
| `npm_registry` | `whoami` / `list` / `info` / `search` / `dist-tags` / `set-dist-tag` / `delete-dist-tag` / `deprecate` / `undeprecate` / `set-access` / `owners` / `add-owner` / `remove-owner` / `unpublish` / `install-command` / `diagnostics` |
| `npm_publish` | 发布本地目录到 npm（支持 dryRun / OTP / access / tag） |
| `github_publish` | `list-repos` / `list-releases` / `create-repo` / `push` / `release` / `delete-release` |
| `publish_package` | 一次发布到多个目标：npm + GitHub Packages + GitHub Release |

安全边界：

- 目录参数限制在已注册工作区内；需要其他目录时由用户在面板中选择，或管理员配置 `toolPaths`。
- `npm_publish` / `publish_package` 是真实、不可逆的发布；描述中明确要求先 `release_status`、先 dryRun、只在用户明确要求时执行。
- `unpublish` 需要 `force=true`；删除整包还需要 `confirmName` 等于包名。

---

## 配置

```yaml
- id: dsh-release-depot
  name: dsh-release-depot
  config:
    proxy: auto                    # auto | direct | http://127.0.0.1:7890
    noProxy: [localhost, 127.0.0.1]
    npmRegistry: https://registry.npmjs.org
    githubRegistry: https://npm.pkg.github.com
    githubApiBase: https://api.github.com
    githubUploadsBase: https://uploads.github.com
    authFile: D:\secrets\release-depot-auth.json   # 可选
    maxFiles: 3000
    maxPackageBytes: 52428800
    maxGitBytes: 83886080
    toolPaths: [D:\work\another-project]            # 额外允许 AI 访问的目录
    allowToolPathsOutsideWorkspace: false            # 不建议设为 true
```

界面默认发布参数保存在 `prefs.json`，与插件 row config 分开。

---

## 安全模型

- 令牌保存在 `$DSH_HOME/.dsh-release-depot/auth.json`，权限 0600、原子写入；0.x 的 `.dsh-ship-deck` 会在启动时迁移。
- 令牌只作为 `Authorization` 头发往 registry 与 `api.github.com` / `uploads.github.com`；不经过第三方。
- 面板 RPC 走同源 Host 路由：`application/json`、Origin 校验、1 MiB 请求体上限。
- AI 工具路径限制在已注册工作区；防提示注入让模型打包任意本机目录。
- 不保存 npm 密码，不保存 TOTP secret，不实现后台自动续期。

---

## 已知限制

- **不会自动续期 npm Token**：npm 不再签发永久 Token（通常最多 90 天），而续期需要 npm 密码 + 2FA。插件不保存密码，只做 **到期自动识别 + 21 天提醒 + 重新生成链接**。任何声称“全自动续期”的实现都需要保存密码/2FA secret，不建议使用。
- **只支持 6 位 TOTP**：仅 WebAuthn/passkey 的账户请用 npm CLI 或 trusted publishing。
- **不执行构建脚本**（`prepack` / `prepare` / `prepublishOnly`）；请先构建。
- **不生成 provenance / attestation 签名**（需要 sigstore + OIDC）。
- **删除整包不可恢复**；npm 只允许同一天内重新发布单个被删除版本。
- GitHub 设备流只面向 github.com；Enterprise 用 PAT + `githubApiBase` / `githubUploadsBase`。
- GitHub 推送走 Git Data API，超大仓库不如 `git push`；超过 `maxGitBytes` 会提示。
- 多目标发布**没有事务回滚**：npm 成功、GitHub 失败会保留部分结果，记录会明确标出。
- `npm unpublish` / `dist-tag` / `deprecate` / `owner` / `access` 使用 npm CLI 同款协议；私有 registry 行为以其实现为准。

---

## 开发与测试

```powershell
node tests/host.test.mjs
```

测试覆盖：npm 登录与 Token Info、OTP 挑战、发布 tarball 完整性、dist-tag、废弃、access、owner、单版本/整包删除、GitHub 推送、Release + asset、组合发布、历史、诊断，并断言任何返回都不包含 Token。

目录：

```text
dsh-release-depot/
├── package.json          # dsh.bundle / dsh.client
├── cordis.patch.yml      # bundle patch
├── index.js              # Host 入口：RPC + 工具
├── client.js             # 浏览器半：面板 UI + 样式（无构建）
├── lib/
│   ├── service.js        # 面板/工具共用操作层
│   ├── registry.js       # npm registry 协议
│   ├── github.js         # GitHub REST / 设备流 / Git Data API
│   ├── pack.js           # tarball 打包器
│   ├── semver.js         # 版本与范围
│   ├── net.js            # 代理 + 系统 CA
│   ├── store.js          # auth / prefs / history
│   └── tools.js          # 5 个工具 + 工作区路径守卫
├── locale/               # 插件管理器展示元数据
├── docs/                 # 详情页单图 + 说明
└── tests/                # mock registry / GitHub 集成测试
```

---

## 更新日志

每个版本的变更见 [CHANGELOG.md](CHANGELOG.md)。

---

## English

**Release Depot** connects npm and GitHub inside DeepSeek Harness and gives both the panel and the agent one shared publishing service: publish to npm / GitHub Packages, push a directory and create a GitHub Release with the tarball attached, manage dist-tags, access, maintainers and versions, and review a local publish log.

Install: `dsh plugin --profile desktop add dsh-release-depot`, then restart DSH and open **发布仓** in the left sidebar. Tokens stay in `$DSH_HOME/.dsh-release-depot/auth.json`; npm token expiry is read automatically, but renewal is manual because npm requires password + 2FA.

MIT License.