/**
 * dsh-release-depot — GitHub client.
 *
 * Covers the two things the plugin needs beyond the generic REST tool another
 * plugin may provide: OAuth device-flow / token login, and a publish pipeline
 * that creates a repository, pushes a directory snapshot through the Git Data
 * API (no local git credentials required), then creates a release and uploads
 * the npm tarball as an asset.
 */
import { walkForGit } from './pack.js'
import { parseGitHubRepo } from './semver.js'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_AGENT = 'dsh-release-depot/1.1.8'

export class GitHubError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'GitHubError'
    this.status = options.status ?? 0
    this.code = options.code ?? 'EGITHUB'
    this.hint = options.hint ?? ''
    this.details = options.details ?? null
  }
}

function githubHeaders(token, extra = {}) {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': USER_AGENT,
    ...(token !== null && token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  }
}

function parseJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function describeGitHubError(status, text, context = '') {
  const payload = parseJson(text)
  const detail = typeof payload?.message === 'string' ? payload.message : text.slice(0, 400)
  const errors = Array.isArray(payload?.errors)
    ? payload.errors.map((item) => item?.message ?? item?.code ?? JSON.stringify(item)).join('；')
    : ''
  const prefix = context === '' ? '' : `${context}：`
  const merged = errors === '' ? detail : `${detail}（${errors}）`
  if (status === 401) {
    return new GitHubError(`${prefix}GitHub Token 无效或已过期（${merged}）。请在「设置 → GitHub 账号」重新连接。`, {
      code: 'E401', status, hint: 'OAuth 设备流的授权可能被撤销；经典 PAT 检查是否过期，fine-grained PAT 需要目标仓库的 Contents 写权限。',
    })
  }
  if (status === 403) {
    if (/must have admin|administration|delete_repo|resource not accessible/i.test(merged)) {
      return new GitHubError(`${prefix}GitHub 拒绝了请求，Token 权限不足（${merged}）。`, {
        code: 'ESCOPE',
        status,
        hint: '删除仓库需要 delete_repo 权限：OAuth/经典 PAT 请在 https://github.com/settings/tokens 勾选 delete_repo 后重新生成；fine-grained PAT 需要该仓库的 Administration: Read and write。',
        details: {
          requiredScope: 'delete_repo',
          tokenSettingsUrl: 'https://github.com/settings/tokens',
          fineGrainedUrl: 'https://github.com/settings/personal-access-tokens',
        },
      })
    }
    return new GitHubError(`${prefix}GitHub 拒绝了请求（${merged}）。`, {
      code: 'E403', status,
      hint: '检查 Token 作用域（repo / workflow / write:packages）与组织 SSO 授权；也可能触发了速率限制。',
      details: { tokenSettingsUrl: 'https://github.com/settings/tokens' },
    })
  }
  if (status === 404) {
    return new GitHubError(`${prefix}GitHub 找不到资源或无权访问（${merged}）。`, {
      code: 'E404', status, hint: '仓库可能不存在、名字拼错，或者 Token 没有该仓库权限。',
    })
  }
  if (status === 422) {
    return new GitHubError(`${prefix}GitHub 校验失败（${merged}）。`, {
      code: 'E422', status, hint: '常见原因：仓库名已存在、release tag 已存在、分支保护不允许更新。',
    })
  }
  if (status === 429) {
    return new GitHubError(`${prefix}GitHub 限流，请稍后重试（${merged}）。`, { code: 'E429', status })
  }
  return new GitHubError(`${prefix}GitHub 返回 HTTP ${status}${merged === '' ? '' : `：${merged}`}`, {
    code: 'EHTTP', status, details: payload,
  })
}

function assertRepoPart(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(value)) {
    throw new GitHubError(`${label}不合法：${String(value ?? '')}`, { code: 'EINVALID' })
  }
}

/** Sanitize a package name into a usable repository name. */
export function repoNameFromPackage(name) {
  const base = String(name ?? '').replace(/^@[^/]+\//, '')
  const cleaned = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '')
  return (cleaned === '' ? 'package' : cleaned).slice(0, 100)
}

export class GitHubClient {
  constructor(options) {
    this.network = options.network
    this.token = typeof options.token === 'string' && options.token !== '' ? options.token : null
    this.apiBase = String(options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '')
    this.uploadsBase = String(options.uploadsBase ?? 'https://uploads.github.com').replace(/\/+$/, '')
    this.githubBase = String(options.githubBase ?? 'https://github.com').replace(/\/+$/, '')
  }

  async rawRequest(url, options = {}) {
    const method = options.method ?? 'GET'
    const headers = githubHeaders(options.token ?? this.token, options.headers)
    let body = options.body
    if (body !== undefined && body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body)
      headers['content-type'] = 'application/json'
    }
    let res
    try {
      res = await this.network.fetch(url, { method, headers, body }, options.timeoutMs ?? 45000)
    } catch (error) {
      const cause = error?.cause instanceof Error ? error.cause.message : ''
      const reason = error instanceof Error ? error.message : String(error)
      throw new GitHubError(`无法连接 GitHub：${reason}${cause === '' ? '' : `（${cause}）`}`, {
        code: 'ENETWORK', hint: '检查网络/代理设置；插件会自动读取系统代理与系统证书。',
      })
    }
    const text = await res.text().catch(() => '')
    return { res, text, status: res.status, json: parseJson(text), headers: res.headers }
  }

  async request(path, options = {}) {
    const url = /^https?:\/\//i.test(path)
      ? path
      : `${options.base ?? this.apiBase}/${String(path).replace(/^\/+/, '')}`
    const { res, text, json } = await this.rawRequest(url, options)
    if (!res.ok && options.allow404 !== true) {
      throw describeGitHubError(res.status, text, options.context ?? '')
    }
    return { status: res.status, json, text, headers: res.headers, ok: res.ok }
  }

  /** Validate the token and read the account. */
  async whoami() {
    const { json, headers } = await this.request('/user', { context: '验证 GitHub Token' })
    if (json === null || typeof json.login !== 'string') {
      throw new GitHubError('GitHub /user 响应无法识别', { code: 'EBADRESPONSE' })
    }
    const scopesHeader = String(headers.get('x-oauth-scopes') ?? '')
    return {
      login: json.login,
      name: typeof json.name === 'string' ? json.name : null,
      avatarUrl: typeof json.avatar_url === 'string' ? json.avatar_url : null,
      htmlUrl: typeof json.html_url === 'string' ? json.html_url : null,
      publicRepos: Number(json.public_repos ?? 0),
      scopes: scopesHeader === '' ? [] : scopesHeader.split(',').map((scope) => scope.trim()).filter(Boolean),
    }
  }

  /** Repositories the account can push to (owner + collaborator + org member). */
  async listRepos(options = {}) {
    const perPage = Math.min(Math.max(Number(options.perPage ?? 50), 1), 100)
    const page = Math.max(Number(options.page ?? 1), 1)
    const query = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
      sort: options.sort === 'full_name' ? 'full_name' : 'updated',
      direction: 'desc',
      affiliation: 'owner,collaborator,organization_member',
    })
    const { json } = await this.request(`/user/repos?${query.toString()}`, { context: '读取仓库列表' })
    const items = Array.isArray(json) ? json : []
    return items.map((repo) => ({
      owner: repo.owner?.login ?? '',
      name: repo.name ?? '',
      fullName: repo.full_name ?? '',
      private: repo.private === true,
      description: typeof repo.description === 'string' ? repo.description : '',
      defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : null,
      updatedAt: repo.updated_at ?? null,
      htmlUrl: repo.html_url ?? null,
      pushedAt: repo.pushed_at ?? null,
      language: repo.language ?? null,
      archived: repo.archived === true,
    }))
  }

  /** One repository, or null when absent/invisible. */
  async getRepo(owner, repo) {
    assertRepoPart(owner, 'owner')
    assertRepoPart(repo, 'repo')
    const { status, json } = await this.request(`/repos/${owner}/${repo}`, { allow404: true })
    if (status === 404) return null
    return json
  }

  async createRepo(options) {
    const name = String(options.name ?? '').trim()
    assertRepoPart(name, '仓库名')
    const description = typeof options.description === 'string' ? options.description.slice(0, 350) : ''
    const body = {
      name,
      private: options.private === true,
      description,
      auto_init: options.autoInit === true,
      has_issues: true,
      has_wiki: false,
    }
    if (typeof options.org === 'string' && options.org.trim() !== '') assertRepoPart(options.org.trim(), 'org')
    const path = typeof options.org === 'string' && options.org.trim() !== ''
      ? `/orgs/${options.org.trim()}/repos`
      : '/user/repos'
    const { json } = await this.request(path, {
      method: 'POST',
      body,
      context: '创建仓库',
    })
    return {
      owner: json?.owner?.login ?? options.org ?? null,
      name: json?.name ?? name,
      fullName: json?.full_name ?? name,
      htmlUrl: json?.html_url ?? null,
      private: json?.private === true,
      defaultBranch: json?.default_branch ?? null,
    }
  }

  /** Delete a repository; GitHub requires delete_repo (OAuth) or Administration: write (fine-grained PAT). */
  async deleteRepo(owner, repo) {
    const result = await this.request(`/repos/${owner}/${repo}`, {
      method: 'DELETE',
      context: `删除仓库 ${owner}/${repo}`,
    })
    if (result.status >= 300) {
      throw new GitHubError(`删除仓库 ${owner}/${repo} 失败（HTTP ${result.status}）`, {
        code: 'EDELETEREPO',
        status: result.status,
        hint: '删除仓库需要 delete_repo scope（OAuth）或 Administration: write（fine-grained PAT），且账号需有 admin 权限。',
        details: {
          requiredScope: 'delete_repo',
          tokenSettingsUrl: 'https://github.com/settings/tokens',
          fineGrainedUrl: 'https://github.com/settings/personal-access-tokens',
        },
      })
    }
    return { ok: true, owner, repo, fullName: `${owner}/${repo}`, deleted: true }
  }

  async listReleases(owner, repo, options = {}) {
    assertRepoPart(owner, 'owner')
    assertRepoPart(repo, 'repo')
    const perPage = Math.min(Math.max(Number(options.perPage ?? 30), 1), 100)
    const { json } = await this.request(`/repos/${owner}/${repo}/releases?per_page=${perPage}`, {
      context: '读取 Releases',
    })
    const items = Array.isArray(json) ? json : []
    return items.map((release) => ({
      id: release.id,
      tag: release.tag_name ?? '',
      name: release.name ?? '',
      draft: release.draft === true,
      prerelease: release.prerelease === true,
      createdAt: release.created_at ?? null,
      publishedAt: release.published_at ?? null,
      htmlUrl: release.html_url ?? null,
      body: typeof release.body === 'string' ? release.body.slice(0, 2000) : '',
      assets: Array.isArray(release.assets)
        ? release.assets.map((asset) => ({ id: asset.id, name: asset.name, size: asset.size, url: asset.browser_download_url }))
        : [],
    }))
  }

  async createRelease(owner, repo, options) {
    assertRepoPart(owner, 'owner')
    assertRepoPart(repo, 'repo')
    const tag = String(options.tag ?? '').trim()
    if (tag === '' || !/^[A-Za-z0-9._/@+-]{1,120}$/.test(tag)) {
      throw new GitHubError(`release tag 不合法：${tag}`, { code: 'EINVALIDTAG' })
    }
    const body = {
      tag_name: tag,
      target_commitish: typeof options.target === 'string' && options.target !== '' ? options.target : undefined,
      name: typeof options.name === 'string' && options.name.trim() !== '' ? options.name.trim().slice(0, 200) : tag,
      body: typeof options.body === 'string' ? options.body.slice(0, 100000) : '',
      draft: options.draft === true,
      prerelease: options.prerelease === true,
      generate_release_notes: options.generateNotes === true,
    }
    const { json } = await this.request(`/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      body,
      context: '创建 Release',
    })
    return {
      id: json?.id ?? null,
      tag: json?.tag_name ?? tag,
      name: json?.name ?? null,
      draft: json?.draft === true,
      htmlUrl: json?.html_url ?? null,
      uploadUrl: json?.upload_url ?? null,
    }
  }

  async deleteRelease(owner, repo, releaseId) {
    assertRepoPart(owner, 'owner')
    assertRepoPart(repo, 'repo')
    if (!Number.isInteger(Number(releaseId)) || Number(releaseId) <= 0) {
      throw new GitHubError('release id 不合法', { code: 'EINVALID' })
    }
    await this.request(`/repos/${owner}/${repo}/releases/${Number(releaseId)}`, {
      method: 'DELETE',
      context: '删除 Release',
    })
    return { ok: true, id: Number(releaseId) }
  }

  async deleteTag(owner, repo, tag) {
    assertRepoPart(owner, 'owner')
    assertRepoPart(repo, 'repo')
    // The ref is a path, not a query: a slash in the tag must stay literal.
    // `encodeURIComponent` would turn `release/1.2.3` into `release%2F1.2.3`,
    // which 404s — and `allow404` would then report success while the tag
    // survived.
    const ref = String(tag ?? '').split('/').map((part) => encodeURIComponent(part)).join('/')
    if (ref === '') throw new GitHubError('tag 不能为空', { code: 'EINVALIDTAG' })
    await this.request(`/repos/${owner}/${repo}/git/refs/tags/${ref}`, {
      method: 'DELETE',
      allow404: true,
      context: '删除 tag',
    })
    return { ok: true, tag }
  }

  /** Upload a buffer as a release asset (uploads.github.com). */
  async uploadAsset(owner, repo, releaseId, file) {
    assertRepoPart(owner, 'owner')
    assertRepoPart(repo, 'repo')
    const name = String(file.name ?? '').trim()
    if (name === '') throw new GitHubError('asset 文件名不能为空', { code: 'EINVALID' })
    const query = new URLSearchParams({ name })
    const url = `${this.uploadsBase}/repos/${owner}/${repo}/releases/${Number(releaseId)}/assets?${query.toString()}`
    const { status, json } = await this.request(url, {
      method: 'POST',
      body: file.data,
      headers: {
        'content-type': file.contentType ?? 'application/octet-stream',
        'content-length': String(file.data.length),
      },
      timeoutMs: 300000,
      context: `上传 asset ${name}`,
    })
    if (status >= 300) throw new GitHubError(`上传 asset 失败（HTTP ${status}）`, { code: 'EUPLOAD' })
    return {
      id: json?.id ?? null,
      name: json?.name ?? name,
      size: json?.size ?? file.data.length,
      url: json?.browser_download_url ?? null,
    }
  }

  /**
   * Push a local directory snapshot as one commit on a branch.
   *
   * Two modes:
   *  - replace (default): the new tree lists only files in the directory, so
   *    the repository mirrors the directory;
   *  - merge: the previous tree is the base, so files outside the snapshot
   *    are kept.
   */
  async pushDirectory(options) {
    const owner = String(options.owner ?? '').trim()
    const repo = String(options.repo ?? '').trim()
    assertRepoPart(owner, 'owner')
    assertRepoPart(repo, 'repo')
    if (typeof options.dir !== 'string' || options.dir === '') {
      throw new GitHubError('缺少要上传的目录', { code: 'EINVALID' })
    }

    const existing = await this.getRepo(owner, repo)
    let created = false
    let defaultBranch = typeof options.branch === 'string' && options.branch.trim() !== ''
      ? options.branch.trim()
      : 'main'
    if (existing === null) {
      if (options.create !== true) {
        throw new GitHubError(`仓库 ${owner}/${repo} 不存在；如需创建请勾选“自动创建仓库”`, {
          code: 'ENOREPO', hint: '也可以先在 GitHub 上创建仓库再发布。',
        })
      }
      const createdRepo = await this.createRepo({
        name: repo,
        private: options.private === true,
        description: options.description,
        autoInit: true,
      })
      created = true
      defaultBranch = typeof options.branch === 'string' && options.branch.trim() !== ''
        ? options.branch.trim()
        : 'main'
    } else if (typeof options.branch === 'string' && options.branch.trim() !== '') {
      defaultBranch = options.branch.trim()
    } else if (typeof existing.default_branch === 'string' && existing.default_branch !== '') {
      defaultBranch = existing.default_branch
    }
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(defaultBranch) || defaultBranch.startsWith('/') || defaultBranch.includes('..')) {
      throw new GitHubError(`分支名不合法：${defaultBranch}`, { code: 'EINVALIDBRANCH' })
    }

    let headSha = null
    let headTree = null
    try {
      const ref = await this.request(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, {
        allow404: true,
      })
      if (ref.status === 200 && typeof ref.json?.object?.sha === 'string') {
        headSha = ref.json.object.sha
        if (options.syncMode === 'merge') {
          const commit = await this.request(`/repos/${owner}/${repo}/git/commits/${headSha}`, { context: '读取目标提交' })
          headTree = commit.json?.tree?.sha ?? null
        }
      }
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 404) throw error
    }

    // The Git Data API refuses to create blobs in a brand-new empty repo.
    // Bootstrap one initial README commit through the Contents API, then make
    // sure the requested branch points at it.
    if (headSha === null) {
      const content = Buffer.from(`# ${repo}\n\nInitialized by Release Depot.\n`, 'utf8').toString('base64')
      const init = await this.request(`/repos/${owner}/${repo}/contents/README.md`, {
        method: 'PUT',
        body: { message: 'Initial commit', content },
        context: '初始化空仓库',
      })
      const sha = init.json?.commit?.sha
      if (typeof sha !== 'string') {
        throw new GitHubError('无法初始化空仓库（Contents API 没有返回 commit sha）', { code: 'EEMPTYREPO' })
      }
      headSha = sha
      const branchRef = await this.request(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, {
        allow404: true,
      })
      if (branchRef.status !== 200) {
        await this.request(`/repos/${owner}/${repo}/git/refs`, {
          method: 'POST',
          body: { ref: `refs/heads/${defaultBranch}`, sha },
          context: '创建分支',
        })
      }
    }

    const walk = await walkForGit(options.dir, {
      maxFiles: options.maxFiles,
      maxTotalBytes: options.maxTotalBytes,
    })
    const { readFile } = await import('node:fs/promises')
    const blobs = []
    let index = 0
    const concurrency = 5
    const workers = Array.from({ length: Math.min(concurrency, walk.files.length) }, async () => {
      for (;;) {
        const current = index
        index += 1
        if (current >= walk.files.length) return
        const file = walk.files[current]
        const data = await readFile(file.absolutePath)
        const { json } = await this.request(`/repos/${owner}/${repo}/git/blobs`, {
          method: 'POST',
          body: { content: data.toString('base64'), encoding: 'base64' },
          timeoutMs: 60000,
          context: `上传 ${file.path}`,
        })
        blobs[current] = { path: file.path, mode: file.mode === '100755' ? '100755' : '100644', type: 'blob', sha: json?.sha }
      }
    })
    await Promise.all(workers)
    if (blobs.some((blob) => typeof blob.sha !== 'string')) {
      throw new GitHubError('GitHub 没有返回全部 blob sha，发布中止', { code: 'EBADRESPONSE' })
    }

    const treeBody = { tree: blobs }
    if (options.syncMode === 'merge' && headTree !== null) treeBody.base_tree = headTree
    const tree = await this.request(`/repos/${owner}/${repo}/git/trees`, {
      method: 'POST',
      body: treeBody,
      timeoutMs: 90000,
      context: '创建 Git tree',
    })
    const treeSha = tree.json?.sha
    if (typeof treeSha !== 'string') throw new GitHubError('创建 tree 失败：没有 sha', { code: 'EBADRESPONSE' })

    const message = typeof options.message === 'string' && options.message.trim() !== ''
      ? options.message.trim().slice(0, 2000)
      : `Publish ${new Date().toISOString()}`
    const commitBody = {
      message,
      tree: treeSha,
      parents: headSha === null ? [] : [headSha],
    }
    const commit = await this.request(`/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      body: commitBody,
      context: '创建提交',
    })
    const commitSha = commit.json?.sha
    if (typeof commitSha !== 'string') throw new GitHubError('创建提交失败：没有 sha', { code: 'EBADRESPONSE' })

    const refPath = `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(defaultBranch)}`
    const updated = await this.request(refPath, {
      method: 'PATCH',
      body: { sha: commitSha, force: false },
      allow404: true,
    })
    if (!(updated.status >= 200 && updated.status < 300)) {
      const createdRef = await this.request(`/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${defaultBranch}`, sha: commitSha },
        context: '创建分支',
      })
      if (createdRef.status >= 300) {
        throw new GitHubError('无法创建或更新分支引用（可能受分支保护限制）', {
          code: 'EREF', hint: '确认 Token 有 Contents 写权限，且分支没有保护规则阻止更新。',
        })
      }
    }
    // A freshly created empty repository can have an unexpected initial
    // default branch name; point it at the branch we just published.
    try {
      await this.request(`/repos/${owner}/${repo}`, {
        method: 'PATCH',
        body: { default_branch: defaultBranch },
        context: '设置默认分支',
      })
    } catch {
      /* default branch is cosmetic; the commit is already on the right branch */
    }

    return {
      ok: true,
      owner,
      repo,
      fullName: `${owner}/${repo}`,
      branch: defaultBranch,
      commitSha,
      commitUrl: `https://github.com/${owner}/${repo}/commit/${commitSha}`,
      repoUrl: `https://github.com/${owner}/${repo}`,
      created,
      fileCount: blobs.length,
      totalBytes: walk.totalBytes,
      files: blobs.slice(0, 300).map((blob) => blob.path),
      warnings: walk.warnings,
    }
  }

  // ── GitHub OAuth device flow ────────────────────────────────────────────

  static async deviceStart(clientId, scopes, network) {
    let res
    try {
      res = await network.fetch(DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': USER_AGENT,
        },
        body: new URLSearchParams({ client_id: clientId, scope: scopes }).toString(),
      }, 20000)
    } catch (error) {
      throw new GitHubError(`无法连接 github.com：${error instanceof Error ? error.message : String(error)}`, {
        code: 'ENETWORK',
      })
    }
    const data = parseJson(await res.text().catch(() => ''))
    if (!res.ok || data === null || typeof data.device_code !== 'string') {
      throw new GitHubError(data?.error_description ?? data?.message ?? `GitHub 拒绝了该 Client ID（HTTP ${res.status}）`, {
        code: 'EDEVICE', status: res.status,
      })
    }
    return {
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      deviceCode: data.device_code,
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 900,
      interval: Math.max(1, typeof data.interval === 'number' ? data.interval : 5),
    }
  }

  static async devicePoll(clientId, deviceCode, network) {
    let res
    try {
      res = await network.fetch(ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': USER_AGENT,
        },
        body: new URLSearchParams({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }).toString(),
      }, 20000)
    } catch (error) {
      return { status: 'error', message: `无法连接 github.com：${error instanceof Error ? error.message : String(error)}` }
    }
    const data = parseJson(await res.text().catch(() => ''))
    if (data !== null && typeof data.access_token === 'string' && data.access_token !== '') {
      const client = new GitHubClient({ network, token: data.access_token })
      const user = await client.whoami()
      const scopes = typeof data.scope === 'string'
        ? data.scope.split(',').map((scope) => scope.trim()).filter(Boolean)
        : user.scopes
      return { status: 'authorized', token: data.access_token, user: { ...user, scopes } }
    }
    const code = data?.error ?? null
    if (code === 'authorization_pending') return { status: 'pending' }
    if (code === 'slow_down') return { status: 'pending', slowDown: true }
    if (code === 'expired_token') return { status: 'expired', message: '验证码已过期，请重新开始连接' }
    if (code === 'access_denied') return { status: 'denied', message: '授权被拒绝' }
    return { status: 'error', message: data?.error_description ?? data?.error ?? `GitHub 返回 HTTP ${res.status}` }
  }
}

export { parseGitHubRepo }