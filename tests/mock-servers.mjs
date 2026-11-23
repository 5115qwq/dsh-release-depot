/**
 * In-process registry + GitHub doubles for the Release Depot host tests.
 * They implement the exact wire calls the clients make, including npm's
 * tarball attachment verification and OTP challenge.
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function json(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

export async function startMockRegistry(options = {}) {
  const token = options.token ?? 'npm_test_token_1234567890'
  const otp = options.otp ?? '123456'
  const state = {
    docs: new Map(),
    tarballs: new Map(),
    requests: [],
    otpRequired: options.otpRequired !== false,
    url: '',
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const path = decodeURIComponent(url.pathname)
    state.requests.push(`${request.method} ${path}`)
    const auth = String(request.headers.authorization ?? '')
    const authed = auth === `Bearer ${token}`
    try {
      if (request.method === 'GET' && path === '/-/ping') return json(response, 200, {})
      if (request.method === 'GET' && path === '/-/npm/v1/tokens') {
        if (!authed) return json(response, 401, { error: 'Unauthorized' })
        const masked = token.length > 12 ? `${token.slice(0, 8)}...${token.slice(-4)}` : token
        return json(response, 200, {
          objects: [{
            name: 'mock token',
            key: 'mock-key',
            token: masked,
            expiry: '2099-01-01T12:00:00.000Z',
            bypass_2fa: true,
            created: new Date().toISOString(),
            permissions: [{ name: 'package', action: 'write' }],
            scopes: [{ name: null, type: 'package' }],
          }],
          total: 1,
        })
      }
      if (request.method === 'GET' && path === '/-/whoami') {
        if (!authed) return json(response, 401, { error: 'Unauthorized' })
        return json(response, 200, { username: 'shiptester', email: 'ship@example.com' })
      }
      if (request.method === 'GET' && path === '/-/org/shiptester/package') {
        if (!authed) return json(response, 401, { error: 'Unauthorized' })
        const owned = { '@shipscope/other': 'read' }
        for (const name of state.docs.keys()) owned[name] = 'write'
        return json(response, 200, owned)
      }
      if (request.method === 'GET' && path === '/-/user/shiptester/package') {
        return json(response, 404, { error: 'Not found' })
      }
      if (request.method === 'GET' && path.startsWith('/-/user/org.couchdb.user:')) {
        if (!authed) return json(response, 401, { error: 'Unauthorized' })
        const name = decodeURIComponent(path.slice('/-/user/org.couchdb.user:'.length))
        return json(response, 200, { name, email: `${name}@example.com` })
      }
      if (request.method === 'GET' && path === '/-/v1/search') {
        return json(response, 200, {
          total: 1,
          objects: [{ package: { name: 'demo-pkg', version: '1.0.0', description: 'demo', date: new Date().toISOString(), links: {} } }],
        })
      }
      const accessMatch = /^\/-\/package\/(.+)\/access$/.exec(path)
      if (accessMatch !== null && request.method === 'POST') {
        if (!authed) return json(response, 401, { error: 'Unauthorized' })
        if (state.otpRequired && request.headers['npm-otp'] !== otp) {
          return json(response, 401, { error: '[EOTP] one-time password required' })
        }
        const body = JSON.parse((await readBody(request)).toString('utf8'))
        const doc = state.docs.get(accessMatch[1])
        if (doc === undefined) return json(response, 404, { error: 'Not found' })
        doc.access = body.access
        return json(response, 200, { ok: true })
      }
      const tagMatch = /^\/-\/package\/(.+)\/dist-tags(?:\/([^/]+))?$/.exec(path)
      if (tagMatch !== null) {
        const name = tagMatch[1]
        const tag = tagMatch[2] === undefined ? null : tagMatch[2]
        if (!authed) return json(response, 401, { error: 'Unauthorized' })
        const doc = state.docs.get(name)
        if (doc === undefined) return json(response, 404, { error: 'Not found' })
        if (request.method === 'GET' && tag === null) return json(response, 200, { ...doc['dist-tags'], _etag: 'x' })
        if (request.method === 'PUT' && tag !== null) {
          if (state.requireOtp === 'account-2fa') {
            return json(response, 403, { error: 'Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.' })
          }
          if (state.otpRequired && request.headers['npm-otp'] !== otp) {
            return json(response, 401, { error: '[EOTP] This operation requires a one-time password from your authenticator.' })
          }
          const version = JSON.parse((await readBody(request)).toString('utf8'))
          doc['dist-tags'][tag] = version
          return json(response, 200, { ok: true })
        }
        if (request.method === 'DELETE' && tag !== null) {
          if (doc['dist-tags'][tag] === undefined) return json(response, 404, { error: 'Not found' })
          delete doc['dist-tags'][tag]
          return json(response, 200, { ok: true })
        }
        return json(response, 405, { error: 'Method not allowed' })
      }
      const tarballMatch = /^\/(.+)\/-\/(.+)\/-rev\/([^/]+)$/.exec(path)
      if (tarballMatch !== null && request.method === 'DELETE') {
        for (const [key, value] of [...state.tarballs.entries()]) {
          if (value.name === tarballMatch[2] || key === tarballMatch[2]) state.tarballs.delete(key)
        }
        return json(response, 200, { ok: true })
      }
      const revMatch = /^\/(.+)\/-rev\/([^/]+)$/.exec(path)
      if (revMatch !== null) {
        if (!authed) return json(response, 401, { error: 'Unauthorized' })
        const name = revMatch[1]
        const doc = state.docs.get(name)
        if (doc === undefined) return json(response, 404, { error: 'Not found' })
        if (request.method === 'DELETE') {
          state.docs.delete(name)
          for (const [key, value] of [...state.tarballs.entries()]) {
            if (value.name.startsWith(`${name}-`)) state.tarballs.delete(key)
          }
          return json(response, 200, { ok: true })
        }
        if (request.method === 'PUT') {
          const next = JSON.parse((await readBody(request)).toString('utf8'))
          next._rev = `${Number(doc._rev.split('-')[0]) + 1}-rev`
          state.docs.set(name, { ...doc, ...next })
          return json(response, 201, { ok: true })
        }
      }
      const getTarball = /^\/(.+)\/-\/(.+\.tgz)$/.exec(path)
      if (getTarball !== null && request.method === 'GET') {
        const value = state.tarballs.get(getTarball[2])
        if (value === undefined) return json(response, 404, { error: 'Not found' })
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': value.data.length })
        return response.end(value.data)
      }

      const pkg = path.slice(1)
      if (pkg.includes('/') && !pkg.startsWith('@')) return json(response, 404, { error: 'Not found' })
      if (request.method === 'GET') {
        const doc = state.docs.get(pkg)
        if (doc === undefined) return json(response, 404, { error: 'Not found' })
        return json(response, 200, doc)
      }
      if (request.method === 'PUT') {
        if (!authed) return json(response, 401, { error: 'Unauthorized' })
        const body = JSON.parse((await readBody(request)).toString('utf8'))
        const attachmentName = Object.keys(body._attachments ?? {})[0]
        if (attachmentName === undefined) {
          // npm deprecate / metadata update: merge versions and tags, no new tarball.
          const doc = state.docs.get(pkg)
          if (doc === undefined) return json(response, 404, { error: 'Not found' })
          for (const [version, manifest] of Object.entries(body.versions ?? {})) {
            if (doc.versions[version] !== undefined) doc.versions[version].deprecated = manifest.deprecated
          }
          doc['dist-tags'] = body['dist-tags'] ?? doc['dist-tags']
          doc._rev = `${Number(doc._rev.split('-')[0]) + 1}-rev`
          return json(response, 201, { ok: true })
        }
        if (state.otpRequired && request.headers['npm-otp'] !== otp) {
          return json(response, 401, { error: '[EOTP] one-time password required' })
        }
        const version = Object.keys(body.versions ?? {})[0]
        if (version === undefined) return json(response, 400, { error: 'no version' })
        let doc = state.docs.get(pkg)
        if (doc === undefined) {
          doc = {
            name: pkg,
            versions: {},
            'dist-tags': {},
            maintainers: [{ name: 'shiptester' }],
            time: { created: new Date().toISOString(), modified: new Date().toISOString() },
            _rev: '1-rev',
            readme: body.readme ?? '',
          }
        }
        if (doc.versions[version] !== undefined) return json(response, 409, { error: 'Cannot publish over previously published version' })
        const manifest = body.versions[version]
        const attachment = body._attachments[attachmentName]
        const data = Buffer.from(attachment.data, 'base64')
        if (data.length !== attachment.length) return json(response, 400, { error: 'attachment length mismatch' })
        const sha1 = createHash('sha1').update(data).digest('hex')
        const sha512 = `sha512-${createHash('sha512').update(data).digest('base64')}`
        if (sha1 !== manifest.dist.shasum) return json(response, 400, { error: 'shasum mismatch' })
        if (sha512 !== manifest.dist.integrity) return json(response, 400, { error: 'integrity mismatch' })
        if (!(manifest.dist.tarball.startsWith(state.url))) {
          return json(response, 400, { error: `bad tarball url: ${manifest.dist.tarball}` })
        }
        manifest.dist.tarball = `${state.url}/${pkg}/-/${attachmentName}`
        doc.versions[version] = manifest
        doc['dist-tags'] = { ...doc['dist-tags'], ...body['dist-tags'] }
        doc.time[version] = new Date().toISOString()
        doc.time.modified = new Date().toISOString()
        doc._rev = `${Number(doc._rev.split('-')[0]) + 1}-rev`
        if (body.access !== undefined) doc.access = body.access
        state.docs.set(pkg, doc)
        state.tarballs.set(attachmentName, { name: attachmentName, version, data })
        return json(response, 201, { ok: true, id: pkg, rev: doc._rev })
      }
      return json(response, 405, { error: 'Method not allowed' })
    } catch (error) {
      return json(response, 500, { error: error.message })
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  state.url = `http://127.0.0.1:${port}`
  return {
    url: state.url,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

export async function startMockGitHub(options = {}) {
  const token = options.token ?? 'gh_test_token_1234567890'
  const state = {
    user: { login: 'shiptester', name: 'Ship Tester', avatar_url: 'https://avatars.example/u/1', html_url: 'https://github.com/shiptester', public_repos: 1 },
    repos: new Set(['demo-repo']),
    refs: new Map(),
    blobs: new Map(),
    trees: [],
    commits: [],
    releases: new Map(),
    assets: [],
    requests: [],
    nextReleaseId: 1,
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const path = decodeURIComponent(url.pathname)
    state.requests.push(`${request.method} ${path}`)
    const authed = String(request.headers.authorization ?? '') === `Bearer ${token}`
    if (request.method === 'GET' && path === '/rate_limit') return json(response, 200, { rate: {} })
    if (!authed) return json(response, 401, { message: 'Bad credentials' })
    try {
      if (request.method === 'GET' && path === '/user') {
        response.setHeader('x-oauth-scopes', 'repo, workflow')
        return json(response, 200, state.user)
      }
      if (request.method === 'GET' && path === '/user/repos') {
        return json(response, 200, [...state.repos].map((name) => ({
          name, full_name: `shiptester/${name}`, private: true, description: 'demo',
          default_branch: 'main', updated_at: new Date().toISOString(),
          html_url: `https://github.com/shiptester/${name}`, owner: { login: 'shiptester' }, language: 'JavaScript',
        })))
      }
      if (request.method === 'POST' && path === '/user/repos') {
        const body = JSON.parse((await readBody(request)).toString('utf8'))
        state.repos.add(body.name)
        return json(response, 201, {
          name: body.name, full_name: `shiptester/${body.name}`, private: body.private,
          default_branch: 'main', html_url: `https://github.com/shiptester/${body.name}`,
          owner: { login: 'shiptester' },
        })
      }
      const repoMatch = /^\/repos\/shiptester\/([^/]+)(\/.*)?$/.exec(path)
      if (repoMatch !== null) {
        const repo = repoMatch[1]
        const rest = repoMatch[2] ?? ''
        if (!state.repos.has(repo)) return json(response, 404, { message: 'Not Found' })
        if (request.method === 'GET' && rest === '') {
          return json(response, 200, {
            name: repo, full_name: `shiptester/${repo}`, private: true, default_branch: 'main',
            html_url: `https://github.com/shiptester/${repo}`, owner: { login: 'shiptester' },
          })
        }
        if (request.method === 'GET' && rest.startsWith('/git/ref/heads/')) {
          const branch = rest.slice('/git/ref/heads/'.length)
          const ref = state.refs.get(`${repo}:${branch}`)
          if (ref === undefined) return json(response, 404, { message: 'Not Found' })
          return json(response, 200, { ref: `refs/heads/${branch}`, object: { sha: ref } })
        }
        if (request.method === 'PUT' && rest === '/contents/README.md') {
          await readBody(request)
          state.refs.set(`${repo}:main`, 'init-commit')
          return json(response, 201, { commit: { sha: 'init-commit' }, content: {} })
        }
        if (request.method === 'POST' && rest === '/git/blobs') {
          const body = JSON.parse((await readBody(request)).toString('utf8'))
          const sha = createHash('sha1').update(Buffer.from(body.content, 'base64')).digest('hex')
          state.blobs.set(sha, body.content)
          return json(response, 201, { sha })
        }
        if (request.method === 'POST' && rest === '/git/trees') {
          const body = JSON.parse((await readBody(request)).toString('utf8'))
          state.trees.push(body)
          return json(response, 201, { sha: `tree-${state.trees.length}` })
        }
        // Recursive tree read, used to detect files that a `replace` push would
        // delete. Resolve a commit sha -> its tree -> its entries.
        if (request.method === 'GET' && rest.startsWith('/git/trees/')) {
          const sha = rest.slice('/git/trees/'.length).split('?')[0]
          const commit = state.commits.find((entry, index) => `commit-${index + 1}` === sha)
          let tree = null
          if (commit !== undefined) {
            const treeIndex = Number(String(commit.tree).replace('tree-', '')) - 1
            tree = state.trees[treeIndex] ?? null
          } else if (sha === 'init-commit') {
            tree = { tree: [] }
          } else {
            const treeIndex = Number(String(sha).replace('tree-', '')) - 1
            tree = state.trees[treeIndex] ?? null
          }
          if (tree === null) return json(response, 404, { message: 'Not Found' })
          return json(response, 200, { sha, tree: tree.tree ?? [] })
        }
        if (request.method === 'POST' && rest === '/git/commits') {
          const body = JSON.parse((await readBody(request)).toString('utf8'))
          state.commits.push(body)
          return json(response, 201, { sha: `commit-${state.commits.length}`, tree: { sha: body.tree } })
        }
        if (request.method === 'GET' && rest.startsWith('/git/commits/')) {
          return json(response, 200, { sha: rest.split('/').pop(), tree: { sha: 'base-tree' } })
        }
        if (request.method === 'PATCH' && rest.startsWith('/git/refs/heads/')) {
          const branch = rest.slice('/git/refs/heads/'.length)
          const body = JSON.parse((await readBody(request)).toString('utf8'))
          state.refs.set(`${repo}:${branch}`, body.sha)
          return json(response, 200, { ref: `refs/heads/${branch}`, object: { sha: body.sha } })
        }
        if (request.method === 'POST' && rest === '/git/refs') {
          const body = JSON.parse((await readBody(request)).toString('utf8'))
          const branch = body.ref.replace('refs/heads/', '')
          state.refs.set(`${repo}:${branch}`, body.sha)
          return json(response, 201, { ref: body.ref, object: { sha: body.sha } })
        }
        if (request.method === 'POST' && rest === '/releases') {
          const body = JSON.parse((await readBody(request)).toString('utf8'))
          const id = state.nextReleaseId
          state.nextReleaseId += 1
          state.releases.set(id, { id, ...body, html_url: `https://github.com/shiptester/${repo}/releases/tag/${body.tag_name}` })
          return json(response, 201, {
            id, tag_name: body.tag_name, name: body.name, draft: body.draft,
            html_url: `https://github.com/shiptester/${repo}/releases/tag/${body.tag_name}`,
            upload_url: `http://127.0.0.1${url.port === '' ? '' : `:${url.port}`}/uploads/repos/shiptester/${repo}/releases/${id}/assets{?name,label}`,
          })
        }
        if (request.method === 'GET' && rest === '/releases') {
          return json(response, 200, [...state.releases.values()].map((release) => ({
            id: release.id, tag_name: release.tag_name, name: release.name, draft: release.draft,
            prerelease: release.prerelease, html_url: release.html_url, assets: [],
          })))
        }
        const releaseMatch = /^\/releases\/(\d+)$/.exec(rest)
        if (releaseMatch !== null && request.method === 'DELETE') {
          state.releases.delete(Number(releaseMatch[1]))
          return json(response, 200, {})
        }
        return json(response, 404, { message: 'Not Found' })
      }
      const uploadMatch = /^\/uploads\/repos\/shiptester\/([^/]+)\/releases\/(\d+)\/assets$/.exec(path)
      if (uploadMatch !== null && request.method === 'POST') {
        const body = await readBody(request)
        const name = url.searchParams.get('name') ?? 'asset.bin'
        state.assets.push({ name, size: body.length, data: body })
        return json(response, 201, { id: state.assets.length, name, size: body.length, browser_download_url: `https://github.com/dl/${name}` })
      }
      return json(response, 404, { message: 'Not Found' })
    } catch (error) {
      return json(response, 500, { message: error.message })
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    uploadsUrl: `http://127.0.0.1:${port}/uploads`,
    token,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}