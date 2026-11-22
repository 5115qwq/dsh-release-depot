/**
 * dsh-release-depot — agent tools.
 *
 * One operation, two callers: every tool below calls the same ShipDeck service
 * methods the panel calls. Publish/registry operations are real side effects,
 * so the descriptions state that plainly; the destructive ones require the
 * caller to confirm explicitly (`force`, `confirmName`).
 *
 * Directory arguments are confined to the agent's registered workspaces (and
 * `toolPaths` from the plugin row). A model steered by a malicious README
 * cannot publish an arbitrary directory from the machine.
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { serializeError } from './service.js'
import { isValidPackageName, isValidVersion } from './semver.js'

const ACTIONS = [
  'whoami',
  'list',
  'info',
  'search',
  'dist-tags',
  'set-dist-tag',
  'delete-dist-tag',
  'deprecate',
  'undeprecate',
  'set-access',
  'owners',
  'add-owner',
  'remove-owner',
  'unpublish',
  'install-command',
  'diagnostics',
]

function textResult(value, limit = 12000) {
  const summary = typeof value?.summary === 'string' ? value.summary : ''
  const data = value?.data === undefined ? '' : JSON.stringify(value.data, null, 2)
  return [{ type: 'text', text: `${value?.ok === true ? '' : 'FAILED: '}${summary}${data === '' ? '' : `\n${data}`}`.slice(0, limit) }]
}

function ok(value, summary) {
  return {
    ok: true,
    summary,
    data: JSON.stringify(withoutLocalPaths(value)),
  }
}

function fail(error) {
  const serialized = serializeError(error)
  return {
    ok: false,
    summary: `${serialized.message}${serialized.hint === '' ? '' : ` 提示：${serialized.hint}`}`,
    data: JSON.stringify(serialized),
  }
}

/** Keep local filesystem paths out of model-visible publish/status payloads. */
function withoutLocalPaths(value) {
  if (Array.isArray(value)) return value.map(withoutLocalPaths)
  if (value === null || typeof value !== 'object') return value
  const copy = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'dir' || key === 'lastDir' || key === 'storage' || key === 'dshHome') continue
    copy[key] = withoutLocalPaths(item)
  }
  return copy
}

const output = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      data: { type: 'string' },
    },
    required: ['ok', 'summary'],
  },
  render: (_args, value) => textResult(value),
}

const pathProperties = {
  dir: {
    type: 'string',
    description: 'Absolute path of the package directory inside a registered workspace, e.g. C:/work/my-package or /home/me/my-package.',
  },
}

function samePath(a, b) {
  const left = process.platform === 'win32' ? a.toLowerCase() : a
  const right = process.platform === 'win32' ? b.toLowerCase() : b
  return left === right
}

function inside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Build a resolver that keeps tool-supplied paths inside the agent's
 * workspaces. With no resolvable root it refuses rather than guessing.
 */
function createPathGuard(agentCtx, config) {
  const extraRoots = Array.isArray(config?.toolPaths) ? config.toolPaths.filter((item) => typeof item === 'string') : []
  async function roots() {
    const found = []
    try {
      const workingDirectory = agentCtx.get('workingDirectory')
      if (workingDirectory !== undefined && typeof workingDirectory.defaultDirectory === 'string') {
        found.push(workingDirectory.defaultDirectory)
      }
    } catch {
      /* optional service */
    }
    try {
      const registry = agentCtx.get('workspaceRegistry')
      for (const workspace of registry?.list?.() ?? []) {
        if (typeof workspace?.path === 'string') found.push(workspace.path)
      }
    } catch {
      /* optional service */
    }
    found.push(...extraRoots)
    const unique = []
    for (const candidate of found) {
      try {
        const real = await realpath(resolve(candidate))
        if (!unique.some((entry) => samePath(entry, real))) unique.push(real)
      } catch {
        /* ignore missing root */
      }
    }
    return unique
  }

  async function assertPath(input, label = '目录') {
    if (typeof input !== 'string' || input.trim() === '') {
      throw new Error(`缺少${label}路径`)
    }
    if (config?.allowToolPathsOutsideWorkspace === true) {
      return realpath(resolve(input.trim()))
    }
    const allowed = await roots()
    if (allowed.length === 0) {
      throw new Error('无法确定当前会话的工作区，因此拒绝访问任意路径。请先在 DSH 里打开一个工作区，或让用户在发布仓面板中操作。')
    }
    let target
    if (isAbsolute(input.trim())) {
      target = resolve(input.trim())
    } else {
      target = join(allowed[0], input.trim())
      const base = await roots()
      if (!base.some((root) => inside(root, target))) {
        throw new Error(`相对路径只能位于已注册的工作区里：${allowed[0]}`)
      }
    }
    let real
    try {
      real = await realpath(target)
    } catch {
      throw new Error(`${label}不存在：${target}`)
    }
    if (!allowed.some((root) => inside(root, real))) {
      throw new Error(`拒绝访问工作区之外的${label}：${real}。请让用户在发布仓面板里操作，或由管理员把该目录加入插件配置 toolPaths。`)
    }
    return real
  }

  return { assertPath, roots }
}

function normalizeReleaseTargets(input) {
  if (Array.isArray(input)) return input
  if (typeof input === 'string') return [input]
  return undefined
}

function summarizePublish(result) {
  const record = result?.record
  if (record === undefined) return '发布完成'
  const lines = record.targets.map((target) => {
    if (target.ok === false) return `${target.target}: 失败 — ${target.error?.message ?? '未知错误'}`
    if (target.dryRun === true) return `${target.target}: 预检通过`
    const link = target.url ?? target.release?.htmlUrl ?? target.repoUrl ?? ''
    return `${target.target}: 成功${link === '' ? '' : ` — ${link}`}`
  })
  return `${result.ok === true ? '发布成功' : '发布部分失败'}：${record.package}@${record.version}${result.dryRun === true ? '（dry run，未推送）' : ''}\n${lines.join('\n')}`
}

/**
 * @param {import('./service.js').ShipDeck} service
 * @param {any} agentCtx
 * @param {object} config plugin row config
 */
export function createTools(service, agentCtx, config) {
  const guard = createPathGuard(agentCtx, config)

  const releaseStatus = {
    name: 'release_status',
    description:
      'Report which npm and GitHub accounts Release Depot has connected, the publish defaults, and recent publish history. ' +
      'Call it first to learn whether publishing is possible; tokens are never returned. ' +
      'If an account is missing, ask the user to open the 发布仓 workbench from the left sidebar panel icon and connect it under 设置.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: 'How many recent publish records to include, 1-50. Defaults to 10.' },
      },
    },
    output,
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const status = service.status()
        const limit = Math.min(Math.max(Number(args?.limit ?? 10), 1), 50)
        const history = service.history(limit)
        const expiry = status.npm.expiresInDays
        const summary = `npm: ${status.npm.connected ? `@${status.npm.username ?? '?'}` : '未连接'}；GitHub: ${status.github.connected ? `@${status.github.login ?? '?'}` : '未连接'}；发布记录 ${status.counts.history} 条${expiry !== null && expiry !== undefined ? `；npm Token 剩余 ${expiry} 天` : ''}${status.npm.bypass2fa === true ? '（Bypass 2FA，2027-01 将被撤销）' : ''}`
        return ok(withoutLocalPaths({ status, history }), summary)
      } catch (error) {
        return fail(error)
      }
    },
  }

  const npmRegistryTool = {
    name: 'npm_registry',
    description:
      'Read or manage the connected npm account through registry.npmjs.org. ' +
      '`whoami`/`list`/`info`/`search`/`dist-tags`/`install-command` are read-only; ' +
      '`set-dist-tag`, `deprecate`, `unpublish`, `set-access`, `add-owner`, `remove-owner` and `delete-dist-tag` change a published package and must be done only when the user explicitly asked for that exact change. ' +
      '`unpublish` needs force=true, and removing a whole package also needs confirmName equal to the package name.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'Operation to perform.' },
        name: { type: 'string', description: 'Package name, scoped (@scope/name) when applicable.' },
        version: { type: 'string', description: 'Exact version for info/unpublish/install-command/set-dist-tag.' },
        tag: { type: 'string', description: 'Distribution tag for dist-tag actions, e.g. latest, next.' },
        range: { type: 'string', description: 'SemVer range for deprecate, e.g. <1.2.3 or ^2.0.0. Defaults to *.' },
        message: { type: 'string', description: 'Deprecation text; empty string undeprecates.' },
        access: { type: 'string', enum: ['public', 'private'], description: 'Package visibility for set-access. Only scoped packages can be private.' },
        user: { type: 'string', description: 'npm username for add-owner / remove-owner.' },
        query: { type: 'string', description: 'Search text for the search action.' },
        limit: { type: 'integer', description: 'Result limit for list/search, 1-100.' },
        otp: { type: 'string', description: 'Six-digit npm two-factor code, when the account requires one.' },
        force: { type: 'boolean', description: 'Must be true for unpublish.' },
        confirmName: { type: 'string', description: 'Must equal the package name when unpublishing a whole package.' },
      },
      required: ['action'],
    },
    output,
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = String(args?.action ?? '')
      try {
        switch (action) {
          case 'whoami': {
            const result = await service.verifyNpm()
            return ok(result, result.npm.connected ? `npm 账号 @${result.npm.username} ${result.invalidated === true ? '已失效' : '可用'}` : 'npm 未登录')
          }
          case 'list': {
            const result = await service.npmPackages({ limit: args?.limit, refresh: true, details: false })
            const summary = `账号下 ${result.items.length} 个可管理的包${result.truncated ? '（已截断）' : ''}`
            return ok({ items: result.items, warnings: result.warnings, source: result.source }, summary)
          }
          case 'info': {
            const result = await service.npmInfo({ name: args?.name, otp: args?.otp })
            return ok(result, `${result.name} 最新 ${result.latest ?? '?'}，共 ${result.versions.length} 个版本`)
          }
          case 'search': {
            const result = await service.npmSearch({ query: args?.query, limit: args?.limit })
            return ok(result, `搜索到 ${result.items.length} 个包（总计 ${result.total}）`)
          }
          case 'dist-tags': {
            const result = await service.npmDistTags({ name: args?.name })
            return ok(result, `${result.name} 的 dist-tags：${Object.entries(result.tags).map(([key, value]) => `${key}=${value}`).join(', ') || '无'}`)
          }
          case 'set-dist-tag': {
            const result = await service.npmSetTag({
              name: args?.name,
              tag: args?.tag,
              version: args?.version ?? args?.range,
              otp: args?.otp,
            })
            return ok(result, `已设置 ${args?.name} 的 ${args?.tag} → ${args?.version ?? args?.range}`)
          }
          case 'delete-dist-tag': {
            const result = await service.npmDeleteTag({ name: args?.name, tag: args?.tag, otp: args?.otp })
            return ok(result, `已删除 ${args?.name} 的 dist-tag ${args?.tag}`)
          }
          case 'deprecate':
          case 'undeprecate': {
            const undeprecate = action === 'undeprecate'
            const result = await service.npmDeprecate({
              name: args?.name,
              range: args?.range ?? '*',
              message: undeprecate ? '' : String(args?.message ?? ''),
              otp: args?.otp,
            })
            return ok(result, `${undeprecate ? '已取消废弃' : '已废弃'} ${result.name} 的 ${result.versions.length} 个版本`)
          }
          case 'set-access': {
            const result = await service.npmSetAccess({
              name: args?.name,
              access: args?.access,
              otp: args?.otp,
            })
            return ok(result, `${result.name} 的访问级别已设为 ${result.access}`)
          }
          case 'owners': {
            const result = await service.npmOwners({ name: args?.name })
            return ok(result, `${result.name} 有 ${result.maintainers.length} 位维护者`)
          }
          case 'add-owner':
          case 'remove-owner': {
            const action = action === 'add-owner' ? 'add' : 'remove'
            const result = await service.npmChangeOwner({
              name: args?.name,
              user: args?.user,
              action,
              otp: args?.otp,
            })
            return ok(result, result.unchanged === true
              ? `${args?.user} 已经是维护者`
              : `已${action === 'add' ? '添加' : '移除'}维护者 ${args?.user}`)
          }
          case 'unpublish': {
            const result = await service.npmUnpublish({
              name: args?.name,
              version: args?.version,
              force: args?.force === true,
              confirmName: args?.confirmName,
              otp: args?.otp,
            })
            return ok(result, result.removed === 'package' ? `已删除整个包 ${result.name}` : `已删除 ${result.name}@${result.version}`)
          }
          case 'install-command': {
            const result = service.npmInstallCommand({ name: args?.name, version: args?.version })
            return ok(result, result.command)
          }
          case 'diagnostics': {
            const result = await service.diagnostics({ ping: true })
            return ok(result, `npm 网络 ${result.ping?.npm?.ok ? '正常' : '异常'}，GitHub 网络 ${result.ping?.github?.ok ? '正常' : '异常'}`)
          }
          default:
            return fail(new Error(`未知 action：${action}（可用：${ACTIONS.join(', ')}）`))
        }
      } catch (error) {
        return fail(error)
      }
    },
  }

  const npmPublishTool = {
    name: 'npm_publish',
    description:
      'Publish a local package directory to the connected npm registry. This is a real, irreversible publish: the version can only be replaced by publishing a new version. ' +
      'Run release_status first; use dryRun to validate the package and account without writing. ' +
      'The directory must be inside the current workspace; packages with private:true are rejected.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...pathProperties,
        access: { type: 'string', enum: ['public', 'restricted'], description: 'Package visibility. Defaults to public; restricted only works for scoped packages on npmjs.com.' },
        tag: { type: 'string', description: 'Distribution tag, default latest.' },
        otp: { type: 'string', description: 'Six-digit npm two-factor code, when required.' },
        dryRun: { type: 'boolean', description: 'When true, pack and check the registry without publishing.' },
      },
      required: ['dir'],
    },
    output,
    timeoutMs: 600000,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const dir = await guard.assertPath(args?.dir, '项目目录')
        const result = await service.publish({
          dir,
          targets: ['npm'],
          access: args?.access,
          tag: args?.tag,
          otp: args?.otp,
          dryRun: args?.dryRun === true,
          actor: 'tool',
        })
        return ok(result, summarizePublish(result))
      } catch (error) {
        return fail(error)
      }
    },
  }

  const githubPublishTool = {
    name: 'github_publish',
    description:
      'Manage repositories and releases on the connected GitHub account, or push a local project directory as a commit. ' +
      '`list-repos`/`list-releases` are read-only. `create-repo`, `push`, `release` change GitHub; `delete-release` is destructive and needs the user\'s explicit request. ' +
      'A release can attach the packed npm tarball or another asset file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list-repos', 'list-releases', 'create-repo', 'push', 'release', 'delete-release'],
          description: 'Operation to perform.',
        },
        owner: { type: 'string', description: 'Repository owner (user or organization). Defaults to the connected login for push/release.' },
        repo: { type: 'string', description: 'Repository name.' },
        dir: { type: 'string', description: 'Absolute project directory inside a registered workspace (push, or release with attachDir).' },
        branch: { type: 'string', description: 'Target branch; defaults to the repository default branch (main for a new repository).' },
        message: { type: 'string', description: 'Commit message for push.' },
        create: { type: 'boolean', description: 'For push: create the repository when it does not exist.' },
        private: { type: 'boolean', description: 'Repository visibility when creating or pushing a missing repository. Defaults to private.' },
        description: { type: 'string', description: 'Repository description when creating it.' },
        org: { type: 'string', description: 'Create the repository under this organization instead of the user account.' },
        tag: { type: 'string', description: 'Release tag, e.g. v1.2.3. Required for release and delete-release tag removal.' },
        name: { type: 'string', description: 'Release title.' },
        body: { type: 'string', description: 'Release notes (Markdown).' },
        draft: { type: 'boolean', description: 'Create the release as a draft.' },
        prerelease: { type: 'boolean', description: 'Mark the release as a prerelease.' },
        releaseId: { type: 'integer', description: 'Release id for delete-release.' },
        deleteTag: { type: 'boolean', description: 'Also delete the git tag when deleting a release.' },
        assetPath: { type: 'string', description: 'Absolute path of a single file to attach to the release.' },
        assetDir: { type: 'string', description: 'Package directory to pack; its .tgz is attached to the release.' },
        syncMode: { type: 'string', enum: ['replace', 'merge'], description: 'replace mirrors the directory; merge keeps existing files not present locally. Defaults to replace.' },
        limit: { type: 'integer', description: 'Result limit for list actions, 1-100.' },
      },
      required: ['action'],
    },
    output,
    timeoutMs: 600000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = String(args?.action ?? '')
      try {
        switch (action) {
          case 'list-repos': {
            const result = await service.githubRepos({ limit: args?.limit, refresh: true })
            return ok({ items: result.items }, `${result.items.length} 个仓库`)
          }
          case 'list-releases': {
            const result = await service.githubReleases({ owner: args?.owner, repo: args?.repo, limit: args?.limit })
            return ok(result, `${args?.owner}/${args?.repo} 有 ${result.items.length} 个 release`)
          }
          case 'create-repo': {
            const result = await service.githubCreateRepo({
              name: args?.repo ?? args?.name,
              private: args?.private !== false,
              description: args?.description,
              org: args?.org,
            })
            return ok(result, `已创建仓库 ${result.repo.fullName ?? result.repo.name}（${result.repo.private ? 'private' : 'public'}）`)
          }
          case 'push': {
            const dir = await guard.assertPath(args?.dir, '项目目录')
            const result = await service.githubPush({
              owner: args?.owner,
              repo: args?.repo,
              branch: args?.branch,
              dir,
              message: args?.message,
              create: args?.create === true,
              private: args?.private !== false,
              description: args?.description,
              syncMode: args?.syncMode,
            })
            return ok(result, `已推送 ${result.fileCount} 个文件到 ${result.fullName}@${result.branch}（${result.commitSha.slice(0, 7)}）`)
          }
          case 'release': {
            let assetPath = args?.assetPath
            if (typeof assetPath === 'string' && assetPath.trim() !== '') assetPath = await guard.assertPath(assetPath, 'asset 文件')
            const assetDir = typeof args?.assetDir === 'string' && args.assetDir.trim() !== ''
              ? await guard.assertPath(args.assetDir, '打包目录')
              : undefined
            const result = await service.githubRelease({
              owner: args?.owner,
              repo: args?.repo,
              tag: args?.tag,
              name: args?.name,
              body: args?.body,
              draft: args?.draft === true,
              prerelease: args?.prerelease === true,
              assetPath,
              assetDir,
            })
            return ok(result, `已创建 release ${result.release.tag}${result.asset === null ? '' : `，上传 asset ${result.asset.name}`}`)
          }
          case 'delete-release': {
            const result = await service.githubDeleteRelease({
              owner: args?.owner,
              repo: args?.repo,
              releaseId: args?.releaseId,
              deleteTag: args?.deleteTag === true,
              tag: args?.tag,
            })
            return ok(result, `已删除 release #${result.id}`)
          }
          default:
            return fail(new Error(`未知 action：${action}`))
        }
      } catch (error) {
        return fail(error)
      }
    },
  }

  const publishPackageTool = {
    name: 'publish_package',
    description:
      'Publish one local package directory to several targets in a single run: publish to npm, publish to GitHub Packages, and/or push to GitHub and create a release with the tarball attached. ' +
      'This performs real, irreversible publishes. Run release_status first, use dryRun for a full preflight, and only run it when the user explicitly asked to publish. ' +
      'Defaults come from the panel; the directory must be inside the current workspace.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...pathProperties,
        targets: {
          type: 'array',
          items: { type: 'string', enum: ['npm', 'github-packages', 'github-release'] },
          description: 'Targets to publish to. Defaults to the panel default (npm).',
        },
        access: { type: 'string', enum: ['public', 'restricted'], description: 'npm access level. Defaults to public.' },
        tag: { type: 'string', description: 'npm dist-tag, default latest.' },
        otp: { type: 'string', description: 'Six-digit npm two-factor code, when required.' },
        dryRun: { type: 'boolean', description: 'Pack and check all targets without publishing.' },
        githubOwner: { type: 'string', description: 'GitHub owner for the release target; derived from repository in package.json when omitted.' },
        githubRepo: { type: 'string', description: 'GitHub repository name; derived from the package name when omitted.' },
        createRepo: { type: 'boolean', description: 'Create the GitHub repository when it does not exist.' },
        privateRepo: { type: 'boolean', description: 'Create the GitHub repository as private. Defaults to true.' },
        branch: { type: 'string', description: 'Branch to push to.' },
        releaseTag: { type: 'string', description: 'Release tag; defaults to v<version>.' },
        releaseName: { type: 'string', description: 'Release title; defaults to <name> v<version>.' },
        releaseBody: { type: 'string', description: 'Release notes; generated when omitted.' },
        draft: { type: 'boolean', description: 'Create the release as a draft.' },
        prerelease: { type: 'boolean', description: 'Mark the release as a prerelease.' },
        attachTarball: { type: 'boolean', description: 'Attach the npm tarball to the release. Defaults to true.' },
        commitMessage: { type: 'string', description: 'Commit message for the GitHub push.' },
        syncMode: { type: 'string', enum: ['replace', 'merge'], description: 'GitHub push mode; defaults to replace.' },
      },
      required: ['dir'],
    },
    output,
    timeoutMs: 900000,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const dir = await guard.assertPath(args?.dir, '项目目录')
        const result = await service.publish({
          dir,
          targets: normalizeReleaseTargets(args?.targets),
          access: args?.access,
          tag: args?.tag,
          otp: args?.otp,
          dryRun: args?.dryRun === true,
          actor: 'tool',
          github: {
            owner: args?.githubOwner,
            repo: args?.githubRepo,
            create: args?.createRepo === true,
            private: args?.privateRepo !== false,
            branch: args?.branch,
            releaseTag: args?.releaseTag,
            releaseName: args?.releaseName,
            body: args?.releaseBody,
            draft: args?.draft === true,
            prerelease: args?.prerelease === true,
            attachTarball: args?.attachTarball !== false,
            message: args?.commitMessage,
            syncMode: args?.syncMode,
          },
        })
        return ok(result, summarizePublish(result))
      } catch (error) {
        return fail(error)
      }
    },
  }

  return [releaseStatus, npmRegistryTool, npmPublishTool, githubPublishTool, publishPackageTool]
}

export const SHIP_DECK_PROMPT = {
  name: 'tool:ship-deck',
  order: 118,
  text:
    'Release Depot (发布仓) owns npm and GitHub publishing for this session. ' +
    'Call release_status before publishing to see which accounts are connected; tokens are never returned. ' +
    'The user opens the 发布仓 workbench from the left sidebar panel icon and connects accounts under 设置. ' +
    'npm_publish and publish_package perform real, irreversible publishes: only run them when the user explicitly asked, prefer dryRun first, and never raise a version or publish on your own initiative. ' +
    'npm_registry actions that deprecate or unpublish require the user\'s explicit request; unpublish also needs force=true and, for a whole package, confirmName equal to the package name. ' +
    'Directory arguments must stay inside the current workspace; if a needed directory is elsewhere, ask the user to use the panel instead.',
}

// Keep a valid, stable export list for tests.
export { isValidPackageName, isValidVersion }