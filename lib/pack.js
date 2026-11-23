/**
 * dsh-release-depot — package packer and directory walker.
 *
 * npm publish needs a gzipped ustar tarball whose paths live under
 * `package/`. This module builds that tarball without npm, pacote or tar
 * dependencies, applying the inclusion rules users expect:
 *
 *  - `files` in package.json wins; otherwise `.npmignore`, falling back to
 *    `.gitignore`, with `!` re-includes and trailing-slash directory rules;
 *  - node_modules / VCS directories / lockfiles / .npmrc never ship;
 *  - package.json, README*, LICENSE*, CHANGELOG* and the `main`/`bin` files
 *    always ship, as npm documents;
 *  - symlinks are skipped (npm does not publish them), empty dirs are
 *    omitted, and size/count limits produce a clear error instead of a
 *    registry rejection.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { isValidPackageName, isValidVersion, parseGitHubRepo } from './semver.js'

const execFileAsync = promisify(execFile)

export class PackError extends Error {
  constructor(message, code = 'EPACK') {
    super(message)
    this.name = 'PackError'
    this.code = code
  }
}

const HARD_EXCLUDES = new Set([
  '.git', '.svn', '.hg', 'CVS', 'node_modules',
])
const HARD_EXCLUDE_FILES = new Set([
  '.DS_Store', '.npmrc', '.npmignore', '.gitignore',
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'npm-debug.log', 'yarn-error.log', '.env', '.env.local',
  '.github-ca-cache.pem',
])

/**
 * Files that hold credentials. They are excluded from GitHub pushes even when
 * git tracks them, because pushing publishes their contents publicly.
 */
const SECRET_FILES = new Set([
  '.env', '.env.local', '.env.development', '.env.production', '.env.test',
  '.npmrc', '.yarnrc', '.pypirc', '.netrc', '.git-credentials',
  'id_rsa', 'id_ed25519', '.htpasswd',
])
const ALWAYS_INCLUDE = [
  /^package\.json$/i,
  /^readme(\.[a-z0-9]+)?$/i,
  /^licen[cs]e(\.[a-z0-9]+)?$/i,
  /^licen[cs]e$/i,
  /^copying(\.[a-z0-9]+)?$/i,
  /^changelog(\.[a-z0-9]+)?$/i,
  /^changes(\.[a-z0-9]+)?$/i,
  /^history(\.[a-z0-9]+)?$/i,
]

const MAX_FILES_DEFAULT = 3000
const MAX_FILE_BYTES_DEFAULT = 100 * 1024 * 1024
const MAX_TOTAL_BYTES_DEFAULT = 50 * 1024 * 1024
const MAX_GIT_FILES_DEFAULT = 3000
const MAX_GIT_TOTAL_DEFAULT = 80 * 1024 * 1024

function toPosix(value) {
  return value.split(sep).join('/')
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

/** Convert one ignore-style glob to a RegExp over a root-relative POSIX path. */
function globToRegExp(glob, options = {}) {
  let pattern = glob.trim().replace(/^!/, '')
  if (pattern === '') return null
  const anchored = pattern.startsWith('/')
  if (anchored) pattern = pattern.slice(1)
  const dirOnly = pattern.endsWith('/')
  if (dirOnly) pattern = pattern.slice(0, -1)
  if (pattern === '') return null

  const hasSlash = pattern.includes('/')
  let regex = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        const after = pattern[index + 2]
        if (after === '/') {
          regex += '(?:.*/)?'
          index += 2
          continue
        }
        regex += '.*'
        index += 1
        continue
      }
      regex += '[^/]*'
      continue
    }
    if (char === '?') {
      regex += '[^/]'
      continue
    }
    if (char === '[') {
      const close = pattern.indexOf(']', index + 1)
      if (close > index + 1) {
        let body = pattern.slice(index + 1, close)
        if (body.startsWith('!')) body = `^${body.slice(1)}`
        regex += `[${body.replace(/\\/g, '\\\\')}]`
        index = close
        continue
      }
    }
    if (char === '\\' && index + 1 < pattern.length) {
      regex += escapeRegExp(pattern[index + 1])
      index += 1
      continue
    }
    regex += escapeRegExp(char)
  }

  const prefix = anchored || hasSlash ? '^' : '(?:^|.*/)'
  const suffix = dirOnly ? '(?:/.*)?$' : '$'
  try {
    return new RegExp(`${prefix}${regex}${suffix}`, 'i')
  } catch {
    return null
  }
}

/** Ordered ignore matcher (last matching rule wins). */
export function createIgnoreMatcher(lines) {
  const rules = []
  for (const raw of lines) {
    if (typeof raw !== 'string') continue
    const line = raw.replace(/\r$/, '')
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const negate = trimmed.startsWith('!')
    const body = negate ? trimmed.slice(1) : trimmed
    if (body === '') continue
    const regex = globToRegExp(body)
    if (regex === null) continue
    rules.push({ regex, negate, dirOnly: body.endsWith('/'), path: body.replace(/\/+$/, '') })
  }
  return {
    /** True when the path is ignored by the accumulated rules. */
    matches(path, isDir) {
      let ignored = false
      for (const rule of rules) {
        if (rule.dirOnly && !isDir) continue
        if (rule.regex.test(path)) ignored = !rule.negate
      }
      return ignored
    },
    /**
     * Like `matches` but a directory-only rule also covers its contents
     * (`dist/` must ignore `dist/a.js`, exactly like npm). Called for files
     * whose parent directory already matched a non-pruned ignore rule.
     */
    negated(path) {
      for (const rule of rules) {
        if (!rule.negate) continue
        const body = rule.path ?? ''
        if (rule.regex.test(path) || (body !== '' && path === body)) return true
      }
      return false
    },
  }
}

/**
 * Matcher for the `files` field, which anchors every entry at the root.
 * Literal entries also match their subtree (`lib` ships `lib/**`), matching
 * npm-packlist behavior.
 */
function createFilesMatcher(entries) {
  const rules = []
  for (const raw of entries) {
    if (typeof raw !== 'string') continue
    const negate = raw.startsWith('!')
    let body = (negate ? raw.slice(1) : raw).trim()
    if (body === '' || body === '.' || body === './') {
      rules.push({ regex: /^.*$/, negate, dirOnly: false, literal: false, base: '' })
      continue
    }
    body = body.replace(/^\.\//, '')
    const dirOnly = body.endsWith('/')
    if (dirOnly) body = body.slice(0, -1)
    let regex
    const literal = !/[*?[\]]/.test(body)
    if (literal) {
      regex = new RegExp(`^${escapeRegExp(body)}(?:/.*)?$`)
    } else {
      regex = globToRegExp(`/${body}`)
    }
    if (regex === null) continue
    rules.push({ regex, negate, dirOnly, literal, base: literal ? body : null })
  }
  function lastMatch(path, isDir) {
    let verdict = null
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue
      if (rule.regex.test(path)) verdict = !rule.negate
    }
    return verdict
  }
  return {
    pruneDirs: false,
    matches(path, isDir) {
      const verdict = lastMatch(path, isDir)
      return verdict === true
    },
    /** True when the path is included because an ancestor directory was. */
    negated(path) {
      let negated = false
      for (const rule of rules) {
        if (!rule.negate) continue
        if (rule.regex.test(path)) negated = true
      }
      return negated
    },
    hasRules: rules.length > 0,
  }
}

async function readManifest(dir) {
  const file = join(dir, 'package.json')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw new PackError(`目录里没有 package.json：${dir}`, 'ENOENT')
  }
  let manifest
  try {
    manifest = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new PackError(`package.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, 'EJSON')
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new PackError('package.json 必须是 JSON 对象', 'EJSON')
  }
  return manifest
}

/** Flatten every relative target named by a package.json `exports` value. */
function collectExportTargets(exports, out) {
  if (typeof exports === 'string') {
    const clean = exports.trim().replace(/^\.\//, '')
    if (clean !== '' && clean.startsWith('./') === false && !clean.startsWith('..')) out.push(clean)
    return
  }
  if (Array.isArray(exports)) {
    for (const item of exports) collectExportTargets(item, out)
    return
  }
  if (exports !== null && typeof exports === 'object') {
    for (const value of Object.values(exports)) collectExportTargets(value, out)
  }
}

function collectAlwaysInclude(manifest) {
  const names = []
  if (typeof manifest.main === 'string' && manifest.main.trim() !== '') {
    names.push(manifest.main.trim().replace(/^\.\//, ''))
  }
  if (typeof manifest.browser === 'string' && manifest.browser.trim() !== '') {
    names.push(manifest.browser.trim().replace(/^\.\//, ''))
  }
  if (typeof manifest.types === 'string' && manifest.types.trim() !== '') {
    names.push(manifest.types.trim().replace(/^\.\//, ''))
  }
  if (typeof manifest.typings === 'string' && manifest.typings.trim() !== '') {
    names.push(manifest.typings.trim().replace(/^\.\//, ''))
  }
  if (typeof manifest.bin === 'string') {
    names.push(manifest.bin.trim().replace(/^\.\//, ''))
  } else if (manifest.bin !== null && typeof manifest.bin === 'object') {
    for (const value of Object.values(manifest.bin)) {
      if (typeof value === 'string') names.push(value.trim().replace(/^\.\//, ''))
    }
  }
  // Modern packages expose entry points only through `exports`; a `files`
  // allow-list that omits them would ship a package that cannot be imported.
  if (manifest.exports !== undefined && manifest.exports !== null) {
    collectExportTargets(manifest.exports, names)
  }
  return names.filter((name) => name !== '' && !name.startsWith('..') && !name.includes('node_modules'))
}

async function readIgnoreFallback(dir) {
  for (const name of ['.npmignore', '.gitignore']) {
    try {
      const text = await readFile(join(dir, name), 'utf8')
      return text.split(/\r?\n/)
    } catch {
      /* next */
    }
  }
  return []
}

/**
 * List the files a publish would include.
 * @param {string} dir package directory
 * @param {object} manifest parsed package.json
 * @param {object} limits {maxFiles,maxFileBytes,maxTotalBytes}
 */
export async function collectPackageFiles(dir, manifest, limits = {}) {
  const maxFiles = limits.maxFiles ?? MAX_FILES_DEFAULT
  const maxFileBytes = limits.maxFileBytes ?? MAX_FILE_BYTES_DEFAULT
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_BYTES_DEFAULT

  const filesField = Array.isArray(manifest.files) ? manifest.files.filter((item) => typeof item === 'string') : null
  const matcher = filesField !== null && filesField.length > 0
    ? createFilesMatcher(filesField)
    : createIgnoreMatcher(await readIgnoreFallback(dir))
  const pruneDirs = filesField === null || filesField.length === 0
  const alwaysInclude = new Set(collectAlwaysInclude(manifest))
  const warnings = []
  const files = []
  let totalBytes = 0

  async function visit(absoluteDir, relativeDir, subtreeIncluded) {
    let entries
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true })
    } catch (error) {
      warnings.push(`无法读取目录 ${relativeDir || '.'}：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      const absolutePath = join(absoluteDir, entry.name)
      if (entry.isSymbolicLink()) {
        warnings.push(`已跳过符号链接：${relativePath}`)
        continue
      }
      if (entry.isDirectory()) {
        if (HARD_EXCLUDES.has(entry.name)) continue
        const dirMatched = matcher.matches(relativePath, true)
        if (pruneDirs && dirMatched) continue
        const subtree = pruneDirs ? false : subtreeIncluded || dirMatched
        await visit(absolutePath, relativePath, subtree)
        continue
      }
      if (!entry.isFile()) continue
      if (HARD_EXCLUDE_FILES.has(entry.name)) continue
      if (entry.name.startsWith('npm-debug.log')) continue
      if (entry.name.endsWith('.tgz') || entry.name.endsWith('.orig')) continue
      const includedByRules = subtreeIncluded
        // A directory matched an ignore rule and we are not pruning: keep the
        // subtree unless a `!` rule re-includes this exact path.
        ? !matcher.negated(relativePath)
        // `files` entries are an allow-list: unlisted paths are excluded.
        : pruneDirs
          ? !matcher.matches(relativePath, false)
          : matcher.matches(relativePath, false)
      const mustInclude = alwaysInclude.has(relativePath) || ALWAYS_INCLUDE.some((regex) => regex.test(relativePath))
      if (!includedByRules && !mustInclude) continue
      let info
      try {
        info = await stat(absolutePath)
      } catch {
        warnings.push(`已跳过无法读取的文件：${relativePath}`)
        continue
      }
      if (info.size > maxFileBytes) {
        throw new PackError(`文件过大（>${Math.round(maxFileBytes / 1024 / 1024)}MB）：${relativePath}`, 'EFBIG')
      }
      totalBytes += info.size
      if (totalBytes > maxTotalBytes) {
        throw new PackError(`打包总大小超过 ${Math.round(maxTotalBytes / 1024 / 1024)}MB，请精简 files 字段`, 'EFBIG')
      }
      files.push({ path: relativePath, absolutePath, size: info.size, mode: (info.mode & 0o111) !== 0 ? 0o755 : 0o644 })
      if (files.length > maxFiles) {
        throw new PackError(`文件数超过 ${maxFiles}，请精简 files 字段`, 'EMFILE')
      }
    }
  }

  await visit(dir, '', false)

  // `files` may name a file the walker skipped only because a parent was ignored;
  // verify every explicit non-glob entry exists so mistakes are visible early.
  if (filesField !== null) {
    for (const entry of filesField) {
      if (entry.startsWith('!') || /[*?[\]]/.test(entry) || entry.endsWith('/')) continue
      const clean = entry.replace(/^\.\//, '')
      if (!existsSync(join(dir, clean))) {
        warnings.push(`files 字段里的路径不存在：${entry}`)
      }
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (!files.some((file) => file.path === 'package.json')) {
    throw new PackError('打包列表里没有 package.json', 'EMISSING')
  }

  // Entry points must actually exist on disk; otherwise the package installs
  // fine and fails at require/import time with a confusing MODULE_NOT_FOUND.
  const shipped = new Set(files.map((file) => file.path))
  for (const entry of collectAlwaysInclude(manifest)) {
    // Glob entries (e.g. `locale/*.json` in the files list) name a set, not a
    // single shipable path; skip them rather than warn about a non-file.
    if (/[*?[\]]/.test(entry)) continue
    if (shipped.has(entry)) continue
    if (!existsSync(join(dir, entry))) {
      warnings.push(`package.json 里的入口不存在：${entry}`)
    } else {
      warnings.push(`入口 ${entry} 未被包含（检查 files 字段或忽略规则）`)
    }
  }
  return { files, warnings, totalBytes }
}

function writeOctal(buffer, offset, length, value) {
  const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0')
  buffer.write(text.slice(-(length - 1)), offset, length - 1, 'ascii')
  buffer[offset + length - 1] = 0
}

function tarHeader({ name, size, mtime, mode = 0o644, type = '0' }) {
  const header = Buffer.alloc(512, 0)
  let headerName = name
  let prefix = ''
  if (Buffer.byteLength(headerName) > 100) {
    const bytes = Buffer.from(headerName, 'utf8')
    let split = -1
    for (let index = bytes.length - 1; index >= 0; index -= 1) {
      if (bytes[index] === 0x2f && bytes.length - index - 1 <= 100 && index <= 155) {
        split = index
        break
      }
    }
    if (split <= 0) return null
    prefix = bytes.subarray(0, split).toString('utf8')
    headerName = bytes.subarray(split + 1).toString('utf8')
    if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(headerName) > 100) return null
  }
  header.write(headerName, 0, 100, 'utf8')
  writeOctal(header, 100, 8, mode)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, mtime)
  header.write('        ', 148, 8, 'ascii')
  header[156] = type.charCodeAt(0)
  header.write('ustar', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  header.write(prefix, 345, 155, 'utf8')
  let checksum = 0
  for (const byte of header) checksum += byte
  const octal = checksum.toString(8).padStart(6, '0')
  header.write(`${octal}\0 `, 148, 8, 'ascii')
  return header
}

function paxHeader(path) {
  const tail = Buffer.byteLength(` path=${path}\n`)
  let length = tail + 1
  let line = ''
  for (;;) {
    line = `${length} path=${path}\n`
    const actual = Buffer.byteLength(line)
    if (actual === length) break
    length = actual
  }
  const body = Buffer.from(line, 'utf8')
  const header = tarHeader({ name: 'PaxHeader', size: body.length, mtime: 0, mode: 0o644, type: 'x' })
  return { header, body }
}

/** Build a deterministic ustar.gz tarball for a package. */
export function buildTarball(files) {
  const chunks = []
  let unpackedSize = 0
  const fixedMtime = 1600000000
  for (const file of files) {
    const body = file.content ?? readFileSync(file.absolutePath)
    unpackedSize += body.length
    const path = `package/${file.path}`
    const mode = file.mode ?? 0o644
    let header = tarHeader({ name: path, size: body.length, mtime: file.mtime ?? fixedMtime, mode })
    if (header === null) {
      const pax = paxHeader(path)
      chunks.push(pax.header, pax.body, Buffer.alloc((512 - (pax.body.length % 512)) % 512))
      // The ustar entry is only a placeholder resolved by the PAX `path=` record
      // above; it must still carry the real mode. Truncate by BYTES, not chars,
      // or a CJK basename overflows the 100-byte field again and collides.
      let shortName = `package/${basename(file.path)}`
      if (Buffer.byteLength(shortName) > 100) {
        shortName = `package/${Buffer.from(basename(file.path), 'utf8').subarray(0, 80).toString('utf8')}`
      }
      header = tarHeader({ name: shortName, size: body.length, mtime: file.mtime ?? fixedMtime, mode })
      if (header === null) {
        header = tarHeader({ name: 'package/file', size: body.length, mtime: file.mtime ?? fixedMtime, mode })
      }
    }
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  const tar = Buffer.concat(chunks)
  const gz = gzipSync(tar, { level: 9 })
  return { data: gz, unpackedSize }
}

/**
 * Validate a manifest and pack the project.
 * @param {string} inputDir
 * @param {object} options {limits, manifestOverride}
 */
export async function packProject(inputDir, options = {}) {
  if (typeof inputDir !== 'string' || inputDir.trim() === '') {
    throw new PackError('请提供要发布的目录路径', 'EINVAL')
  }
  let dir
  try {
    dir = await realpath(resolve(inputDir.trim()))
  } catch {
    throw new PackError(`目录不存在：${inputDir}`, 'ENOENT')
  }
  const info = await stat(dir)
  if (!info.isDirectory()) throw new PackError(`不是目录：${dir}`, 'ENOTDIR')

  const manifest = options.manifestOverride ?? await readManifest(dir)
  if (typeof manifest.name !== 'string' || !isValidPackageName(manifest.name)) {
    throw new PackError(`package.json 的 name 不是合法 npm 包名：${String(manifest.name ?? '(缺失)')}`, 'ENAME')
  }
  if (typeof manifest.version !== 'string' || !isValidVersion(manifest.version)) {
    throw new PackError(`package.json 的 version 不是合法 SemVer：${String(manifest.version ?? '(缺失)')}`, 'EVERSION')
  }
  if (manifest.private === true) {
    throw new PackError('package.json 标记了 private: true，npm 拒绝发布；如确实要发布请先移除该字段', 'EPRIVATE')
  }
  if (manifest.packageExtensions !== undefined) {
    throw new PackError('packageExtensions 只能用于项目根，不能发布', 'EPACKAGEEXTENSIONS')
  }

  const { files, warnings, totalBytes } = await collectPackageFiles(dir, manifest, options.limits)
  for (const file of files) {
    file.content = await readFile(file.absolutePath)
  }
  const { data, unpackedSize } = buildTarball(files)

  const shasum = createHash('sha1').update(data).digest('hex')
  const sha512 = createHash('sha512').update(data).digest('base64')
  const integrity = `sha512-${sha512}`
  const tarballName = `${manifest.name}-${manifest.version}.tgz`

  const publishedManifest = { ...manifest }
  delete publishedManifest.packageExtensions
  publishedManifest._id = `${manifest.name}@${manifest.version}`
  publishedManifest.dist = {
    ...(publishedManifest.dist !== null && typeof publishedManifest.dist === 'object' ? publishedManifest.dist : {}),
    integrity,
    shasum,
  }

  const repository = typeof manifest.repository === 'string'
    ? manifest.repository
    : manifest.repository?.url
  const githubRepo = parseGitHubRepo(manifest.repository) ?? parseGitHubRepo(manifest.repository?.url)
  const readmeFile = files.find((file) => /^readme(\.[a-z0-9]+)?$/i.test(file.path) && file.size <= 512 * 1024)
  const readme = readmeFile !== undefined
    ? readmeFile.content.toString('utf8').replace(/^\uFEFF/, '').slice(0, 200000)
    : null

  return {
    ok: true,
    dir,
    manifest,
    publishedManifest,
    name: manifest.name,
    version: manifest.version,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    license: typeof manifest.license === 'string' ? manifest.license : '',
    private: manifest.private === true,
    files: files.map((file) => ({ path: file.path, size: file.size })),
    fileCount: files.length,
    unpackedSize,
    packedSize: data.length,
    tarballName,
    tarball: data,
    shasum,
    integrity,
    repository: typeof repository === 'string' ? repository : null,
    githubRepo,
    readme,
    totalBytes,
    warnings,
  }
}

/**
 * Inspect the local git state so a push can warn before it forks the history.
 *
 * A GitHub push built from the working tree creates a commit whose parent is
 * the REMOTE head. If the local branch has commits that were never pushed, that
 * new commit is a *sibling* of them: the local work is silently bypassed and the
 * two trees can differ (working-tree bytes ignore `.gitattributes` EOL rules).
 *
 * @returns {Promise<null|{isRepo:boolean,head:string|null,branch:string|null,clean:boolean,dirtyCount:number,error?:string}>}
 */
export async function inspectLocalGit(inputDir) {
  let dir
  try {
    dir = await realpath(resolve(inputDir))
  } catch {
    return null
  }
  if (!existsSync(join(dir, '.git'))) return { isRepo: false, head: null, branch: null, clean: true, dirtyCount: 0 }
  const run = async (args) => {
    const { stdout } = await execFileAsync('git', ['-C', dir, ...args], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    })
    return String(stdout).trim()
  }
  try {
    const head = (await run(['rev-parse', 'HEAD']).catch(() => '')) || null
    const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')) || null
    const status = await run(['status', '--porcelain'])
    const dirtyCount = status === '' ? 0 : status.split('\n').filter((line) => line.trim() !== '').length
    return { isRepo: true, head, branch, clean: dirtyCount === 0, dirtyCount }
  } catch (error) {
    return { isRepo: true, head: null, branch: null, clean: true, dirtyCount: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Compare the local branch with a remote head and describe the relationship.
 * `ahead` means the local branch has commits the remote does not.
 */
export async function compareWithRemote(inputDir, remoteHead) {
  if (typeof remoteHead !== 'string' || remoteHead === '') return null
  const dir = await realpath(resolve(inputDir)).catch(() => null)
  if (dir === null || !existsSync(join(dir, '.git'))) return null
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-list', '--left-right', '--count', `HEAD...${remoteHead}`], {
      maxBuffer: 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    })
    const [aheadText, behindText] = String(stdout).trim().split(/\s+/)
    const ahead = Number(aheadText)
    const behind = Number(behindText)
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null
    return { ahead, behind }
  } catch {
    // The local repo may not know this commit yet (no fetch); treat as unknown.
    return null
  }
}

/**
 * Parse `.gitattributes` into the subset that governs line endings.
 * Returns `{ rules: [{ pattern, regex, eol }], auto: boolean }` where `eol` is
 * `'lf'`, `'crlf'` or `null` (leave untouched).
 */
export async function readEolPolicy(inputDir) {
  const rules = []
  let auto = false
  let text
  try {
    text = await readFile(join(inputDir, '.gitattributes'), 'utf8')
  } catch {
    return { rules, auto }
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 2) continue
    const [pattern, ...attrs] = parts
    let eol = null
    for (const attr of attrs) {
      if (attr === 'text' || attr === 'text=auto') auto = true
      else if (attr === 'eol=lf') eol = 'lf'
      else if (attr === 'eol=crlf') eol = 'crlf'
      else if (attr === '-text' || attr === 'binary') eol = null
    }
    if (eol === null) continue
    const regex = globToRegExp(pattern.startsWith('/') ? pattern.slice(1) : pattern)
    if (regex !== null) rules.push({ pattern, regex, eol })
  }
  return { rules, auto }
}

/** True for files git treats as binary (a NUL in the first 8 KB). */
function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 8192)
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true
  }
  return false
}

/**
 * Decode as UTF-8 only when the buffer round-trips byte-for-byte. Anything else
 * (invalid sequences, or binary content without a NUL in the first 8 KB) is left
 * untouched — a lossy decode would corrupt the uploaded blob.
 */
function decodeTextExact(buffer) {
  let text
  try {
    text = buffer.toString('utf8')
  } catch {
    return null
  }
  if (!Buffer.from(text, 'utf8').equals(buffer)) return null
  return text
}

/**
 * Normalise a file's line endings the way `git add` would, so a commit built
 * from working-tree bytes matches a commit built by git itself.
 * With no matching rule and no `text`/`text=auto`, the bytes are returned as-is.
 */
export function normalizeEol(buffer, relativePath, policy) {
  if (policy === null || policy === undefined) return buffer
  const empty = Buffer.alloc(0)
  if (buffer.equals(empty) || looksBinary(buffer)) return buffer
  let rule = null
  for (const candidate of policy.rules) {
    if (candidate.regex.test(relativePath)) rule = candidate
  }
  const target = rule !== null ? rule.eol : (policy.auto ? 'lf' : null)
  if (target === null) return buffer
  const text = decodeTextExact(buffer)
  if (text === null) return buffer
  const hasCrlf = text.includes('\r\n')
  if (target === 'lf') {
    if (!hasCrlf) return buffer
    return Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')
  }
  // target === 'crlf': git stores CRLF as-is in that case.
  if (!hasCrlf && !text.includes('\n')) return buffer
  const lf = text.replace(/\r\n/g, '\n')
  return Buffer.from(lf.replace(/\n/g, '\r\n'), 'utf8')
}

/**
 * Walk a project for a GitHub push. Prefers `git ls-files` so the push matches
 * the repository's own ignore rules, and falls back to a plain walk.
 * @returns {Promise<{files:Array<{path:string,absolutePath:string,size:number}>, warnings:string[], totalBytes:number}>}
 */
export async function walkForGit(inputDir, options = {}) {
  const dir = await realpath(resolve(inputDir))
  const maxFiles = options.maxFiles ?? MAX_GIT_FILES_DEFAULT
  const maxTotalBytes = options.maxTotalBytes ?? MAX_GIT_TOTAL_DEFAULT
  const warnings = []
  const files = []
  let totalBytes = 0

  let paths = null
  if (existsSync(join(dir, '.git'))) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60000,
        windowsHide: true,
      })
      paths = String(stdout).split('\0').filter((entry) => entry !== '')
    } catch (error) {
      warnings.push(`git ls-files 失败，改用目录扫描：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (paths === null) {
    paths = []
    const ignoreLines = await readIgnoreFallback(dir)
    const matcher = createIgnoreMatcher(ignoreLines)
    const stack = ['']
    while (stack.length > 0) {
      const relativeDir = stack.pop()
      const absoluteDir = relativeDir === '' ? dir : join(dir, relativeDir)
      let entries
      try {
        entries = await readdir(absoluteDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (HARD_EXCLUDES.has(entry.name)) continue
          if (matcher.matches(relativePath, true)) continue
          stack.push(relativePath)
          continue
        }
        if (!entry.isFile()) continue
        if (matcher.matches(relativePath, false)) continue
        if (entry.name === '.DS_Store' || entry.name === '.env' || entry.name === '.npmrc') continue
        paths.push(relativePath)
      }
    }
  }

  const unique = [...new Set(paths)].sort()
  for (const relativePath of unique) {
    const normalized = toPosix(relativePath)
    if (normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') continue
    if (normalized.split('/').some((part) => HARD_EXCLUDES.has(part))) continue
    // Never push credential files, whatever `git ls-files` reports. A committed
    // `.env` or `.npmrc` would otherwise be published to a GitHub repository
    // verbatim — including the npm token that lives in `.npmrc`.
    if (normalized.split('/').some((part) => SECRET_FILES.has(part))) {
      warnings.push(`已跳过含敏感凭据的文件：${normalized}`)
      continue
    }
    const absolutePath = join(dir, normalized)
    let info
    try {
      info = await lstat(absolutePath)
    } catch {
      warnings.push(`已跳过无法读取的文件：${normalized}`)
      continue
    }
    if (!info.isFile()) {
      warnings.push(`已跳过非普通文件：${normalized}`)
      continue
    }
    if (info.size > 50 * 1024 * 1024) {
      warnings.push(`已跳过超过 50MB 的文件：${normalized}（GitHub 单文件上限）`)
      continue
    }
    totalBytes += info.size
    if (totalBytes > maxTotalBytes) {
      throw new PackError(`要上传的内容超过 ${Math.round(maxTotalBytes / 1024 / 1024)}MB，请精简目录或改用 git push`, 'EFBIG')
    }
    files.push({ path: normalized, absolutePath, size: info.size, mode: (info.mode & 0o111) !== 0 ? '100755' : '100644' })
    if (files.length > maxFiles) {
      throw new PackError(`文件数超过 ${maxFiles}，GitHub API 逐文件提交不适合如此大的项目`, 'EMFILE')
    }
  }

  if (files.length === 0) {
    throw new PackError('目录里没有可上传的文件', 'EEMPTY')
  }
  return { files, warnings, totalBytes }
}

/** Read a single file for release assets, with a clear size guard. */
export async function readAssetFile(file, maxBytes = 100 * 1024 * 1024) {
  const resolved = resolve(file)
  const info = await stat(resolved)
  if (!info.isFile()) throw new PackError(`不是文件：${resolved}`, 'ENOTFILE')
  if (info.size > maxBytes) throw new PackError(`文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB`, 'EFBIG')
  return { name: basename(resolved), data: await readFile(resolved), size: info.size }
}

// Exported for tests.
export const internals = { globToRegExp, tarHeader, dirnameOf: dirname }