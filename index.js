/**
 * dsh-release-depot — host entry.
 *
 * A plain Cordis plugin (no @deepseek-ai/* runtime imports) that serves the
 * panel's same-origin RPC route and registers the agent tools. All mutations
 * go through one service instance, so the UI and the tools share behavior.
 */
import { join } from 'node:path'
import { Network } from './lib/net.js'
import { ShipDeck, serializeError } from './lib/service.js'
import { ShipDeckStore, dshHome } from './lib/store.js'
import { createTools, SHIP_DECK_PROMPT } from './lib/tools.js'

export const name = 'dsh-release-depot'

const VERSION = '1.1.3'
const MAX_BODY_BYTES = 1024 * 1024

function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const normalized = {
    authFile: typeof config.authFile === 'string' ? config.authFile : '',
    proxy: typeof config.proxy === 'string' ? config.proxy : 'auto',
    noProxy: Array.isArray(config.noProxy) ? config.noProxy.filter((item) => typeof item === 'string') : [],
    npmRegistry: typeof config.npmRegistry === 'string' ? config.npmRegistry : '',
    githubRegistry: typeof config.githubRegistry === 'string' ? config.githubRegistry : '',
    githubApiBase: typeof config.githubApiBase === 'string' ? config.githubApiBase : 'https://api.github.com',
    githubUploadsBase: typeof config.githubUploadsBase === 'string' ? config.githubUploadsBase : '',
    maxFiles: Number(config.maxFiles) > 0 ? Number(config.maxFiles) : undefined,
    maxPackageBytes: Number(config.maxPackageBytes) > 0 ? Number(config.maxPackageBytes) : undefined,
    maxGitBytes: Number(config.maxGitBytes) > 0 ? Number(config.maxGitBytes) : undefined,
    toolPaths: Array.isArray(config.toolPaths) ? config.toolPaths.filter((item) => typeof item === 'string') : [],
    allowToolPathsOutsideWorkspace: config.allowToolPathsOutsideWorkspace === true,
  }
  return normalized
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function sendText(response, status, text) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  response.end(text)
}

function sameOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined || origin === 'null') return true
  const host = request.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJson(request, limitBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) throw Object.assign(new Error('请求体过大'), { code: 'EBODY' })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/** The complete RPC surface. Keeping it as data makes the allowlist auditable. */
function createOperations(service) {
  const ops = {
    status: () => service.status(),
    diagnostics: (input) => service.diagnostics(input),

    'npm.connect': (input) => service.connectNpm(input),
    'npm.verify': () => service.verifyNpm(),
    'npm.token-info': () => service.refreshNpmTokenInfo(),
    'npm.disconnect': () => service.disconnectNpm(),
    'npm.set-token-meta': (input) => service.setNpmTokenMeta(input),
    'npm.packages': (input) => service.npmPackages(input),
    'npm.info': (input) => service.npmInfo(input),
    'npm.search': (input) => service.npmSearch(input),
    'npm.dist-tags': (input) => service.npmDistTags(input),
    'npm.set-tag': (input) => service.npmSetTag(input),
    'npm.delete-tag': (input) => service.npmDeleteTag(input),
    'npm.deprecate': (input) => service.npmDeprecate(input),
    'npm.set-access': (input) => service.npmSetAccess(input),
    'npm.owners': (input) => service.npmOwners(input),
    'npm.change-owner': (input) => service.npmChangeOwner(input),
    'npm.unpublish': (input) => service.npmUnpublish(input),
    'npm.install-command': (input) => service.npmInstallCommand(input),

    'github.device-start': (input) => service.githubDeviceStart(input),
    'github.device-poll': (input) => service.githubDevicePoll(input),
    'github.connect-pat': (input) => service.githubConnectPat(input),
    'github.verify': () => service.verifyGitHub(),
    'github.disconnect': () => service.disconnectGitHub(),
    'github.repos': (input) => service.githubRepos(input),
    'github.releases': (input) => service.githubReleases(input),
    'github.create-repo': (input) => service.githubCreateRepo(input),
    'github.push': (input) => service.githubPush(input),
    'github.release': (input) => service.githubRelease(input),
    'github.delete-release': (input) => service.githubDeleteRelease(input),

    'project.inspect': (input) => service.projectInspect(input),
    'project.preview': (input) => service.projectPreview(input),
    'publish.run': (input) => service.publish(input),

    history: (input) => ({ ok: true, items: service.history(input?.limit) }),
    'history.clear': () => service.clearHistory(),
    'prefs.get': () => service.getPrefs(),
    'prefs.set': (input) => service.setPrefs(input),
  }
  return ops
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const home = dshHome()
  const network = new Network({
    caCacheFile: join(home, '.dsh-release-depot', 'system-ca.pem'),
  })
  network.configure({ proxy: config.proxy, noProxy: config.noProxy })
  const store = new ShipDeckStore({ authFile: config.authFile })
  const service = new ShipDeck({ config, network, store, version: VERSION })
  const operations = createOperations(service)

  ctx.inject(['webServer'], (hostCtx) => {
    const dispose = hostCtx.webServer.register({
      kind: 'prefix',
      path: '/dsh-release-depot',
      handler: async (request, response) => {
        const method = request.method ?? 'GET'
        let url
        try {
          url = new URL(request.url ?? '/', 'http://127.0.0.1')
        } catch {
          sendText(response, 400, 'bad request')
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { ok: false, error: { message: '跨域请求被拒绝', code: 'ECORS' } })
          return
        }
        if (method === 'GET' && url.pathname === '/dsh-release-depot/status') {
          try {
            sendJson(response, 200, { ok: true, result: service.status() })
          } catch (error) {
            sendJson(response, 200, { ok: false, error: serializeError(error) })
          }
          return
        }
        if (method === 'POST' && url.pathname === '/dsh-release-depot/rpc') {
          const contentType = String(request.headers['content-type'] ?? '')
          if (!contentType.toLowerCase().includes('application/json')) {
            sendJson(response, 415, { ok: false, error: { message: '需要 application/json 请求体', code: 'ECONTENTTYPE' } })
            return
          }
          let body
          try {
            body = await readJson(request)
          } catch (error) {
            sendJson(response, 400, { ok: false, error: serializeError(error) })
            return
          }
          const op = typeof body?.op === 'string' ? body.op : ''
          const handler = operations[op]
          if (handler === undefined) {
            sendJson(response, 400, { ok: false, error: { message: `未知操作：${op || '(空)'}`, code: 'EOP' } })
            return
          }
          try {
            const result = await handler(body?.input ?? {})
            sendJson(response, 200, { ok: true, result })
          } catch (error) {
            sendJson(response, 200, { ok: false, error: serializeError(error) })
          }
          return
        }
        sendJson(response, 404, { ok: false, error: { message: 'not found', code: 'ENOTFOUND' } })
      },
    })
    hostCtx.effect(() => dispose, 'dsh-release-depot: http routes')
  })

  ctx.inject(['tools', 'systemPrompt'], (agentCtx) => {
    const tools = createTools(service, agentCtx, config)
    agentCtx.effect(() => {
      const disposers = tools.map((tool) => agentCtx.tools.register(tool))
      const removeSection = agentCtx.systemPrompt.section(SHIP_DECK_PROMPT)
      return () => {
        for (const dispose of disposers) dispose()
        removeSection()
      }
    }, 'dsh-release-depot: tools')
  })
}