/**
 * Host-side integration test: connect accounts, publish to a mock registry
 * (with a real OTP challenge), manage dist-tags/deprecate/unpublish, push a
 * directory and create a release with an uploaded asset on a mock GitHub.
 * Run: node tests/host.test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Network } from '../lib/net.js'
import { GitHubClient } from '../lib/github.js'
import { ShipDeck, serializeError } from '../lib/service.js'
import { ShipDeckStore } from '../lib/store.js'
import { startMockGitHub, startMockRegistry } from './mock-servers.mjs'
import { parseRange, satisfies } from '../lib/semver.js'
import { inspectLocalGit } from '../lib/pack.js'

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

  // Republishing the identical artifact is idempotent: a partially successful
  // publish (npm done, GitHub failed) must be retryable. No PUT is attempted.
  const requestsBefore = registry.state.requests.length
  const retry = await service.publish({ dir: fixture, targets: ['npm'], otp: '123456' })
  assert.equal(retry.ok, true, 'an identical republish should be skipped, not failed')
  assert.equal(retry.record.targets[0].skipped, true)
  assert.match(String(retry.record.targets[0].warnings[0]), /跳过/)
  const putAttempts = registry.state.requests
    .slice(requestsBefore)
    .filter((entry) => entry.method === 'PUT').length
  assert.equal(putAttempts, 0, 'an existing identical version must not reach the registry PUT')
  log('republishing an identical artifact is idempotent (skipped, no PUT)')

  // The preflight must predict what the real run does. For an identical
  // republish the real run SKIPS, so a preflight reporting failure would
  // contradict it and block the publish button for no reason.
  const dryRetry = await service.publish({ dir: fixture, targets: ['npm'], otp: '123456', dryRun: true })
  assert.equal(dryRetry.ok, true, 'preflight must not fail when the real run would skip')
  assert.equal(dryRetry.record.targets[0].skipped, true)
  assert.match(String(dryRetry.record.targets[0].warnings[0]), /跳过/)
  log('preflight predicts the idempotent skip')

  // A *different* artifact on the same version is a real conflict and must fail.
  const tamperedFixture = await makeFixture('1.2.3')
  // `files` whitelists lib/README, so touch a shipped file to change the bytes.
  await writeFile(join(tamperedFixture, 'lib', 'index.js'), 'export const x = 999\n')
  const conflict = await service.publish({ dir: tamperedFixture, targets: ['npm'], otp: '123456' })
  assert.equal(conflict.ok, false, 'a different artifact on an existing version must be rejected')
  assert.equal(conflict.record.targets[0].error.code, 'EVERSIONEXISTS')
  log('a different artifact on an existing version is rejected')


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
  // Removing a maintainer revokes their write access irreversibly, so it needs force.
  const ownerGuard = await service.npmChangeOwner({ name: '@acme/demo-pkg', user: 'teammate', action: 'remove', otp: '123456' }).catch((error) => error)
  assert.equal(serializeError(ownerGuard).code, 'ECONFIRM')
  await service.npmChangeOwner({ name: '@acme/demo-pkg', user: 'teammate', action: 'remove', otp: '123456', force: true })
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
  // Every help link the error hands the user must be a real npm route.
  // `/settings/~/two-factor-authentication` looks plausible but 404s on npm;
  // the working route is `/settings/~/tfa`.
  assert.equal(serialized2fa.details.npmTwoFactorPage, 'https://www.npmjs.com/settings/~/tfa')
  for (const [key, url] of Object.entries(serialized2fa.details)) {
    if (key === 'authKind' || typeof url !== 'string' || !url.startsWith('http')) continue
    assert.ok(
      !/two-factor-authentication/.test(url),
      `${key} must not point at the 404 route: ${url}`,
    )
  }
  registry.state.requireOtp = null
  log('2FA-missing-account is distinguished from a wrong OTP, with a working 2FA URL')

  const ghConnected = await service.githubConnectPat({ token: github.token })
  assert.equal(ghConnected.github.login, 'shiptester')
  assert.equal(service.githubPublicStatus().scopes.join(','), 'repo,workflow')
  log('GitHub PAT verified and stored without exposure')

  // A partially successful publish (npm ok, GitHub failed) must be retryable as
  // a whole: npm is skipped when the artifact is identical, GitHub is retried.
  const retryDir = await mkdtemp(join(tmpdir(), 'ship-retry-'))
  createdFixtures.push(retryDir)
  await writeFile(join(retryDir, 'package.json'), JSON.stringify({ name: '@acme/retry-pkg', version: '1.0.0', description: 'd' }))
  await writeFile(join(retryDir, 'i.js'), 'x\n')
  const partial = await service.publish({
    dir: retryDir,
    targets: ['npm', 'github-release'],
    otp: '123456',
    github: { owner: 'shiptester', repo: 'retry-missing-repo', create: false },
  })
  assert.equal(partial.ok, false)
  assert.equal(partial.record.targets[0].ok, true, 'npm should have succeeded')
  assert.equal(partial.record.targets[1].error.code, 'ENOREPO')

  const retried = await service.publish({
    dir: retryDir,
    targets: ['npm', 'github-release'],
    otp: '123456',
    github: { owner: 'shiptester', repo: 'retry-ok-repo', create: true },
  })
  assert.equal(retried.ok, true, 'retrying must not fail on the already-published npm version')
  assert.equal(retried.record.targets[0].skipped, true, 'npm must be skipped when the artifact is identical')
  assert.equal(retried.record.targets[1].ok, true, 'the previously failed target must now run')
  log('a partially successful publish can be retried as a whole')

  // A full retry must also survive the release already existing: the tag was
  // created by the first attempt, so createRelease would 422 without reuse.
  const releaseRetryDir = await mkdtemp(join(tmpdir(), 'ship-relretry-'))
  createdFixtures.push(releaseRetryDir)
  await writeFile(join(releaseRetryDir, 'package.json'), JSON.stringify({ name: '@acme/relretry-pkg', version: '1.0.0', description: 'd' }))
  await writeFile(join(releaseRetryDir, 'i.js'), 'x\n')
  const relOpts = { owner: 'shiptester', repo: 'relretry-repo', create: true, allowRemove: true, attachTarball: true }
  const firstRun = await service.publish({
    dir: releaseRetryDir, targets: ['npm', 'github-release'], otp: '123456', github: relOpts,
  })
  assert.equal(firstRun.ok, true, JSON.stringify(firstRun.record.targets.map((t) => t.error?.code)))
  const secondRun = await service.publish({
    dir: releaseRetryDir, targets: ['npm', 'github-release'], otp: '123456', github: relOpts,
  })
  assert.equal(secondRun.ok, true, 'a full retry must not fail on the existing release')
  assert.equal(secondRun.record.targets[0].skipped, true, 'npm must be skipped on retry')
  log('retrying a completed publish reuses the existing release')

  const repos = await service.githubRepos({ refresh: true })
  assert.equal(repos.items[0].fullName, 'shiptester/demo-repo')
  log('GitHub repository list works')

  const commitsBeforePush = github.state.commits.length
  const push = await service.githubPush({
    owner: 'shiptester', repo: 'demo-repo', dir: fixture2, branch: 'main', create: false,
  })
  assert.equal(push.ok, true)
  assert.equal(push.fileCount, preview.fileCount)
  assert.equal(github.state.commits.length, commitsBeforePush + 1)
  assert.equal(github.state.refs.get('demo-repo:main'), push.commitSha)
  const lastTree = github.state.trees[github.state.trees.length - 1]
  assert.equal(lastTree.tree.length, preview.fileCount)
  log('GitHub push creates blobs, a tree, a commit and the branch ref')

  const assetsBefore = github.state.assets.length
  const releasesBefore = (await service.githubReleases({ owner: 'shiptester', repo: 'demo-repo' })).items.length
  const release = await service.githubRelease({
    owner: 'shiptester', repo: 'demo-repo', tag: 'v1.2.4', name: 'Demo v1.2.4', body: 'notes', assetDir: fixture2,
  })
  assert.equal(release.ok, true)
  assert.equal(github.state.assets.length, assetsBefore + 1)
  assert.ok(github.state.assets[github.state.assets.length - 1].data.length > 0)
  const releaseList = await service.githubReleases({ owner: 'shiptester', repo: 'demo-repo' })
  assert.equal(releaseList.items.length, releasesBefore + 1)
  await service.githubDeleteRelease({ owner: 'shiptester', repo: 'demo-repo', releaseId: releaseList.items[0].id, force: true })
  const remaining = await service.githubReleases({ owner: 'shiptester', repo: 'demo-repo' })
  assert.equal(remaining.items.length, releasesBefore)
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

  // release_status must stay inside the tool-output budget: status() no longer
  // inlines history, and the tool passes the compacted summary instead.
  const agentPayload = JSON.stringify({ status: service.status(), history: service.historySummary(10) })
  assert.ok(agentPayload.length <= 12000, `release_status payload too large: ${agentPayload.length}`)
  assert.equal(service.status().recentHistory, undefined)
  assert.equal(service.status().lastRecord === null || typeof service.status().lastRecord === 'object', true)
  const panel = service.panelStatus()
  assert.ok(Array.isArray(panel.recentHistory))
  assert.ok(Array.isArray(panel.recentProjects))
  log('agent status payload stays under the output limit; panel status keeps previews')

  // npm accepts a space between an operator and its version, and the tool
  // schema advertises that form; it must not be reported as "no match".
  for (const range of ['>= 2.0.0', '< 3.0.0', '^ 1.2.0', '>= 2.0.0 < 3.0.0']) {
    assert.doesNotThrow(() => parseRange(range), `range should parse: ${range}`)
  }
  assert.equal(satisfies('2.5.0', '>= 2.0.0'), true)
  assert.equal(satisfies('2.5.0', '< 3.0.0'), true)
  assert.equal(satisfies('2.5.0', '^ 1.2.0'), false)
  // npm reads a partial upper bound as the whole minor: `<=2.3` means `<2.4.0`,
  // which is what a hyphen range such as `1.2.3 - 2.3` lowers to.
  assert.equal(satisfies('2.3.9', '1.2.3 - 2.3'), true)
  assert.equal(satisfies('2.4.0', '1.2.3 - 2.3'), false)
  assert.equal(satisfies('2.9.9', '1 - 2'), true)
  assert.equal(satisfies('1.2.9', '<=1.2'), true)
  assert.equal(satisfies('1.3.0', '<=1.2'), false)
  log('spaced and partial comparator ranges follow npm semantics')

  // A preflight must fail when npm would reject the publish outright, because
  // the panel blocks the publish button on any failed preflight target.
  const unscoped = await makeFixture('1.3.0', 'plain-pkg')
  const restrictedDry = await service.publish({
    dir: unscoped, targets: ['npm'], access: 'restricted', dryRun: true,
  })
  assert.equal(restrictedDry.ok, false, 'restricted + unscoped must fail preflight')
  assert.equal(restrictedDry.record.targets[0].error.code, 'EUNSCOPED')
  log('preflight rejects restricted on an unscoped package')

  // github_publish documents that `owner` defaults to the connected login; the
  // service must actually apply that default rather than failing with EINVALID.
  const pushNoOwner = await service.githubPush({
    repo: 'owner-default-repo', dir: fixture, create: true, private: false,
  })
  assert.equal(pushNoOwner.ok, true, JSON.stringify(pushNoOwner))
  assert.equal(pushNoOwner.owner, 'shiptester')
  const releasesNoOwner = await service.githubReleases({ repo: 'owner-default-repo' })
  assert.equal(releasesNoOwner.ok, true)
  log('GitHub owner defaults to the connected login')

  // Regression: packing used to drop every file that was not force-included,
  // producing a package containing only package.json. A published tarball must
  // carry the real source files, and `.npmignore` directory rules must exclude
  // their contents (`dist/` also drops `dist/a.js`).
  const { packProject } = await import('../lib/pack.js')
  const packDir = await mkdtemp(join(tmpdir(), 'ship-pack-'))
  createdFixtures.push(packDir)
  await writeFile(join(packDir, 'package.json'), JSON.stringify({ name: 'pack-test', version: '1.0.0', description: 'd' }))
  await writeFile(join(packDir, 'index.js'), 'module.exports = 1\n')
  await writeFile(join(packDir, 'keep.js'), 'keep\n')
  await mkdir(join(packDir, 'dist'))
  await writeFile(join(packDir, 'dist', 'a.js'), 'a\n')
  const packed = await packProject(packDir)
  const packedPaths = packed.files.map((file) => file.path)
  assert.ok(packedPaths.includes('index.js'), `index.js missing from tarball: ${packedPaths.join(',')}`)
  assert.ok(packedPaths.includes('keep.js'), `keep.js missing from tarball: ${packedPaths.join(',')}`)
  assert.ok(packedPaths.includes('package.json'))
  log('tarball keeps ordinary source files')

  await writeFile(join(packDir, '.npmignore'), 'dist/\n')
  const packedIgnored = await packProject(packDir)
  const ignoredPaths = packedIgnored.files.map((file) => file.path)
  assert.equal(ignoredPaths.includes('dist/a.js'), false, 'dist/ must exclude dist/a.js')
  assert.ok(ignoredPaths.includes('keep.js'), '.npmignore must not drop unrelated files')
  log('.npmignore directory rules exclude their contents')

  // A modern package may expose entry points only through `exports`; a `files`
  // allow-list that omits them must not ship a package that cannot be imported.
  const exportDir = await mkdtemp(join(tmpdir(), 'ship-exports-'))
  createdFixtures.push(exportDir)
  await writeFile(join(exportDir, 'package.json'), JSON.stringify({
    name: 'export-test', version: '1.0.0', files: ['index.js'],
    exports: { '.': './dist/index.mjs' }, main: 'index.js',
  }))
  await writeFile(join(exportDir, 'index.js'), 'module.exports = 1\n')
  await mkdir(join(exportDir, 'dist'))
  await writeFile(join(exportDir, 'dist', 'index.mjs'), 'export default 1\n')
  const packedExports = await packProject(exportDir)
  const exportPaths = packedExports.files.map((file) => file.path)
  assert.ok(exportPaths.includes('dist/index.mjs'), `exports target missing: ${exportPaths.join(',')}`)
  log('exports entry points are always shipped')

  // A broken `main` must be reported instead of shipping silently.
  const brokenMainDir = await mkdtemp(join(tmpdir(), 'ship-badmain-'))
  createdFixtures.push(brokenMainDir)
  await writeFile(join(brokenMainDir, 'package.json'), JSON.stringify({
    name: 'broken-main', version: '1.0.0', files: ['index.js'], main: './lib/main.js',
  }))
  await writeFile(join(brokenMainDir, 'index.js'), 'x\n')
  const packedBroken = await packProject(brokenMainDir)
  assert.ok(
    packedBroken.warnings.some((warning) => warning.includes('lib/main.js')),
    `expected a warning about the missing main, got: ${JSON.stringify(packedBroken.warnings)}`,
  )
  log('a missing main entry produces a warning')

  // `files` entries with a trailing slash (`"lib/"`) are common and must behave
  // exactly like `"lib"` — the whole subtree included, nothing else.
  const slashDir = await mkdtemp(join(tmpdir(), 'ship-slash-'))
  createdFixtures.push(slashDir)
  await writeFile(join(slashDir, 'package.json'), JSON.stringify({ name: 'slash-test', version: '1.0.0', files: ['lib/'] }))
  await mkdir(join(slashDir, 'lib'))
  await writeFile(join(slashDir, 'lib', 'main.js'), 'm\n')
  await writeFile(join(slashDir, 'top.js'), 't\n')
  const packedSlash = await packProject(slashDir)
  const slashPaths = packedSlash.files.map((file) => file.path)
  assert.ok(slashPaths.includes('lib/main.js'), `"lib/" must include the subtree: ${slashPaths.join(',')}`)
  assert.equal(slashPaths.includes('top.js'), false, `"lib/" must exclude siblings: ${slashPaths.join(',')}`)
  log('files entries with a trailing slash include their subtree')

  // Pushing to GitHub publishes file contents, so credential files must never
  // be uploaded even when git tracks them (a committed .npmrc holds the token).
  const { walkForGit } = await import('../lib/pack.js')
  const secretDir = await mkdtemp(join(tmpdir(), 'ship-secret-'))
  createdFixtures.push(secretDir)
  try {
    execFileSync('git', ['init', '-q', secretDir])
    await writeFile(join(secretDir, 'index.js'), 'x\n')
    await writeFile(join(secretDir, '.env'), 'SECRET=1\n')
    await writeFile(join(secretDir, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_leak\n')
    execFileSync('git', ['-C', secretDir, 'add', '-A'])
    const walked = await walkForGit(secretDir)
    const walkedPaths = walked.files.map((file) => file.path)
    assert.equal(walkedPaths.includes('.env'), false, '`.env` must not be pushed')
    assert.equal(walkedPaths.includes('.npmrc'), false, '`.npmrc` must not be pushed')
    assert.ok(walkedPaths.includes('index.js'))
    assert.ok(walked.warnings.some((warning) => warning.includes('.npmrc')), 'skipping a secret should warn')
  } catch (error) {
    if (error && /git/i.test(String(error.message))) {
      log('git not available; skipped the GitHub secret-file test')
    } else {
      throw error
    }
  }
  log('credential files are never pushed to GitHub')

  // A push is built from working-tree bytes, not from local git history, so it
  // must say so and warn when the local branch is ahead of the remote head.
  const aheadDir = await mkdtemp(join(tmpdir(), 'ship-ahead-'))
  createdFixtures.push(aheadDir)
  try {
    execFileSync('git', ['init', '-q', aheadDir])
    await writeFile(join(aheadDir, 'index.js'), 'x\n')
    execFileSync('git', ['-C', aheadDir, 'add', '-A'])
    execFileSync('git', ['-C', aheadDir, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    const gi = await inspectLocalGit(aheadDir)
    assert.equal(gi.isRepo, true)
    assert.equal(typeof gi.head, 'string')
    assert.equal(gi.clean, true)
    // Working tree dirty -> the count must be reported, not swallowed.
    await writeFile(join(aheadDir, 'extra.js'), 'y\n')
    const dirty = await inspectLocalGit(aheadDir)
    assert.equal(dirty.clean, false)
    assert.ok(dirty.dirtyCount >= 1)
  } catch (error) {
    if (error && /git/i.test(String(error.message))) log('git not available; skipped the local-git-state test')
    else throw error
  }
  log('local git state is inspected before a push')

  // EOL normalisation must follow .gitattributes and never corrupt binary data.
  const { readEolPolicy, normalizeEol } = await import('../lib/pack.js')
  const eolDir = await mkdtemp(join(tmpdir(), 'ship-eol-'))
  createdFixtures.push(eolDir)
  await writeFile(join(eolDir, '.gitattributes'), '*.js text eol=lf\n*.bat text eol=crlf\n*.png binary\n')
  const eolPolicy = await readEolPolicy(eolDir)
  const crlf = Buffer.from('a\r\nb\r\n', 'utf8')
  assert.equal(normalizeEol(crlf, 'src/a.js', eolPolicy).toString(), 'a\nb\n', 'eol=lf must normalise CRLF to LF')
  assert.equal(normalizeEol(crlf, 'run.bat', eolPolicy).toString(), 'a\r\nb\r\n', 'eol=crlf must keep CRLF')
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
  assert.deepEqual([...normalizeEol(png, 'x.png', eolPolicy)], [...png], 'binary bytes must never be rewritten')
  const invalidUtf8 = Buffer.from([0xff, 0x0d, 0x0a, 0xfe])
  assert.deepEqual([...normalizeEol(invalidUtf8, 'blob.js', eolPolicy)], [...invalidUtf8], 'non-UTF-8 bytes must stay untouched')
  log('line endings follow .gitattributes without corrupting binaries')

  // End-to-end against a REAL git repository: the blob the tool uploads for a
  // CRLF file must be byte-identical to what `git show HEAD:<file>` stores.
  // This is the check that a mock without git can never perform.
  const e2eDir = await mkdtemp(join(tmpdir(), 'ship-e2e-git-'))
  createdFixtures.push(e2eDir)
  try {
    execFileSync('git', ['init', '-q', e2eDir])
    await writeFile(join(e2eDir, '.gitattributes'), '*.js text eol=lf\n')
    await writeFile(join(e2eDir, 'a.js'), 'line1\r\nline2\r\n')
    execFileSync('git', ['-C', e2eDir, 'add', '-A'])
    execFileSync('git', ['-C', e2eDir, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    const gitStored = execFileSync('git', ['-C', e2eDir, 'show', 'HEAD:a.js'], { encoding: 'buffer' })

    const pushClient = new GitHubClient({ network, token: github.token, apiBase: github.url })
    const pushResult = await pushClient.pushDirectory({
      owner: 'shiptester', repo: 'demo-repo', dir: e2eDir, branch: 'main', message: 'e2e', syncMode: 'replace', allowRemove: true,
    })
    assert.equal(pushResult.ok, true)
    assert.equal(pushResult.source, 'working-tree')
    const uploadedTree = github.state.trees.at(-1)
    const uploadedEntry = uploadedTree.tree.find((node) => node.path === 'a.js')
    const uploadedBytes = Buffer.from(github.state.blobs.get(uploadedEntry.sha), 'base64')
    assert.deepEqual([...uploadedBytes], [...gitStored], 'uploaded bytes must equal what git would store')
  } catch (error) {
    if (error && /git/i.test(String(error.message)) && !/assert/i.test(String(error.name))) {
      log('git not available; skipped the end-to-end git byte test')
    } else {
      throw error
    }
  }
  log('uploaded blobs are byte-identical to git-stored blobs')

  // Push must offer a read-only preflight, like npm publish's dryRun.
  const previewDir = await mkdtemp(join(tmpdir(), 'ship-preview-'))
  createdFixtures.push(previewDir)
  await writeFile(join(previewDir, 'package.json'), JSON.stringify({ name: 'preview-pkg', version: '1.0.0' }))
  await writeFile(join(previewDir, 'a.js'), 'x\r\n')
  await writeFile(join(previewDir, '.gitattributes'), '*.js text eol=lf\n')
  const beforeCommits = github.state.commits.length
  const previewed = await service.githubPush({
    owner: 'shiptester', repo: 'demo-repo', dir: previewDir, branch: 'main', dryRun: true,
  })
  assert.equal(previewed.dryRun, true)
  assert.ok(previewed.fileCount >= 2, `preview should list files: ${JSON.stringify(previewed)}`)
  assert.equal(previewed.eolNormalized, 1, 'preview must report the CRLF file that would be normalised')
  assert.equal(github.state.commits.length, beforeCommits, 'a preview must not create a commit')
  assert.equal(typeof previewed.commitSha, 'undefined', 'a preview has no commit sha')
  log('push preview reports the plan without writing')

  // Deletion is irreversible, so replace mode must refuse to shrink the remote
  // unless the caller opts in. A warning alone is not enough: an agent that
  // only reads `ok` would silently lose remote files.
  const rmDir = await mkdtemp(join(tmpdir(), 'ship-rm-'))
  createdFixtures.push(rmDir)
  await writeFile(join(rmDir, 'keep.js'), 'k\n')
  await writeFile(join(rmDir, 'gone.js'), 'g\n')
  await service.githubPush({
    owner: 'shiptester', repo: 'demo-repo', dir: rmDir, branch: 'main', syncMode: 'replace', allowRemove: true,
  })
  await rm(join(rmDir, 'gone.js'))
  const blocked = await service.githubPush({
    owner: 'shiptester', repo: 'demo-repo', dir: rmDir, branch: 'main', syncMode: 'replace',
  }).catch((error) => error)
  assert.equal(serializeError(blocked).code, 'EREMOVE')
  assert.ok(serializeError(blocked).details.removed.includes('gone.js'))
  const allowed = await service.githubPush({
    owner: 'shiptester', repo: 'demo-repo', dir: rmDir, branch: 'main', syncMode: 'replace', allowRemove: true,
  })
  assert.equal(allowed.ok, true)
  assert.deepEqual(allowed.removed, ['gone.js'])
  log('replace deletions require an explicit allowRemove')

  // The tool schema must expose allowRemove, otherwise a model can never opt in
  // and EREMOVE becomes a dead end. Assert the wiring end to end: schema ->
  // tool arg -> service -> github client.
  const { createTools } = await import('../lib/tools.js')
  const toolList = createTools(service, {}, {})
  const githubTool = toolList.find((tool) => tool.name === 'github_publish')
  assert.ok(githubTool, 'github_publish tool must exist')
  const allowRemoveSchema = githubTool.parameters?.properties?.allowRemove
  assert.ok(allowRemoveSchema, 'github_publish must declare allowRemove')
  assert.equal(allowRemoveSchema.type, 'boolean')
  const pushDrySchema = githubTool.parameters?.properties?.dryRun
  assert.ok(pushDrySchema, 'github_publish must declare dryRun for push previews')
  log('github_publish schema exposes allowRemove and dryRun')

  // publish_package pushes to GitHub through the github-release target, so it
  // must expose allowRemove too — otherwise publishing a shrunken directory is
  // a dead end (EREMOVE with no way to opt in).
  const publishTool = toolList.find((tool) => tool.name === 'publish_package')
  assert.ok(publishTool, 'publish_package tool must exist')
  assert.ok(
    publishTool.parameters?.properties?.allowRemove,
    'publish_package must declare allowRemove for the github-release target',
  )
  log('publish_package schema exposes allowRemove')

  // End-to-end: the github-release target must honour allowRemove, otherwise a
  // shrinking project can never be published.
  const shrinkDir = await mkdtemp(join(tmpdir(), 'ship-shrink-'))
  createdFixtures.push(shrinkDir)
  await writeFile(join(shrinkDir, 'package.json'), JSON.stringify({ name: 'shrink-pkg', version: '1.0.0', description: 'd' }))
  await writeFile(join(shrinkDir, 'a.js'), 'a\n')
  await writeFile(join(shrinkDir, 'b.js'), 'b\n')
  const firstShrink = await service.publish({
    dir: shrinkDir,
    targets: ['github-release'],
    github: { owner: 'shiptester', repo: 'shrink-repo', create: true, allowRemove: true },
  })
  assert.equal(firstShrink.ok, true, JSON.stringify(firstShrink.record.targets[0]))
  await rm(join(shrinkDir, 'b.js'))
  const noOptIn = await service.publish({
    dir: shrinkDir,
    targets: ['github-release'],
    github: { owner: 'shiptester', repo: 'shrink-repo' },
  })
  assert.equal(noOptIn.ok, false, 'shrinking must be rejected without allowRemove')
  assert.equal(noOptIn.record.targets[0].error.code, 'EREMOVE')
  const optIn = await service.publish({
    dir: shrinkDir,
    targets: ['github-release'],
    github: { owner: 'shiptester', repo: 'shrink-repo', allowRemove: true },
  })
  assert.equal(optIn.ok, true, JSON.stringify(optIn.record.targets[0]))
  log('github-release publishes honour allowRemove')

  // The tool result's `ok` must reflect the operation, not just "the call did
  // not throw". A partially failed publish previously reported ok:true, so a
  // caller reading only `ok` believed the publish succeeded.
  const guardDir = await mkdtemp(join(tmpdir(), 'ship-toolok-'))
  createdFixtures.push(guardDir)
  await writeFile(join(guardDir, 'package.json'), JSON.stringify({ name: '@acme/toolok-pkg', version: '1.0.0', description: 'd' }))
  await writeFile(join(guardDir, 'index.js'), 'export const a = 1\n')
  const toolList2 = createTools(service, {}, { toolPaths: [guardDir] })
  const npmPublish = toolList2.find((tool) => tool.name === 'npm_publish')
  const firstOk = await npmPublish.execute({ dir: guardDir, otp: '123456' })
  assert.equal(firstOk.ok, true, JSON.stringify(firstOk.summary))

  // An identical retry is idempotent (skipped), so it must still be ok:true.
  const retryOk = await npmPublish.execute({ dir: guardDir, otp: '123456' })
  assert.equal(retryOk.ok, true, 'an identical retry is a skip, not a failure')
  assert.match(String(retryOk.summary), /跳过/)

  // Changing the shipped bytes makes the same version a real conflict, and that
  // must surface as ok:false so a caller reading only `ok` does not miss it.
  await writeFile(join(guardDir, 'index.js'), 'export const a = 2\n')
  const secondFail = await npmPublish.execute({ dir: guardDir, otp: '123456' })
  assert.equal(secondFail.ok, false, 'a real conflict must report ok:false at the tool level')
  assert.match(String(secondFail.summary), /失败/)
  assert.equal(secondFail.data.record.targets[0].error.code, 'EVERSIONEXISTS')
  log('tool ok reflects publish success, not just absence of a throw')

  // "Not connected" is unconfigured, not a failure: it must stay ok:true so a
  // caller does not treat "user has not signed in yet" as an error to report.
  const offlineHome = await mkdtemp(join(tmpdir(), 'ship-offline-'))
  createdFixtures.push(offlineHome)
  await mkdir(join(offlineHome, '.dsh-release-depot'), { recursive: true })
  const offlineService = new ShipDeck({
    config: { npmRegistry: registry.url },
    network,
    store: new ShipDeckStore({ home: offlineHome }),
  })
  const offlineNpm = createTools(offlineService, {}, {}).find((tool) => tool.name === 'npm_registry')
  const notConnected = await offlineNpm.execute({ action: 'whoami' })
  assert.equal(notConnected.ok, true, 'not connected must not be reported as a failure')
  assert.match(String(notConnected.summary), /未登录/)
  log('whoami treats "not connected" as unconfigured, not failure')

  // Package names reach the registry as URL path segments, so an unvalidated
  // name could traverse to another endpoint with the user's token attached.
  for (const badName of ['../../-/npm/v1/tokens', 'x/../y', 'a/b/c']) {
    const distTagsGuard = await service.npmDistTags({ name: badName }).catch((error) => error)
    assert.equal(serializeError(distTagsGuard).code, 'ENAME', `dist-tags must reject ${badName}`)
    const deleteGuard = await service.npmDeleteTag({ name: badName, tag: 'latest' }).catch((error) => error)
    assert.equal(serializeError(deleteGuard).code, 'ENAME', `delete-dist-tag must reject ${badName}`)
  }
  log('package names are validated before becoming URL paths')

  // A bad dist-tag must fail the preflight too, not just the real publish.
  const badTagDry = await service.publish({ dir: fixture, targets: ['npm'], tag: '-bad', dryRun: true }).catch((error) => error)
  assert.equal(serializeError(badTagDry).code, 'ETAGINVALID')
  let badPrefs = null
  try {
    service.setPrefs({ tag: '-bad' })
  } catch (error) {
    badPrefs = error
  }
  assert.equal(serializeError(badPrefs).code, 'ETAGINVALID')
  log('invalid dist-tag is rejected in preflight and in preferences')

  // An unparseable range must not be reported as "no version matches", which
  // would tempt the caller to retry with `*` and deprecate every version.
  const badRange = await service.npmDeprecate({ name: '@acme/demo-pkg', range: 'not-a-range', message: 'x', otp: '123456' }).catch((error) => error)
  assert.equal(serializeError(badRange).code, 'EINVALIDRANGE')
  log('invalid semver range reports EINVALIDRANGE, not ENOVERSIONS')

  // Proxy credentials must never reach the panel or the model.
  const previousProxy = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = 'http://alice:s3cret@proxy.local:8080'
  try {
    const proxied = await service.diagnostics({})
    const serialized = JSON.stringify(proxied.network)
    assert.equal(serialized.includes('s3cret'), false, 'proxy password leaked')
    assert.equal(serialized.includes('alice'), false, 'proxy username leaked')
  } finally {
    if (previousProxy === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = previousProxy
  }
  log('proxy credentials are redacted from diagnostics')

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