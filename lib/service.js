/**
 * dsh-release-depot — shared operations.
 *
 * Every user-facing panel action and every agent tool calls a method here;
 * there is exactly one implementation of connect / inspect / publish /
 * manage. Methods return plain JSON-safe values or throw an error with a
 * human message, a machine code and an actionable hint. Tokens never appear
 * in any returned value.
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GitHubClient, GitHubError, repoNameFromPackage } from './github.js'
import { PackError, packProject, readAssetFile } from './pack.js'
import {
  GITHUB_REGISTRY,
  NPM_REGISTRY,
  NpmRegistry,
  RegistryError,
} from './registry.js'
import {
  isValidPackageName,
  isValidVersion,
  parseGitHubRepo,
  splitPackageName,
} from './semver.js'
import { ShipDeckStore } from './store.js'

const TARGETS = ['npm', 'github-packages', 'github-release']
const CACHE_TTL_MS = 120000
const USER_AGENT = 'dsh-release-depot/1.1.9'

export class ShipDeckError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'ShipDeckError'
    this.code = options.code ?? 'ESHIPDECK'
    this.status = options.status ?? 0
    this.hint = options.hint ?? ''
    this.details = options.details ?? null
  }
}

/** Turn any thrown error into the JSON shape routes and tools return. */
export function serializeError(error) {
  if (error instanceof ShipDeckError || error instanceof RegistryError || error instanceof GitHubError || error instanceof PackError) {
    const base = {
      message: error.message,
      code: error.code,
      status: error.status ?? 0,
      hint: error.hint ?? '',
    }
    if (error.details !== null && error.details !== undefined) base.details = error.details
    return base
  }
  return { message: error instanceof Error ? error.message : String(error), code: 'EUNKNOWN', status: 0, hint: '' }
}

function nowIso() {
  return new Date().toISOString()
}

function normalizeRegistryUrl(input, fallback) {
  const value = typeof input === 'string' ? input.trim() : ''
  if (value === '') return fallback
  let url
  try {
    url = new URL(value)
  } catch {
    throw new ShipDeckError(`registry 地址不合法：${value}`, { code: 'EINVALIDREGISTRY' })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ShipDeckError('registry 只支持 http(s) 地址', { code: 'EINVALIDREGISTRY' })
  }
  if (url.username !== '' || url.password !== '') {
    throw new ShipDeckError('registry 地址里不要包含用户名或密码', { code: 'EINVALIDREGISTRY' })
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

function normalizeTargets(input, fallback) {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? [input] : fallback
  const list = Array.isArray(raw) ? raw : []
  const targets = [...new Set(list.filter((item) => TARGETS.includes(item)))]
  if (targets.length === 0) {
    throw new ShipDeckError('至少选择一个发布目标（npm / github-packages / github-release）', { code: 'ENOTARGET' })
  }
  return targets
}

function cleanToken(input) {
  let token = typeof input === 'string' ? input.trim() : ''
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    token = token.slice(1, -1).trim()
  }
  return token
}

function assertOtp(value) {
  if (value === undefined || value === null || value === '') return null
  const otp = String(value).trim()
  if (!/^\d{6}$/.test(otp)) {
    throw new ShipDeckError('一次性验证码应为 6 位数字', { code: 'EOTP_FORMAT' })
  }
  return otp
}

function normalizeExpiryDate(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const text = String(value).trim()
  const parsed = new Date(`${text}T12:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ShipDeckError('Token 到期日应为 YYYY-MM-DD 格式', { code: 'EEXPIRY' })
  }
  return text
}

function daysUntil(dateText) {
  if (typeof dateText !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return null
  const end = Date.parse(`${dateText}T23:59:59Z`)
  if (Number.isNaN(end)) return null
  return Math.ceil((end - Date.now()) / 86400000)
}

function shortText(value, limit = 300) {
  if (typeof value !== 'string') return ''
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/**
 * Shrink one publish record for status/history payloads: keep what an agent or
 * the panel actually needs, drop per-target noise (integrity, shasum, rate
 * limits, file counts, warning arrays) that only matters in the full log.
 */
function summarizeRecord(record) {
  if (record === undefined || record === null) return null
  const targets = Array.isArray(record.targets) ? record.targets.filter((target) => target !== null && typeof target === 'object') : []
  return {
    id: typeof record.id === 'string' ? record.id : null,
    at: typeof record.at === 'string' ? record.at : null,
    package: typeof record.package === 'string' ? record.package : '（未知包）',
    version: typeof record.version === 'string' ? record.version : '—',
    ok: record.ok === true,
    dryRun: record.dryRun === true,
    actor: record.actor === 'tool' || record.actor === 'ui' ? record.actor : null,
    durationMs: Number.isFinite(Number(record.durationMs)) ? Number(record.durationMs) : null,
    targets: targets.map((target) => ({
      target: target?.target ?? null,
      ok: target?.ok === true,
      ...(target?.dryRun === true ? { dryRun: true } : {}),
      ...(typeof target?.status === 'number' ? { status: target.status } : {}),
      ...(target?.pending === true ? { pending: true } : {}),
      ...(target?.error?.message ? { error: target.error.message } : {}),
      ...(typeof target?.url === 'string' && target.url !== '' ? { url: target.url } : {}),
      ...(typeof target?.release?.htmlUrl === 'string' ? { release: target.release.htmlUrl } : {}),
      ...(typeof target?.release?.tag === 'string' ? { releaseTag: target.release.tag } : {}),
      ...(typeof target?.commitUrl === 'string' ? { commitUrl: target.commitUrl } : {}),
      ...(typeof target?.repoUrl === 'string' ? { repoUrl: target.repoUrl } : {}),
      ...(typeof target?.asset?.name === 'string' ? { asset: target.asset.name } : {}),
      ...(Array.isArray(target?.warnings) && target.warnings.length > 0 ? { warnings: target.warnings } : {}),
    })),
  }
}

/** A safe GitHub release asset name, bounded to GitHub's limit. */
function releaseAssetName(pack) {
  const base = `${pack.name.replace(/^@/, '').replace(/[@/]/g, '-')}-${pack.version}.tgz`
  return base.length <= 200 ? base : `${base.slice(0, 196)}.tgz`
}

/** Read the changelog section for one version, without package boilerplate. */
async function readChangelogSection(dir, version) {
  try {
    const text = await readFile(join(dir, 'CHANGELOG.md'), 'utf8')
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(?:\\s|$)`, 'i')
    const start = lines.findIndex((line) => heading.test(line.trim()))
    if (start === -1) return ''
    const collected = []
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^##\s+/.test(lines[index])) break
      collected.push(lines[index])
    }
    return collected.join('\n').trim()
  } catch {
    return ''
  }
}

/** User-facing release notes: version changelog + install, no local paths. */
function defaultReleaseBody(pack, targets, changelog, npmAvailable = false) {
  const lines = []
  const notes = typeof changelog === 'string' ? changelog.trim() : ''
  const description = typeof pack.description === 'string' ? pack.description.trim() : ''
  if (notes !== '') {
    lines.push("### 更新内容 / What's changed", '', notes)
  } else if (description !== '') {
    lines.push(description)
  }
  if (npmAvailable) {
    lines.push('', '### Install / 安装', '', '```sh', `npm install ${pack.name}@${pack.version}`, '```')
    if (Array.isArray(targets) && targets.includes('npm')) {
      lines.push('', `- npm: https://www.npmjs.com/package/${pack.name}/v/${pack.version}`)
    }
  }
  return lines.join('\n')
}

/** Match the stored secret against npm's masked token list (`npm_abcd...wxyz`). */
function tokenMatches(fullToken, entry) {
  const masked = typeof entry?.token === 'string' ? entry.token : ''
  if (masked === '') return false
  if (masked === fullToken) return true
  const marker = masked.indexOf('...')
  if (marker <= 0) return false
  const prefix = masked.slice(0, marker)
  const suffix = masked.slice(marker + 3)
  return fullToken.startsWith(prefix) && fullToken.endsWith(suffix)
}

function tokenExpiryDate(entry) {
  if (typeof entry?.expiry !== 'string') return null
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(entry.expiry)
  return match === null ? null : match[1]
}

export class ShipDeck {
  constructor(options) {
    this.version = options.version ?? '1.1.9'
    this.network = options.network
    this.store = options.store ?? new ShipDeckStore({ authFile: options.config?.authFile })
    this.config = options.config ?? {}
    this.cache = new Map()
    this.network.configure({
      proxy: typeof this.config.proxy === 'string' ? this.config.proxy : 'auto',
      noProxy: this.config.noProxy,
    })
  }

  // ── settings resolution ────────────────────────────────────────────────

  get prefs() {
    return this.store.readPrefs()
  }

  get npmRegistry() {
    return normalizeRegistryUrl(
      this.prefs.npmRegistry || this.config.npmRegistry,
      NPM_REGISTRY,
    )
  }

  get githubRegistry() {
    return normalizeRegistryUrl(
      this.prefs.githubRegistry || this.config.githubRegistry,
      GITHUB_REGISTRY,
    )
  }

  get githubApiBase() {
    const value = typeof this.config.githubApiBase === 'string' && this.config.githubApiBase.trim() !== ''
      ? this.config.githubApiBase.trim()
      : 'https://api.github.com'
    return value.replace(/\/+$/, '')
  }

  get limits() {
    const maxFiles = Number(this.config.maxFiles)
    const maxPackageBytes = Number(this.config.maxPackageBytes)
    return {
      maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : undefined,
      maxFileBytes: Number(this.config.maxFileBytes) > 0 ? Number(this.config.maxFileBytes) : undefined,
      maxTotalBytes: Number.isFinite(maxPackageBytes) && maxPackageBytes > 0 ? maxPackageBytes : undefined,
    }
  }

  cacheGet(key) {
    const entry = this.cache.get(key)
    if (entry === undefined) return null
    if (Date.now() - entry.at > CACHE_TTL_MS) {
      this.cache.delete(key)
      return null
    }
    return entry.value
  }

  cacheSet(key, value) {
    this.cache.set(key, { at: Date.now(), value })
    return value
  }

  /** Newest cached `packages:<token>:<kind>` entry, whatever the token suffix. */
  cachedPackages() {
    let newest = null
    let newestAt = 0
    for (const [key, entry] of this.cache.entries()) {
      if (!key.startsWith('packages')) continue
      if (Date.now() - entry.at > CACHE_TTL_MS) continue
      if (entry.at >= newestAt) {
        newest = entry.value
        newestAt = entry.at
      }
    }
    return newest
  }

  invalidate(prefix) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key)
    }
  }

  // ── public status ──────────────────────────────────────────────────────

  npmPublicStatus() {
    const auth = this.store.npm
    if (auth === null || typeof auth.token !== 'string') {
      return {
        connected: false,
        registry: this.npmRegistry,
        username: null,
        connectedAt: null,
        lastVerifiedAt: null,
        kind: null,
      }
    }
    return {
      connected: true,
      registry: auth.registry ?? this.npmRegistry,
      username: auth.username ?? null,
      email: auth.email ?? null,
      connectedAt: auth.connectedAt ?? null,
      lastVerifiedAt: auth.lastVerifiedAt ?? null,
      kind: auth.kind ?? 'token',
      expiresAt: auth.expiresAt ?? null,
      expiresInDays: daysUntil(auth.expiresAt),
      bypass2fa: auth.bypass2fa === true,
      tokenName: auth.tokenName ?? null,
      tokenPermissions: Array.isArray(auth.tokenPermissions) ? auth.tokenPermissions : [],
      tokenScopes: Array.isArray(auth.tokenScopes) ? auth.tokenScopes : [],
    }
  }

  githubPublicStatus() {
    const auth = this.store.github
    if (auth === null || typeof auth.token !== 'string') {
      return {
        connected: false,
        login: null,
        name: null,
        avatarUrl: null,
        scopes: [],
        kind: null,
        connectedAt: null,
        lastVerifiedAt: null,
        clientId: this.store.rememberedClientId,
      }
    }
    return {
      connected: true,
      login: auth.login ?? null,
      name: auth.name ?? null,
      avatarUrl: auth.avatarUrl ?? null,
      htmlUrl: auth.htmlUrl ?? (auth.login ? `https://github.com/${auth.login}` : null),
      publicRepos: auth.publicRepos ?? null,
      scopes: Array.isArray(auth.scopes) ? auth.scopes : [],
      kind: auth.kind ?? null,
      connectedAt: auth.connectedAt ?? null,
      lastVerifiedAt: auth.lastVerifiedAt ?? null,
      clientId: auth.clientId ?? this.store.rememberedClientId,
    }
  }

  history(limit = 20) {
    const records = this.store.readHistory().records
    const size = Math.min(Math.max(Number(limit) || 20, 1), 100)
    return records.slice(0, size)
  }

  /** Same records, compacted for tool output and the panel list. */
  historySummary(limit = 10) {
    return this.history(limit).map(summarizeRecord)
  }

  recentProjects(records) {
    const seen = new Map()
    for (const record of records) {
      if (typeof record.package !== 'string' || seen.has(record.package)) continue
      seen.set(record.package, {
        name: record.package,
        version: record.version ?? null,
        dir: record.dir ?? '',
        at: record.at ?? null,
        ok: record.ok === true,
        targets: Array.isArray(record.targets) ? record.targets.map((target) => target.target) : [],
      })
      if (seen.size >= 6) break
    }
    return [...seen.values()]
  }

  /**
   * Compact state for an agent: identities, counts and preferences only.
   * Publish history is intentionally excluded — `release_status` already
   * returns it separately, and inlining it here duplicated ~8k chars and blew
   * past the tool-output limit.
   */
  status() {
    const records = this.store.readHistory().records
    const packagesCache = this.cachedPackages()
    return {
      ok: true,
      at: nowIso(),
      version: this.version,
      npm: this.npmPublicStatus(),
      github: this.githubPublicStatus(),
      counts: {
        npmPackages: packagesCache !== null && Array.isArray(packagesCache.items) ? packagesCache.items.length : null,
        history: records.length,
        githubReleases: records.filter((record) => Array.isArray(record.targets)
          && record.targets.some((target) => target.target === 'github-release' && target.ok === true)).length,
        npmPublishes: records.filter((record) => Array.isArray(record.targets)
          && record.targets.some((target) => target.target === 'npm' && target.ok === true)).length,
      },
      lastRecord: summarizeRecord(records[0]),
      prefs: { ...this.prefs },
      storage: this.store.describe(),
      authCorrupt: this.store.authCorrupt === true,
      registries: {
        npm: this.npmRegistry,
        github: this.githubRegistry,
        githubApi: this.githubApiBase,
      },
      targets: TARGETS,
    }
  }

  /** Panel state: `status()` plus the recent-publish previews the UI renders. */
  panelStatus() {
    const records = this.store.readHistory().records
    return {
      ...this.status(),
      recentHistory: records.slice(0, 8).map(summarizeRecord),
      recentProjects: this.recentProjects(records),
    }
  }

  // ── npm account ────────────────────────────────────────────────────────

  requireNpm() {
    const auth = this.store.npm
    if (auth === null || typeof auth.token !== 'string' || auth.token === '') {
      throw new ShipDeckError('npm 尚未登录。请在「发布仓 → 设置 → npm 账号」粘贴 Access Token 并验证。', {
        code: 'ENOTCONNECTED',
        hint: '在 npmjs.com → Access Tokens 创建 Granular Access Token（勾选 Read and write）。',
      })
    }
    return auth
  }

  requireGitHub() {
    const auth = this.store.github
    if (auth === null || typeof auth.token !== 'string' || auth.token === '') {
      throw new ShipDeckError('GitHub 尚未连接。请在「发布仓 → 设置 → GitHub 账号」用设备流或 PAT 登录。', {
        code: 'ENOTCONNECTED',
        hint: '设备流需要一个 GitHub OAuth App 的 Client ID（无需回调地址）。',
      })
    }
    return auth
  }

  npmClient(otp, auth = this.requireNpm()) {
    return new NpmRegistry({
      network: this.network,
      registry: auth.registry || this.npmRegistry,
      token: auth.token,
      otp: otp ?? null,
    })
  }

  /** Anonymous registry access: reads work before the user signs in. */
  npmClientOptional(otp) {
    const auth = this.store.npm
    return new NpmRegistry({
      network: this.network,
      registry: auth?.registry || this.npmRegistry,
      token: auth?.token ?? null,
      otp: otp ?? null,
    })
  }

  githubClient(auth = this.requireGitHub()) {
    return new GitHubClient({
      network: this.network,
      token: auth.token,
      apiBase: this.githubApiBase,
      uploadsBase: typeof this.config.githubUploadsBase === 'string' && this.config.githubUploadsBase.trim() !== ''
        ? this.config.githubUploadsBase.trim()
        : 'https://uploads.github.com',
    })
  }

  async npmTokenMetadata(client, fullToken) {
    try {
      const tokens = await client.tokenInfo()
      const match = tokens.find((entry) => tokenMatches(fullToken, entry))
      if (match === undefined) return null
      return {
        expiresAt: tokenExpiryDate(match),
        bypass2fa: match.bypass2fa === true,
        tokenName: match.name === '' ? null : match.name,
        permissions: match.permissions,
        scopes: match.scopes,
      }
    } catch {
      // Token listing is account-level and can be blocked by npm; manual expiry remains available.
      return null
    }
  }

  async connectNpm(input) {
    const token = cleanToken(input?.token)
    if (token.length < 10 || token.length > 500) {
      throw new ShipDeckError('请填写有效的 npm Access Token', { code: 'EINVALIDTOKEN' })
    }
    const requestedRegistry = typeof input?.registry === 'string' && input.registry.trim() !== ''
      ? input.registry
      : this.prefs.npmRegistry || this.config.npmRegistry
    const registry = normalizeRegistryUrl(requestedRegistry, NPM_REGISTRY)
    const client = new NpmRegistry({ network: this.network, registry, token })
    const who = await client.whoami()
    const meta = await this.npmTokenMetadata(client, token)
    const at = nowIso()
    this.store.setNpm({
      token,
      username: who.username,
      email: who.email,
      registry,
      kind: 'token',
      connectedAt: at,
      lastVerifiedAt: at,
      expiresAt: meta?.expiresAt ?? normalizeExpiryDate(input?.expiresAt),
      bypass2fa: meta?.bypass2fa === true,
      tokenName: meta?.tokenName ?? null,
      tokenPermissions: meta?.permissions ?? [],
      tokenScopes: meta?.scopes ?? [],
    })
    this.invalidate('packages')
    this.invalidate('npm:')
    return { ok: true, verified: true, npm: this.npmPublicStatus() }
  }

  async refreshNpmTokenInfo() {
    const auth = this.requireNpm()
    const client = this.npmClient(null, auth)
    const meta = await this.npmTokenMetadata(client, auth.token)
    if (meta === null) {
      return { ok: true, matched: false, npm: this.npmPublicStatus() }
    }
    this.store.setNpm({
      ...auth,
      expiresAt: meta.expiresAt ?? auth.expiresAt,
      bypass2fa: meta.bypass2fa,
      tokenName: meta.tokenName,
      tokenPermissions: meta.permissions,
      tokenScopes: meta.scopes,
    })
    return { ok: true, matched: true, npm: this.npmPublicStatus() }
  }

  async verifyNpm() {
    const auth = this.store.npm
    if (auth === null) return { ok: true, npm: this.npmPublicStatus(), verified: false }
    try {
      const client = this.npmClient(null, auth)
      const who = await client.whoami()
      const meta = await this.npmTokenMetadata(client, auth.token)
      const at = nowIso()
      this.store.setNpm({
        ...auth,
        username: who.username,
        email: who.email ?? auth.email ?? null,
        lastVerifiedAt: at,
        ...(meta === null
          ? {}
          : {
              expiresAt: meta.expiresAt ?? auth.expiresAt,
              bypass2fa: meta.bypass2fa,
              tokenName: meta.tokenName,
              tokenPermissions: meta.permissions,
              tokenScopes: meta.scopes,
            }),
      })
      return { ok: true, verified: true, npm: this.npmPublicStatus() }
    } catch (error) {
      const serialized = serializeError(error)
      if (serialized.status === 401) {
        this.store.setNpm(null)
        this.invalidate('packages')
        this.invalidate('npm:')
        return { ok: true, verified: false, invalidated: true, npm: this.npmPublicStatus(), error: serialized }
      }
      return { ok: true, verified: false, npm: this.npmPublicStatus(), error: serialized }
    }
  }

  disconnectNpm() {
    this.store.setNpm(null)
    this.invalidate('packages')
    this.invalidate('npm:')
    return { ok: true, npm: this.npmPublicStatus() }
  }

  setNpmTokenMeta(input) {
    const auth = this.requireNpm()
    const expiresAt = normalizeExpiryDate(input?.expiresAt)
    this.store.setNpm({ ...auth, expiresAt })
    return { ok: true, npm: this.npmPublicStatus() }
  }

  /** Packages the account can manage, with enough detail for the list. */
  async npmPackages(input = {}) {
    const auth = this.requireNpm()
    const refresh = input.refresh === true
    // The cached value is already sliced to `limit`, so different limits must
    // not share an entry (the panel asks for 60, the tool for anything ≤100).
    const limit = Math.min(Number(input.limit) || 60, 100)
    const cacheKey = `packages:${auth.token.slice(-8)}:${auth.bypass2fa === true ? 'bypass' : 'plain'}:${limit}`
    if (!refresh) {
      const cached = this.cacheGet(cacheKey)
      if (cached !== null) return { ok: true, ...cached, cached: true }
    }
    const client = this.npmClient(null, auth)
    let entries = []
    let source = 'access'
    const warnings = []
    try {
      const owned = await client.listOwned(auth.username ?? '')
      entries = owned.entries
    } catch (error) {
      const serialized = serializeError(error)
      // Trust the stored token metadata, not the error text: npm answers a
      // generic "You may not perform that action with these credentials" for
      // every granular token here, bypass or not.
      const bypass = auth.bypass2fa === true
      warnings.push(bypass
        ? '当前 Token 勾选了 Bypass 2FA，npm 不允许它读取完整账号包列表；已改用公开搜索。私有包不会显示。'
        : 'Granular Access Token 不支持 npm 的「账号包列表」接口（npm 只对网页会话开放）；已改用公开搜索。公开包的发布与管理不受影响，私有包可用「详情」按包名直接查看。')
      if (serialized.code === 'ENETWORK') {
        warnings.push(`读取账号包列表时网络异常：${serialized.message}`)
      }
      try {
        const searched = await client.search(`maintainer:${auth.username ?? ''}`, { size: 100 })
        entries = searched.items.map((item) => ({ name: item.name, permission: 'write' }))
        source = 'search'
      } catch (second) {
        throw second
      }
    }
    entries.sort((a, b) => (a.permission === b.permission ? a.name.localeCompare(b.name) : a.permission === 'write' ? -1 : 1))
    const selected = entries.slice(0, limit)
    if (input.details === false) {
      return {
        ok: true,
        items: selected.map((entry) => ({ name: entry.name, permission: entry.permission })),
        source,
        warnings,
        truncated: entries.length > selected.length,
        total: entries.length,
        at: nowIso(),
        details: false,
      }
    }
    const items = new Array(selected.length)
    let cursor = 0
    const workers = Array.from({ length: Math.min(6, selected.length) }, async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= selected.length) return
        const entry = selected[index]
        try {
          const info = await client.packageInfo(entry.name)
          items[index] = {
            name: entry.name,
            permission: entry.permission,
            version: info.latest,
            description: shortText(info.description, 240),
            modified: info.modified ?? null,
            distTags: info.distTags,
            license: info.license,
            repository: info.repository,
            deprecatedLatest: info.versions.find((version) => version.version === info.latest)?.deprecated ?? null,
          }
        } catch (error) {
          items[index] = {
            name: entry.name,
            permission: entry.permission,
            version: null,
            description: '',
            error: serializeError(error).message,
          }
        }
      }
    })
    await Promise.all(workers)
    const value = {
      items: items.filter((item) => item !== undefined),
      source,
      warnings,
      truncated: entries.length > selected.length,
      total: entries.length,
      at: nowIso(),
    }
    this.cacheSet(cacheKey, value)
    return { ok: true, ...value, cached: false }
  }

  async npmInfo(input) {
    const name = String(input?.name ?? '').trim()
    if (!isValidPackageName(name)) throw new ShipDeckError(`不是合法的包名：${name}`, { code: 'ENAME' })
    const client = this.npmClientOptional(assertOtp(input?.otp))
    const info = await client.packageInfo(name)
    const requestedVersion = typeof input?.version === 'string' && input.version.trim() !== ''
      ? input.version.trim()
      : null
    if (requestedVersion !== null) {
      const selected = info.versions.find((version) => version.version === requestedVersion)
      if (selected === undefined) {
        throw new ShipDeckError(`${name} 不存在版本 ${requestedVersion}`, { code: 'ENOVERSION' })
      }
      return { ok: true, ...info, requestedVersion, requested: selected }
    }
    return { ok: true, ...info }
  }

  async npmSearch(input) {
    const query = String(input?.query ?? '').trim()
    if (query === '') throw new ShipDeckError('请输入搜索关键词', { code: 'EQUERY' })
    const client = new NpmRegistry({ network: this.network, registry: this.npmRegistry })
    return { ok: true, ...(await client.search(query, { size: input?.limit ?? 25 })) }
  }

  async npmDistTags(input) {
    const name = String(input?.name ?? '').trim()
    if (!isValidPackageName(name)) throw new ShipDeckError(`不是合法的包名：${name}`, { code: 'ENAME' })
    const client = this.npmClientOptional(null)
    return { ok: true, name, tags: await client.distTags(name) }
  }

  npmInstallCommand(input) {
    const name = String(input?.name ?? '').trim()
    if (!isValidPackageName(name)) throw new ShipDeckError(`不是合法的包名：${name}`, { code: 'ENAME' })
    const client = this.npmClientOptional(null)
    return { ok: true, name, command: client.installCommand(name, input?.version) }
  }

  async npmSetTag(input) {
    const client = this.npmClient(assertOtp(input?.otp))
    const name = String(input?.name ?? '')
    const tag = String(input?.tag ?? '')
    const version = String(input?.version ?? '')
    const result = await client.setDistTag(name, tag, version)
    this.invalidate('npm:')
    this.invalidate('packages')
    return { ok: true, ...result }
  }

  async npmDeleteTag(input) {
    const client = this.npmClient(assertOtp(input?.otp))
    const result = await client.deleteDistTag(String(input?.name ?? ''), String(input?.tag ?? ''))
    this.invalidate('npm:')
    this.invalidate('packages')
    return { ok: true, ...result }
  }

  async npmDeprecate(input) {
    const name = String(input?.name ?? '')
    const range = String(input?.range ?? '*')
    const message = String(input?.message ?? '')
    const client = this.npmClient(assertOtp(input?.otp))
    const result = await client.deprecate(name, range, message)
    this.invalidate('npm:')
    this.invalidate('packages')
    return { ok: true, ...result }
  }

  async npmSetAccess(input) {
    const name = String(input?.name ?? '')
    // npm's API calls it "restricted"; accept "private" as a friendly alias.
    const access = input?.access === 'private' || input?.access === 'restricted' ? 'restricted' : 'public'
    const client = this.npmClient(assertOtp(input?.otp))
    const result = await client.setAccess(name, access)
    this.invalidate('npm:')
    this.invalidate('packages')
    return { ok: true, ...result }
  }

  async npmOwners(input) {
    const name = String(input?.name ?? '')
    if (!isValidPackageName(name)) throw new ShipDeckError(`不是合法的包名：${name}`, { code: 'ENAME' })
    const maintainers = await this.npmClientOptional(null).owners(name)
    return { ok: true, name, maintainers }
  }

  async npmChangeOwner(input) {
    const name = String(input?.name ?? '')
    const user = String(input?.user ?? '').trim()
    const action = input?.action === 'remove' || input?.action === 'rm' ? 'remove' : 'add'
    const client = this.npmClient(assertOtp(input?.otp))
    const result = await client.changeOwner(name, user, action)
    this.invalidate('npm:')
    this.invalidate('packages')
    return { ok: true, ...result }
  }

  async npmUnpublish(input) {
    const name = String(input?.name ?? '')
    const version = input?.version === undefined || input?.version === null ? '' : String(input.version).trim()
    if (input?.force !== true) {
      throw new ShipDeckError('删除包或版本属于不可逆操作，需要显式传入 force: true 确认。', { code: 'ECONFIRM' })
    }
    const wholeRequested = version === '' || version === '*'
    if (wholeRequested && input?.confirmName !== name) {
      throw new ShipDeckError('删除整个包需要 confirmName 与包名完全一致，以防误操作。', { code: 'ECONFIRM' })
    }
    // A real OTP lets a non-bypass granular token perform governance actions;
    // without one npm answers 401/403 and the error mapping explains why.
    const client = this.npmClient(assertOtp(input?.otp))
    const result = await client.unpublish(name, version, { confirmWhole: input?.confirmName === name })
    this.invalidate('npm:')
    this.invalidate('packages')
    return { ok: true, ...result }
  }

  // ── GitHub account ─────────────────────────────────────────────────────

  async githubDeviceStart(input) {
    const clientId = String(input?.clientId ?? '').trim()
    if (!/^[A-Za-z0-9._-]{10,64}$/.test(clientId)) {
      throw new ShipDeckError('Client ID 格式不正确：应填写 GitHub OAuth App 的 Client ID（20 位左右）', {
        code: 'EINVALIDCLIENT',
      })
    }
    const scopes = String(input?.scopes ?? 'repo workflow read:org write:packages').trim().slice(0, 200)
    if (scopes !== '' && !/^[a-z0-9:,_\- ]+$/i.test(scopes)) {
      throw new ShipDeckError('scopes 格式不正确（只用空格分隔的小写作用域名）', { code: 'EINVALIDSCOPES' })
    }
    const device = await GitHubClient.deviceStart(clientId, scopes, this.network)
    this.store.rememberedClientId = clientId
    return { ok: true, ...device, clientId }
  }

  async githubDevicePoll(input) {
    const clientId = String(input?.clientId ?? '').trim()
    const deviceCode = String(input?.deviceCode ?? '')
    if (clientId === '' || deviceCode === '') {
      throw new ShipDeckError('缺少设备流参数，请重新开始连接', { code: 'EINVALIDDEVICE' })
    }
    const result = await GitHubClient.devicePoll(clientId, deviceCode, this.network)
    if (result.status === 'authorized') {
      const at = nowIso()
      this.store.setGitHub({
        token: result.token,
        login: result.user.login,
        name: result.user.name ?? null,
        avatarUrl: result.user.avatarUrl ?? null,
        htmlUrl: result.user.htmlUrl ?? null,
        publicRepos: result.user.publicRepos ?? null,
        scopes: result.user.scopes ?? [],
        kind: 'oauth',
        clientId,
        connectedAt: at,
        lastVerifiedAt: at,
      })
      this.invalidate('repos')
      this.invalidate('github:')
      return { ok: true, status: 'authorized', github: this.githubPublicStatus() }
    }
    return { ok: true, ...result }
  }

  async githubConnectPat(input) {
    const token = cleanToken(input?.token)
    if (token.length < 10 || token.length > 500) {
      throw new ShipDeckError('请填写有效的 GitHub Token', { code: 'EINVALIDTOKEN' })
    }
    const client = new GitHubClient({ network: this.network, token, apiBase: this.githubApiBase })
    const user = await client.whoami()
    const at = nowIso()
    this.store.setGitHub({
      token,
      login: user.login,
      name: user.name ?? null,
      avatarUrl: user.avatarUrl ?? null,
      htmlUrl: user.htmlUrl ?? null,
      publicRepos: user.publicRepos ?? null,
      scopes: user.scopes ?? [],
      kind: 'pat',
      clientId: this.store.rememberedClientId,
      connectedAt: at,
      lastVerifiedAt: at,
    })
    this.invalidate('repos')
    this.invalidate('github:')
    return { ok: true, verified: true, github: this.githubPublicStatus() }
  }

  async verifyGitHub() {
    const auth = this.store.github
    if (auth === null) return { ok: true, verified: false, github: this.githubPublicStatus() }
    try {
      const user = await this.githubClient(auth).whoami()
      const at = nowIso()
      this.store.setGitHub({
        ...auth,
        login: user.login,
        name: user.name ?? auth.name ?? null,
        avatarUrl: user.avatarUrl ?? auth.avatarUrl ?? null,
        htmlUrl: user.htmlUrl ?? auth.htmlUrl ?? null,
        publicRepos: user.publicRepos ?? auth.publicRepos ?? null,
        scopes: user.scopes.length > 0 ? user.scopes : auth.scopes ?? [],
        lastVerifiedAt: at,
      })
      return { ok: true, verified: true, github: this.githubPublicStatus() }
    } catch (error) {
      const serialized = serializeError(error)
      if (serialized.status === 401) {
        this.store.setGitHub(null)
        this.invalidate('repos')
        this.invalidate('github:')
        return { ok: true, verified: false, invalidated: true, github: this.githubPublicStatus(), error: serialized }
      }
      return { ok: true, verified: false, github: this.githubPublicStatus(), error: serialized }
    }
  }

  disconnectGitHub() {
    const clientId = this.store.rememberedClientId
    this.store.setGitHub(null)
    this.invalidate('repos')
    this.invalidate('github:')
    return { ok: true, github: this.githubPublicStatus(), rememberedClientId: clientId }
  }

  async githubRepos(input = {}) {
    const auth = this.requireGitHub()
    const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 100)
    const cacheKey = `repos:${limit}`
    if (input.refresh !== true) {
      const cached = this.cacheGet(cacheKey)
      if (cached !== null) return { ok: true, items: cached, cached: true }
    }
    const client = this.githubClient(auth)
    const items = await client.listRepos({ perPage: limit })
    this.cacheSet(cacheKey, items)
    return { ok: true, items, cached: false }
  }

  async githubReleases(input) {
    const owner = this.resolveOwner(input)
    const repo = String(input?.repo ?? '').trim()
    const client = this.githubClient()
    const items = await client.listReleases(owner, repo, { perPage: input?.limit ?? 30 })
    return { ok: true, items }
  }

  async githubCreateRepo(input) {
    const client = this.githubClient()
    const repo = await client.createRepo({
      name: String(input?.name ?? '').trim(),
      private: input?.private !== false,
      description: typeof input?.description === 'string' ? input.description : '',
      org: typeof input?.org === 'string' && input.org.trim() !== '' ? input.org.trim() : '',
    })
    this.invalidate('repos')
    return { ok: true, repo }
  }

  /**
   * Resolve the GitHub owner: explicit input wins, otherwise fall back to the
   * connected account. The tool schema promises this default, and the panel
   * always sends an owner, so only agent calls rely on it.
   */
  resolveOwner(input) {
    const explicit = String(input?.owner ?? '').trim()
    if (explicit !== '') return explicit
    const login = this.store.github?.login
    if (typeof login === 'string' && login !== '') return login
    throw new ShipDeckError('缺少 owner：GitHub 尚未连接，无法推断仓库所有者。', {
      code: 'EINVALIDOWNER',
      hint: '请在面板顶部连接 GitHub，或显式传入 owner。',
    })
  }

  async githubPush(input) {
    const client = this.githubClient()
    if (input?.dryRun === true) {
      return client.previewPush({
        owner: this.resolveOwner(input),
        repo: String(input?.repo ?? '').trim(),
        branch: typeof input?.branch === 'string' ? input.branch : '',
        dir: String(input?.dir ?? ''),
        syncMode: input?.syncMode === 'merge' ? 'merge' : 'replace',
        maxFiles: this.limits.maxFiles,
        maxTotalBytes: this.config.maxGitBytes,
      })
    }
    const result = await client.pushDirectory({
      owner: this.resolveOwner(input),
      repo: String(input?.repo ?? '').trim(),
      branch: typeof input?.branch === 'string' ? input.branch : '',
      dir: String(input?.dir ?? ''),
      message: typeof input?.message === 'string' ? input.message : '',
      create: input?.create === true,
      private: input?.private !== false,
      description: typeof input?.description === 'string' ? input.description : '',
      syncMode: input?.syncMode === 'merge' ? 'merge' : 'replace',
      maxFiles: this.limits.maxFiles,
      maxTotalBytes: this.config.maxGitBytes,
    })
    this.invalidate('repos')
    return result
  }

  async githubRelease(input) {
    const client = this.githubClient()
    const owner = this.resolveOwner(input)
    const repo = String(input?.repo ?? '').trim()
    const tag = String(input?.tag ?? '').trim()
    const release = await client.createRelease(owner, repo, {
      tag,
      target: typeof input?.target === 'string' ? input.target : undefined,
      name: typeof input?.name === 'string' ? input.name : undefined,
      body: typeof input?.body === 'string' ? input.body : '',
      draft: input?.draft === true,
      prerelease: input?.prerelease === true,
      generateNotes: input?.generateNotes === true,
    })
    let asset = null
    if (release.id !== null) {
      if (typeof input?.assetPath === 'string' && input.assetPath.trim() !== '') {
        const file = await readAssetFile(input.assetPath.trim())
        asset = await client.uploadAsset(owner, repo, release.id, file)
      } else if (typeof input?.assetDir === 'string' && input.assetDir.trim() !== '') {
        const pack = await packProject(input.assetDir.trim(), { limits: this.limits })
        const safeName = releaseAssetName(pack)
        asset = await client.uploadAsset(owner, repo, release.id, {
          name: safeName,
          data: pack.tarball,
          contentType: 'application/gzip',
        })
      }
    }
    return { ok: true, release, asset }
  }

  async githubDeleteRepo(input) {
    if (input?.force !== true) {
      throw new ShipDeckError('删除仓库属于不可逆操作，需要显式传入 force: true 确认。', { code: 'ECONFIRM' })
    }
    const owner = this.resolveOwner(input)
    const repo = String(input?.repo ?? '').trim()
    if (repo === '') throw new ShipDeckError('缺少 repo', { code: 'EINVALIDREPO' })
    const expected = `${owner}/${repo}`
    if (String(input?.confirmName ?? '').trim() !== expected) {
      throw new ShipDeckError(`删除仓库需要 confirmName 与 ${expected} 完全一致。`, { code: 'ECONFIRM' })
    }
    const client = this.githubClient()
    const result = await client.deleteRepo(owner, repo)
    this.invalidate('repos')
    this.invalidate('github:')
    return { ok: true, ...result }
  }

  async githubDeleteRelease(input) {
    if (input?.force !== true) {
      throw new ShipDeckError('删除 Release 属于不可逆操作，需要显式传入 force: true 确认。', { code: 'ECONFIRM' })
    }
    if (input?.deleteTag === true && (typeof input?.tag !== 'string' || input.tag.trim() === '')) {
      throw new ShipDeckError('同时删除 tag 时必须提供 tag 名称。', { code: 'EINVALIDTAG' })
    }
    const client = this.githubClient()
    const owner = this.resolveOwner(input)
    const repo = String(input?.repo ?? '').trim()
    if (repo === '') throw new ShipDeckError('缺少 repo', { code: 'EINVALIDREPO' })
    const releaseId = Number(input?.releaseId ?? input?.id)
    const result = await client.deleteRelease(owner, repo, releaseId)
    if (input?.deleteTag === true && typeof input?.tag === 'string' && input.tag.trim() !== '') {
      await client.deleteTag(owner, repo, input.tag.trim())
    }
    return { ok: true, ...result }
  }

  // ── project inspection ─────────────────────────────────────────────────

  async projectInspect(input) {
    const dir = String(input?.dir ?? '').trim()
    if (dir === '') throw new ShipDeckError('请填写项目目录', { code: 'EINVAL' })
    const { realpath, stat, readFile: read } = await import('node:fs/promises')
    let real
    try {
      real = await realpath(dir)
      const info = await stat(real)
      if (!info.isDirectory()) throw new Error('not a directory')
    } catch {
      throw new ShipDeckError(`目录不存在：${dir}`, { code: 'ENOENT' })
    }
    let manifest
    try {
      manifest = JSON.parse((await read(join(real, 'package.json'), 'utf8')).replace(/^\uFEFF/, ''))
    } catch (error) {
      throw new ShipDeckError(`读取 package.json 失败：${error instanceof Error ? error.message : String(error)}`, {
        code: 'EMANIFEST',
      })
    }
    const name = typeof manifest.name === 'string' ? manifest.name : ''
    const version = typeof manifest.version === 'string' ? manifest.version : ''
    const githubRepo = parseGitHubRepo(manifest.repository) ?? parseGitHubRepo(manifest.repository?.url)
    const unspecified = []
    if (!isValidPackageName(name)) unspecified.push('name 不是合法 npm 包名')
    if (!isValidVersion(version)) unspecified.push('version 不是合法 SemVer')
    if (manifest.private === true) unspecified.push('private: true 会阻止 npm 发布')
    return {
      ok: true,
      dir: real,
      manifest: {
        name,
        version,
        description: typeof manifest.description === 'string' ? manifest.description : '',
        private: manifest.private === true,
        license: typeof manifest.license === 'string' ? manifest.license : '',
        main: typeof manifest.main === 'string' ? manifest.main : '',
        filesField: Array.isArray(manifest.files) ? manifest.files : null,
        repository: typeof manifest.repository === 'object' ? manifest.repository?.url ?? null : manifest.repository ?? null,
        scripts: manifest.scripts !== null && typeof manifest.scripts === 'object' ? Object.keys(manifest.scripts) : [],
      },
      packageName: name,
      version,
      githubRepo,
      suggestedRepoName: repoNameFromPackage(name),
      problems: unspecified,
      prefs: { ...this.prefs },
    }
  }

  async projectPreview(input) {
    const pack = await packProject(String(input?.dir ?? ''), { limits: this.limits })
    return {
      ok: true,
      dir: pack.dir,
      name: pack.name,
      version: pack.version,
      description: shortText(pack.description, 300),
      fileCount: pack.fileCount,
      files: pack.files.slice(0, 500),
      filesTruncated: pack.fileCount > 500,
      packedSize: pack.packedSize,
      unpackedSize: pack.unpackedSize,
      integrity: pack.integrity,
      shasum: pack.shasum,
      tarballName: pack.tarballName,
      warnings: pack.warnings,
      githubRepo: pack.githubRepo,
      suggestedRepoName: repoNameFromPackage(pack.name),
      private: pack.private,
    }
  }

  // ── publish pipeline ───────────────────────────────────────────────────

  async publish(input) {
    const started = Date.now()
    const dir = String(input?.dir ?? '').trim()
    const pack = await packProject(dir, { limits: this.limits })
    const targets = normalizeTargets(input?.targets, this.prefs.defaultTargets?.length ? this.prefs.defaultTargets : ['npm'])
    const dryRun = input?.dryRun === true
    const otp = assertOtp(input?.otp)
    const access = input?.access === 'restricted' || (input?.access === undefined && this.prefs.access === 'restricted')
      ? 'restricted'
      : 'public'
    const tag = typeof input?.tag === 'string' && input.tag.trim() !== '' ? input.tag.trim() : this.prefs.tag || 'latest'
    // Validate up front: the real publish path rejects a bad tag, so the
    // preflight must too, otherwise a green preflight hides a certain failure.
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(tag)) {
      throw new ShipDeckError(`不是合法的 dist-tag：${tag}`, {
        code: 'ETAGINVALID',
        hint: 'tag 必须以字母开头，只含字母、数字、点、下划线或连字符，最长 32 位。',
      })
    }
    const githubOptions = input?.github !== null && typeof input?.github === 'object' ? input.github : {}
    const results = []
    const warnings = [...pack.warnings]
    // Release notes embed the npm install line only when npm actually published,
    // which is only knowable after the npm target ran. Always run the GitHub
    // release last so caller-supplied ordering cannot drop that section.
    const orderedTargets = [
      ...targets.filter((item) => item !== 'github-release'),
      ...targets.filter((item) => item === 'github-release'),
    ]

    for (const target of orderedTargets) {
      const targetStarted = Date.now()
      try {
        if (target === 'npm') {
          const auth = this.requireNpm()
          const registry = new NpmRegistry({
            network: this.network,
            registry: auth.registry || this.npmRegistry,
            token: auth.token,
            otp,
          })
          if (dryRun) {
            // Mirror the guards NpmRegistry.publish enforces, so a green
            // preflight cannot hide a publish that is certain to fail: the
            // panel blocks publishing on any failed preflight target.
            const { scope } = splitPackageName(pack.name)
            if (access === 'restricted' && scope === null) {
              results.push({
                target,
                ok: false,
                dryRun: true,
                registry: registry.registry,
                name: pack.name,
                version: pack.version,
                access,
                tag,
                error: {
                  message: '不能把非 scoped 包设为 restricted；请把访问级别改为 public',
                  code: 'EUNSCOPED',
                  status: 0,
                  hint: 'npm 只允许 scoped 包（@scope/name）使用 restricted。',
                },
                durationMs: Date.now() - targetStarted,
              })
            } else {
              let existing = null
              try {
                const doc = await registry.packument(pack.name)
                const versions = Object.keys(doc.versions ?? {})
                existing = { latest: doc['dist-tags']?.latest ?? null, versionCount: versions.length, versionExists: versions.includes(pack.version) }
              } catch (error) {
                const serialized = serializeError(error)
                if (serialized.status !== 404) throw error
                existing = { latest: null, versionCount: 0, versionExists: false }
              }
              results.push({
                target,
                ok: !(existing?.versionExists === true),
                dryRun: true,
                registry: registry.registry,
                name: pack.name,
                version: pack.version,
                access,
                tag,
                existing,
                warnings: existing?.versionExists === true ? [`${pack.name}@${pack.version} 已存在，真实发布会返回 409。`] : [],
                durationMs: Date.now() - targetStarted,
              })
            }
          } else {
            const result = await registry.publish(pack, { access, tag })
            results.push({ target, ok: true, ...result, durationMs: Date.now() - targetStarted })
          }
          continue
        }

        if (target === 'github-packages') {
          const auth = this.requireGitHub()
          const { scope } = splitPackageName(pack.name)
          if (scope === null) {
            throw new ShipDeckError('GitHub Packages 只接受 scoped 包名（@owner/name）', {
              code: 'ESCOPE',
              hint: `把 package.json 的 name 改成 @${auth.login ?? 'your-login'}/${repoNameFromPackage(pack.name)} 后再发布。`,
            })
          }
          if (typeof auth.login === 'string' && scope.slice(1).toLowerCase() !== auth.login.toLowerCase()) {
            warnings.push(`包名 scope 是 ${scope}，与当前 GitHub 账号 @${auth.login} 不同；GitHub Packages 通常要求 scope 与账号或组织一致。`)
          }
          const registry = new NpmRegistry({
            network: this.network,
            registry: this.githubRegistry,
            token: auth.token,
            otp,
          })
          // GitHub Packages only supports scoped packages, which is already
          // enforced above; restricted/public is meaningless there, so pin it
          // to public and surface the user's choice as a warning instead of
          // silently publishing to a different visibility than the wizard shows.
          const ghAccess = 'public'
          if (access === 'restricted') {
            warnings.push('GitHub Packages 总是以 public 发布（该 registry 不支持 restricted）；npm 目标仍按你选择的 restricted 处理。')
          }
          if (dryRun) {
            let existing = null
            try {
              const doc = await registry.packument(pack.name)
              const versions = Object.keys(doc.versions ?? {})
              existing = { latest: doc['dist-tags']?.latest ?? null, versionCount: versions.length, versionExists: versions.includes(pack.version) }
            } catch (error) {
              const serialized = serializeError(error)
              if (serialized.status !== 404) throw error
              existing = { latest: null, versionCount: 0, versionExists: false }
            }
            results.push({
              target, ok: existing?.versionExists !== true, dryRun: true,
              registry: registry.registry,
              name: pack.name, version: pack.version, access: ghAccess, tag,
              existing,
              warnings: existing?.versionExists === true ? [`${pack.name}@${pack.version} 已存在，真实发布会返回 409。`] : [],
              durationMs: Date.now() - targetStarted,
            })
          } else {
            const result = await registry.publish(pack, { access: ghAccess, tag })
            results.push({ target, ok: true, ...result, durationMs: Date.now() - targetStarted })
          }
          continue
        }

        if (target === 'github-release') {
          const auth = this.requireGitHub()
          const fromRepo = pack.githubRepo
          const owner = String(
            githubOptions.owner
            || fromRepo?.owner
            || auth.login
            || '',
          ).trim()
          const repo = String(
            githubOptions.repo
            || fromRepo?.repo
            || repoNameFromPackage(pack.name),
          ).trim()
          if (owner === '' || repo === '') {
            throw new ShipDeckError('无法确定 GitHub owner/repo，请在发布向导里填写。', { code: 'ENOREPO' })
          }
          const client = this.githubClient(auth)
          const branch = typeof githubOptions.branch === 'string' && githubOptions.branch.trim() !== ''
            ? githubOptions.branch.trim()
            : undefined
          const releaseTag = typeof githubOptions.releaseTag === 'string' && githubOptions.releaseTag.trim() !== ''
            ? githubOptions.releaseTag.trim()
            : `v${pack.version}`
          const releaseName = typeof githubOptions.releaseName === 'string' && githubOptions.releaseName.trim() !== ''
            ? githubOptions.releaseName.trim()
            : `${pack.name} v${pack.version}`
          const npmResult = results.find((item) => item.target === 'npm')
          const npmAvailable = targets.includes('npm') && npmResult?.ok === true
          const releaseBody = typeof githubOptions.body === 'string' && githubOptions.body.trim() !== ''
            ? githubOptions.body
            : defaultReleaseBody(pack, targets, await readChangelogSection(pack.dir, pack.version), npmAvailable)

          if (dryRun) {
            const existing = await client.getRepo(owner, repo)
            results.push({
              target,
              ok: existing !== null || githubOptions.create === true,
              dryRun: true,
              owner, repo, branch: branch ?? existing?.default_branch ?? 'main',
              releaseTag, create: existing === null,
              repoExists: existing !== null,
              warnings: existing === null
                ? [`仓库 ${owner}/${repo} 不存在；真实发布会${githubOptions.create === true ? '自动创建' : '失败，因为未勾选自动创建'}。`]
                : [],
              durationMs: Date.now() - targetStarted,
            })
          } else {
            const push = await client.pushDirectory({
              owner,
              repo,
              branch,
              dir: pack.dir,
              message: typeof githubOptions.message === 'string' && githubOptions.message.trim() !== ''
                ? githubOptions.message.trim()
                : `Release ${pack.name} v${pack.version}`,
              create: githubOptions.create === true,
              private: githubOptions.private !== false,
              description: pack.description,
              syncMode: githubOptions.syncMode === 'merge' ? 'merge' : 'replace',
              maxFiles: this.limits.maxFiles,
              maxTotalBytes: this.config.maxGitBytes,
            })
            const release = await client.createRelease(owner, repo, {
              tag: releaseTag,
              target: push.branch,
              name: releaseName,
              body: releaseBody,
              draft: githubOptions.draft === true,
              prerelease: githubOptions.prerelease === true,
            })
            let asset = null
            if (release.id !== null && githubOptions.attachTarball !== false) {
              const safeName = releaseAssetName(pack)
              asset = await client.uploadAsset(owner, repo, release.id, {
                name: safeName,
                data: pack.tarball,
                contentType: 'application/gzip',
              })
            }
            results.push({
              target, ok: true,
              owner, repo, branch: push.branch,
              commitSha: push.commitSha,
              commitUrl: push.commitUrl,
              repoUrl: push.repoUrl,
              created: push.created,
              fileCount: push.fileCount,
              release,
              asset,
              warnings: push.warnings,
              durationMs: Date.now() - targetStarted,
            })
          }
          continue
        }

        throw new ShipDeckError(`未知发布目标：${target}`, { code: 'ETARGET' })
      } catch (error) {
        const serialized = serializeError(error)
        results.push({
          target,
          ok: false,
          error: serialized,
          durationMs: Date.now() - targetStarted,
        })
      }
    }

    const ok = results.every((result) => result.ok === true)
    const record = {
      id: `pub_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`,
      at: nowIso(),
      package: pack.name,
      version: pack.version,
      dir: pack.dir,
      access,
      tag,
      targets: results,
      ok,
      dryRun,
      actor: input?.actor === 'tool' ? 'tool' : 'ui',
      durationMs: Date.now() - started,
      tarball: { name: pack.tarballName, size: pack.packedSize, integrity: pack.integrity, fileCount: pack.fileCount },
    }
    if (!dryRun) {
      this.store.appendHistory(record)
      this.store.writePrefs({ lastDir: pack.dir })
      this.invalidate('packages')
      this.invalidate('npm:')
      if (targets.includes('github-release')) this.invalidate('repos')
    }
    return { ok, dryRun, record, warnings }
  }

  // ── preferences & diagnostics ──────────────────────────────────────────

  getPrefs() {
    return { ok: true, prefs: { ...this.prefs }, registries: {
      npm: this.npmRegistry,
      github: this.githubRegistry,
      githubApi: this.githubApiBase,
    } }
  }

  setPrefs(input) {
    const patch = {}
    if (Array.isArray(input?.defaultTargets)) patch.defaultTargets = input.defaultTargets
    if (input?.access === 'public' || input?.access === 'restricted') patch.access = input.access
    if (typeof input?.tag === 'string') {
      // Reject rather than silently drop: the store ignores invalid tags, so a
      // dropped value would report success while nothing was saved.
      if (!/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(input.tag)) {
        throw new ShipDeckError(`不是合法的 dist-tag：${input.tag}`, {
          code: 'ETAGINVALID',
          hint: 'tag 必须以字母开头，只含字母、数字、点、下划线或连字符，最长 32 位。',
        })
      }
      patch.tag = input.tag
    }
    if (typeof input?.npmRegistry === 'string') patch.npmRegistry = input.npmRegistry.trim()
    if (typeof input?.githubRegistry === 'string') patch.githubRegistry = input.githubRegistry.trim()
    if (typeof input?.lastDir === 'string') patch.lastDir = input.lastDir
    if (typeof input?.sidebarVisible === 'boolean') patch.sidebarVisible = input.sidebarVisible
    if (typeof patch.npmRegistry === 'string' && patch.npmRegistry !== '') {
      patch.npmRegistry = normalizeRegistryUrl(patch.npmRegistry, NPM_REGISTRY)
    }
    if (typeof patch.githubRegistry === 'string' && patch.githubRegistry !== '') {
      patch.githubRegistry = normalizeRegistryUrl(patch.githubRegistry, GITHUB_REGISTRY)
    }
    this.store.writePrefs(patch)
    this.invalidate('packages')
    return this.getPrefs()
  }

  clearHistory() {
    this.store.clearHistory()
    return { ok: true, history: [] }
  }

  async diagnostics(input = {}) {
    const storage = this.store.describe()
    const network = await this.network.describe()
    const auth = this.store.authFileInfo()
    const result = {
      ok: true,
      at: nowIso(),
      pluginVersion: this.version,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      dshHome: this.store.home,
      storage: { ...storage, authFileInfo: auth },
      network,
      registries: {
        npm: this.npmRegistry,
        github: this.githubRegistry,
        githubApi: this.githubApiBase,
      },
      npm: this.npmPublicStatus(),
      github: this.githubPublicStatus(),
    }
    if (input.ping === true) {
      const npmProbe = async () => {
        try {
          const started = Date.now()
          await new NpmRegistry({ network: this.network, registry: this.npmRegistry }).ping()
          return { ok: true, ms: Date.now() - started }
        } catch (error) {
          return { ok: false, error: serializeError(error).message }
        }
      }
      const githubProbe = async () => {
        try {
          const started = Date.now()
          const client = new GitHubClient({ network: this.network, apiBase: this.githubApiBase, token: null })
          await client.request('/rate_limit', { timeoutMs: 12000 })
          return { ok: true, ms: Date.now() - started }
        } catch (error) {
          return { ok: false, error: serializeError(error).message }
        }
      }
      const [npmPing, githubPing] = await Promise.all([npmProbe(), githubProbe()])
      result.ping = { npm: npmPing, github: githubPing }
    }
    return result
  }

}

export { TARGETS, USER_AGENT }