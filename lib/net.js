/**
 * dsh-release-depot — portable network layer for registry.npmjs.org,
 * api.github.com, uploads.github.com and github.com.
 *
 * Different machines reach these hosts differently: some need an HTTP proxy,
 * some sit behind a local TLS interceptor whose root CA is only in the OS
 * store. Node's built-in fetch honors neither the Windows system proxy nor,
 * without extra flags, the OS certificate store. This module resolves:
 *
 *   proxy: explicit config → HTTPS_PROXY/HTTP_PROXY/ALL_PROXY → Windows system
 *          proxy → direct (NO_PROXY honored)
 *   CA:    OS store (Windows: exported from the certificate store and cached
 *          for 30 days; macOS/Linux: standard bundle paths)
 *
 * Every step degrades gracefully: without `undici` the plain global fetch is
 * used, and a failing probe never crashes the plugin. The exporter is only
 * consulted when the first request needs a dispatcher, and the result is
 * cached for the process.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const DEFAULT_NO_PROXY = ['127.0.0.1', 'localhost', '::1']
const UNIX_CA_PATHS = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
  '/etc/pki/tls/cacert.pem',
  '/etc/ssl/cert.pem',
]
const CA_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

let undiciModulePromise = null
async function loadUndici() {
  if (undiciModulePromise === null) {
    undiciModulePromise = import('undici')
      .then((module) => (typeof module.ProxyAgent === 'function' ? module : null))
      .catch(() => null)
  }
  return undiciModulePromise
}

export function parseNoProxy(raw) {
  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw.split(/[,\s]+/).map((entry) => entry.trim()).filter((entry) => entry !== '')
  }
  if (Array.isArray(raw)) {
    return raw.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
  }
  return []
}

export function bypassesProxy(host, noProxy) {
  const normalizedHost = String(host).toLowerCase().replace(/^\[|\]$/g, '')
  for (const raw of noProxy) {
    const entry = String(raw).toLowerCase().trim()
    if (entry === '' || entry === '0.0.0.0') continue
    if (entry === '*') return true
    const bare = entry.split(':')[0]
    if (bare === normalizedHost) return true
    if (entry.startsWith('.')) {
      if (normalizedHost === entry.slice(1) || normalizedHost.endsWith(entry)) return true
    } else if (normalizedHost.endsWith(`.${bare}`)) {
      return true
    }
  }
  return false
}

export function normalizeProxyUrl(proxy) {
  if (typeof proxy !== 'string') return undefined
  const value = proxy.trim()
  if (value === '' || /^(direct|none|off)$/i.test(value)) return undefined
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`
}

export function envProxy() {
  const read = (name) => process.env[name] ?? process.env[name.toLowerCase()] ?? undefined
  return {
    https: read('HTTPS_PROXY'),
    http: read('HTTP_PROXY'),
    all: read('ALL_PROXY'),
    noProxy: parseNoProxy(process.env.NO_PROXY ?? process.env.no_proxy),
  }
}

export async function winSystemProxy() {
  if (process.platform !== 'win32') return undefined
  try {
    const { stdout } = await execFileAsync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyEnable',
    ], { windowsHide: true, timeout: 5000 })
    if (!/0x1\s*$/i.test(String(stdout).trim())) return undefined
  } catch {
    return undefined
  }
  try {
    const { stdout } = await execFileAsync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyServer',
    ], { windowsHide: true, timeout: 5000 })
    const line = String(stdout)
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => /ProxyServer\s+REG_SZ\s+/i.test(entry))
    if (line === undefined) return undefined
    const server = line.replace(/^.*REG_SZ\s+/i, '').trim()
    if (server === '' || server.toLowerCase() === 'none') return undefined
    for (const part of server.split(';')) {
      const match = /^(?:https|http|all)=([^:]+:\d+)$/i.exec(part.trim())
      if (match !== null) return `http://${match[1]}`
    }
    if (/^[^:]+:\d+$/.test(server)) return `http://${server}`
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the proxy for one host.
 * @param {string} host request hostname
 * @param {{proxy?: string, noProxy?: string[]|string}} config
 */
export async function resolveProxy(host, config = {}) {
  const mode = typeof config.proxy === 'string' && config.proxy !== '' ? config.proxy : 'auto'
  if (/^direct$/i.test(mode)) return undefined
  if (mode !== 'auto') return normalizeProxyUrl(mode)

  const env = envProxy()
  const noProxy = [...DEFAULT_NO_PROXY, ...parseNoProxy(config.noProxy), ...env.noProxy]
  if (bypassesProxy(host, noProxy)) return undefined
  const candidate = env.https ?? env.http ?? env.all ?? (await winSystemProxy())
  return normalizeProxyUrl(candidate)
}

function unixSystemCaPem() {
  if (process.platform === 'win32') return undefined
  for (const path of UNIX_CA_PATHS) {
    try {
      if (existsSync(path)) return readFileSync(path, 'utf8')
    } catch {
      /* next candidate */
    }
  }
  return undefined
}

async function winSystemCaPem() {
  const script = `
$sb = New-Object System.Text.StringBuilder
foreach ($loc in 'CurrentUser', 'LocalMachine') {
  foreach ($storeName in 'Root', 'CA') {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, $loc)
    try {
      $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
      foreach ($cert in $store.Certificates) {
        [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----')
        [void]$sb.AppendLine([Convert]::ToBase64String($cert.RawData, [System.Base64FormattingOptions]::InsertLineBreaks))
        [void]$sb.AppendLine('-----END CERTIFICATE-----')
      }
    } catch { } finally { try { $store.Dispose() } catch { } }
  }
}
$sb.ToString()
`
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (typeof stdout === 'string' && stdout.includes('BEGIN CERTIFICATE')) return stdout
  } catch {
    /* no export available */
  }
  return undefined
}

export class Network {
  /**
   * @param {object} options
   * @param {string} [options.caCacheFile] where to cache the OS CA bundle
   * @param {boolean} [options.disableSystemCa] skip the OS store export (tests)
   */
  constructor(options = {}) {
    this.config = { proxy: 'auto', noProxy: [] }
    this.caCacheFile = options.caCacheFile ?? ''
    this.disableSystemCa = options.disableSystemCa === true
    this.caCache = null
    this.dispatcherCache = new Map()
  }

  /** Apply the plugin row's network settings. */
  configure(config = {}) {
    this.config = {
      proxy: typeof config.proxy === 'string' && config.proxy.trim() !== '' ? config.proxy.trim() : 'auto',
      noProxy: config.noProxy,
    }
  }

  async systemCaPem() {
    if (this.disableSystemCa) return undefined
    if (this.caCache !== null) return this.caCache
    const cacheFile = this.caCacheFile
    if (cacheFile !== '') {
      try {
        if (existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < CA_CACHE_MAX_AGE_MS) {
          const cached = readFileSync(cacheFile, 'utf8')
          if (cached.includes('BEGIN CERTIFICATE')) {
            this.caCache = cached
            return cached
          }
        }
      } catch {
        /* re-export */
      }
    }
    const pem = process.platform === 'win32' ? await winSystemCaPem() : unixSystemCaPem()
    if (typeof pem === 'string' && pem.includes('BEGIN CERTIFICATE')) {
      this.caCache = pem
      if (cacheFile !== '') {
        try {
          mkdirSync(dirname(cacheFile), { recursive: true })
          writeFileSync(cacheFile, pem)
        } catch {
          /* cache is best effort */
        }
      }
      return pem
    }
    this.caCache = undefined
    return undefined
  }

  /** undici dispatcher for one host, or undefined for the default fetch. */
  async dispatcherFor(host) {
    const undici = await loadUndici()
    if (undici === null) return undefined
    const proxy = await resolveProxy(host, this.config)
    const key = proxy === undefined ? 'direct' : `proxy:${proxy}`
    if (this.dispatcherCache.has(key)) return this.dispatcherCache.get(key)
    const ca = await this.systemCaPem()
    let dispatcher
    try {
      if (proxy !== undefined) {
        dispatcher = new undici.ProxyAgent({ uri: proxy, requestTls: ca !== undefined ? { ca } : undefined })
      } else if (ca !== undefined) {
        dispatcher = new undici.Agent({ connect: { ca } })
      }
    } catch {
      dispatcher = undefined
    }
    this.dispatcherCache.set(key, dispatcher)
    return dispatcher
  }

  /** fetch() with this host's proxy/CA dispatcher and an AbortSignal timeout. */
  async fetch(url, init = {}, timeoutMs = 30000) {
    const target = typeof url === 'string' ? new URL(url) : url
    const dispatcher = await this.dispatcherFor(target.hostname)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs))
    const external = init.signal
    const onAbort = () => controller.abort()
    if (external !== undefined) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', onAbort, { once: true })
    }
    try {
      return await fetch(target, {
        ...init,
        ...(dispatcher !== undefined ? { dispatcher } : {}),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
      if (external !== undefined) external.removeEventListener('abort', onAbort)
    }
  }

  /** Human-readable network plan for the settings card. */
  async describe() {
    const env = envProxy()
    const proxy = await resolveProxy('registry.npmjs.org', this.config)
    return {
      mode: this.config.proxy,
      proxy: proxy ?? null,
      envProxy: env.https ?? env.http ?? env.all ?? null,
      noProxy: parseNoProxy(this.config.noProxy),
      undici: (await loadUndici()) !== null,
      systemCa: this.caCache !== null && this.caCache !== undefined,
    }
  }
}