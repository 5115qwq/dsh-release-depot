/**
 * Host-side integration test: connect accounts, publish to a mock registry
 * (with a real OTP challenge), manage dist-tags/deprecate/unpublish, push a
 * directory and create a release with an uploaded asset on a mock GitHub.
 * Run: node tests/host.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Network } from '../lib/net.js'
import { ShipDeck, serializeError } from '../lib/service.js'
import { ShipDeckStore } from '../lib/store.js'
import { startMockGitHub, startMockRegistry } from './mock-servers.mjs'

const createdFixtures = []

async function makeFixture(version, name = '@acme/demo-pkg') {
  const dir = await mkdtemp(join(tmpdir(), 'ship-fixture-'))
  createdFixtures.push(dir)
  await mkdir(join(dir, 'lib'), { recursive: true })
  await mkdir(join(dir, 'node_modules', 'junk'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name,
    version,
    description: 'fixture package',
    main: 'lib/index.js',
    files: ['lib', 'README.md'],
    license: 'MIT',
  }, null, 2))
  await writeFile(join(dir, 'README.md'), '# demo\n')
  await writeFile(join(dir, 'lib', 'index.js'), 'export const x = 1\n')
  await writeFile(join(dir, 'lib', 'util.js'), 'export const y = 2\n')
  await writeFile(join(dir, 'node_modules', 'junk', 'index.js'), 'junk\n')
  await writeFile(join(dir, '.npmrc'), 'secret=1\n')
  await writeFile(join(dir, 'CHANGELOG.md'), `# Changelog\n\n## ${version}\n\n- fixture change for ${version}\n`)
  return dir
}

function log(label) {
  console.log(`\n✓ ${label}`)
}

const registry = await startMockRegistry()
const github = await startMockGitHub()
const home = await mkdtemp(join(tmpdir(), 'ship-home-'))
const store = new ShipDeckStore({ home, authFile: join(home, 'auth.json') })
const network = new Network({ disableSystemCa: true })
const service = new ShipDeck({
  config: {
    npmRegistry: registry.url,
    githubApiBase: github.url,
    githubUploadsBase: github.uploadsUrl,
  },
  network,
  store,
  version: 'test',
})

try {
  assert.equal(service.status().npm.connected, false)
  log('status starts disconnected')

  const connected = await service.connectNpm({ token: 'npm_test_token_1234567890', expiresAt: '2099-01-01' })
  assert.equal(connected.npm.username, 'shiptester')
  assert.equal(service.status().npm.connected, true)
  assert.equal(service.status().npm.expiresAt, '2099-01-01')
  assert.ok(service.status().npm.expiresInDays > 0, 'expiry days should be computed')
  assert.equal(service.status().npm.bypass2fa, true)
  const refreshed = await service.refreshNpmTokenInfo()
  assert.equal(refreshed.matched, true)
  assert.equal(refreshed.npm.bypass2fa, true)
  const meta = service.setNpmTokenMeta({ expiresAt: '2099-02-01' })
  assert.equal(meta.npm.expiresAt, '2099-02-01')
  assert.ok(!JSON.stringify(service.status()).includes('npm_test_token_1234567890'), 'token must never leak in status')
  log('npm token verified and stored without exposure')

  const fixture = await makeFixture('1.2.3')
  const preview = await service.projectPreview({ dir: fixture })
  assert.equal(preview.name, '@acme/demo-pkg')
  assert.equal(preview.fileCount, 5)
  assert.equal(preview.files.some((file) => file.path.includes('node_modules')), false)
  log('project preview packs the right files')

  const dry = await service.publish({ dir: fixture, targets: ['npm'], dryRun: true, access: 'restricted' })
  assert.equal(dry.ok, true)
  assert.equal(dry.record.targets[0].dryRun, true)
  log('dry-run publish reports the registry state')

  const noOtp = await service.publish({ dir: fixture, targets: ['npm'] })
  assert.equal(noOtp.ok, false)
  assert.equal(noOtp.record.targets[0].error.code, 'EOTP')
  assert.match(noOtp.record.targets[0].error.hint, /6 位|动态码|Bypass/)
  log('publish without OTP is rejected with EOTP')

  const published = await service.publish({ dir: fixture, targets: ['npm'], otp: '123456' })
  assert.equal(published.ok, true, JSON.stringify(published, null, 2))
  assert.equal(published.record.targets[0].status, 201)
  const stored = registry.state.tarballs.get('@acme/demo-pkg-1.2.3.tgz')
  assert.ok(stored, 'registry received the tarball')
  assert.equal(stored.data.length, preview.packedSize)
  log('publish with OTP stores tarball, integrity and version')

  const packages = await service.npmPackages({ refresh: true })
  assert.equal(packages.items.length, 2)
  const demo = packages.items.find((item) => item.name === '@acme/demo-pkg')
  assert.equal(demo.version, '1.2.3')
  log('account package list reads identity and latest versions')

  // A second publish would conflict.
  const conflict = await service.publish({ dir: fixture, targets: ['npm'], otp: '123456' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.record.targets[0].error.code, 'EPUBLISHCONFLICT')
  log('republishing an existing version maps to EPUBLISHCONFLICT')

  const tags = await service.npmSetTag({ name: '@acme/demo-pkg', tag: 'next', version: '1.2.3', otp: '123456' })
  assert.equal(tags.ok, true)
  assert.equal(registry.state.docs.get('@acme/demo-pkg')['dist-tags'].next, '1.2.3')
  const tagList = await service.npmDistTags({ name: '@acme/demo-pkg' })
  assert.deepEqual(tagList.tags, { latest: '1.2.3', next: '1.2.3' })
  await service.npmDeleteTag({ name: '@acme/demo-pkg', tag: 'next', otp: '123456' })
  log('dist-tags are set, listed and deleted')

  await service.npmDeprecate({ name: '@acme/demo-pkg', range: '^1.0.0', message: 'old', otp: '123456' })
  assert.equal(registry.state.docs.get('@acme/demo-pkg').versions['1.2.3'].deprecated, 'old')
  await service.npmDeprecate({ name: '@acme/demo-pkg', range: '^1.0.0', message: '', otp: '123456' })
  assert.equal(registry.state.docs.get('@acme/demo-pkg').versions['1.2.3'].deprecated, undefined)
  await service.npmSetAccess({ name: '@acme/demo-pkg', access: 'private', otp: '123456' })
  assert.equal(registry.state.docs.get('@acme/demo-pkg').access, 'restricted')
  const owners = await service.npmOwners({ name: '@acme/demo-pkg' })
  assert.equal(owners.maintainers[0].name, 'shiptester')
  await service.npmChangeOwner({ name: '@acme/demo-pkg', user: 'teammate', action: 'add', otp: '123456' })
  assert.ok(registry.state.docs.get('@acme/demo-pkg').maintainers.some((entry) => entry.name === 'teammate'))
  await service.npmChangeOwner({ name: '@acme/demo-pkg', user: 'teammate', action: 'remove', otp: '123456' })
  assert.equal(registry.state.docs.get('@acme/demo-pkg').maintainers.some((entry) => entry.name === 'teammate'), false)
  log('deprecate, undeprecate, access level and maintainers work')

  // Publish a newer version, then unpublish the older one.
  const fixture2 = await makeFixture('1.2.4')
  const newer = await service.publish({ dir: fixture2, targets: ['npm'], otp: '123456' })
  assert.equal(newer.ok, true)
  const unpublished = await service.npmUnpublish({
    name: '@acme/demo-pkg', version: '1.2.3', force: true, otp: '123456',
  })
  assert.equal(unpublished.ok, true)
  const doc = registry.state.docs.get('@acme/demo-pkg')
  assert.equal(doc.versions['1.2.3'], undefined)
  assert.equal(doc.versions['1.2.4'].version, '1.2.4')
  assert.equal(doc['dist-tags'].latest, '1.2.4')
  assert.equal(registry.state.tarballs.get('@acme/demo-pkg-1.2.3.tgz'), undefined)
  log('single-version unpublish rewrites the packument and removes the tarball')

  const wholeGuard = await service.npmUnpublish({ name: '@acme/demo-pkg', force: false, otp: '123456' }).catch((error) => error)
  assert.equal(serializeError(wholeGuard).code, 'ECONFIRM')
  const wildcardGuard = await service.npmUnpublish({ name: '@acme/demo-pkg', version: '*', force: true, otp: '123456' }).catch((error) => error)
  assert.equal(serializeError(wildcardGuard).code, 'ECONFIRM')
  log('whole-package removal requires explicit confirmation')

  // Regression: the 2FA requirement must be reported as "account has no 2FA"
  // when npm answers 403 without an OTP challenge, so the UI never asks the
  // user to hunt for a code that npm will not inspect.
  registry.state.requireOtp = 'account-2fa'
  const needsAccount2fa = await service.npmSetTag({
    name: '@acme/demo-pkg', tag: 'probe', version: '1.2.4',
  }).catch((error) => error)
  const serialized2fa = serializeError(needsAccount2fa)
  assert.equal(serialized2fa.code, 'E2FAACCOUNT')
  assert.equal(serialized2fa.details.otpUseful, false)
  registry.state.requireOtp = null
  log('2FA-missing-account is distinguished from a wrong OTP')

  const ghConnected = await service.githubConnectPat({ token: github.token })
  assert.equal(ghConnected.github.login, 'shiptester')
  assert.equal(service.githubPublicStatus().scopes.join(','), 'repo,workflow')
  log('GitHub PAT verified and stored without exposure')

  const repos = await service.githubRepos({ refresh: true })
  assert.equal(repos.items[0].fullName, 'shiptester/demo-repo')
  log('GitHub repository list works')

  const push = await service.githubPush({
    owner: 'shiptester', repo: 'demo-repo', dir: fixture2, branch: 'main', create: false,
  })
  assert.equal(push.ok, true)
  assert.equal(push.fileCount, preview.fileCount)
  assert.equal(github.state.commits.length, 1)
  assert.equal(github.state.refs.get('demo-repo:main'), push.commitSha)
  assert.equal(github.state.trees[0].tree.length, preview.fileCount)
  log('GitHub push creates blobs, a tree, a commit and the branch ref')

  const release = await service.githubRelease({
    owner: 'shiptester', repo: 'demo-repo', tag: 'v1.2.4', name: 'Demo v1.2.4', body: 'notes', assetDir: fixture2,
  })
  assert.equal(release.ok, true)
  assert.equal(github.state.assets.length, 1)
  assert.ok(github.state.assets[0].data.length > 0)
  const releaseList = await service.githubReleases({ owner: 'shiptester', repo: 'demo-repo' })
  assert.equal(releaseList.items.length, 1)
  await service.githubDeleteRelease({ owner: 'shiptester', repo: 'demo-repo', releaseId: releaseList.items[0].id, force: true })
  assert.equal(github.state.releases.size, 0)
  log('release creation, asset upload, listing and deletion work')

  const pipeline = await service.publish({
    dir: fixture2,
    targets: ['npm', 'github-release'],
    otp: '123456',
    github: { owner: 'shiptester', repo: 'new-repo', create: true, private: true, attachTarball: true },
    dryRun: true,
  })
  assert.equal(pipeline.record.targets.length, 2)
  assert.equal(pipeline.record.targets[1].dryRun, true)
  assert.equal(pipeline.record.targets[1].repoExists, false)
  log('combined dry-run preflights npm and a missing GitHub repo')

  const combinedFixture = await makeFixture('1.2.5')
  const combined = await service.publish({
    dir: combinedFixture,
    targets: ['npm', 'github-release'],
    otp: '123456',
    github: { owner: 'shiptester', repo: 'new-repo-two', create: true, private: true },
  })
  assert.equal(combined.ok, true, JSON.stringify(combined.record.targets, null, 2))
  assert.equal(combined.record.targets[1].created, true)
  assert.equal(combined.record.targets[1].release.tag, 'v1.2.5')
  assert.ok(github.state.releases.size >= 1)
  assert.ok(github.state.assets.length >= 1)
  const releaseBodies = [...github.state.releases.values()].map((release) => String(release.body ?? ''))
  assert.ok(releaseBodies.every((body) => !body.includes('Published from')), 'release notes must not expose local paths')
  assert.ok(releaseBodies.every((body) => !body.includes('C:\\')), 'release notes must not expose local drives')
  assert.ok(releaseBodies.some((body) => body.includes('fixture change for 1.2.5')), 'release notes should use the version changelog')
  assert.ok(releaseBodies.some((body) => body.includes('npm install @acme/demo-pkg@1.2.5')), 'release notes should include install command')
  assert.deepEqual(combined.record.targets.map((target) => target.target), ['npm', 'github-release'])
  log('combined publish creates the repo, pushes, releases and attaches the tarball')

  const history = service.history(50)
  assert.ok(history.length >= 5)
  assert.equal(history[0].ok, true)
  assert.equal(history[0].actor, 'ui')
  log('history records every publish attempt')

  const prefs = service.setPrefs({ access: 'public', tag: 'next', defaultTargets: ['github-release'], sidebarVisible: false })
  assert.equal(prefs.prefs.tag, 'next')
  assert.equal(prefs.prefs.sidebarVisible, false)
  assert.deepEqual(prefs.prefs.defaultTargets, ['github-release'])
  service.setPrefs({ sidebarVisible: true })
  log('preferences persist')

  const diagnostics = await service.diagnostics({ ping: true })
  assert.equal(diagnostics.ping.npm.ok, true)
  assert.equal(diagnostics.ping.github.ok, true)
  assert.ok(!JSON.stringify(diagnostics).includes(github.token), 'token must not leak in diagnostics')
  log('diagnostics probe both networks without leaking tokens')
} finally {
  await registry.close()
  await github.close()
  await rm(home, { recursive: true, force: true })
  for (const dir of createdFixtures) await rm(dir, { recursive: true, force: true }).catch(() => {})
}

console.log('\nAll host integration tests passed.')