/**
 * dsh-release-depot — npm registry client.
 *
 * Implements the registry wire protocol used by the npm CLI for the actions
 * this plugin exposes, without importing npm: verify identity, read
 * packuments, publish a tarball, edit dist-tags, deprecate versions,
 * unpublish, and list the packages an account can manage.
 *
 * Endpoints (see libnpmpublish / libnpmaccess / npm's dist-tag command):
 *   GET    /-/whoami
 *   GET    /-/org/:user/package        (fallback /-/user/:user/package)
 *   GET    /:pkg?write=true            (mutable packument)
 *   PUT    /:pkg                        publish / deprecate
 *   PUT    /-/package/:pkg/dist-tags/:tag   body: JSON string version
 *   DELETE /-/package/:pkg/dist-tags/:tag
 *   DELETE /:pkg/-rev/:rev              unpublish whole package
 *   PUT    /:pkg/-rev/:rev              unpublish one version
 */
import { createHash } from 'node:crypto'
import {
  compareVersions,
  escapedPackageName,
  isValidPackageName,
  isValidVersion,
  maxVersion,
  satisfies,
  splitPackageName,
} from './semver.js'

export const NPM_REGISTRY = 'https://registry.npmjs.org'
export const GITHUB_REGISTRY = 'https://npm.pkg.github.com'
const USER_AGENT = 'dsh-release-depot/1.0.0 (npm registry client)'

export class RegistryError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'RegistryError'
    this.code = options.code ?? 'EREGISTRY'
    this.status = options.status ?? 0
    this.hint = options.hint ?? ''
    this.target = options.target ?? null
  }
}

function trimRegistry(registry) {
  return String(registry ?? '').trim().replace(/\/+$/, '')
}

function joinPath(registry, path) {
  return `${trimRegistry(registry)}/${String(path).replace(/^\/+/, '')}`
}

function parseBody(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function extractErrorCode(message, payload) {
  const text = typeof payload?.error === 'string'
    ? payload.error
    : typeof payload?.message === 'string'
      ? payload.message
      : typeof message === 'string' ? message : ''
  const match = /\[(E[A-Z0-9]+)\]/.exec(text)
  if (match !== null) return match[1]
  if (/one-time password|otp/i.test(text)) return 'EOTP'
  if (/previously published|cannot publish over/i.test(text)) return 'EPUBLISHCONFLICT'
  if (/unauthorized|bad credentials|invalid token/i.test(text)) return 'E401'
  if (/forbidden|not authorized|permission/i.test(text)) return 'E403'
  if (/not found/i.test(text)) return 'E404'
  return null
}

function errorFromResponse(status, text, headers, context = '') {
  const payload = parseBody(text)
  const detail = typeof payload?.error === 'string'
    ? payload.error
    : typeof payload?.message === 'string'
      ? payload.message
      : typeof payload?.reason === 'string'
        ? payload.reason
        : (typeof text === 'string' ? text.slice(0, 400) : '')
  const code = extractErrorCode(detail, payload)
  const prefix = context === '' ? '' : `${context}：`
  const otpChallenge = String(headers?.get?.('www-authenticate') ?? '').toLowerCase().includes('otp') ||
    /one-time password/i.test(detail)

  if (status === 401 && (code === 'EOTP' || otpChallenge)) {
    const webAuth = typeof payload?.authUrl === 'string' && payload.authUrl !== ''
    return new RegistryError(
      webAuth
        ? `${prefix}npm 要求浏览器 WebAuthn 二次验证。本插件只支持 6 位 TOTP；请改用勾选「Bypass two-factor authentication」的 Granular Token，或先用 npm CLI 完成验证。`
        : `${prefix}registry 要求一次性验证码（2FA）。请在发布向导里填入 6 位验证码后重试。`,
      {
        code: webAuth ? 'EWEBAUTHN' : 'EOTP',
        status,
        hint: webAuth
          ? '打开 npm Token 页面，重新生成一个勾选 Bypass two-factor authentication 的 Granular Access Token。'
          : 'npm 账户开启了 two-factor authentication；把认证器里的验证码填到 OTP 输入框。',
      },
    )
  }
  if (status === 401) {
    return new RegistryError(`${prefix}npm Token 无效或已过期（${detail || 'Unauthorized'}）。请在「设置 → npm 账号」重新登录。`, {
      code: 'E401', status, hint: '确认 Token 没有多余字符，且拥有 publish 权限；granular token 需要勾选对应包与 Read and write。',
    })
  }
  if (status === 402) {
    return new RegistryError(`${prefix}该包需要付费账户才能发布（${detail || 'Payment Required'}）。`, {
      code: 'E402', status, hint: '私有 scoped 包需要付费；把 access 改成 public 再试。',
    })
  }
  if (status === 403) {
    const stageOnly = /stage[\s-]*only|staged publishing|stage permission/i.test(detail)
    const needs2fa = /two-factor authentication or granular access token with bypass|bypass 2fa/i.test(detail)
    return new RegistryError(`${prefix}registry 拒绝了请求（${detail || 'Forbidden'}）。`, {
      code: needs2fa ? 'E2FAREQUIRED' : 'E403', status,
      hint: needs2fa
        ? 'npm 现在要求发布时进行 2FA，或使用勾选了 Bypass two-factor authentication 的 Granular Token；请到 npm Token 页面重新生成并替换。'
        : stageOnly
          ? '这个 Granular Token 只有 staging 权限，不能直接发布；请改用 Read and write (publish and stage)，或在 npm 网页上提升该 Token 的权限。'
          : '确认当前账号是包的所有者/维护者，并且 Token 有 write 权限；部分包要求 OTP。',
    })
  }
  if (status === 404) {
    return new RegistryError(`${prefix}找不到该包或无权访问（${detail || 'Not Found'}）。`, {
      code: 'E404', status, hint: '检查包名拼写；私有包需要 Token 且有读权限。',
    })
  }
  if (status === 409) {
    return new RegistryError(`${prefix}该版本已存在，不能覆盖发布（${detail || 'Conflict'}）。`, {
      code: 'EPUBLISHCONFLICT', status, hint: 'npm 不允许覆盖已发布版本：请提升 version 后再发布。',
    })
  }
  if (status === 413) {
    return new RegistryError(`${prefix}发布的包体超过 registry 限制。`, {
      code: 'E413', status, hint: '精简 files 字段，排除构建产物或大资源后再试。',
    })
  }
  if (status === 422) {
    return new RegistryError(`${prefix}registry 校验失败（${detail || 'Unprocessable Entity'}）。`, {
      code: 'E422', status, hint: '检查 package.json 的 name/version/description 与 registry 策略。',
    })
  }
  if (status === 429) {
    return new RegistryError(`${prefix}registry 限流，请稍后重试（${detail || 'Too Many Requests'}）。`, {
      code: 'E429', status, hint: '等待几分钟，或减少批量请求。',
    })
  }
  return new RegistryError(`${prefix}registry 返回 HTTP ${status}${detail === '' ? '' : `：${detail}`}`, {
    code: code ?? 'EHTTP', status,
  })
}

export class NpmRegistry {
  /**
   * @param {object} options
   * @param {import('./net.js').Network} options.network
   * @param {string} options.registry
   * @param {string} [options.token]
   * @param {string} [options.otp]
   */
  constructor(options) {
    this.network = options.network
    this.registry = trimRegistry(options.registry) || NPM_REGISTRY
    this.token = typeof options.token === 'string' && options.token !== '' ? options.token : null
    this.otp = typeof options.otp === 'string' && /^\d{6}$/.test(options.otp) ? options.otp : null
    this.timeoutMs = options.timeoutMs ?? 45000
  }

  headers(extra = {}) {
    const headers = {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...extra,
    }
    if (this.token !== null) headers.authorization = `Bearer ${this.token}`
    if (this.otp !== null) headers['npm-otp'] = this.otp
    return headers
  }

  async request(path, options = {}) {
    const url = /^https?:\/\//i.test(path) ? path : joinPath(this.registry, path)
    const method = options.method ?? 'GET'
    const headers = this.headers(options.headers)
    let body = options.body
    if (body !== undefined && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body)
      headers['content-type'] = 'application/json'
    }
    let res
    try {
      res = await this.network.fetch(url, { method, headers, body }, options.timeoutMs ?? this.timeoutMs)
    } catch (error) {
      const reason = error?.cause instanceof Error ? error.cause.message : error instanceof Error ? error.message : String(error)
      throw new RegistryError(`无法连接 registry（${this.registry}）：${reason}`, {
        code: 'ENETWORK',
        hint: '检查网络/代理；插件会自动读取系统代理，也可在插件配置里设置 proxy。',
      })
    }
    const text = await res.text().catch(() => '')
    const payload = parseBody(text)
    if (!res.ok) throw errorFromResponse(res.status, text, res.headers, options.context ?? '')
    return { res, payload, text, status: res.status }
  }

  /** Identity check used for login and the status card. */
  async whoami() {
    const { payload } = await this.request('/-/whoami', { context: '验证 npm Token' })
    const username = typeof payload?.username === 'string' ? payload.username : null
    if (username === null) {
      throw new RegistryError('registry 返回了无法识别的 whoami 响应', { code: 'EBADRESPONSE' })
    }
    return {
      username,
      registry: this.registry,
      email: typeof payload?.email === 'string' ? payload.email : null,
    }
  }

  /** Lightweight reachability probe; no auth required. */
  async ping() {
    const started = Date.now()
    await this.request('/-/ping', { timeoutMs: 12000 })
    return { ok: true, ms: Date.now() - started }
  }

  /** Map of package name → permission for an account, via libnpmaccess routes. */
  async listOwned(username) {
    const attempts = username.startsWith('@')
      ? [`/-/org/${encodeURIComponent(username.slice(1))}/package`, `/-/user/${encodeURIComponent(username.slice(1))}/package`]
      : [`/-/org/${encodeURIComponent(username)}/package`, `/-/user/${encodeURIComponent(username)}/package`]
    let lastError = null
    for (const path of attempts) {
      try {
        const { payload } = await this.request(path, { context: '读取账号下的包' })
        if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
          const entries = Object.entries(payload)
            .filter(([name, permission]) => typeof permission === 'string' && ['read', 'write'].includes(permission))
            .map(([name, permission]) => ({ name, permission }))
          return { entries, source: path.includes('/org/') ? 'org' : 'user' }
        }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new RegistryError('无法读取账号下的包列表', { code: 'E404' })
  }

  /** Public search, also used as a fallback for the package list. */
  async search(text, options = {}) {
    const size = Math.min(Math.max(Number(options.size ?? 25), 1), 250)
    const query = String(text ?? '').trim()
    const { payload } = await this.request(
      `/-/v1/search?text=${encodeURIComponent(query)}&size=${size}`,
      { context: '搜索 npm 包', timeoutMs: 20000 },
    )
    const objects = Array.isArray(payload?.objects) ? payload.objects : []
    return {
      total: Number(payload?.total ?? objects.length),
      items: objects
        .filter((entry) => entry?.package !== null && typeof entry?.package === 'object')
        .map((entry) => ({
          name: String(entry.package.name ?? ''),
          version: typeof entry.package.version === 'string' ? entry.package.version : null,
          description: typeof entry.package.description === 'string' ? entry.package.description : '',
          date: typeof entry.package.date === 'string' ? entry.package.date : null,
          links: entry.package.links ?? {},
          publisher: entry.package.publisher?.username ?? null,
          score: entry.score?.final ?? null,
        })),
    }
  }

  /** Full packument, optionally writable (npm uses `?write=true`). */
  async packument(name, options = {}) {
    if (!isValidPackageName(name)) {
      throw new RegistryError(`不是合法的 npm 包名：${name}`, { code: 'ENAME' })
    }
    const query = options.write === true ? '?write=true' : ''
    const { payload } = await this.request(`${escapedPackageName(name)}${query}`, {
      context: `读取 ${name}`,
      timeoutMs: 30000,
    })
    if (payload === null || typeof payload !== 'object') {
      throw new RegistryError(`registry 没有返回可用的 packument：${name}`, { code: 'EBADRESPONSE' })
    }
    return payload
  }

  /** Reduced package detail for the panel. */
  async packageInfo(name) {
    const doc = await this.packument(name)
    const versions = doc.versions !== null && typeof doc.versions === 'object' ? doc.versions : {}
    const versionKeys = Object.keys(versions)
      .filter((version) => isValidVersion(version))
      .sort((a, b) => compareVersions(b, a))
    const distTags = doc['dist-tags'] !== null && typeof doc['dist-tags'] === 'object' ? doc['dist-tags'] : {}
    const latest = typeof distTags.latest === 'string' ? distTags.latest : maxVersion(versionKeys)
    const latestDoc = latest !== null && versions[latest] !== undefined ? versions[latest] : {}
    return {
      name: doc.name ?? name,
      description: typeof doc.description === 'string' ? doc.description : '',
      distTags,
      latest,
      latestTime: doc.time?.[latest] ?? null,
      created: doc.time?.created ?? null,
      modified: doc.time?.modified ?? null,
      license: typeof latestDoc.license === 'string'
        ? latestDoc.license
        : typeof doc.license === 'string' ? doc.license : null,
      repository: typeof latestDoc.repository === 'string'
        ? latestDoc.repository
        : latestDoc.repository?.url ?? null,
      homepage: typeof latestDoc.homepage === 'string' ? latestDoc.homepage : null,
      maintainers: Array.isArray(doc.maintainers)
        ? doc.maintainers.map((item) => ({ name: item?.name ?? '', email: item?.email ?? '' }))
        : [],
      versions: versionKeys.map((version) => ({
        version,
        deprecated: typeof versions[version]?.deprecated === 'string' ? versions[version].deprecated : null,
        time: doc.time?.[version] ?? null,
        size: versions[version]?.dist?.unpackedSize ?? null,
      })),
      readme: typeof doc.readme === 'string' ? doc.readme.slice(0, 8000) : '',
      install: this.installCommand(name, latest),
    }
  }

  installCommand(name, version) {
    const suffix = typeof version === 'string' && version !== '' ? `@${version}` : ''
    return this.registry === NPM_REGISTRY
      ? `npm i ${name}${suffix}`
      : `npm i ${name}${suffix} --registry=${this.registry}`
  }

  /**
   * Publish a packed project.
   * @param {object} pack result of packProject()
   * @param {{access?:string,tag?:string}} options
   */
  async publish(pack, options = {}) {
    const name = pack.name
    const version = pack.version
    if (!isValidPackageName(name) || !isValidVersion(version)) {
      throw new RegistryError('包名或版本不合法，无法发布', { code: 'EVALIDATION' })
    }
    const { scope } = splitPackageName(name)
    const access = options.access === 'public' || options.access === 'restricted' ? options.access : null
    if (access === 'restricted' && scope === null) {
      throw new RegistryError("不能把非 scoped 包设为 restricted；请把访问级别改为 public", {
        code: 'EUNSCOPED', hint: 'npm 只允许 scoped 包（@scope/name）使用 restricted。',
      })
    }
    if (access === 'restricted' && this.registry === GITHUB_REGISTRY) {
      throw new RegistryError('GitHub Packages 的 npm registry 只支持 public 包发布', {
        code: 'EACCESS', hint: '把访问级别改为 public（包仍需是 @owner/name 形式）。',
      })
    }

    const tag = typeof options.tag === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(options.tag)
      ? options.tag
      : 'latest'
    const tarballName = pack.tarballName
    const tarballUrl = joinPath(this.registry, `${name}/-/${tarballName}`)
    const manifest = { ...pack.publishedManifest }
    manifest._id = `${name}@${version}`
    manifest.dist = {
      ...(manifest.dist ?? {}),
      integrity: pack.integrity,
      shasum: pack.shasum,
      tarball: tarballUrl,
    }
    delete manifest.dist.signatures

    const root = {
      _id: name,
      name,
      description: manifest.description ?? '',
      'dist-tags': { [tag]: version },
      versions: { [version]: manifest },
      ...(access !== null ? { access } : {}),
      _attachments: {
        [tarballName]: {
          content_type: 'application/octet-stream',
          data: pack.tarball.toString('base64'),
          length: pack.tarball.length,
        },
      },
    }
    if (typeof manifest.readme === 'string') root.readme = manifest.readme
    else if (typeof pack.readme === 'string' && pack.readme.trim() !== '') root.readme = pack.readme

    const { res, status } = await this.request(escapedPackageName(name), {
      method: 'PUT',
      body: root,
      timeoutMs: 180000,
      context: `发布 ${name}@${version}`,
    })
    const headers = res.headers
    return {
      ok: true,
      status,
      registry: this.registry,
      name,
      version,
      tag,
      access,
      tarballUrl,
      integrity: pack.integrity,
      shasum: pack.shasum,
      size: pack.packedSize,
      fileCount: pack.fileCount,
      url: this.registry === NPM_REGISTRY ? `https://www.npmjs.com/package/${name}/v/${version}` : null,
      rateLimit: headers.get('x-ratelimit-remaining') ?? null,
    }
  }

  /** Set a dist-tag (npm dist-tag add). */
  async setDistTag(name, tag, version) {
    if (!isValidPackageName(name)) throw new RegistryError(`不是合法的包名：${name}`, { code: 'ENAME' })
    if (!isValidVersion(version)) throw new RegistryError(`不是合法的版本：${version}`, { code: 'EVERSION' })
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(tag)) {
      throw new RegistryError(`不是合法的 tag：${tag}`, { code: 'ETAGHINT' })
    }
    const existing = await this.distTags(name)
    if (existing[tag] === version) return { ok: true, unchanged: true, tag, version }
    await this.request(`/-/package/${escapedPackageName(name)}/dist-tags/${encodeURIComponent(tag)}`, {
      method: 'PUT',
      body: JSON.stringify(version),
      headers: { 'content-type': 'application/json' },
      context: `设置 ${name} 的 dist-tag ${tag}`,
    })
    return { ok: true, tag, version }
  }

  async deleteDistTag(name, tag) {
    const existing = await this.distTags(name)
    if (existing[tag] === undefined) {
      throw new RegistryError(`${name} 上不存在 dist-tag：${tag}`, { code: 'ENOTAG' })
    }
    await this.request(`/-/package/${escapedPackageName(name)}/dist-tags/${encodeURIComponent(tag)}`, {
      method: 'DELETE',
      context: `删除 ${name} 的 dist-tag ${tag}`,
    })
    return { ok: true, tag, version: existing[tag] }
  }

  /** Change package visibility (npm access set status). */
  async setAccess(name, access) {
    if (!isValidPackageName(name)) throw new RegistryError(`不是合法的包名：${name}`, { code: 'ENAME' })
    const value = access === 'private' || access === 'restricted' ? 'private' : 'public'
    if (value === 'private' && splitPackageName(name).scope === null) {
      throw new RegistryError('只有 scoped 包可以设为 private', { code: 'EUNSCOPED' })
    }
    await this.request(`/-/package/${escapedPackageName(name)}/access`, {
      method: 'POST',
      body: { access: value },
      context: `设置 ${name} 的访问级别`,
    })
    return { ok: true, name, access: value }
  }

  /** The account's token metadata; token values stay masked. */
  async tokenInfo() {
    const { payload } = await this.request('/-/npm/v1/tokens', {
      context: '读取 npm Token 信息',
      timeoutMs: 20000,
    })
    const objects = Array.isArray(payload?.objects) ? payload.objects : []
    return objects.map((entry) => ({
      name: typeof entry?.name === 'string' ? entry.name : '',
      token: typeof entry?.token === 'string' ? entry.token : '',
      key: typeof entry?.key === 'string' ? entry.key : '',
      expiry: typeof entry?.expiry === 'string' ? entry.expiry : null,
      created: typeof entry?.created === 'string' ? entry.created : null,
      bypass2fa: entry?.bypass_2fa === true,
      revoked: entry?.revoked ?? null,
      permissions: Array.isArray(entry?.permissions)
        ? entry.permissions.map((item) => ({ name: item?.name ?? '', action: item?.action ?? '' }))
        : [],
      scopes: Array.isArray(entry?.scopes)
        ? entry.scopes.map((item) => ({ name: item?.name ?? null, type: item?.type ?? '' }))
        : [],
    }))
  }

  /** Current maintainers from the packument. */
  async owners(name) {
    const doc = await this.packument(name)
    return Array.isArray(doc.maintainers)
      ? doc.maintainers.map((entry) => ({ name: entry?.name ?? '', email: entry?.email ?? '' }))
      : []
  }

  /**
   * Add or remove a maintainer, mirroring `npm owner add|rm`:
   * resolve the user document, then PUT the editable packument revision with
   * only `_id`, `_rev` and `maintainers`.
   */
  async changeOwner(name, user, action) {
    if (!isValidPackageName(name)) throw new RegistryError(`不是合法的包名：${name}`, { code: 'ENAME' })
    const username = String(user ?? '').trim()
    if (!/^[A-Za-z0-9._-]{1,214}$/.test(username)) {
      throw new RegistryError(`不是合法的 npm 用户名：${username}`, { code: 'EUSER' })
    }
    const verb = action === 'remove' || action === 'rm' ? 'remove' : 'add'
    const { payload: userDoc } = await this.request(`/-/user/org.couchdb.user:${encodeURIComponent(username)}`, {
      context: `读取用户 ${username}`,
    })
    if (userDoc === null || typeof userDoc.name !== 'string') {
      throw new RegistryError(`找不到 npm 用户：${username}`, { code: 'EUSER404' })
    }
    const normalized = { name: userDoc.name, email: typeof userDoc.email === 'string' ? userDoc.email : '' }
    const doc = await this.packument(name, { write: true })
    const current = Array.isArray(doc.maintainers) ? doc.maintainers : []
    const exists = current.some((entry) => entry?.name === normalized.name)
    if (verb === 'add' && exists) {
      return { ok: true, name, user: normalized, action: verb, unchanged: true, maintainers: current }
    }
    if (verb === 'remove' && !exists) {
      throw new RegistryError(`${normalized.name} 不是 ${name} 的维护者`, { code: 'ENOTOWNER' })
    }
    const maintainers = verb === 'add'
      ? [...current, normalized]
      : current.filter((entry) => entry?.name !== normalized.name)
    if (maintainers.length === 0) {
      throw new RegistryError('不能移除所有维护者；先添加其他人。', { code: 'EOWNERRM' })
    }
    const rev = doc._rev
    if (typeof rev !== 'string' || rev === '') {
      throw new RegistryError('registry 没有返回 _rev，无法修改维护者', { code: 'EREV' })
    }
    await this.request(`${escapedPackageName(name)}/-rev/${encodeURIComponent(rev)}`, {
      method: 'PUT',
      body: { _id: doc._id ?? name, _rev: rev, maintainers },
      context: `${verb === 'add' ? '添加' : '移除'}维护者 ${normalized.name}`,
    })
    return { ok: true, name, user: normalized, action: verb, maintainers }
  }

  async distTags(name) {
    const { payload } = await this.request(`/-/package/${escapedPackageName(name)}/dist-tags`, {
      context: `读取 ${name} 的 dist-tags`,
      timeoutMs: 20000,
    })
    if (payload === null || typeof payload !== 'object') {
      throw new RegistryError(`registry 没有返回 ${name} 的 dist-tags`, { code: 'EBADRESPONSE' })
    }
    const tags = {}
    for (const [tag, version] of Object.entries(payload)) {
      if (tag === '_etag' || typeof version !== 'string') continue
      tags[tag] = version
    }
    return tags
  }

  /**
   * Deprecate every matching version (npm deprecate); an empty message
   * undeprecates.
   */
  async deprecate(name, range, message) {
    const text = typeof message === 'string' ? message.trim() : ''
    if (text.length > 500) throw new RegistryError('废弃说明不能超过 500 字', { code: 'EMESSAGE' })
    const doc = await this.packument(name, { write: true })
    const versions = doc.versions !== null && typeof doc.versions === 'object' ? doc.versions : {}
    const targetRange = typeof range === 'string' && range.trim() !== '' ? range.trim() : '*'
    const matched = Object.keys(versions)
      .filter((version) => isValidVersion(version) && satisfies(version, targetRange, { includePrerelease: true }))
    if (matched.length === 0) {
      throw new RegistryError(`没有版本满足范围 ${targetRange}`, { code: 'ENOVERSIONS' })
    }
    for (const version of matched) {
      if (text === '') delete versions[version].deprecated
      else versions[version].deprecated = text
    }
    await this.request(escapedPackageName(name), {
      method: 'PUT',
      body: doc,
      timeoutMs: 90000,
      context: text === '' ? `取消废弃 ${name}` : `废弃 ${name}`,
    })
    return { ok: true, name, range: targetRange, versions: matched, deprecated: text !== '' }
  }

  /**
   * Unpublish one version or the whole package. npm's protocol is mirrored:
   * a whole-package removal deletes `/<pkg>/-rev/<rev>`, a single-version
   * removal rewrites the packument then deletes the tarball document.
   */
  async unpublish(name, version) {
    if (!isValidPackageName(name)) throw new RegistryError(`不是合法的包名：${name}`, { code: 'ENAME' })
    let doc
    try {
      doc = await this.packument(name, { write: true })
    } catch (error) {
      if (error instanceof RegistryError && error.status === 404) return { ok: true, noop: true, name }
      throw error
    }
    const versions = doc.versions !== null && typeof doc.versions === 'object' ? doc.versions : {}
    const allVersions = Object.keys(versions)
    const target = typeof version === 'string' ? version.trim() : ''
    if (target !== '' && target !== '*' && !isValidVersion(target)) {
      throw new RegistryError(`不是合法的版本：${target}`, { code: 'EVERSION' })
    }
    if (target === '' || target === '*' || allVersions.length <= 1) {
      const rev = doc._rev
      if (typeof rev !== 'string' || rev === '') {
        throw new RegistryError('registry 没有返回 _rev，无法删除整个包', { code: 'EREV' })
      }
      await this.request(`${escapedPackageName(name)}/-rev/${encodeURIComponent(rev)}`, {
        method: 'DELETE',
        context: `删除整个包 ${name}`,
      })
      return { ok: true, name, removed: 'package', versions: allVersions }
    }
    if (versions[target] === undefined) {
      throw new RegistryError(`${name} 不存在版本 ${target}`, { code: 'ENOVERSION' })
    }
    const rev = doc._rev
    if (typeof rev !== 'string' || rev === '') {
      throw new RegistryError('registry 没有返回 _rev，无法删除版本', { code: 'EREV' })
    }
    const tarball = versions[target]?.dist?.tarball
    delete versions[target]
    if (doc['dist-tags'] === null || typeof doc['dist-tags'] !== 'object') doc['dist-tags'] = {}
    for (const tag of Object.keys(doc['dist-tags'])) {
      if (doc['dist-tags'][tag] === target) delete doc['dist-tags'][tag]
    }
    if (doc['dist-tags'].latest === undefined) {
      const next = maxVersion(Object.keys(versions))
      if (next !== null) doc['dist-tags'].latest = next
    }
    delete doc._revisions
    delete doc._attachments
    await this.request(`${escapedPackageName(name)}/-rev/${encodeURIComponent(rev)}`, {
      method: 'PUT',
      body: doc,
      timeoutMs: 90000,
      context: `删除 ${name}@${target}`,
    })
    if (typeof tarball === 'string' && tarball !== '') {
      try {
        const after = await this.packument(name, { write: true })
        const tarballPath = this.relativeTarballPath(tarball)
        if (after._rev !== undefined && tarballPath !== null) {
          await this.request(`${tarballPath}/-rev/${encodeURIComponent(after._rev)}`, {
            method: 'DELETE',
            context: '删除 tarball 文件',
          })
        }
      } catch {
        /* The version is gone; a lingering tarball blob is harmless. */
      }
    }
    return { ok: true, name, removed: 'version', version: target, tarball }
  }

  relativeTarballPath(tarball) {
    try {
      const base = new URL(this.registry)
      const url = new URL(tarball)
      if (url.host !== base.host) return null
      const basePath = base.pathname.replace(/\/+$/, '')
      let path = url.pathname
      if (basePath !== '' && path.startsWith(basePath)) path = path.slice(basePath.length)
      return path.replace(/^\/+/, '')
    } catch {
      return null
    }
  }

  /** Compare local tarball hash with the registry's stored integrity. */
  static integrityOf(buffer) {
    return `sha512-${createHash('sha512').update(buffer).digest('base64')}`
  }
}

export { RegistryError as NpmRegistryError, errorFromResponse }