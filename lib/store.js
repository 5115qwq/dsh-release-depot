/**
 * dsh-release-depot — durable local state.
 *
 * Everything the plugin owns lives under one home-level directory, never
 * beside the package: a profile install replaces the package directory on the
 * next update, and credentials stored there would be wiped. Shape:
 *
 *   <DSH_HOME>/.dsh-release-depot/
 *     auth.json      npm + GitHub tokens (mode 0600, atomic replace)
 *     prefs.json     publish defaults chosen in the panel
 *     history.json   bounded publish history (newest first)
 *
 * Tokens never leave this file except as an Authorization header sent to the
 * registry / api.github.com. Nothing here is ever returned by a public API.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const DEFAULT_PREFS = Object.freeze({
  version: 1,
  defaultTargets: ['npm'],
  access: 'public',
  tag: 'latest',
  npmRegistry: '',
  githubRegistry: '',
  lastDir: '',
  sidebarVisible: true,
})

const DEFAULT_HISTORY = Object.freeze({ version: 1, records: [] })
const HISTORY_LIMIT = 200

/** The DSH home directory used by this installation. */
export function dshHome() {
  const raw = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return raw === '' ? join(homedir(), '.dsh') : raw
}

function readJson(file) {
  try {
    if (!existsSync(file)) return null
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    if (text.trim() === '') return null
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/** Atomic JSON write with the tightest permissions the platform supports. */
export function writeJsonPrivate(file, value) {
  const dir = dirname(file)
  ensureDir(dir)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    /* Windows: mode is advisory */
  }
  renameSync(tmp, file)
}

function removeQuietly(file) {
  try {
    if (existsSync(file)) unlinkSync(file)
  } catch {
    /* best effort */
  }
}

/** Keep only fields the plugin knows, so a hand-edited file cannot inject keys. */
function sanitizeAuth(raw) {
  if (raw === null) return {}
  const out = {}
  if (raw.npm !== null && typeof raw.npm === 'object') {
    const npm = raw.npm
    if (typeof npm.token === 'string' && npm.token !== '') {
      out.npm = {
        token: npm.token,
        username: typeof npm.username === 'string' ? npm.username : null,
        email: typeof npm.email === 'string' ? npm.email : null,
        registry: typeof npm.registry === 'string' ? npm.registry : null,
        kind: typeof npm.kind === 'string' ? npm.kind : 'token',
        connectedAt: typeof npm.connectedAt === 'string' ? npm.connectedAt : null,
        lastVerifiedAt: typeof npm.lastVerifiedAt === 'string' ? npm.lastVerifiedAt : null,
        expiresAt: typeof npm.expiresAt === 'string' ? npm.expiresAt : null,
        bypass2fa: npm.bypass2fa === true,
        tokenName: typeof npm.tokenName === 'string' ? npm.tokenName : null,
        tokenPermissions: Array.isArray(npm.tokenPermissions)
          ? npm.tokenPermissions.filter((item) => item !== null && typeof item === 'object').map((item) => ({ name: String(item.name ?? ''), action: String(item.action ?? '') }))
          : [],
        tokenScopes: Array.isArray(npm.tokenScopes)
          ? npm.tokenScopes.filter((item) => item !== null && typeof item === 'object').map((item) => ({ name: item.name ?? null, type: String(item.type ?? '') }))
          : [],
      }
    }
  }
  if (raw.github !== null && typeof raw.github === 'object') {
    const gh = raw.github
    if (typeof gh.token === 'string' && gh.token !== '') {
      out.github = {
        token: gh.token,
        login: typeof gh.login === 'string' ? gh.login : null,
        name: typeof gh.name === 'string' ? gh.name : null,
        avatarUrl: typeof gh.avatarUrl === 'string' ? gh.avatarUrl : null,
        htmlUrl: typeof gh.htmlUrl === 'string' ? gh.htmlUrl : null,
        publicRepos: Number.isFinite(Number(gh.publicRepos)) ? Number(gh.publicRepos) : null,
        scopes: Array.isArray(gh.scopes) ? gh.scopes.filter((item) => typeof item === 'string') : [],
        kind: typeof gh.kind === 'string' ? gh.kind : null,
        clientId: typeof gh.clientId === 'string' ? gh.clientId : null,
        connectedAt: typeof gh.connectedAt === 'string' ? gh.connectedAt : null,
        lastVerifiedAt: typeof gh.lastVerifiedAt === 'string' ? gh.lastVerifiedAt : null,
      }
    }
  }
  if (raw.githubClientId !== null && typeof raw.githubClientId === 'string') {
    out.githubClientId = raw.githubClientId
  }
  return out
}

export class ShipDeckStore {
  /**
   * @param {object} options
   * @param {string} [options.authFile] explicit credential path override
   * @param {string} [options.home] DSH home override (tests)
   */
  constructor(options = {}) {
    this.home = typeof options.home === 'string' && options.home !== '' ? resolve(options.home) : dshHome()
    this.dir = join(this.home, '.dsh-release-depot')
    // 0.x installations stored credentials under .dsh-ship-deck; move them
    // forward once so a package rename does not log the user out.
    const legacyDir = join(this.home, '.dsh-ship-deck')
    if (!existsSync(this.dir) && existsSync(legacyDir)) {
      try {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 })
        for (const name of ['auth.json', 'prefs.json', 'history.json']) {
          const from = join(legacyDir, name)
          if (existsSync(from)) copyFileSync(from, join(this.dir, name))
        }
        // Never leave a second copy of the token behind.
        const legacyAuth = join(legacyDir, 'auth.json')
        if (existsSync(join(this.dir, 'auth.json')) && existsSync(legacyAuth)) unlinkSync(legacyAuth)
      } catch {
        /* a failed migration leaves the old files usable */
      }
    }
    const override = typeof options.authFile === 'string' && options.authFile.trim() !== ''
      ? resolve(options.authFile.trim())
      : ''
    this.authFile = override === '' ? join(this.dir, 'auth.json') : override
    this.prefsFile = join(this.dir, 'prefs.json')
    this.historyFile = join(this.dir, 'history.json')
    this.authCache = null
    this.prefsCache = null
    this.historyCache = null
  }

  /** Public, non-secret description of where state lives. */
  describe() {
    return {
      home: this.home,
      dir: this.dir,
      authFile: this.authFile,
      authFileCustomized: this.authFile !== join(this.dir, 'auth.json'),
    }
  }

  readAuth() {
    if (this.authCache !== null) return this.authCache
    this.authCache = sanitizeAuth(readJson(this.authFile))
    return this.authCache
  }

  writeAuth(record) {
    this.authCache = sanitizeAuth(record)
    if (Object.keys(this.authCache).length === 0) {
      // Disconnected: remove the file entirely so no stale secret remains.
      removeQuietly(this.authFile)
      return
    }
    writeJsonPrivate(this.authFile, this.authCache)
  }

  get npm() {
    return this.readAuth().npm ?? null
  }

  get github() {
    return this.readAuth().github ?? null
  }

  setNpm(record) {
    const auth = this.readAuth()
    if (record === null) delete auth.npm
    else auth.npm = record
    this.writeAuth(auth)
  }

  setGitHub(record) {
    const auth = this.readAuth()
    if (record === null) delete auth.github
    else auth.github = record
    this.writeAuth(auth)
  }

  /** Remember the OAuth App Client ID (not a secret) across disconnects. */
  get rememberedClientId() {
    const id = this.readAuth().githubClientId
    return typeof id === 'string' && id !== '' ? id : null
  }

  set rememberedClientId(value) {
    const auth = this.readAuth()
    if (typeof value === 'string' && value !== '') auth.githubClientId = value
    else delete auth.githubClientId
    this.writeAuth(auth)
  }

  readPrefs() {
    if (this.prefsCache !== null) return this.prefsCache
    const raw = readJson(this.prefsFile)
    const prefs = { ...DEFAULT_PREFS }
    if (raw !== null) {
      if (Array.isArray(raw.defaultTargets)) {
        const allowed = ['npm', 'github-packages', 'github-release']
        prefs.defaultTargets = raw.defaultTargets.filter((item) => allowed.includes(item))
      }
      if (raw.access === 'public' || raw.access === 'restricted') prefs.access = raw.access
      if (typeof raw.tag === 'string' && raw.tag !== '') prefs.tag = raw.tag
      if (typeof raw.npmRegistry === 'string') prefs.npmRegistry = raw.npmRegistry
      if (typeof raw.githubRegistry === 'string') prefs.githubRegistry = raw.githubRegistry
      if (typeof raw.lastDir === 'string') prefs.lastDir = raw.lastDir
      if (typeof raw.sidebarVisible === 'boolean') prefs.sidebarVisible = raw.sidebarVisible
    }
    this.prefsCache = prefs
    return prefs
  }

  writePrefs(patch) {
    const current = this.readPrefs()
    const next = { ...current }
    if (Array.isArray(patch.defaultTargets)) {
      const allowed = ['npm', 'github-packages', 'github-release']
      next.defaultTargets = patch.defaultTargets.filter((item) => allowed.includes(item))
    }
    if (patch.access === 'public' || patch.access === 'restricted') next.access = patch.access
    if (typeof patch.tag === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(patch.tag)) next.tag = patch.tag
    if (typeof patch.npmRegistry === 'string') next.npmRegistry = patch.npmRegistry.slice(0, 300)
    if (typeof patch.githubRegistry === 'string') next.githubRegistry = patch.githubRegistry.slice(0, 300)
    if (typeof patch.lastDir === 'string') next.lastDir = patch.lastDir.slice(0, 1000)
    if (typeof patch.sidebarVisible === 'boolean') next.sidebarVisible = patch.sidebarVisible
    writeJsonPrivate(this.prefsFile, next)
    this.prefsCache = next
    return next
  }

  readHistory() {
    if (this.historyCache !== null) return this.historyCache
    const raw = readJson(this.historyFile)
    const records = raw !== null && Array.isArray(raw.records)
      ? raw.records.filter((item) => item !== null && typeof item === 'object')
      : []
    this.historyCache = { version: 1, records }
    return this.historyCache
  }

  appendHistory(record) {
    const history = this.readHistory()
    const next = {
      version: 1,
      records: [record, ...history.records].slice(0, HISTORY_LIMIT),
    }
    writeJsonPrivate(this.historyFile, next)
    this.historyCache = next
    return record
  }

  clearHistory() {
    const next = { version: 1, records: [] }
    writeJsonPrivate(this.historyFile, next)
    this.historyCache = next
    return next
  }

  /** File mode plus mtime, for the diagnostics card (never the contents). */
  authFileInfo() {
    try {
      if (!existsSync(this.authFile)) return { exists: false }
      const stat = statSync(this.authFile)
      return { exists: true, mode: (stat.mode & 0o777).toString(8), bytes: stat.size, modifiedAt: stat.mtime.toISOString() }
    } catch {
      return { exists: false }
    }
  }
}

export { HISTORY_LIMIT, DEFAULT_PREFS }