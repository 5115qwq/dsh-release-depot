/**
 * dsh-release-depot — tiny SemVer implementation.
 *
 * The plugin runs inside a profile where no `semver` package is guaranteed to
 * resolve, so version parsing, comparison and the range subset that npm
 * deprecate / dist-tag / unpublish need live here. The subset follows the
 * ranges users actually type: exact versions, `*`, `x` / `x.y` wildcards,
 * `^`, `~`, comparison sets (`>=1 <2`), hyphen ranges and `||`.
 */

const VERSION_RE =
  /^[v=\s]*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

/** Parse a full version, or return null. */
export function parseVersion(input) {
  if (typeof input !== 'string') return null
  const match = VERSION_RE.exec(input.trim())
  if (match === null) return null
  const prerelease = match[4] === undefined ? [] : match[4].split('.')
  if (prerelease.some((part) => part === '')) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    build: match[5] === undefined ? [] : match[5].split('.'),
    raw: input.trim(),
  }
}

/** True when the string is a plain, complete SemVer version (no v/=/space). */
export function isValidVersion(input) {
  if (typeof input !== 'string' || input.trim() !== input) return false
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(input)) return false
  // SemVer forbids leading zeros in the numeric identifiers (`01.2.3` is not a
  // version), while prerelease identifiers may legitimately keep them.
  const [core] = input.split(/[-+]/, 1)
  if (core.split('.').some((part) => part.length > 1 && part.startsWith('0'))) return false
  if (parseVersion(input) === null) return false
  return true
}

function compareIdentifier(a, b) {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) return Number(a) - Number(b)
  if (aNum) return -1
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** SemVer precedence comparison; build metadata is ignored. */
export function compareVersions(a, b) {
  const va = typeof a === 'string' ? parseVersion(a) : a
  const vb = typeof b === 'string' ? parseVersion(b) : b
  if (va === null || vb === null) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (va[key] !== vb[key]) return va[key] < vb[key] ? -1 : 1
  }
  const pa = va.prerelease
  const pb = vb.prerelease
  if (pa.length === 0 && pb.length === 0) return 0
  if (pa.length === 0) return 1
  if (pb.length === 0) return -1
  const length = Math.max(pa.length, pb.length)
  for (let index = 0; index < length; index += 1) {
    const left = pa[index]
    const right = pb[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const diff = compareIdentifier(left, right)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

/** Loose numeric comparison: 1.2 == 1.2.0, trailing zeros ignored. */
export function compareLoose(a, b) {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (va === null || vb === null) return String(a).localeCompare(String(b))
  return compareVersions(va, vb)
}

const COMPARATOR_RE = /^(>=|<=|>|<|=|~>|~|\^)?\s*(.+)$/

function zeroPad(parts) {
  const [major = '0', minor = '0', patch = '0'] = parts
  return [Number(major), Number(minor), Number(patch)]
}

function expandComparatorToken(token) {
  if (token === '' || token === '*' || token === 'x' || token === 'X') return []
  // Hyphen ranges are split before this runs.
  const match = COMPARATOR_RE.exec(token)
  if (match === null) return [{ op: 'invalid', version: token }]
  const op = match[1] ?? ''
  const value = match[2].trim()
  if (value === '' || value === '*' || value === 'x' || value === 'X') {
    if (op === '' || op === '=' || op === '>=') return []
    return [{ op: 'invalid', version: token }]
  }

  const loose = /^v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?$/.exec(value)
  if (loose === null) return [{ op: 'invalid', version: token }]

  const rawMajor = loose[1]
  const rawMinor = loose[2]
  const rawPatch = loose[3]
  const pre = loose[4]
  const major = Number(rawMajor)
  const hasMinor = rawMinor !== undefined && !/^[xX*]$/.test(rawMinor)
  const hasPatch = rawPatch !== undefined && !/^[xX*]$/.test(rawPatch)
  const minor = hasMinor ? Number(rawMinor) : 0
  const patch = hasPatch ? Number(rawPatch) : 0
  const suffix = pre === undefined ? '' : `-${pre}`

  if (op === '^') {
    const lower = `${major}.${minor}.${patch}${suffix}`
    if (major > 0) return [{ op: '>=', version: lower }, { op: '<', version: `${major + 1}.0.0-0` }]
    if (hasMinor && minor > 0) return [{ op: '>=', version: lower }, { op: '<', version: `0.${minor + 1}.0-0` }]
    if (hasPatch) return [{ op: '>=', version: lower }, { op: '<', version: `0.0.${patch + 1}-0` }]
    return [{ op: '>=', version: lower }, { op: '<', version: `0.${minor + 1}.0-0` }]
  }
  if (op === '~' || op === '~>') {
    const lower = `${major}.${minor}.${patch}${suffix}`
    const upper = hasMinor ? `${major}.${minor + 1}.0-0` : `${major + 1}.0.0-0`
    return [{ op: '>=', version: lower }, { op: '<', version: upper }]
  }
  if (!hasPatch) {
    // Wildcards: 1.2 behaves like 1.2.x, 1 behaves like 1.x.
    const lower = `${major}.${minor}.0`
    const upper = hasMinor ? `${major}.${minor + 1}.0-0` : `${major + 1}.0.0-0`
    if (op === '' || op === '=') return [{ op: '>=', version: lower }, { op: '<', version: upper }]
    // npm reads `<=2.3` as `<=2.3.x`, i.e. `<2.4.0`; emitting `<=2.3.0` would
    // silently exclude 2.3.1–2.3.x (this is what hyphen ranges like
    // `1.2.3 - 2.3` lower to). The bound uses a plain version, not `-0`, so a
    // range that never mentions a prerelease keeps excluding prereleases.
    if (op === '<=') return [{ op: '<', version: upper.replace(/-0$/, '') }]
    if (op === '>') return [{ op: '>=', version: upper.replace(/-0$/, '') }]
    return [{ op, version: lower }]
  }
  const version = `${major}.${minor}.${patch}${suffix}`
  return [{ op: op === '=' || op === '' ? '=' : op, version }]
}

function parseRangeSet(set) {
  // npm allows a space between an operator and its version (`>= 2.0.0`), which
  // the schema advertises. Normalise it away before tokenising, otherwise the
  // lone `>=` expands to an invalid comparator and the whole range throws.
  const text = set.trim().replace(/(>=|<=|>|<|=|~>|~|\^)\s+/g, '$1')
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text)
  if (hyphen !== null) {
    return [
      ...expandComparatorToken(`>=${hyphen[1]}`),
      ...expandComparatorToken(`<=${hyphen[2]}`),
    ]
  }
  const tokens = text.split(/\s+/).filter((token) => token !== '')
  const comparators = []
  for (const token of tokens) comparators.push(...expandComparatorToken(token))
  return comparators
}

/** Parsed range: array of OR sets of comparators. Throws on invalid input. */
export function parseRange(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('版本范围不能为空')
  }
  const sets = input.split('||').map((set) => parseRangeSet(set))
  if (sets.some((set) => set.some((comparator) => comparator.op === 'invalid'))) {
    throw new Error(`无效的版本范围：${input}`)
  }
  return sets
}

export function isValidRange(input) {
  try {
    parseRange(input)
    return true
  } catch {
    return false
  }
}

function testComparator(version, comparator) {
  const diff = compareVersions(version, comparator.version)
  switch (comparator.op) {
    case '=': return diff === 0
    case '>': return diff > 0
    case '>=': return diff >= 0
    case '<': return diff < 0
    case '<=': return diff <= 0
    default: return true
  }
}

/**
 * Range satisfaction. Prerelease versions satisfy a range when the range
 * itself mentions a prerelease or `includePrerelease` is set, which mirrors
 * the option npm deprecate passes.
 */
export function satisfies(version, range, options = {}) {
  const parsed = typeof version === 'string' ? parseVersion(version) : version
  if (parsed === null) return false
  let sets
  try {
    sets = parseRange(range)
  } catch {
    return false
  }
  for (const set of sets) {
    if (set.length === 0) {
      if (parsed.prerelease.length === 0 || options.includePrerelease) return true
      continue
    }
    if (parsed.prerelease.length > 0 && options.includePrerelease !== true) {
      const mentionsPre = set.some((comparator) => /-/.test(comparator.version))
      if (!mentionsPre) continue
    }
    if (set.every((comparator) => testComparator(parsed, comparator))) return true
  }
  return false
}

/** Highest version in a list, optionally filtered by a range. */
/**
 * Highest version, preferring stable releases: unless every candidate is a
 * prerelease, a `1.0.0` outranks a `2.0.0-rc.1`. This matters when picking the
 * `latest` dist-tag after a version is unpublished — shipping `2.0.0-rc.1` as
 * `latest` is never what the maintainer meant.
 */
export function maxVersion(versions, range) {
  let best = null
  let bestStable = false
  for (const version of versions) {
    if (range !== undefined && !satisfies(version, range)) continue
    const parsed = parseVersion(version)
    if (parsed === null) continue
    const stable = parsed.prerelease.length === 0
    if (best === null) {
      best = version
      bestStable = stable
      continue
    }
    if (stable !== bestStable) {
      if (stable) {
        best = version
        bestStable = true
      }
      continue
    }
    if (compareVersions(version, best) > 0) best = version
  }
  return best
}

/** Extract { owner, repo } from a package.json repository field. */
export function parseGitHubRepo(input) {
  if (input === null || input === undefined) return null
  let value = input
  if (typeof value === 'object' && typeof value.url === 'string') value = value.url
  if (typeof value !== 'string') return null
  const cleaned = value
    .trim()
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .replace(/^github:/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(cleaned)
  if (match === null) return null
  return { owner: match[1], repo: match[2] }
}

/** Validate an npm package name (scoped or unscoped). */
export function isValidPackageName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 214) return false
  if (name.trim() !== name) return false
  if (/[A-Z\s]/.test(name)) return false
  if (name.startsWith('.') || name.startsWith('_')) return false
  if (name.startsWith('@')) {
    const match = /^@([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/.exec(name)
    if (match === null) return false
    return !match[2].startsWith('.') && !match[2].startsWith('_')
  }
  return /^[a-z0-9][a-z0-9._-]*$/.test(name) && !name.includes('node_modules') && !name.includes('favicon.ico')
}

/** Split a package name into { scope, name }; scope includes the @. */
export function splitPackageName(name) {
  if (typeof name !== 'string') return { scope: null, name: '' }
  const slash = name.indexOf('/')
  if (name.startsWith('@') && slash > 0) {
    return { scope: name.slice(0, slash), name: name.slice(slash + 1) }
  }
  return { scope: null, name }
}

/** Registry path segment for a package: @scope%2fname (every slash escaped). */
export function escapedPackageName(name) {
  return String(name).replace(/\//g, '%2f')
}

/** Increment the minor or patch field of a version. */
export function bumpVersion(version, release = 'patch') {
  const parsed = parseVersion(version)
  if (parsed === null) return null
  if (release === 'major') return `${parsed.major + 1}.0.0`
  if (release === 'minor') return `${parsed.major}.${parsed.minor + 1}.0`
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
}