# Changelog

## 1.1.9

### `github_publish` 的 push 语义（社区反馈）

`github_publish { action: 'push' }` 通过 Git Data API 在工作区内容上创建 commit，**从不读取本地 git 历史**。此前这一点完全没有暴露，导致本地已有未推送 commit 时，远端会得到一个内容不同的**旁支提交**，且 `.gitattributes` 的换行符规则不生效。

- **P0 文档**：工具描述明确说明 push「上传当前文件内容、不推送本地 commit、本地领先时会产生兄弟提交」，并提示需要历史时改用 `git push`。
- **P1 本地 git 状态检测**：推送前检查目录是否为 git 仓库、本地 HEAD 与远端 HEAD 的关系、工作区是否干净。本地领先时警告「本次推送不包含这 N 个提交」；落后时提示「将以工作区内容覆盖远端」；有未提交改动时报告数量。返回值新增 `source: 'working-tree'` 与 `localGit` 字段，不再让人误以为推的是本地 commit。
- **P2 换行符归一化**：按 `.gitattributes` 的 `text` / `eol=lf` / `eol=crlf` 规则归一化后再上传，与 `git add` 保持一致。二进制（含 NUL，或无法无损 UTF-8 解码）严格原样上传，绝不改写字节。
- **P3 删除提示**：`syncMode: 'replace'` 时会对比远端文件树，列出将被删除的文件（最多 20 个），避免「推完仓库少东西了」的沉默丢失。
### 修复

- **二进制文件被 UTF-8 往返破坏（严重）**：换行归一化的首版实现会把 PNG 等无 NUL 的二进制按 UTF-8 解码再编码，字节被替换字符污染。现在只有能逐字节往返的内容才会被改写。
- **`set-dist-tag` 的摘要不反映实际结果**：摘要用请求参数拼字符串，注册表返回 `unchanged: true`（tag 已指向该版本）时仍声称「已设置」。现在按注册表返回的 `unchanged` 分别提示「无需修改」。
- **`release_status` / `npm_publish` / `publish_package` 描述与实现不符**：仍写着「在设置里连接账号」（入口早已移到 npm 包库 / GitHub 仓库顶部），且没说明 2FA、`EPRIVATE`、版本已存在这些最常见失败原因。已按实际行为重写。

### 新增功能

- **`github_publish` 的 push 支持预检（`dryRun`）**：与 npm 发布的 `dryRun` 对齐。预览会列出将上传的文件、`replace` 模式将删除的远端文件、需要换行符归一化的文件数、本地 git 状态，以及全部警告，**不创建任何 commit**。面板的「推送目录」对话框也增加了「预检」按钮，结果区区分「预检结果 · 未写入」与「推送完成」。

### 测试

- 新增回归测试：本地 git 状态检测（干净/脏/领先）、`.gitattributes` EOL 归一化、二进制与非 UTF-8 字节的完整性。
- **新增真实 git 端到端测试**：在真实 `git` 仓库里写 CRLF 文件并 commit，工具推送后比对上传的 blob 与 `git show HEAD:<file>` 的字节，必须完全一致。这是 mock 环境无法覆盖的检查。
- 新增 push 预检测试：断言不产生 commit、`eolNormalized` 计数正确。

## 1.1.8

### 安全修复

- **GitHub 推送会把凭据文件推到仓库（严重）**：`walkForGit` 只在目录扫描分支过滤 `.env`/`.npmrc`，走 `git ls-files` 时完全绕过过滤。结果是**已被 git 跟踪的 `.env` 与 `.npmrc`（内含 npm Token）会原样推送到 GitHub 公开仓库**。现在过滤移到公共路径，并扩充到 `.npmrc`/`.netrc`/`.git-credentials`/`id_rsa`/`.pypirc` 等，跳过时给出警告。

### 严重修复（打包器）

- **打出来的 tarball 可能只有 `package.json`**：`collectPackageFiles` 在「无 files 字段」的常规项目里，把未被 `ALWAYS_INCLUDE` 兜底的普通源码文件（`index.js`、`client.js` 等）全部丢弃。也就是说用本插件发布一个普通包，用户装到的会是空壳。已修正包含判定：非修剪模式下只有命中忽略规则才排除。
- **只要有 `.npmignore` / `.gitignore` 就直接崩溃**：`createIgnoreMatcher` 返回的是函数，但 `collectPackageFiles` 与 `walkForGit` 都按 `matcher.matches(...)` / `matcher(path)` 调用，抛 `TypeError`。现统一为带 `matches` / `negated` 的对象，并同步修正 `walkForGit` 的两处调用。
- **`.npmignore` 的目录规则不作用于目录内文件**：`.npmignore` 写了 `dist/` 时，`dist/` 被跳过但 `dist/a.js` 仍会被打进包。现在目录规则会连带排除其内容，同时 `!` 取反规则仍然生效。
- **`files` 字段为白名单时判定走反**：`files` 模式下未列出的路径会被反向包含。现按白名单语义处理。
- **PAX 回退路径丢失可执行位**：路径超过 ustar 100 字节时走 PAX，两条回退调用漏传 `mode`，`bin` 脚本会变成 `0644`、安装后无法执行。现已传递真实 mode。
- **长名截断按字符而非字节**：60 个中文字符 = 180 字节，截断后仍溢出导致回退到 `package/file` 占位名，多个长名文件会互相碰撞。现在按 UTF-8 字节截断。

### 修复

- **`npm access set` 仍发送旧枚举**：`npmSetAccess` 里残留 `'private'` 映射，而 registry 层要求 `restricted`，导致设置访问级别时行为不一致。现三层统一为 `restricted`（`private` 作为友好别名接受）。
- **包名未校验就拼进 URL（安全）**：`distTags` / `deleteDistTag` 缺少 `isValidPackageName` 守卫，而 `escapedPackageName` 只转义第一个 `/`，`../..` 段会原样进入请求路径并携带用户 Token。现在所有 registry 方法入口统一校验，转义改为替换全部斜杠。
- **预检不校验 dist-tag**：非法 tag（如 `-bad`）在 dry run 里显示通过，真实发布才报 `ETAGINVALID`，而面板正是靠预检决定能否发布。现在 tag 在发布前统一校验。
- **非法版本范围被误报为「没有版本匹配」**：`satisfies` 吞掉解析错误返回 `false`，导致 `not-a-range`、`>=` 这类输入被当成空匹配，用户很可能改用 `*` 重试从而废弃所有版本。现在返回 `EINVALIDRANGE` 并附示例，空匹配时也会列出已有版本。
- **`<=2.3` 这类部分上界排除了合法版本**：npm 把 `<=2.3` 读作 `<2.4.0`（整个 2.3.x），实现却生成 `<=2.3.0`。因此 `deprecate { range: '1.2.3 - 2.3' }` 会静默跳过 2.3.1–2.3.x 却报告成功。现在 `<=`/`>` 的部分上界按 npm 语义展开。
- **`maxVersion` 会把预发布版当成最新版**：只有一个 `2.0.0-rc.1` 和若干 1.x 时，取消发布后 `latest` 会指向 rc 版。现在优先选正式版本（全为预发布时才取最高预发布）。
- **前导零版本被接受**：`01.2.3` 按 SemVer 规范非法，之前判为合法。现在拒绝（预发布段仍允许）。
- **GitHub tag 含斜杠无法删除**：`delete-release` 带 `deleteTag` 时，`v1.0.0/rc` 被整体 `encodeURIComponent` 成 `%2F`，请求 404 而 `allow404` 让调用方以为删成功，tag 实际保留。现在按路径分段编码。
- **代理凭据可能泄露（安全）**：`redactProxyUrl` 对无 scheme 的 `user:pass@host:port` 不生效，而 `envProxy` 直接读取未规范化的环境变量，凭据会进入诊断输出与模型上下文。现在先文本剥离 userinfo 再解析，两种写法都会脱敏。
- **删除类 GitHub 操作绕过 owner 默认值**：`delete-repo` / `delete-release` 未走 `resolveOwner`，只传 `repo` 时报出内容为空的 `owner不合法：`。现在统一回退到已连接账号，缺少 `repo` 时给出明确错误。
- **创建仓库时 `org` 未校验（安全）**：`org` 被原样拼进 `/orgs/<org>/repos`，`..`、`a/b`、`x?y=1` 会改变请求路径或注入查询参数。现在与 `owner`/`repo` 一样经 `assertRepoPart` 校验。
- **偏好设置里的 tag 校验不一致**：读取时不校验（手改 `prefs.json` 可注入 `-bad`），写入非法值则被静默丢弃却返回成功。现在读写同一套规则，非法值直接报错。
- **`Origin: null` 被当作同源（安全）**：`null` 来自沙箱 iframe 与 `data:` 文档，并不属于本应用。现在按跨源拒绝处理。
- **`exports` 入口可能被静默丢弃**：现代 ESM 包只通过 `package.json` 的 `exports` 暴露入口，而打包器只强制包含 `main`/`bin`/`types`。当 `files` 白名单没写入口目录时，发布出去的包无法 `import`。现在递归收集 `exports` 的全部目标并强制包含。
- **入口缺失时零警告**：`main`/`exports`/`bin` 指向不存在的文件时会静默发布，用户安装后才 `MODULE_NOT_FOUND`。现在打包结果里会明确提示「入口不存在」或「入口未被包含」（glob 条目自动跳过，避免误报）。

### 健壮性

- **凭据文件损坏被静默当作「从未配置」**：`auth.json` 解析失败时返回 `null`，用户看到的是账号消失而非文件损坏。现在标记 `authCorrupt`，保留原文件不覆盖，并在工作台提示重新连接。
- **历史记录坏数据渲染成 `null@null`**：手改或旧格式的历史条目会让列表显示 `null`、`NaN`。`summarizeRecord` 现对 package/version/at/duration/targets 做类型规范化。

### AI 工具

- 系统提示词纠正过期信息：账号已在「npm 包库 / GitHub 仓库」顶部连接，不再是「设置」；补充 `dryRun` 通过≠已发布，以及 `E2FAACCOUNT` 表示账号未启用 2FA、填验证码无效时的正确引导。
- `npm_registry` 描述补齐遗漏动作（`undeprecate`/`owners`/`diagnostics`），并说明 unpublish 需要账号已开 2FA + 当次 6 位码。

### 测试

- 新增回归测试：`files` 尾斜杠子树、GitHub 凭据文件过滤、部分比较器 npm 语义、`exports` 入口、`main` 缺失告警、包名路径穿越、非法 dist-tag、非法版本范围、代理凭据脱敏。

### 说明

- 建议尽快升级：本版修复了一个会把 npm Token 推送到 GitHub 仓库的泄密路径，以及三处会发出错误内容的打包器缺陷。
- 本版聚合了两轮修复：原计划的 1.1.7 与 1.1.8 合并为同一版本发布（1.1.7 未单独发布）。

## 1.1.6

### 修复

- **预检会放过注定失败的发布**：`restricted` + 非 scoped 包在 dry run 里显示通过，真实发布才报 `EUNSCOPED`。现在预检执行与真实发布相同的校验，面板不会再把「绿」的预检当成可发布。
- **`github_publish` 的 `owner` 默认值不生效**：文档写「默认用已连接账号」，实际传空就报 `EINVALID`。`githubReleases` / `githubRelease` / `githubPush` 现在真正回退到登录账号，未连接时给出明确错误。
- **`info` 输出被截断成坏 JSON**：成熟包可能有 250 个版本 + 8KB readme，超过 12000 字符上限后被硬切，模型拿到无法解析的内容。现在工具侧只投影最新信息 + 最近 20 个版本 + 版本总数，readme 不再进模型上下文。
- **截断不再产生坏 JSON**：超限时保留摘要、给出明确提示（原长度/上限/如何缩小范围），并按行边界截断。
- **`deprecate` 拒绝带空格的版本范围**：schema 示例写的是 `<1.2.3`，但 `>= 2.0.0`、`< 3.0.0` 这类会解析失败并误导为「没有版本满足范围」。现在与 npm 一样接受运算符后的空格。
- **包列表缓存忽略 `limit`**：先请求 5 个再请求 100 个会拿到旧的 5 个（缓存 120 秒）。缓存键已包含 limit。
- **Release notes 可能缺少安装说明**：`targets` 里 `github-release` 排在 `npm` 前面时，生成说明时 npm 结果还不存在，安装段被永久省略。现在固定把 `github-release` 放到最后执行。
- **GitHub Packages 静默改成 public**：向导显示 `restricted` 时该目标仍写死 public，失败还会发生在 npm 已发布之后。现在显式固定 public 并给出警告，不再静默。
- **npm 账号邮箱进入模型上下文**：`release_status` 的 `status.npm.email` 会被工具带出。现在工具输出过滤 `email` 与 `maintainers[].email`。
- **诊断信息泄露本机绝对路径**：`diagnostics` 的 `storage.authFile` 等字段带完整路径。现在工具层把 `C:\...`、`/home/...` 一律替换为 `<local path>`。

### 优化

- `release_status` 载荷从约 20KB 降到约 5KB（不再内联重复历史），稳定落在工具输出预算内；面板改用新的 `panelStatus()`，仍保留最近记录与最近项目预览。
- `status()` 的历史项精简为可操作字段（去掉 integrity/shasum/rateLimit/fileCount 等噪声），完整记录仍可从面板历史读取。
- 清理死代码：`RecordsPage`（已无路由）、`targetSummary`、`integrityOf`、`errorHint`，以及不再使用的 `node:crypto` 导入。
- 新增回归测试：带空格版本范围、restricted 预检、owner 默认值、载荷预算、2FA 链接正确性。

### 说明

- 1.1.5 已发布且不可覆盖，本轮全部修复以 1.1.6 发布。

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