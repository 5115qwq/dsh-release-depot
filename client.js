/**
 * dsh-release-depot — browser half (plain __ModuleLoader__ module, no build step).
 *
 * A neubrutalist "release deck": sidebar workspace navigation, a dashboard
 * with at-a-glance cards, npm package management, GitHub repository/release
 * management, publish history, account settings, and a four-step publish
 * wizard. All data comes from the host RPC route; accounts are connected here.
 */
window.__ModuleLoader__.load({
  id: 'dsh-release-depot',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const NS = 'dsh-release-depot'
    const h = React.createElement

    // ── shared state ───────────────────────────────────────────────────────

    let localeService = null
    const hostServices = {}

    let sidebarVisible = true
    const sidebarListeners = new Set()
    function setSidebarVisibleState(next) {
      const normalized = next !== false
      if (normalized === sidebarVisible) return
      sidebarVisible = normalized
      for (const fn of [...sidebarListeners]) fn()
    }
    function subscribeSidebar(fn) {
      sidebarListeners.add(fn)
      return () => sidebarListeners.delete(fn)
    }
    function useSidebarVisible() {
      return React.useSyncExternalStore(subscribeSidebar, () => sidebarVisible, () => true)
    }

    let themeScheme = 'light'
    const themeListeners = new Set()
    function setThemeScheme(next) {
      const normalized = next === 'dark' ? 'dark' : 'light'
      if (normalized === themeScheme) return
      themeScheme = normalized
      for (const fn of [...themeListeners]) fn()
    }
    function subscribeTheme(fn) {
      themeListeners.add(fn)
      return () => themeListeners.delete(fn)
    }
    function useThemeScheme() {
      return React.useSyncExternalStore(subscribeTheme, () => themeScheme, () => 'light')
    }

    function detectLang() {
      try {
        const snap = localeService?.getSnapshot?.()
        if (typeof snap?.active === 'string') return snap.active.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        /* fall through */
      }
      const nav = typeof navigator !== 'undefined' ? navigator.language : 'zh'
      return String(nav).toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    function subscribeLocale(fn) {
      if (localeService === null || typeof localeService.subscribe !== 'function') return () => {}
      return localeService.subscribe(fn)
    }

    function getLocaleSnapshot() {
      if (localeService === null || typeof localeService.getSnapshot !== 'function') return null
      try {
        return localeService.getSnapshot()
      } catch {
        return null
      }
    }

    function useLang() {
      const snap = React.useSyncExternalStore(subscribeLocale, getLocaleSnapshot, () => null)
      const active = typeof snap?.active === 'string' ? snap.active : null
      return active === null ? detectLang() : active.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    /** Translate helper: t('中文', 'English') bound to the active locale. */
    function useT() {
      const lang = useLang()
      return React.useCallback((zh, en) => (lang === 'zh' ? zh : en), [lang])
    }

    // ── api ────────────────────────────────────────────────────────────────

    const RPC = '/dsh-release-depot/rpc'

    /**
     * Small mutable scratchpad for values that must survive a confirm dialog's
     * render without forcing the parent to re-render on every keystroke.
     * Reset it right before opening a dialog.
     */
    const OT = { npmOtp: '', confirmText: '' }
    function resetScratch() {
      OT.npmOtp = ''
      OT.confirmText = ''
    }

    class ApiError extends Error {
      constructor(info) {
        super(info?.message ?? '请求失败')
        this.name = 'ApiError'
        this.code = info?.code ?? 'EUNKNOWN'
        this.hint = info?.hint ?? ''
        this.status = info?.status ?? 0
        this.details = info?.details ?? null
      }
    }

    async function call(op, input) {
      let response
      try {
        response = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op, input: input ?? {} }),
          cache: 'no-store',
        })
      } catch (error) {
        throw new ApiError({ message: `无法连接 DSH 主机：${error instanceof Error ? error.message : String(error)}`, code: 'ENETWORK' })
      }
      let data
      try {
        data = await response.json()
      } catch {
        throw new ApiError({ message: `宿主返回了非 JSON 响应（HTTP ${response.status}）`, code: 'EBADRESPONSE' })
      }
      if (data?.ok !== true) throw new ApiError(data?.error)
      return data.result
    }

    async function fetchStatus() {
      try {
        const response = await fetch('/dsh-release-depot/status', { cache: 'no-store' })
        const data = await response.json()
        if (data?.ok !== true) throw new ApiError(data?.error)
        return data.result
      } catch (error) {
        if (error instanceof ApiError) throw error
        throw new ApiError({ message: `读取状态失败：${error instanceof Error ? error.message : String(error)}` })
      }
    }

    function errorText(error) {
      if (error === null || error === undefined) return ''
      const base = error instanceof Error ? error.message : String(error)
      return error.hint ? `${base} 提示：${error.hint}` : base
    }

    /** Collect actionable links a Host error carried in `details`. */
    function errorLinks(error) {
      const details = error?.details
      if (details === null || typeof details !== 'object') return []
      const links = []
      const push = (label, href) => {
        if (typeof href !== 'string' || href === '' || !/^https:\/\//.test(href)) return
        if (links.some((item) => item.href === href)) return
        links.push({ label, href })
      }
      push('打开 npm Token 页面', details.npmTokenPage)
      push('设置 npm 两步验证', details.npmTwoFactorPage)
      push('npm 2FA 说明', details.npmHelpPage)
      push('我的 npm 包', details.npmPackagesPage)
      push('到 npm 网页删除', details.npmPackagePage)
      push('GitHub Token 设置', details.tokenSettingsUrl)
      push('GitHub 细粒度 Token', details.fineGrainedUrl)
      return links
    }

    function formatTime(value, lang) {
      if (typeof value !== 'string' || value === '') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      const pad = (number) => String(number).padStart(2, '0')
      if (lang === 'zh') {
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
      }
      return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / 1024 / 1024).toFixed(2)} MB`
    }

    function packageUrl(name, registry) {
      if (typeof name !== 'string' || name === '') return null
      if (typeof registry === 'string' && registry.includes('npm.pkg.github.com')) {
        return `https://github.com/${name.replace(/^@/, '').split('/')[0]}?tab=packages`
      }
      if (typeof registry === 'string' && registry !== '' && !registry.includes('registry.npmjs.org')) {
        return null
      }
      return `https://www.npmjs.com/package/${name}`
    }

    // ── icons ──────────────────────────────────────────────────────────────

    const icon = (paths, viewBox = '0 0 24 24') =>
      h('svg', { className: 'sd-i', viewBox, 'aria-hidden': 'true', focusable: 'false' },
        paths.map((d, index) => h('path', { key: index, d, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' })))

    const Icons = {
      box: () => h('svg', { className: 'sd-i', viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        h('path', { d: 'M3 8l9-4 9 4-9 4-9-4z', fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M3 8v8l9 4 9-4V8', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinejoin: 'round' }),
        h('path', { d: 'M12 12v8', stroke: 'currentColor', strokeWidth: 2 })),
      dashboard: () => icon(['M4 4h6v7H4z', 'M14 4h6v4h-6z', 'M14 12h6v8h-6z', 'M4 15h6v5H4z']),
      package: () => icon(['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z', 'M4 7.5l8 4.5 8-4.5', 'M12 12v9']),
      repo: () => icon(['M4 5a2 2 0 012-2h12v18H6a2 2 0 01-2-2z', 'M8 7h8', 'M8 11h6']),
      record: () => icon(['M5 3h14v18H5z', 'M9 8h6', 'M9 12h6', 'M9 16h4']),
      settings: () => icon(['M12 15a3 3 0 100-6 3 3 0 000 6z', 'M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 00-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 00-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 000 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 002 1.2l.4 2.6h4l.4-2.6a7 7 0 002-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z']),
      close: () => icon(['M6 6l12 12', 'M18 6L6 18']),
      refresh: () => icon(['M20 11a8 8 0 10-2.3 5.7', 'M20 5v6h-6']),
      plus: () => icon(['M12 5v14', 'M5 12h14']),
      check: () => icon(['M4 12l5 5L20 6']),
      warn: () => icon(['M12 3l9 17H3z', 'M12 9v5', 'M12 17h.01']),
      copy: () => icon(['M9 9h11v11H9z', 'M5 15H4V4h11v1']),
      folder: () => icon(['M3 6h6l2 2h10v11H3z']),
      external: () => icon(['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5H5V6h5']),
      trash: () => icon(['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13']),
      tag: () => icon(['M3 12V4h8l10 10-8 8L3 12z', 'M7 8h.01']),
      chevron: () => icon(['M9 6l6 6-6 6']),
      arrow: () => icon(['M5 12h14', 'M13 6l6 6-6 6']),
      github: () => h('svg', { className: 'sd-i', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', {
          d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z',
          fill: 'currentColor',
        })),
      npm: () => h('svg', { className: 'sd-i', viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        h('path', { d: 'M3 5h18v14h-9v-2H8v2H3V5zm3 3v6h3V8h3v6h3V8h3v6h1V8h-13z', fill: 'currentColor', stroke: 'none' })),
      sun: () => icon(['M12 4V2', 'M12 22v-2', 'M4 12H2', 'M22 12h-2', 'M5.6 5.6L4.2 4.2', 'M19.8 19.8l-1.4-1.4', 'M5.6 18.4l-1.4 1.4', 'M19.8 4.2l-1.4 1.4', 'M12 8a4 4 0 100 8 4 4 0 000-8z']),
      moon: () => icon(['M20 14.5A8.5 8.5 0 019.5 4 8.5 8.5 0 1020 14.5z']),
      play: () => icon(['M8 5l11 7-11 7V5z']),
      shield: () => icon(['M12 3l7 3v6c0 5-3.5 8-7 9-3.5-1-7-4-7-9V6l7-3z', 'M9 12l2 2 4-4']),
    }

    function LogoMark() {
      return h('svg', { className: 'sd-logo-mark', viewBox: '0 0 48 48', 'aria-hidden': 'true' },
        h('rect', { x: 2, y: 2, width: 44, height: 44, rx: 10, fill: '#ffd84d', stroke: '#141414', strokeWidth: 3 }),
        h('path', { d: 'M12 19l12-5 12 5-12 5-12-5z', fill: '#141414' }),
        h('path', { d: 'M12 19v11l12 5 12-5V19', fill: 'none', stroke: '#141414', strokeWidth: 3, strokeLinejoin: 'round' }),
        h('path', { d: 'M24 24v11', stroke: '#141414', strokeWidth: 3 }),
        h('path', { d: 'M24 8v6M21 11h6', stroke: '#141414', strokeWidth: 3, strokeLinecap: 'round' }))
    }

    // ── primitives ─────────────────────────────────────────────────────────

    function Btn(props) {
      const { variant = 'default', size = 'md', block = false, busy = false, disabled, children, ...rest } = props
      const className = ['sd-btn', `sd-btn-${variant}`, `sd-btn-${size}`, block ? 'sd-btn-block' : '', busy ? 'is-busy' : '']
        .filter(Boolean).join(' ')
      return h('button', {
        type: 'button',
        ...rest,
        className,
        disabled: disabled === true || busy === true,
      }, busy ? h('span', { className: 'sd-spin', 'aria-hidden': 'true' }) : null, children)
    }

    function Chip(props) {
      return h('span', { className: `sd-chip sd-chip-${props.tone ?? 'plain'}${props.className ? ` ${props.className}` : ''}` }, props.children)
    }

    function Field(props) {
      return h('label', { className: 'sd-field' },
        h('span', { className: 'sd-field-label' }, props.label, props.optional === true ? h('span', { className: 'sd-field-opt' }, 'optional') : null),
        props.children,
        props.hint ? h('span', { className: 'sd-field-hint' }, props.hint) : null)
    }

    function TextInput(props) {
      const { type = 'text', className, ...rest } = props
      return h('input', { ...rest, type, className: 'sd-input' + (className ? ` ${className}` : '') })
    }

    function Spinner(props) {
      return h('span', { className: 'sd-spin' + (props.large ? ' sd-spin-lg' : ''), role: 'status', 'aria-label': props.label ?? 'loading' })
    }

    function EmptyState(props) {
      return h('div', { className: 'sd-empty' },
        h('div', { className: 'sd-empty-icon' }, props.icon ?? h(Icons.box, null)),
        h('div', { className: 'sd-empty-title' }, props.title),
        props.body ? h('p', { className: 'sd-empty-body' }, props.body) : null,
        props.action ?? null)
    }

    function Modal(props) {
      const { title, subtitle, onClose, children, footer, wide = false } = props
      const ref = React.useRef(null)
      React.useEffect(() => {
        const node = ref.current
        if (node !== null) {
          const preferred = node.querySelector('.sd-modal-body input, .sd-modal-body select, .sd-modal-body textarea, .sd-modal-body [data-autofocus], .sd-modal-body button, .sd-modal-foot button')
          const fallback = node.querySelector('.sd-modal-head button')
          const target = preferred ?? fallback
          if (target !== null) target.focus()
        }
      }, [])
      return h('div', {
        className: 'sd-modal-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      },
        h('div', {
          className: 'sd-modal' + (wide ? ' sd-modal-wide' : ''),
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': typeof title === 'string' ? title : 'dialog',
          ref,
        },
          h('div', { className: 'sd-modal-head' },
            h('div', null,
              h('h2', { className: 'sd-modal-title' }, title),
              subtitle ? h('p', { className: 'sd-modal-sub' }, subtitle) : null),
            h('button', { type: 'button', className: 'sd-icon-btn', onClick: onClose, 'aria-label': 'close' }, h(Icons.close, null))),
          h('div', { className: 'sd-modal-body' }, children),
          footer ? h('div', { className: 'sd-modal-foot' }, footer) : null))
    }

    function ConfirmDialog(props) {
      const t = useT()
      const [busy, setBusy] = React.useState(false)
      const titleId = React.useId()
      const run = async () => {
        setBusy(true)
        try {
          await props.onConfirm()
          props.onClose()
        } catch (error) {
          props.onError?.(error)
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'sd-modal-backdrop sd-modal-confirm' },
        h('div', { className: 'sd-modal sd-modal-sm', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
          h('div', { className: 'sd-confirm-band' }, h('span', { className: 'sd-eyebrow sd-eyebrow-danger' }, props.danger ? 'DANGER' : 'CONFIRM')),
          h('div', { className: 'sd-modal-body' },
            h('h2', { className: 'sd-modal-title', id: titleId }, props.title),
            h('p', { className: 'sd-confirm-text' }, props.body),
            props.note ? h('div', { className: 'sd-note sd-note-warn' }, props.note) : null),
          h('div', { className: 'sd-modal-foot' },
            h(Btn, { variant: 'ghost', onClick: props.onClose, disabled: busy, autoFocus: true }, t('取消', 'Cancel')),
            h(Btn, { variant: props.danger ? 'danger' : 'primary', busy, onClick: run }, props.confirmLabel ?? t('确认', 'Confirm')))))
    }

    function Toasts(props) {
      const items = props.items
      if (items.length === 0) return null
      return h('div', { className: 'sd-toasts', 'aria-live': 'polite' },
        items.map((item) => h('div', { key: item.id, className: `sd-toast sd-toast-${item.tone}` },
          h('span', { className: 'sd-toast-icon' }, item.tone === 'error' ? h(Icons.warn, null) : h(Icons.check, null)),
          h('div', { className: 'sd-toast-body' },
            h('span', { className: 'sd-toast-text' }, item.text),
            Array.isArray(item.links) && item.links.length > 0
              ? h('div', { className: 'sd-toast-links' },
                item.links.map((link) => h('a', {
                  key: link.href,
                  className: 'sd-toast-link',
                  href: link.href,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                }, link.label, h(Icons.external, null))))
              : null))))
    }

    function CopyButton(props) {
      const t = useT()
      const [copied, setCopied] = React.useState(false)
      const copy = async () => {
        try {
          if (navigator.clipboard?.writeText !== undefined) await navigator.clipboard.writeText(props.text)
          else {
            const area = document.createElement('textarea')
            area.value = props.text
            area.style.position = 'fixed'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            document.execCommand('copy')
            area.remove()
          }
          setCopied(true)
          props.onCopied?.()
        } catch {
          props.onCopied?.()
        }
      }
      return h(Btn, { size: 'sm', variant: 'ghost', onClick: copy, title: props.text }, copied ? t('已复制', 'Copied') : (props.label ?? t('复制', 'Copy')))
    }

    // ── trigger + root ─────────────────────────────────────────────────────

    function SidebarIcon({ size = 16, active = false }) {
      const px = typeof size === 'number' && size > 0 ? size : 16
      return h('svg', {
        width: px,
        height: px,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': 'true',
        style: { opacity: active ? 1 : 0.82 },
      },
        h('path', { d: 'M3.5 8.2 12 4l8.5 4.2L12 12.5 3.5 8.2Z', stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round' }),
        h('path', { d: 'M3.5 8.2v7.6L12 20l8.5-4.2V8.2', stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round' }),
        h('path', { d: 'M12 12.5V20', stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', { d: 'M12 2.9v3.6', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }))
    }

    function BundleEntryCard() {
      const t = useT()
      const enabled = useSidebarVisible()
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState(null)
      const toggle = async () => {
        const next = !enabled
        hostServices.sidebar?.setEnabled(next)
        setSaving(true)
        setError(null)
        try {
          await call('prefs.set', { sidebarVisible: next })
        } catch (err) {
          hostServices.sidebar?.setEnabled(!next)
          setError(errorText(err))
        } finally {
          setSaving(false)
        }
      }
      return h('div', { className: 'sd-bundle-card' },
        h('div', { className: 'sd-bundle-icon' }, h(LogoMark, null)),
        h('div', { className: 'sd-bundle-copy' },
          h('strong', null, t('左侧栏「发布仓」开关', 'Show Release Depot in sidebar')),
          h('span', null, t('默认打开；关闭后隐藏左侧栏入口，可随时在这里重新打开。',
            'On by default. Turn it off to hide the left-sidebar entry; reopen it here anytime.')),
          error !== null ? h('span', { className: 'sd-bundle-error' }, error) : null),
        h('button', {
          type: 'button',
          role: 'switch',
          className: 'sd-switch' + (enabled ? ' is-on' : ''),
          'aria-checked': enabled,
          'aria-label': t('左侧栏「发布仓」开关', 'Show Release Depot in sidebar'),
          disabled: saving,
          onClick: toggle,
        }, h('span', { className: 'sd-switch-knob', 'aria-hidden': 'true' })))
    }

    // ── panel ──────────────────────────────────────────────────────────────

    function Panel() {
      const t = useT()
      const lang = useLang()
      const [status, setStatus] = React.useState(null)
      const [statusError, setStatusError] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [tab, setTab] = React.useState('dashboard')
      const theme = useThemeScheme()
      const [toasts, setToasts] = React.useState([])
      const toastId = React.useRef(0)
      const [confirm, setConfirm] = React.useState(null)
      const [wizard, setWizard] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [releasesRepo, setReleasesRepo] = React.useState(null)
      const [pushRepo, setPushRepo] = React.useState(null)
      const [noticeHidden, setNoticeHidden] = React.useState(false)
      const tokenInfoChecked = React.useRef(false)

      const refresh = React.useCallback(async () => {
        try {
          const value = await fetchStatus()
          setStatus(value)
          setStatusError(null)
        } catch (error) {
          setStatusError(error)
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        refresh()
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (confirm !== null) setConfirm(null)
          else if (wizard !== null) setWizard(null)
          else if (releasesRepo !== null) setReleasesRepo(null)
          else if (pushRepo !== null) setPushRepo(null)
          else if (detail !== null) setDetail(null)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [refresh, confirm, wizard, releasesRepo, pushRepo, detail])

      React.useEffect(() => {
        const onTab = (event) => {
          const target = event?.detail
          if (target === 'wizard') setWizard({ prefill: {} })
          else if (typeof target === 'string') setTab(target)
        }
        window.addEventListener('ship-deck:tab', onTab)
        return () => window.removeEventListener('ship-deck:tab', onTab)
      }, [])

      React.useEffect(() => {
        if (status?.npm?.connected !== true || tokenInfoChecked.current) return
        tokenInfoChecked.current = true
        call('npm.token-info')
          .then((result) => {
            if (result?.matched === true) refresh()
          })
          .catch(() => {})
      }, [status?.npm?.connected, refresh])

      const toast = React.useCallback((text, tone = 'ok', options = {}) => {
        const id = toastId.current
        toastId.current += 1
        const links = Array.isArray(options?.links) ? options.links : []
        setToasts((items) => [...items, { id, text, tone, links }])
        window.setTimeout(() => {
          setToasts((items) => items.filter((item) => item.id !== id))
        }, tone === 'error' ? 9000 : 3500)
      }, [])

      const fail = React.useCallback((error) => {
        toast(errorText(error), 'error', { links: errorLinks(error) })
      }, [toast])

      const go = React.useCallback((nextTab) => {
        setTab(nextTab)
      }, [])

      const openWizard = React.useCallback((prefill) => {
        setWizard({ prefill: prefill ?? {} })
      }, [])

      const navItems = [
        { id: 'dashboard', label: t('工作台', 'Workbench'), icon: Icons.dashboard },
        { id: 'packages', label: t('npm 包库', 'npm packages'), icon: Icons.package, badge: status?.counts?.npmPackages },
        { id: 'repos', label: t('GitHub 仓库', 'GitHub repos'), icon: Icons.repo, badge: status?.github?.connected ? 'ON' : null },
        { id: 'settings', label: t('设置', 'Settings'), icon: Icons.settings },
      ]

      const tabLabels = {
        dashboard: t('工作台', 'Workbench'),
        packages: t('npm 包库', 'npm packages'),
        repos: t('GitHub 仓库', 'GitHub repos'),
        settings: t('设置', 'Settings'),
      }

      const notice = buildNotice(t, status, loading, statusError, refresh)

      return h('div', { className: `sd-mainpanel sd-theme-${theme}` },
        h('div', { className: 'sd-app', role: 'region', 'aria-label': t('发布仓工作台', 'Release Depot workbench') },
          h('aside', { className: 'sd-side' },
            h('div', { className: 'sd-logo' },
              h('div', { className: 'sd-logo-tile' }, h(LogoMark, null)),
              h('div', { className: 'sd-logo-text' },
                h('div', { className: 'sd-logo-title' }, t('发布仓', 'Release Depot')),
                h('div', { className: 'sd-logo-sub' }, 'RELEASE DEPOT'))),
            h('div', { className: 'sd-dash' }),
            h('div', { className: 'sd-nav-label' }, t('工作空间', 'Workspace')),
            h('nav', { className: 'sd-nav', 'aria-label': t('发布仓导航', 'Release Depot navigation') },
              navItems.map((item) => h('button', {
                key: item.id,
                type: 'button',
                className: 'sd-nav-item' + (tab === item.id ? ' is-active' : ''),
                onClick: () => go(item.id),
                'aria-current': tab === item.id ? 'page' : undefined,
              },
                h('span', { className: 'sd-nav-icon' }, h(item.icon, null)),
                h('span', { className: 'sd-nav-text' }, item.label),
                item.badge !== null && item.badge !== undefined
                  ? h('span', { className: 'sd-nav-badge' }, String(item.badge))
                  : null))),
            h('div', { className: 'sd-side-spacer' }),
            h('div', { className: 'sd-conn-card' },
              connectionRow('npm', status?.npm?.connected === true, status?.npm?.username, t('未连接', 'offline')),
              connectionRow('GitHub', status?.github?.connected === true, status?.github?.login, t('未连接', 'offline'))),
            h('div', { className: 'sd-mini-note' },
              h('span', { className: 'sd-mini-note-dot' }),
              h('div', null,
                h('strong', null, t('仅本机凭据', 'Local credentials only')),
                h('span', null, t('令牌只保存在 DSH home。', 'Tokens stay in your DSH home.')))),
            h('div', { className: 'sd-side-foot' }, h('span', null, `v${status?.version ?? '1.1.8'}`), h('span', null, t('本地运行', 'local runtime')))),
          h('main', { className: 'sd-main' },
            h('header', { className: 'sd-top' },
              h('div', { className: 'sd-crumb' },
                h('span', { className: 'sd-crumb-root' }, t('发布仓', 'Release Depot')),
                h('span', { className: 'sd-crumb-sep' }, '/'),
                h('span', { className: 'sd-crumb-current' }, tabLabels[tab])),
              h('div', { className: 'sd-top-right' },
                h('span', { className: 'sd-pill ' + (status?.npm?.connected || status?.github?.connected ? 'sd-pill-ok' : 'sd-pill-warn') },
                  h('span', { className: 'sd-dot' }),
                  status?.npm?.connected && status?.github?.connected
                    ? t('双账号已连接', 'Both accounts connected')
                    : status?.npm?.connected || status?.github?.connected
                      ? t('单账号已连接', 'One account connected')
                      : t('账号未连接', 'No account yet')))),
            h('div', { className: 'sd-hazard', 'aria-hidden': 'true' }),
            h('div', { className: 'sd-content' },
              notice !== null && !noticeHidden
                ? h('div', { className: 'sd-notice' },
                  h('span', { className: 'sd-notice-icon' }, h(Icons.warn, null)),
                  h('div', { className: 'sd-notice-text' }, notice.text),
                  notice.actionLabel
                    ? h(Btn, { size: 'sm', variant: 'default', onClick: () => { setNoticeHidden(true); notice.action() } }, notice.actionLabel)
                    : null,
                  h('button', { type: 'button', className: 'sd-link-btn', onClick: () => setNoticeHidden(true) }, t('知道了', 'Got it')))
                : null,
              tab === 'dashboard' && h(Dashboard, {
                status, loading, refresh, openWizard, lang, t, toast, fail, setConfirm,
              }),
              tab === 'packages' && h(PackagesPage, { status, t, lang, toast, fail, openWizard, onOpenDetail: setDetail, refreshStatus: refresh }),
              tab === 'repos' && h(ReposPage, {
                status, t, lang, toast, fail, openPush: setPushRepo, openReleases: setReleasesRepo, refreshStatus: refresh, setConfirm,
              }),
              tab === 'settings' && h(SettingsPage, {
                status, t, lang, toast, fail, refreshStatus: refresh, setConfirm,
              }))),
          h(Toasts, { items: toasts }),
          detail !== null && h(PackageDetail, {
            name: detail,
            t,
            lang,
            toast,
            fail,
            refreshStatus: refresh,
            setConfirm,
            onClose: () => setDetail(null),
          }),
          releasesRepo !== null && h(ReleasesDialog, {
            repo: releasesRepo,
            t,
            lang,
            toast,
            fail,
            setConfirm,
            onClose: () => setReleasesRepo(null),
          }),
          pushRepo !== null && h(PushDialog, {
            repo: pushRepo,
            t,
            lang,
            toast,
            fail,
            setConfirm,
            onClose: () => setPushRepo(null),
          }),
          wizard !== null && h(PublishWizard, {
            prefill: wizard.prefill,
            status,
            t,
            toast,
            fail,
            onClose: () => setWizard(null),
            refreshStatus: refresh,
          }),
          confirm !== null && h(ConfirmDialog, {
            title: confirm.title,
            body: confirm.body,
            note: confirm.note,
            danger: confirm.danger,
            confirmLabel: confirm.confirmLabel,
            onClose: () => setConfirm(null),
            onError: (error) => toast(errorText(error), 'error'),
            onConfirm: confirm.onConfirm,
          })))

      function connectionRow(name, connected, user, offlineLabel) {
        return h('div', { className: 'sd-conn-row' },
          h('span', { className: 'sd-conn-dot' + (connected ? ' is-on' : '') }),
          h('span', { className: 'sd-conn-name' }, name),
          h('span', { className: 'sd-conn-user' }, connected ? (user ?? 'connected') : offlineLabel))
      }
    }

    function buildNotice(t, status, loading, error, retry) {
      if (error !== null) {
        return {
          text: t('读取账号状态失败：', 'Could not read account state: ') + errorText(error),
          actionLabel: t('重试', 'Retry'),
          action: () => retry?.(),
        }
      }
      if (loading || status === null) {
        return { text: t('正在读取账号与本地记录…', 'Reading accounts and local history…') }
      }
      if (status.authCorrupt === true) {
        return {
          text: t('本机凭据文件已损坏，无法读取已保存的 Token（原文件仍然保留，没有被覆盖）。请重新连接 npm 或 GitHub。',
            'The local credential file is corrupted, so the saved tokens could not be read (the original file is kept). Please reconnect npm or GitHub.'),
          actionLabel: t('重新连接', 'Reconnect'),
          action: () => setTabAndScroll('packages'),
        }
      }
      const npm = status.npm?.connected === true
      const github = status.github?.connected === true
      if (!npm && !github) {
        return {
          text: t('还没有连接账号。先在「npm 包库」或「GitHub 仓库」顶部登录，发布仓才能代你发布。',
            'No account connected yet. Sign in at the top of npm packages or GitHub repos before publishing.'),
          actionLabel: t('去 npm 包库', 'Open npm packages'),
          action: () => setTabAndScroll('packages'),
        }
      }
      if (npm && status?.npm?.expiresInDays !== null && status?.npm?.expiresInDays !== undefined && status.npm.expiresInDays <= 21) {
        return {
          text: status.npm.expiresInDays <= 0
            ? t('npm Token 已到期，发布会被拒绝。请重新生成 Token 并更新面板。', 'The npm token has expired; publishing will fail. Generate a new one and update the panel.')
            : t(`npm Token 还有 ${status.npm.expiresInDays} 天到期。npm 不再提供永久 Token，插件不会保存密码，因此不会自动续期；请到 Token 页面重新生成并更新到期日。`,
              `The npm token expires in ${status.npm.expiresInDays} days. npm no longer issues permanent tokens and the plugin does not store your password, so renewal is manual; regenerate it on the token page.`),
          actionLabel: t('去续期', 'Renew'),
          action: () => setTabAndScroll('packages'),
        }
      }
      if (npm && status?.npm?.bypass2fa === true) {
        return {
          text: t('当前 npm Token 勾选了 Bypass two-factor authentication。npm 会在 2027 年 1 月撤销这类 Token；建议改用普通 Granular Token，并在发布时填 6 位 TOTP。',
            'This npm token bypasses two-factor authentication. npm will revoke such tokens in January 2027; switch to a normal granular token and enter the 6-digit TOTP at publish time.'),
          actionLabel: t('去更换', 'Replace'),
          action: () => setTabAndScroll('packages'),
        }
      }
      if (!github) {
        return {
          text: t('npm 已连接，GitHub 未连接。发布到 npm 可以直接开始；GitHub Packages 与 Release 需要先连接 GitHub。',
            'npm is connected, GitHub is not. npm publishing works now; GitHub Packages and releases need GitHub.'),
          actionLabel: t('连接 GitHub', 'Connect GitHub'),
          action: () => setTabAndScroll('repos'),
        }
      }
      if (!npm) {
        return {
          text: t('GitHub 已连接，npm 未连接。可以推送仓库和创建 Release；发布到 npm 需要先登录。',
            'GitHub is connected, npm is not. Repos and releases work; npm publishing needs a token.'),
          actionLabel: t('连接 npm', 'Connect npm'),
          action: () => setTabAndScroll('packages'),
        }
      }
      return {
        text: t('两个账号都已就绪。选择一个项目即可开始发布；所有请求都从本机直接发往 registry 与 GitHub。',
          'Both accounts are ready. Pick a project to publish; every request goes from this machine to the registry and GitHub.'),
        actionLabel: t('开始发布', 'Start publishing'),
        action: () => setTabAndScroll('wizard'),
      }

      function setTabAndScroll(target) {
        // nav is owned by Panel; expose a small custom event to switch tabs.
        window.dispatchEvent(new CustomEvent('ship-deck:tab', { detail: target }))
      }
    }

    // Panel listens for the notice's tab requests.
    // ── dashboard ──────────────────────────────────────────────────────────

    function PageHead(props) {
      return h('div', { className: 'sd-glance sd-page-head' },
        h('div', null,
          h('span', { className: 'sd-eyebrow' }, props.eyebrow),
          h('h1', { className: 'sd-h1' }, props.title),
          props.desc ? h('p', { className: 'sd-sub' }, props.desc) : null),
        props.actions ? h('div', { className: 'sd-page-actions' }, props.actions) : null)
    }

    function StatCard(props) {
      return h('div', { className: `sd-stat sd-stat-${props.color}` },
        h('div', { className: 'sd-stat-label' }, props.label),
        h('div', { className: 'sd-stat-value' }, props.value),
        h('div', { className: 'sd-stat-sub' }, props.sub))
    }

    function Dashboard(props) {
      const { status, loading, refresh, openWizard, lang, t, toast, fail, setConfirm } = props
      const [records, setRecords] = React.useState(null)
      const [recordsLoading, setRecordsLoading] = React.useState(false)
      const [recordsError, setRecordsError] = React.useState(null)

      const loadRecords = React.useCallback(async () => {
        setRecordsLoading(true)
        try {
          const result = await call('history', { limit: 100 })
          setRecords(result.items ?? [])
          setRecordsError(null)
        } catch (error) {
          setRecordsError(error)
        } finally {
          setRecordsLoading(false)
        }
      }, [])

      React.useEffect(() => { loadRecords() }, [loadRecords, status?.counts?.history])

      if (loading && status === null) {
        return h('div', { className: 'sd-loading' }, h(Spinner, { large: true }), h('span', null, t('读取中…', 'Loading…')))
      }
      const npmConnected = status?.npm?.connected === true
      const githubConnected = status?.github?.connected === true
      const projects = status?.recentProjects ?? []

      const clearRecords = () => {
        setConfirm({
          title: t('清空发布记录？', 'Clear publish log?'),
          body: t('只删除本机的记录，不会影响 npm 包或 GitHub Release。', 'Only the local log is removed; npm packages and GitHub releases are untouched.'),
          confirmLabel: t('清空', 'Clear'),
          onConfirm: async () => {
            try {
              await call('history.clear')
              setRecords([])
              refresh()
              toast(t('发布记录已清空', 'Publish log cleared'), 'ok')
            } catch (error) {
              fail(error)
            }
          },
        })
      }

      return h('div', { className: 'sd-page' },
        h('div', { className: 'sd-glance' },
          h('div', null,
            h('span', { className: 'sd-eyebrow' }, 'WORKBENCH'),
            h('h1', { className: 'sd-h1' }, t('工作台', 'Workbench')),
            h('p', { className: 'sd-sub' }, t('账号、包、Release 与发布记录都在这里。', 'Accounts, packages, releases and the publish log in one place.'))),
          h('div', { className: 'sd-page-actions' },
            h(Btn, { variant: 'primary', onClick: () => openWizard({}) }, h(Icons.play, null), t('打开发布向导', 'Publish')),
            h(Btn, { variant: 'default', onClick: refresh, busy: loading }, h(Icons.refresh, null), t('刷新', 'Refresh')))),
        h('div', { className: 'sd-stat-grid' },
          h(StatCard, {
            color: 'mint',
            label: t('npm 包', 'NPM PACKAGES'),
            value: status?.counts?.npmPackages ?? '—',
            sub: npmConnected ? `@${status.npm.username ?? '?'}` : t('连接 npm 后加载', 'connect npm'),
          }),
          h(StatCard, {
            color: 'blue',
            label: t('GitHub Releases', 'GITHUB RELEASES'),
            value: status?.counts?.githubReleases ?? 0,
            sub: githubConnected ? `@${status.github.login ?? '?'}` : t('连接 GitHub 后可创建', 'connect GitHub'),
          }),
          h(StatCard, {
            color: 'pink',
            label: t('本地发布记录', 'LOCAL PUBLISHES'),
            value: status?.counts?.history ?? 0,
            sub: t('只保存在本机', 'stored locally'),
          })),
        h('section', { className: 'sd-section' },
          h('div', { className: 'sd-section-head' },
            h('h2', { className: 'sd-section-title' }, t('从最近项目开始', 'Start from a recent project')),
            h('span', { className: 'sd-section-hint' }, t('发布过的项目会出现在这里', 'Projects with history appear here'))),
          projects.length === 0
            ? h('div', { className: 'sd-project-empty' },
              h('div', { className: 'sd-empty-icon' }, h(Icons.folder, null)),
              h('div', null,
                h('strong', null, t('还没有发布过的项目', 'No published project yet')),
                h('p', null, t('选择本地目录即可开始第一次发布。', 'Pick a local directory to publish for the first time.'))),
              h(Btn, { variant: 'primary', onClick: () => openWizard({}) }, t('选择目录', 'Choose directory')))
            : h('div', { className: 'sd-projects' },
              projects.map((project, index) => h(ProjectCard, {
                key: project.name,
                project,
                color: ['blue', 'mint', 'lilac', 'pink'][index % 4],
                t,
                lang,
                onPublish: () => openWizard({ dir: project.dir }),
              })))),
        h('section', { className: 'sd-section' },
          h('div', { className: 'sd-section-head' },
            h('h2', { className: 'sd-section-title' }, t('发布记录', 'Publish log')),
            h('div', { className: 'sd-inline-row' },
              h(Btn, { size: 'sm', variant: 'ghost', onClick: loadRecords, busy: recordsLoading }, h(Icons.refresh, null), t('刷新', 'Refresh')),
              records !== null && records.length > 0 ? h(Btn, { size: 'sm', variant: 'ghost', onClick: clearRecords }, h(Icons.trash, null), t('清空', 'Clear')) : null)),
          recordsError !== null
            ? h('div', { className: 'sd-note sd-note-danger sd-inline-row' },
              h('span', { style: { flex: 1 } }, errorText(recordsError)),
              h(Btn, { size: 'sm', onClick: loadRecords }, t('重试', 'Retry')))
            : recordsLoading && records === null
              ? h('div', { className: 'sd-loading' }, h(Spinner, { large: true }))
              : records !== null && records.length === 0
                ? h('div', { className: 'sd-empty sd-empty-flat' }, h('span', null, t('还没有发布记录。完成一次发布后会记录在这里。', 'No publish records yet. The first publish will appear here.')))
                : h(HistoryTable, { items: records ?? [], t, lang })))
    }

    function ProjectCard(props) {
      const { project, color, t, lang, onPublish } = props
      const targets = Array.isArray(project.targets) ? project.targets : []
      return h('article', { className: `sd-project sd-project-${color}` },
        h('div', { className: 'sd-project-band' },
          h('span', { className: 'sd-project-name' }, project.name),
          h('span', { className: 'sd-project-tags' },
            targets.map((target) => h('span', { key: target, className: 'sd-project-tag' },
              target === 'npm' ? 'npm' : target === 'github-packages' ? 'GH-PKG' : 'GH-REL')))),
        h('div', { className: 'sd-project-body' },
          h('div', { className: 'sd-project-meta' },
            h('span', { className: 'sd-mono' }, `v${project.version ?? '—'}`),
            h('span', { className: 'sd-project-time' }, formatTime(project.at, lang))),
          h('div', { className: 'sd-project-dir', title: project.dir }, project.dir || '—'),
          h('div', { className: 'sd-project-foot' },
            h(Chip, { tone: project.ok ? 'ok' : 'warn' }, project.ok ? t('上次成功', 'last ok') : t('上次失败', 'last failed')),
            h('button', { type: 'button', className: 'sd-link-btn', onClick: onPublish }, t('继续发布 →', 'Publish again →')))))
    }

    function HistoryTable(props) {
      const { items, compact, t, lang } = props
      if (!Array.isArray(items) || items.length === 0) {
        return h('div', { className: 'sd-empty sd-empty-flat' }, t('暂无记录', 'No records'))
      }
      if (compact) {
        return h('div', { className: 'sd-mini-table' },
          items.map((record) => h('div', { key: record.id ?? `${record.package}@${record.version}@${record.at}`, className: 'sd-mini-row' },
            h('div', { className: 'sd-mini-main' },
              h('span', { className: 'sd-mono sd-strong' }, `${record.package}@${record.version}`),
              h('span', { className: 'sd-mini-dir' }, formatTime(record.at, lang))),
            h('div', { className: 'sd-mini-tags' },
              (record.targets ?? []).map((target, index) => h(Chip, {
                key: `${target.target}-${index}`,
                tone: target.ok ? 'ok' : 'danger',
              }, target.target === 'npm' ? 'npm' : target.target === 'github-packages' ? 'GH-PKG' : 'GH-REL'))),
            h('span', { className: `sd-status ${record.ok ? 'is-ok' : 'is-fail'}` }, record.ok ? 'OK' : 'FAIL'))))
      }
      return h('div', { className: 'sd-record-list' },
        items.map((record, index) => h(RecordCard, { key: record.id ?? `${record.package}@${record.version}@${record.at}@${index}`, record, t, lang })))
    }

    function RecordCard(props) {
      const { record, t, lang } = props
      const [open, setOpen] = React.useState(false)
      const targets = Array.isArray(record.targets) ? record.targets : []
      const failed = targets.filter((target) => target.ok !== true)
      return h('article', { className: 'sd-record' + (record.ok ? '' : ' is-fail') },
        h('div', { className: 'sd-record-head' },
          h('div', null,
            h('div', { className: 'sd-record-title' },
              h('span', { className: 'sd-mono sd-strong' }, `${record.package}@${record.version}`),
              record.dryRun === true ? h(Chip, { tone: 'warn' }, 'DRY RUN') : null,
              h('span', { className: `sd-status ${record.ok ? 'is-ok' : 'is-fail'}` }, record.ok ? 'OK' : 'FAIL')),
            h('div', { className: 'sd-record-meta' },
              h('span', null, formatTime(record.at, lang)),
              h('span', { className: 'sd-mono' }, record.actor === 'tool' ? 'agent' : 'panel'),
              h('span', null, `${targets.length} ${t('个目标', 'targets')}`),
              h('span', { className: 'sd-mono' }, record.tarball?.size !== undefined ? formatBytes(record.tarball.size) : ''))),
          h('button', { type: 'button', className: 'sd-link-btn', onClick: () => setOpen(!open) }, open ? t('收起', 'Hide') : t('详情', 'Details'))),
        h('div', { className: 'sd-record-tags' },
          targets.map((target, index) => h(Chip, { key: `${target.target}-${index}`, tone: target.ok ? 'ok' : 'danger' },
            `${target.target === 'npm' ? 'npm' : target.target === 'github-packages' ? 'GH-PKG' : 'GH-REL'} · ${target.ok ? 'ok' : 'fail'}`))),
        open
          ? h('div', { className: 'sd-record-body' },
            failed.length > 0
              ? h('div', { className: 'sd-note sd-note-danger' },
                failed.map((target) => h('div', { key: target.target },
                  h('strong', null, `${target.target}: `), target.error?.message ?? 'failed',
                  target.error?.hint ? h('div', { className: 'sd-note-hint' }, target.error.hint) : null)))
              : null,
            targets.map((target) => h('div', { key: target.target, className: 'sd-record-target' },
              h('div', { className: 'sd-record-target-head' },
                h('strong', null, target.target),
                h('span', { className: 'sd-mono' }, `${target.durationMs ?? 0}ms`)),
              h('div', { className: 'sd-record-links' },
                target.url ? h('a', { href: target.url, target: '_blank', rel: 'noopener noreferrer', className: 'sd-link' }, 'npm') : null,
                target.release?.htmlUrl ? h('a', { href: target.release.htmlUrl, target: '_blank', rel: 'noopener noreferrer', className: 'sd-link' }, `Release ${target.release.tag}`) : null,
                target.commitUrl ? h('a', { href: target.commitUrl, target: '_blank', rel: 'noopener noreferrer', className: 'sd-link' }, `commit ${String(target.commitSha ?? '').slice(0, 7)}`) : null,
                target.repoUrl ? h('a', { href: target.repoUrl, target: '_blank', rel: 'noopener noreferrer', className: 'sd-link' }, `${target.owner}/${target.repo}`) : null,
                target.asset?.url ? h('a', { href: target.asset.url, target: '_blank', rel: 'noopener noreferrer', className: 'sd-link' }, `asset ${target.asset.name}`) : null),
              target.error?.message ? h('div', { className: 'sd-record-error' }, target.error.message) : null,
              target.warnings?.length > 0
                ? h('ul', { className: 'sd-warn-list' }, target.warnings.map((warning, index) => h('li', { key: index }, warning)))
                : null)))
          : null)
    }

    // ── npm packages ───────────────────────────────────────────────────────

    function PackagesPage(props) {
      const { status, t, lang, toast, fail, openWizard, onOpenDetail, refreshStatus } = props
      const [data, setData] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [query, setQuery] = React.useState('')
      const [error, setError] = React.useState(null)
      const connected = status?.npm?.connected === true

      const load = React.useCallback(async (refresh = false) => {
        if (!connected) {
          setLoading(false)
          return
        }
        setLoading(true)
        try {
          const result = await call('npm.packages', { limit: 60, refresh })
          setData(result)
          setError(null)
          if (typeof refreshStatus === 'function') refreshStatus()
        } catch (err) {
          setError(err)
        } finally {
          setLoading(false)
        }
      }, [connected, refreshStatus])

      React.useEffect(() => { load(false) }, [load])

      const items = (data?.items ?? []).filter((item) => {
        const text = query.trim().toLowerCase()
        if (text === '') return true
        return item.name.toLowerCase().includes(text) || String(item.description ?? '').toLowerCase().includes(text)
      })

      return h('div', { className: 'sd-page' },
        h(PageHead, {
          eyebrow: 'NPM REGISTRY',
          title: t('npm 包库', 'npm packages'),
          desc: t('账号、包列表与版本管理；dist-tag、访问级别、废弃与删除都直接调用 registry。',
            'Account, packages and version management; dist-tags, access, deprecation and unpublish call the registry.'),
          actions: h(React.Fragment, null,
            connected ? h(Btn, { onClick: () => load(true), busy: loading }, h(Icons.refresh, null), t('刷新', 'Refresh')) : null,
            h(Btn, { variant: 'primary', onClick: () => openWizard({}) }, h(Icons.plus, null), t('发布新包', 'Publish'))),
        }),
        h(NpmAccountCard, { status, t, toast, fail, refreshStatus, packageCount: data?.total ?? null }),
        connected
          ? h(React.Fragment, null,
            h('div', { className: 'sd-toolbar' },
              h('div', { className: 'sd-search' },
                h('span', { className: 'sd-search-icon' }, h(Icons.package, null)),
                h('input', {
                  type: 'search',
                  className: 'sd-input sd-search-input',
                  placeholder: t('按包名或描述过滤…', 'Filter by name or description…'),
                  'aria-label': t('过滤 npm 包', 'Filter npm packages'),
                  value: query,
                  onChange: (event) => setQuery(event.target.value),
                })),
              data !== null && h(Chip, { tone: 'plain' }, data.source === 'search'
                ? t('公开搜索 · 私有包不显示', 'public search · private packages hidden')
                : t('账号授权列表', 'account access list')),
              data !== null && h('span', { className: 'sd-toolbar-note' },
                `${data.total ?? items.length} ${t('个包', 'packages')}${data.truncated ? t('（已截断）', ' (truncated)') : ''}`)),
            data?.warnings?.length > 0
              ? h('div', { className: 'sd-note' }, data.warnings.map((warning, index) => h('div', { key: index }, warning)))
              : null,
            error !== null
              ? h('div', { className: 'sd-note sd-note-danger' }, errorText(error))
              : null,
            loading && data === null
              ? h('div', { className: 'sd-loading' }, h(Spinner, { large: true }), h('span', null, t('读取包列表…', 'Loading packages…')))
              : items.length === 0
                ? h(EmptyState, {
                  title: t('没有匹配的包', 'No matching packages'),
                  body: error !== null ? t('上一次读取失败，可以点刷新重试。', 'The last read failed; try Refresh.') : t('换一个关键词，或先发布第一个包。', 'Try another keyword, or publish your first package.'),
                })
                : h('div', { className: 'sd-pkg-list' },
                  items.map((item) => h(PackageRow, {
                    key: item.name,
                    item,
                    t,
                    lang,
                    status,
                    onOpen: () => onOpenDetail(item.name),
                    onCopy: async () => {
                      const command = `npm i ${item.name}@${item.version ?? 'latest'}`
                      try {
                        await navigator.clipboard.writeText(command)
                        toast(t('已复制安装命令', 'Install command copied'), 'ok')
                      } catch {
                        toast(command, 'ok')
                      }
                    },
                  }))))
          : h(EmptyState, {
            icon: h(Icons.npm, null),
            title: t('npm 尚未登录', 'npm is not connected'),
            body: t('在上方粘贴 Granular Access Token（Permissions 选 Read and write (publish and stage)），保存后即可读取你的包。',
              'Paste a granular access token above with Read and write (publish and stage) to load your packages.'),
          }))
    }

    function PackageRow(props) {
      const { item, t, lang, status, onOpen, onCopy } = props
      const registry = status?.npm?.registry
      const url = packageUrl(item.name, registry)
      return h('article', { className: 'sd-pkg' },
        h('div', { className: 'sd-pkg-main' },
          h('div', { className: 'sd-pkg-title' },
            h('span', { className: 'sd-mono sd-strong' }, item.name),
            item.permission ? h(Chip, { tone: item.permission === 'write' ? 'ok' : 'plain' }, item.permission) : null,
            item.deprecatedLatest ? h(Chip, { tone: 'warn' }, t('最新版已废弃', 'latest deprecated')) : null),
          h('p', { className: 'sd-pkg-desc' }, item.description || t('（没有描述）', '(no description)')),
          h('div', { className: 'sd-pkg-meta' },
            h('span', null, t('最新 ', 'latest '), h('span', { className: 'sd-mono' }, item.version ?? '—')),
            h('span', null, formatTime(item.modified, lang)),
            item.license ? h('span', null, item.license) : null,
            item.repository ? h('span', { className: 'sd-ellipsis', title: item.repository }, item.repository) : null)),
        h('div', { className: 'sd-pkg-side' },
          h('div', { className: 'sd-pkg-version' }, item.version ?? '—'),
          h('div', { className: 'sd-pkg-actions' },
            h(Btn, { size: 'sm', onClick: onOpen }, t('详情', 'Details')),
            h(Btn, { size: 'sm', variant: 'ghost', onClick: onCopy }, t('安装命令', 'Install')),
            url !== null ? h('a', {
              className: 'sd-btn sd-btn-sm sd-btn-ghost', href: url, target: '_blank', rel: 'noopener noreferrer',
            }, t('打开', 'Open')) : null)),
        item.error ? h('div', { className: 'sd-note sd-note-danger sd-pkg-error' }, item.error) : null)
    }

    function PackageDetail(props) {
      const { name, t, lang, toast, fail, refreshStatus, onClose, setConfirm } = props
      const [info, setInfo] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [tagForm, setTagForm] = React.useState({ tag: '', version: '', otp: '', open: false })
      const [tagBusy, setTagBusy] = React.useState(false)
      const [deleteTag, setDeleteTag] = React.useState(null)
      const [deleteTagOtp, setDeleteTagOtp] = React.useState('')
      const [deprecate, setDeprecate] = React.useState(null)
      const [deprecateMessage, setDeprecateMessage] = React.useState('')
      const [deprecateOtp, setDeprecateOtp] = React.useState('')
      const [deprecateBusy, setDeprecateBusy] = React.useState(false)
      const [unpublish, setUnpublish] = React.useState({ version: '', confirmName: '', whole: false, open: false })
      const [accessForm, setAccessForm] = React.useState({ access: 'public', otp: '' })
      const [accessBusy, setAccessBusy] = React.useState(false)
      const [ownerForm, setOwnerForm] = React.useState({ user: '', otp: '' })
      const [ownerBusy, setOwnerBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        setLoading(true)
        try {
          const value = await call('npm.info', { name })
          setInfo(value)
          setError(null)
        } catch (err) {
          setError(err)
        } finally {
          setLoading(false)
        }
      }, [name])

      React.useEffect(() => { load() }, [load])

      const saveTag = async () => {
        setTagBusy(true)
        try {
          await call('npm.set-tag', { name, tag: tagForm.tag.trim(), version: tagForm.version.trim(), otp: tagForm.otp.trim() })
          toast(t('dist-tag 已更新', 'dist-tag updated'), 'ok')
          setTagForm({ tag: '', version: '', otp: '', open: false })
          await load()
          refreshStatus?.()
        } catch (err) {
          fail(err)
        } finally {
          setTagBusy(false)
        }
      }

      const removeTag = async (tag) => {
        try {
          await call('npm.delete-tag', { name, tag, otp: deleteTagOtp.trim() })
          toast(t(`已删除 tag ${tag}`, `Removed tag ${tag}`), 'ok')
          setDeleteTag(null)
          setDeleteTagOtp('')
          await load()
        } catch (err) {
          fail(err)
        }
      }

      const applyDeprecate = async (version, message) => {
        setDeprecateBusy(true)
        try {
          await call('npm.deprecate', { name, range: version, message, otp: deprecateOtp.trim() })
          toast(message === '' ? t('已取消废弃', 'Undeprecated') : t('已标记废弃', 'Deprecated'), 'ok')
          setDeprecate(null)
          setDeprecateMessage('')
          await load()
        } catch (err) {
          fail(err)
        } finally {
          setDeprecateBusy(false)
        }
      }

      const changeOwner = async (action, user) => {
        const target = String(user ?? ownerForm.user).trim()
        if (target === '') {
          toast(t('填写 npm 用户名', 'Enter an npm username'), 'error')
          return
        }
        setOwnerBusy(true)
        try {
          await call('npm.change-owner', { name, user: target, action, otp: ownerForm.otp.trim() })
          toast(action === 'add' ? t('维护者已添加', 'Maintainer added') : t('维护者已移除', 'Maintainer removed'), 'ok')
          setOwnerForm({ user: '', otp: ownerForm.otp })
          await load()
        } catch (err) {
          fail(err)
        } finally {
          setOwnerBusy(false)
        }
      }

      const askRemoveOwner = (user) => {
        setConfirm?.({
          title: t('移除维护者', 'Remove maintainer'),
          body: t(`从 ${name} 移除 ${user} 的维护权限。`, `Remove ${user} from ${name}.`),
          danger: true,
          confirmLabel: t('移除', 'Remove'),
          onConfirm: () => changeOwner('remove', user),
        })
      }

      const saveAccess = async () => {
        setAccessBusy(true)
        try {
          await call('npm.set-access', { name, access: accessForm.access, otp: accessForm.otp.trim() })
          toast(t('访问级别已更新', 'Access updated'), 'ok')
          await load()
          refreshStatus?.()
        } catch (err) {
          fail(err)
        } finally {
          setAccessBusy(false)
        }
      }

      const askUnpublish = () => {
        const version = unpublish.whole ? '' : unpublish.version.trim()
        if (!unpublish.whole && version === '') {
          toast(t('请选择要删除的版本', 'Choose a version to remove'), 'error')
          return
        }
        if (unpublish.whole && unpublish.confirmName.trim() !== name) {
          toast(t('请输入完整包名以确认删除整包', 'Type the exact package name to remove the whole package'), 'error')
          return
        }
        resetScratch()
        setConfirm?.({
          title: t('删除 npm 包内容', 'Remove from npm'),
          body: unpublish.whole
            ? t(`即将删除整个包 ${name} 及其所有版本。这可能不可恢复。`, `This removes ${name} and every version. It may be unrecoverable.`)
            : t(`即将删除 ${name}@${version}。同一天内可重新发布该版本。`, `This removes ${name}@${version}. npm allows republishing that version only within the same day.`),
          note: h('div', { className: 'sd-confirm-otp' },
            h('strong', { className: 'sd-confirm-warn' },
              t('npm 侧大概率还没启用 2FA', 'npm 2FA is probably not enabled yet')),
            h('span', { className: 'sd-field-hint' },
              t('npm 的规则是「账号开启 2FA」或「Token 勾选 Bypass 2FA」二选一。如果账号没绑验证器，这里填任何 6 位数字都会被拒绝——因为 npm 根本不校验它。',
                'npm requires either account 2FA or a bypass-2FA token. If no authenticator is registered, any 6-digit code is rejected — npm never even checks it.')),
            h(TextInput, {
              defaultValue: OT.npmOtp,
              placeholder: t('已绑定验证器时填 6 位码', '6-digit code if an authenticator is registered'),
              inputMode: 'numeric',
              autoComplete: 'one-time-code',
              maxLength: 6,
              autoFocus: true,
              onChange: (event) => { OT.npmOtp = event.target.value },
            }),
            h('span', { className: 'sd-confirm-otp-warn' },
              t('⚠ 恢复码（recovery codes）不能填这里：npm 只接受真正的动态码，填恢复码会触发 72 小时安全限制，期间无法发布或删除。',
                '⚠ Do not paste recovery codes here: npm only accepts a real TOTP. A recovery code triggers a 72-hour security hold during which publishing and unpublishing are blocked.')),
            h('span', { className: 'sd-field-hint' },
              t('两个更省事的选择：', 'Two easier options: '),
              h('a', { className: 'sd-link', href: `https://www.npmjs.com/package/${name}/access`, target: '_blank', rel: 'noopener noreferrer' }, t('在 npm 网页删除', 'delete on npm')),
              t('，或 '),
              h('a', { className: 'sd-link', href: 'https://www.npmjs.com/settings/~/tfa', target: '_blank', rel: 'noopener noreferrer' }, t('去开启 2FA', 'enable 2FA')),
              t('（开启时会显示二维码和 secret，可导入电脑上的验证器）。', ' (setup shows a QR code and secret you can import into a desktop authenticator).'))),
          danger: true,
          confirmLabel: t('确认删除', 'Remove'),
          onConfirm: async () => {
            await call('npm.unpublish', {
              name,
              version: unpublish.whole ? '' : version,
              force: true,
              confirmName: unpublish.confirmName.trim(),
              otp: OT.npmOtp.trim(),
            })
            toast(t('删除成功', 'Removed'), 'ok')
            if (unpublish.whole) {
              onClose()
              refreshStatus?.()
            } else {
              await load()
              refreshStatus?.()
            }
          },
        })
      }

      return h(Modal, {
        title: h('span', { className: 'sd-mono' }, name),
        subtitle: info !== null ? `v${info.latest ?? '—'} · ${info.versions?.length ?? 0} ${t('个版本', 'versions')}` : undefined,
        wide: true,
        onClose,
        footer: h(React.Fragment, null,
          info?.install ? h(CopyButton, { text: info.install, label: t('复制安装命令', 'Copy install') }) : null,
          h(Btn, { variant: 'ghost', onClick: onClose }, t('关闭', 'Close'))),
      },
        loading && info === null
          ? h('div', { className: 'sd-loading' }, h(Spinner, { large: true }))
          : error !== null
            ? h('div', { className: 'sd-note sd-note-danger' }, errorText(error))
            : info !== null && h(React.Fragment, null,
              h('div', { className: 'sd-detail-grid' },
                h('div', { className: 'sd-detail-desc' }, info.description || t('（没有描述）', '(no description)')),
                h('div', { className: 'sd-detail-facts' },
                  fact(t('创建', 'Created'), formatTime(info.created, lang)),
                  fact(t('更新', 'Updated'), formatTime(info.modified, lang)),
                  fact(t('License', 'License'), info.license ?? '—'),
                  info.repository ? fact('Repository', info.repository) : null)),
              h('div', { className: 'sd-split' },
                h('section', { className: 'sd-subcard' },
                  h('div', { className: 'sd-subhead' },
                    h('h3', null, t('dist-tags', 'dist-tags')),
                    h(Btn, { size: 'sm', variant: 'ghost', onClick: () => setTagForm({ ...tagForm, open: !tagForm.open }) },
                      tagForm.open ? t('收起', 'Hide') : t('添加', 'Add'))),
                  Object.entries(info.distTags ?? {}).map(([tag, version]) => h('div', { key: tag, className: 'sd-tag-row' },
                    h('span', { className: 'sd-mono sd-tag-name' }, tag),
                    h('span', { className: 'sd-mono' }, version),
                    deleteTag === tag
                      ? h('span', { className: 'sd-inline-row' },
                        h(TextInput, {
                          placeholder: 'OTP',
                          value: deleteTagOtp,
                          maxLength: 6,
                          'aria-label': t('一次性验证码', 'one-time code'),
                          className: 'sd-input-mini',
                          onChange: (event) => setDeleteTagOtp(event.target.value),
                        }),
                        h(Btn, { size: 'sm', variant: 'danger', onClick: () => removeTag(tag) }, t('确认删除', 'Delete')),
                        h(Btn, { size: 'sm', variant: 'ghost', onClick: () => { setDeleteTag(null); setDeleteTagOtp('') } }, t('取消', 'Cancel')))
                      : h('button', {
                        type: 'button',
                        className: 'sd-link-btn sd-danger-text',
                        'aria-label': t(`删除 tag ${tag}`, `remove tag ${tag}`),
                        onClick: () => { setDeleteTag(tag); setDeleteTagOtp('') },
                      }, t('删除', 'remove')))),
                  tagForm.open
                    ? h('div', { className: 'sd-inline-form' },
                      h('div', { className: 'sd-inline-row' },
                        h(TextInput, { placeholder: 'tag', 'aria-label': t('dist-tag 名称', 'dist-tag name'), value: tagForm.tag, onChange: (event) => setTagForm({ ...tagForm, tag: event.target.value }) }),
                        h(TextInput, { placeholder: t('版本', 'version'), 'aria-label': t('目标版本', 'target version'), value: tagForm.version, onChange: (event) => setTagForm({ ...tagForm, version: event.target.value }) }),
                        h(TextInput, { placeholder: 'OTP', 'aria-label': t('一次性验证码', 'one-time code'), value: tagForm.otp, onChange: (event) => setTagForm({ ...tagForm, otp: event.target.value }), maxLength: 6 })),
                      h(Btn, { size: 'sm', variant: 'primary', busy: tagBusy, onClick: saveTag }, t('保存 tag', 'Save tag')))
                    : null),
                h('section', { className: 'sd-subcard' },
                  h('div', { className: 'sd-subhead' }, h('h3', null, t('危险操作', 'Danger zone'))),
                  h('div', { className: 'sd-inline-row' },
                    h('label', { className: 'sd-check' },
                      h('input', { type: 'checkbox', checked: unpublish.whole, onChange: (event) => setUnpublish({ ...unpublish, whole: event.target.checked }) }),
                      h('span', null, t('删除整包', 'Remove whole package'))),
                    h('label', { className: 'sd-check' },
                      h('input', { type: 'checkbox', checked: unpublish.open, onChange: (event) => setUnpublish({ ...unpublish, open: event.target.checked }) }),
                      h('span', null, t('展开', 'Show')))),
                  unpublish.open
                    ? h(React.Fragment, null,
                      unpublish.whole
                        ? h(TextInput, {
                          placeholder: t('输入完整包名确认', 'type the package name to confirm'),
                          value: unpublish.confirmName,
                          onChange: (event) => setUnpublish({ ...unpublish, confirmName: event.target.value }),
                        })
                        : h('select', {
                          className: 'sd-input',
                          value: unpublish.version,
                          onChange: (event) => setUnpublish({ ...unpublish, version: event.target.value }),
                        },
                          h('option', { value: '' }, t('选择版本', 'select version')),
                          info.versions.map((version) => h('option', { key: version.version, value: version.version }, version.version))),
                      h(Btn, { size: 'sm', variant: 'danger', onClick: askUnpublish }, h(Icons.trash, null), t('删除', 'Remove')))
                    : h('div', { className: 'sd-field-hint' }, t('npm 只允许同一天内重新发布被删除的版本；删除需要在 npm 网页或 npm CLI 完成。', 'npm only allows republishing a removed version the same day; deletion must be done on the npm website or with the npm CLI.')))),
              h('section', { className: 'sd-subcard' },
                h('div', { className: 'sd-subhead' }, h('h3', null, t('访问级别', 'Access')), h(Icons.shield, null)),
                h('div', { className: 'sd-inline-row' },
                  h('select', {
                    className: 'sd-input',
                    value: accessForm.access,
                    'aria-label': t('访问级别', 'Access level'),
                    onChange: (event) => setAccessForm({ ...accessForm, access: event.target.value }),
                  },
                    h('option', { value: 'public' }, 'public'),
                    h('option', { value: 'restricted' }, t('private（仅 scoped 包）', 'private (scoped only)'))),
                  h(TextInput, { placeholder: 'OTP', 'aria-label': t('一次性验证码', 'one-time code'), value: accessForm.otp, maxLength: 6, className: 'sd-input-mini', onChange: (event) => setAccessForm({ ...accessForm, otp: event.target.value }) }),
                  h(Btn, { size: 'sm', variant: 'primary', busy: accessBusy, onClick: saveAccess }, t('更新', 'Update'))),
                h('div', { className: 'sd-field-hint' }, t('只有 scoped 包（@scope/name）可以设为 private；私有包可能需要付费账户。', 'Only scoped packages can be private; private packages may require a paid account.'))),
              h('section', { className: 'sd-subcard' },
                h('div', { className: 'sd-subhead' }, h('h3', null, t('维护者', 'Maintainers')), h('span', { className: 'sd-mono' }, String(info.maintainers?.length ?? 0))),
                h('div', { className: 'sd-chips' },
                  (info.maintainers ?? []).map((maintainer) => h('span', { key: maintainer.name, className: 'sd-owner-chip' },
                    h('span', { className: 'sd-mono' }, maintainer.name),
                    info.maintainers.length > 1
                      ? h('button', {
                        type: 'button',
                        className: 'sd-owner-remove',
                        'aria-label': t(`移除维护者 ${maintainer.name}`, `Remove maintainer ${maintainer.name}`),
                        onClick: () => askRemoveOwner(maintainer.name),
                      }, '×')
                      : null))),
                h('div', { className: 'sd-inline-row' },
                  h(TextInput, {
                    placeholder: t('npm 用户名', 'npm username'),
                    'aria-label': t('npm 用户名', 'npm username'),
                    value: ownerForm.user,
                    onChange: (event) => setOwnerForm({ ...ownerForm, user: event.target.value }),
                  }),
                  h(TextInput, {
                    placeholder: 'OTP', 'aria-label': t('一次性验证码', 'one-time code'),
                    className: 'sd-input-mini', maxLength: 6,
                    value: ownerForm.otp,
                    onChange: (event) => setOwnerForm({ ...ownerForm, otp: event.target.value }),
                  }),
                  h(Btn, { size: 'sm', variant: 'primary', busy: ownerBusy, onClick: () => changeOwner('add') }, t('添加维护者', 'Add'))),
                h('div', { className: 'sd-field-hint' }, t('与 npm owner add/rm 协议一致；不能移除最后一位维护者。', 'Matches npm owner add/rm; the last maintainer cannot be removed.'))),
              h('section', { className: 'sd-subcard' },
                h('div', { className: 'sd-subhead' }, h('h3', null, t('版本', 'Versions')), h('span', { className: 'sd-mono' }, String(info.versions.length))),
                h('div', { className: 'sd-version-list' },
                  info.versions.slice(0, 60).map((version) => h('div', { key: version.version, className: 'sd-version-row' },
                    h('span', { className: 'sd-mono sd-strong' }, version.version),
                    h('span', { className: 'sd-version-time' }, formatTime(version.time, lang)),
                    version.deprecated ? h(Chip, { tone: 'warn' }, t('已废弃', 'deprecated')) : null,
                    h('div', { className: 'sd-version-actions' },
                      version.deprecated
                        ? h(Btn, { size: 'sm', variant: 'ghost', onClick: () => applyDeprecate(version.version, '') }, t('取消废弃', 'Undeprecate'))
                        : h(Btn, { size: 'sm', variant: 'ghost', onClick: () => setDeprecate(version.version) }, t('废弃', 'Deprecate')),
                      deprecate === version.version
                        ? h('div', { className: 'sd-inline-form sd-inline-wide' },
                          h(TextInput, {
                            placeholder: t('废弃说明', 'deprecation message'),
                            value: deprecateMessage,
                            onChange: (event) => setDeprecateMessage(event.target.value),
                          }),
                          h(TextInput, { placeholder: 'OTP', 'aria-label': t('一次性验证码', 'one-time code'), value: deprecateOtp, onChange: (event) => setDeprecateOtp(event.target.value), maxLength: 6 }),
                          h(Btn, { size: 'sm', variant: 'primary', busy: deprecateBusy, onClick: () => applyDeprecate(version.version, deprecateMessage) }, t('保存', 'Save')))
                        : null)))),
                info.versions.length > 60 ? h('div', { className: 'sd-field-hint' }, t('仅显示前 60 个版本', 'Showing the first 60 versions')) : null),
              info.readme
                ? h('details', { className: 'sd-readme-box' },
                  h('summary', null, t('README', 'README')),
                  h('pre', { className: 'sd-readme' }, info.readme))
                : null))

      function fact(label, value) {
        return h('div', { className: 'sd-fact' }, h('span', null, label), h('strong', null, value))
      }
    }

    // ── GitHub repos ───────────────────────────────────────────────────────

    function ReposPage(props) {
      const { status, t, lang, toast, fail, openPush, openReleases, refreshStatus, setConfirm } = props
      const [repos, setRepos] = React.useState([])
      const [loading, setLoading] = React.useState(true)
      const [reposError, setReposError] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [form, setForm] = React.useState({ name: '', private: true, description: '', org: '' })
      const [creating, setCreating] = React.useState(false)
      const connected = status?.github?.connected === true

      const load = React.useCallback(async (refresh = false) => {
        if (!connected) { setLoading(false); return }
        setLoading(true)
        try {
          const result = await call('github.repos', { limit: 50, refresh })
          setRepos(result.items)
          setReposError(null)
        } catch (error) {
          setReposError(error)
          fail(error)
        } finally {
          setLoading(false)
        }
      }, [connected, fail])

      React.useEffect(() => { load(false) }, [load])

      const create = async () => {
        if (form.name.trim() === '') {
          toast(t('填写仓库名', 'Enter a repository name'), 'error')
          return
        }
        setCreating(true)
        try {
          const result = await call('github.create-repo', {
            name: form.name.trim(),
            private: form.private,
            description: form.description,
            org: form.org.trim(),
          })
          toast(t(`已创建 ${result.repo.fullName}`, `Created ${result.repo.fullName}`), 'ok')
          setForm({ name: '', private: true, description: '', org: '' })
          await load(true)
          refreshStatus()
        } catch (error) {
          fail(error)
        } finally {
          setCreating(false)
        }
      }

      const missingDeleteScope = connected &&
        Array.isArray(status?.github?.scopes) && status.github.scopes.length > 0 &&
        !status.github.scopes.includes('delete_repo')

      const askDeleteRepo = (repo) => {
        resetScratch()
        setConfirm?.({
          title: t(`删除仓库 ${repo.fullName}？`, `Delete ${repo.fullName}?`),
          body: t('将永久删除该仓库及其所有代码、Issue、Release 与 tag；GitHub 不提供回收站。', 'This permanently deletes the repository, all code, issues, releases and tags; GitHub has no trash.'),
          note: h('div', { className: 'sd-confirm-otp' },
            missingDeleteScope
              ? h(React.Fragment, null,
                h('strong', { className: 'sd-confirm-warn' }, t('当前 Token 缺少 delete_repo 权限', 'This token lacks delete_repo')),
                h('span', { className: 'sd-field-hint' },
                  t('你的 Token scopes 是 ', 'Your token scopes are '),
                  h('code', null, (status.github.scopes ?? []).join(', ')),
                  t('，里面没有 delete_repo，所以删除一定会被 GitHub 拒绝。', ' — no delete_repo, so GitHub will always refuse.')),
                h('a', {
                  className: 'sd-btn sd-btn-sm sd-btn-primary',
                  href: 'https://github.com/settings/tokens',
                  target: '_blank',
                  rel: 'noopener noreferrer',
                }, t('去 GitHub 勾选 delete_repo 并重新生成', 'Add delete_repo on GitHub'))  ,
                h('span', { className: 'sd-field-hint' },
                  t('重新生成后回到「GitHub 仓库」顶部更新 Token 即可。', 'After regenerating, update the token at the top of GitHub repos.')))
              : h(React.Fragment, null,
                h('span', { className: 'sd-field-hint' }, t(`输入 ${repo.fullName} 确认；需要该仓库的 Administration 权限。`, `Type ${repo.fullName}; requires Administration access to this repository.`)),
                h(TextInput, {
                  autoFocus: true,
                  placeholder: repo.fullName,
                  onChange: (event) => { OT.confirmText = event.target.value },
                }))),
          danger: true,
          confirmLabel: t('永久删除仓库', 'Delete repository'),
          onConfirm: async () => {
            if (missingDeleteScope) {
              throw new Error(t('Token 缺少 delete_repo，请先在 GitHub 上重新生成 Token。', 'The token lacks delete_repo; regenerate it on GitHub first.'))
            }
            if (OT.confirmText.trim() !== repo.fullName) {
              throw new Error(t(`请准确输入 ${repo.fullName}`, `Type ${repo.fullName} exactly`))
            }
            await call('github.delete-repo', {
              owner: repo.owner,
              repo: repo.name,
              force: true,
              confirmName: OT.confirmText.trim(),
            })
            toast(t(`已删除 ${repo.fullName}`, `Deleted ${repo.fullName}`), 'ok')
            await load(true)
            refreshStatus()
          },
        })
      }

      if (!connected) {
        return h('div', { className: 'sd-page' },
          h(PageHead, {
            eyebrow: 'GITHUB',
            title: t('GitHub 仓库', 'GitHub repos'),
            desc: t('账号、仓库、Release 与推送；连接后可以列出仓库、推送目录、创建 Release。', 'Account, repositories, releases and pushes.'),
          }),
          h(GithubAccountCard, { status, t, toast, fail, refreshStatus }),
          h(EmptyState, {
            icon: h(Icons.github, null),
            title: t('GitHub 尚未连接', 'GitHub is not connected'),
            body: t('在上方用设备流或 Personal Access Token 登录；令牌只保存在本机。', 'Sign in above with the device flow or a personal access token; the token stays local.'),
          }))
      }

      const filtered = repos.filter((repo) => {
        const text = query.trim().toLowerCase()
        return text === '' || repo.fullName.toLowerCase().includes(text) || String(repo.description ?? '').toLowerCase().includes(text)
      })

      return h('div', { className: 'sd-page' },
        h(PageHead, {
          eyebrow: 'GITHUB',
          title: t('GitHub 仓库', 'GitHub repos'),
          desc: t('列出你拥有或可协作的仓库；推送一个目录即可生成提交，Release 可附带 npm tarball。',
            'Repositories you own or collaborate on; push a directory as a commit, and attach the npm tarball to a release.'),
          actions: h(Btn, { onClick: () => load(true), busy: loading }, h(Icons.refresh, null), t('刷新', 'Refresh')),
        }),
        h(GithubAccountCard, { status, t, toast, fail, refreshStatus }),
        h('div', { className: 'sd-repo-layout' },
          h('section', { className: 'sd-repo-main' },
            h('div', { className: 'sd-toolbar' },
              h('div', { className: 'sd-search' },
                h('span', { className: 'sd-search-icon' }, h(Icons.repo, null)),
                h('input', {
                  type: 'search', className: 'sd-input sd-search-input',
                  placeholder: t('过滤仓库…', 'Filter repositories…'),
                  'aria-label': t('过滤仓库', 'Filter repositories'),
                  value: query, onChange: (event) => setQuery(event.target.value),
                })),
              h('span', { className: 'sd-toolbar-note' }, `${filtered.length} / ${repos.length}`)),
            loading && repos.length === 0
              ? h('div', { className: 'sd-loading' }, h(Spinner, { large: true }))
              : filtered.length === 0
                ? reposError !== null && repos.length === 0
                  ? h('div', { className: 'sd-note sd-note-danger sd-inline-row' },
                    h('span', { style: { flex: 1 } }, errorText(reposError)),
                    h(Btn, { size: 'sm', onClick: () => load(true) }, t('重试', 'Retry')))
                  : h(EmptyState, { title: t('没有仓库', 'No repositories'), body: t('改个关键词，或在右侧创建第一个仓库。', 'Try another keyword or create one on the right.') })
                : h('div', { className: 'sd-repo-list' },
                  filtered.map((repo) => h('article', { key: repo.fullName, className: 'sd-repo' },
                    h('div', { className: 'sd-repo-info' },
                      h('div', { className: 'sd-repo-title' },
                        h('span', { className: 'sd-mono sd-strong' }, repo.fullName),
                        repo.private ? h(Chip, { tone: 'warn' }, 'private') : h(Chip, { tone: 'plain' }, 'public'),
                        repo.archived ? h(Chip, { tone: 'danger' }, 'archived') : null),
                      h('p', null, repo.description || t('（没有描述）', '(no description)')),
                      h('div', { className: 'sd-repo-meta' },
                        h('span', null, t('默认分支 ', 'default '), h('span', { className: 'sd-mono' }, repo.defaultBranch ?? '—')),
                        h('span', null, formatTime(repo.updatedAt, lang)),
                        repo.language ? h('span', null, repo.language) : null)),
                    h('div', { className: 'sd-repo-actions' },
                      h(Btn, { size: 'sm', onClick: () => openPush(repo) }, t('推送目录', 'Push dir')),
                      h(Btn, { size: 'sm', variant: 'ghost', onClick: () => openReleases(repo) }, t('Releases', 'Releases')),
                      h(Btn, { size: 'sm', variant: 'danger', onClick: () => askDeleteRepo(repo) }, h(Icons.trash, null), t('删除', 'Delete')),
                      repo.htmlUrl ? h('a', {
                        className: 'sd-btn sd-btn-sm sd-btn-ghost', href: repo.htmlUrl, target: '_blank', rel: 'noopener noreferrer',
                      }, t('打开', 'Open')) : null))))),
          h('aside', { className: 'sd-repo-side' },
            h('section', { className: 'sd-card sd-create-card' },
              h('div', { className: 'sd-subhead' }, h('h3', null, t('创建仓库', 'Create repository'))),
              h(Field, { label: t('仓库名', 'Repository name') },
                h(TextInput, { value: form.name, placeholder: 'my-package', onChange: (event) => setForm({ ...form, name: event.target.value }) })),
              h(Field, { label: t('描述', 'Description'), optional: true },
                h(TextInput, { value: form.description, onChange: (event) => setForm({ ...form, description: event.target.value }) })),
              h(Field, { label: t('组织', 'Organization'), optional: true, hint: t('留空则创建到个人账号下', 'Leave empty to create under your account') },
                h(TextInput, { value: form.org, onChange: (event) => setForm({ ...form, org: event.target.value }) })),
              h('label', { className: 'sd-check sd-check-block' },
                h('input', { type: 'checkbox', checked: form.private, onChange: (event) => setForm({ ...form, private: event.target.checked }) }),
                h('span', null, t('私有仓库', 'Private repository'))),
              h(Btn, { variant: 'primary', block: true, busy: creating, onClick: create }, h(Icons.plus, null), t('创建', 'Create')))),
        ))
    }

    function PushDialog(props) {
      const { repo, t, toast, fail, onClose, setConfirm } = props
      const [form, setForm] = React.useState({
        dir: '', branch: repo.defaultBranch ?? 'main', message: '', syncMode: 'replace',
      })
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)

      const choose = async () => {
        const workspace = hostServices.uiWorkspace
        if (workspace === undefined || typeof workspace.pickDirectory !== 'function') {
          toast(t('当前环境不支持目录选择器，请直接粘贴绝对路径。', 'This host has no directory picker; paste an absolute path.'), 'error')
          return
        }
        try {
          const picked = await workspace.pickDirectory()
          if (typeof picked === 'string' && picked !== '') setForm((current) => ({ ...current, dir: picked }))
        } catch (error) {
          fail(error)
        }
      }

      const doPush = async () => {
        if (form.dir.trim() === '') {
          toast(t('填写项目目录', 'Enter the project directory'), 'error')
          return
        }
        setBusy(true)
        try {
          const value = await call('github.push', {
            owner: repo.owner,
            repo: repo.name,
            branch: form.branch.trim(),
            dir: form.dir.trim(),
            message: form.message.trim(),
            syncMode: form.syncMode,
            create: false,
          })
          setResult(value)
          toast(t(`已推送 ${value.fileCount} 个文件`, `Pushed ${value.fileCount} files`), 'ok')
        } catch (error) {
          fail(error)
        } finally {
          setBusy(false)
        }
      }

      const submit = () => {
        if (form.syncMode === 'replace') {
          setConfirm?.({
            title: t('镜像推送会删除远端文件', 'Mirror push deletes remote files'),
            body: t(`replace 模式会把 ${repo.fullName} 的 ${form.branch || repo.defaultBranch || '默认'} 分支变成当前目录的完整快照，远端独有的文件会被删除。`,
              `Replace mode turns ${repo.fullName} into a snapshot of this directory; files that exist only on the remote are deleted.`),
            danger: true,
            confirmLabel: t('继续推送', 'Push anyway'),
            onConfirm: doPush,
          })
          return
        }
        doPush()
      }

      return h(Modal, {
        title: t('推送目录', 'Push directory'),
        subtitle: h('span', { className: 'sd-mono' }, repo.fullName),
        onClose,
        footer: h(React.Fragment, null,
          h(Btn, { variant: 'ghost', onClick: onClose }, t('关闭', 'Close')),
          h(Btn, { variant: 'primary', busy, onClick: submit }, h(Icons.arrow, null), t('推送', 'Push'))),
      },
        result !== null
          ? h('div', { className: 'sd-result-box' },
            h('div', { className: 'sd-result-title' }, h(Icons.check, null), t('推送完成', 'Push complete')),
            h('div', { className: 'sd-result-line' }, h('span', null, t('分支', 'branch')), h('span', { className: 'sd-mono' }, result.branch)),
            h('div', { className: 'sd-result-line' }, h('span', null, t('文件', 'files')), h('span', { className: 'sd-mono' }, String(result.fileCount))),
            h('div', { className: 'sd-result-line' }, h('span', null, 'commit'), h('a', { className: 'sd-link sd-mono', href: result.commitUrl, target: '_blank', rel: 'noopener noreferrer' }, result.commitSha.slice(0, 10))),
            h('div', { className: 'sd-field-hint' }, t('提交后仓库会镜像本次目录快照；选择 merge 则保留远端其他文件。', 'The repository mirrors this snapshot; merge keeps other remote files.')))
          : h(React.Fragment, null,
            h(Field, { label: t('项目目录', 'Project directory'), hint: t('目录必须位于已注册的工作区，或由面板手动选择。', 'The directory must be inside a registered workspace, or chosen from this panel.') },
              h('div', { className: 'sd-inline-row' },
                h(TextInput, { value: form.dir, placeholder: 'C:/work/my-project', onChange: (event) => setForm({ ...form, dir: event.target.value }) }),
                h(Btn, { variant: 'ghost', onClick: choose }, h(Icons.folder, null), t('选择', 'Browse')))),
            h('div', { className: 'sd-field-grid' },
              h(Field, { label: t('分支', 'Branch') }, h(TextInput, { value: form.branch, onChange: (event) => setForm({ ...form, branch: event.target.value }) })),
              h(Field, { label: t('同步方式', 'Sync mode') },
                h('select', { className: 'sd-input', value: form.syncMode, onChange: (event) => setForm({ ...form, syncMode: event.target.value }) },
                  h('option', { value: 'replace' }, t('镜像（替换目录）', 'replace (mirror)')),
                  h('option', { value: 'merge' }, t('合并（保留远端）', 'merge (keep remote)'))))),
            h(Field, { label: t('提交信息', 'Commit message'), optional: true },
              h(TextInput, { value: form.message, placeholder: `Publish from Release Depot`, onChange: (event) => setForm({ ...form, message: event.target.value }) })),
            h('div', { className: 'sd-note' }, t('推送通过 GitHub Git Data API 完成，不使用本地 git 凭据。大目录会逐文件上传，请耐心等待。',
              'Pushes use the GitHub Git Data API, not local git credentials. Large directories upload file by file.')))
      )
    }

    function ReleasesDialog(props) {
      const { repo, t, lang, toast, fail, onClose, setConfirm } = props
      const [items, setItems] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [releasesError, setReleasesError] = React.useState(null)
      const [form, setForm] = React.useState({ open: false, tag: '', name: '', body: '', draft: false, prerelease: false })
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        setLoading(true)
        try {
          const result = await call('github.releases', { owner: repo.owner, repo: repo.name, limit: 30 })
          setItems(result.items)
          setReleasesError(null)
        } catch (error) {
          setReleasesError(error)
          fail(error)
        } finally {
          setLoading(false)
        }
      }, [repo, fail])

      React.useEffect(() => { load() }, [load])

      const create = async () => {
        setBusy(true)
        try {
          const result = await call('github.release', {
            owner: repo.owner,
            repo: repo.name,
            tag: form.tag.trim(),
            name: form.name.trim(),
            body: form.body,
            draft: form.draft,
            prerelease: form.prerelease,
          })
          toast(t(`已创建 Release ${result.release.tag}`, `Created release ${result.release.tag}`), 'ok')
          setForm({ open: false, tag: '', name: '', body: '', draft: false, prerelease: false })
          await load()
        } catch (error) {
          fail(error)
        } finally {
          setBusy(false)
        }
      }

      const remove = (release) => {
        setConfirm?.({
          title: t('删除 Release', 'Delete release'),
          body: `${repo.fullName} · ${release.tag}`,
          danger: true,
          confirmLabel: t('删除', 'Delete'),
          onConfirm: async () => {
            await call('github.delete-release', { owner: repo.owner, repo: repo.name, releaseId: release.id, force: true })
            toast(t('Release 已删除（tag 仍保留）', 'Release deleted (tag kept)'), 'ok')
            await load()
          },
        })
      }

      return h(Modal, {
        title: t('Releases', 'Releases'),
        subtitle: h('span', { className: 'sd-mono' }, repo.fullName),
        wide: true,
        onClose,
        footer: h(Btn, { variant: 'ghost', onClick: onClose }, t('关闭', 'Close')),
      },
        h('div', { className: 'sd-subhead' },
          h('h3', null, t('已有 Release', 'Existing releases')),
          h(Btn, { size: 'sm', variant: form.open ? 'ghost' : 'primary', onClick: () => setForm({ ...form, open: !form.open }) },
            form.open ? t('收起', 'Hide') : t('快速创建', 'Quick create'))),
        form.open
          ? h('div', { className: 'sd-inline-form sd-inline-card' },
            h('div', { className: 'sd-field-grid' },
              h(Field, { label: 'Tag' }, h(TextInput, { value: form.tag, placeholder: 'v1.1.8', onChange: (event) => setForm({ ...form, tag: event.target.value }) })),
              h(Field, { label: t('标题', 'Title'), optional: true }, h(TextInput, { value: form.name, onChange: (event) => setForm({ ...form, name: event.target.value }) }))),
            h(Field, { label: t('说明', 'Notes'), optional: true },
              h('textarea', { className: 'sd-input sd-textarea', rows: 3, value: form.body, onChange: (event) => setForm({ ...form, body: event.target.value }) })),
            h('div', { className: 'sd-inline-row' },
              h('label', { className: 'sd-check' }, h('input', { type: 'checkbox', checked: form.draft, onChange: (event) => setForm({ ...form, draft: event.target.checked }) }), h('span', null, 'draft')),
              h('label', { className: 'sd-check' }, h('input', { type: 'checkbox', checked: form.prerelease, onChange: (event) => setForm({ ...form, prerelease: event.target.checked }) }), h('span', null, 'prerelease')),
              h(Btn, { size: 'sm', variant: 'primary', busy, onClick: create }, t('创建', 'Create'))),
            h('div', { className: 'sd-field-hint' }, t('完整发布（推送提交 + 附带 tarball）请用发布向导。', 'Use the publish wizard for a full release with the tarball attached.')))
          : null,
        loading && items === null
          ? h('div', { className: 'sd-loading' }, h(Spinner, { large: true }))
          : releasesError !== null && (items === null || items.length === 0)
            ? h('div', { className: 'sd-note sd-note-danger sd-inline-row' },
              h('span', { style: { flex: 1 } }, errorText(releasesError)),
              h(Btn, { size: 'sm', onClick: load }, t('重试', 'Retry')))
            : (items ?? []).length === 0
            ? h('div', { className: 'sd-empty sd-empty-flat' }, t('这个仓库还没有 Release', 'No releases in this repository'))
            : h('div', { className: 'sd-release-list' },
              items.map((release) => h('div', { key: release.id, className: 'sd-release-row' },
                h('div', { className: 'sd-release-info' },
                  h('div', { className: 'sd-release-title' },
                    h('span', { className: 'sd-mono sd-strong' }, release.tag),
                    release.draft ? h(Chip, { tone: 'warn' }, 'draft') : null,
                    release.prerelease ? h(Chip, { tone: 'plain' }, 'pre') : null),
                  h('div', { className: 'sd-release-meta' }, release.name || '—', ' · ', formatTime(release.publishedAt ?? release.createdAt, lang))),
                h('div', { className: 'sd-release-actions' },
                  release.htmlUrl ? h('a', { className: 'sd-btn sd-btn-sm sd-btn-ghost', href: release.htmlUrl, target: '_blank', rel: 'noopener noreferrer' }, t('打开', 'Open')) : null,
                  h(Btn, { size: 'sm', variant: 'danger', onClick: () => remove(release), 'aria-label': t(`删除 Release ${release.tag}`, `Delete release ${release.tag}`), title: t('删除 Release', 'Delete release') }, h(Icons.trash, null)))))))
    }

    // ── records + settings ─────────────────────────────────────────────────

    function SettingsPage(props) {
      const { status, t, lang, toast, fail, refreshStatus } = props
      const [prefs, setPrefs] = React.useState(null)
      const [prefsError, setPrefsError] = React.useState(null)
      const [diagnostics, setDiagnostics] = React.useState(null)
      const [diagnosticsError, setDiagnosticsError] = React.useState(null)
      const [pinging, setPinging] = React.useState(false)
      const [saving, setSaving] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        call('prefs.get').then((value) => { if (alive) { setPrefs(value.prefs); setPrefsError(null) } }).catch((error) => { if (alive) setPrefsError(error) })
        call('diagnostics').then((value) => {
          if (alive) { setDiagnostics(value); setDiagnosticsError(null) }
        }).catch((error) => {
          if (alive) setDiagnosticsError(error)
        })
        return () => { alive = false }
      }, [])

      const savePrefs = async () => {
        const tagValue = String(prefs?.tag ?? '').trim()
        if (!/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(tagValue)) {
          toast(t('默认 tag 必须字母开头，只含字母、数字、点、下划线或连字符（最长 32 位）。', 'A tag must start with a letter and contain only letters, digits, dot, underscore or hyphen (max 32).'), 'error')
          return
        }
        setSaving(true)
        try {
          const result = await call('prefs.set', {
            defaultTargets: prefs?.defaultTargets,
            access: prefs?.access,
            tag: tagValue,
            npmRegistry: prefs?.npmRegistry,
            githubRegistry: prefs?.githubRegistry,
          })
          setPrefs(result.prefs)
          toast(t('默认设置已保存', 'Defaults saved'), 'ok')
          refreshStatus()
        } catch (error) {
          fail(error)
        } finally {
          setSaving(false)
        }
      }

      const ping = async () => {
        setPinging(true)
        try {
          const result = await call('diagnostics', { ping: true })
          setDiagnostics(result)
          toast(t('网络探测完成', 'Network probe finished'), 'ok')
        } catch (error) {
          fail(error)
        } finally {
          setPinging(false)
        }
      }

      return h('div', { className: 'sd-page' },
        h(PageHead, {
          eyebrow: 'SETTINGS',
          title: t('设置', 'Settings'),
          desc: t('默认发布参数、网络诊断与安全说明。账号连接已移到 npm 包库 / GitHub 仓库顶部。',
            'Publish defaults, network diagnostics and security. Account connections live at the top of npm packages / GitHub repos.'),
        }),
        h('section', { className: 'sd-card sd-settings-card' },
          h('div', { className: 'sd-subhead' }, h('h3', null, t('默认发布参数', 'Publish defaults')), h(Icons.tag, null)),
          prefs === null
            ? prefsError !== null
              ? h('div', { className: 'sd-note sd-note-danger' }, errorText(prefsError))
              : h('div', { className: 'sd-loading' }, h(Spinner, null))
            : h(React.Fragment, null,
              h('div', { className: 'sd-field-grid' },
                h('div', { className: 'sd-field' },
                  h('span', { className: 'sd-field-label' }, t('默认目标', 'Default targets')),
                  h('div', { className: 'sd-check-row' },
                    [['npm', 'npm'], ['github-packages', 'GitHub Packages'], ['github-release', 'GitHub Release']].map(([value, label]) => h('label', { key: value, className: 'sd-check' },
                      h('input', {
                        type: 'checkbox',
                        checked: (prefs.defaultTargets ?? []).includes(value),
                        onChange: (event) => {
                          const next = new Set(prefs.defaultTargets ?? [])
                          if (event.target.checked) next.add(value)
                          else next.delete(value)
                          setPrefs({ ...prefs, defaultTargets: [...next] })
                        },
                      }),
                      h('span', null, label))))),
                h(Field, { label: t('npm 访问级别', 'npm access') },
                  h('select', { className: 'sd-input', value: prefs.access ?? 'public', onChange: (event) => setPrefs({ ...prefs, access: event.target.value }) },
                    h('option', { value: 'public' }, 'public'),
                    h('option', { value: 'restricted' }, 'restricted'))),
                h(Field, { label: t('默认 tag', 'Default tag') }, h(TextInput, { value: prefs.tag ?? 'latest', onChange: (event) => setPrefs({ ...prefs, tag: event.target.value }) })),
                h(Field, { label: 'npm registry', hint: t('留空使用官方 registry', 'Leave empty for the official registry') },
                  h(TextInput, { value: prefs.npmRegistry ?? '', placeholder: 'https://registry.npmjs.org', onChange: (event) => setPrefs({ ...prefs, npmRegistry: event.target.value }) })),
                h(Field, { label: 'GitHub Packages registry', hint: t('留空使用 npm.pkg.github.com', 'Leave empty for npm.pkg.github.com') },
                  h(TextInput, { value: prefs.githubRegistry ?? '', placeholder: 'https://npm.pkg.github.com', onChange: (event) => setPrefs({ ...prefs, githubRegistry: event.target.value }) }))),
              h(Btn, { variant: 'primary', busy: saving, onClick: savePrefs }, t('保存默认值', 'Save defaults')))),
        h('section', { className: 'sd-card sd-settings-card' },
          h('div', { className: 'sd-subhead' }, h('h3', null, t('网络与运行环境', 'Network & runtime')), h(Icons.shield, null)),
          diagnostics === null
            ? diagnosticsError !== null
              ? h('div', { className: 'sd-note sd-note-danger' }, errorText(diagnosticsError))
              : h('div', { className: 'sd-loading' }, h(Spinner, null))
            : h(React.Fragment, null,
              h('div', { className: 'sd-diag-grid' },
                diag(t('Node', 'Node'), diagnostics.node),
                diag(t('平台', 'Platform'), diagnostics.platform),
                diag('npm registry', diagnostics.registries.npm),
                diag('GitHub API', diagnostics.registries.githubApi),
                diag(t('代理模式', 'Proxy mode'), diagnostics.network.mode),
                diag(t('解析到的代理', 'Resolved proxy'), diagnostics.network.proxy ?? t('直连', 'direct')),
                diag(t('undici', 'undici'), diagnostics.network.undici ? t('可用', 'available') : t('不可用（直连 fetch）', 'missing (plain fetch)')),
                diag(t('凭据文件', 'Credential file'), diagnostics.storage.authFile),
                diag(t('文件模式', 'File mode'), diagnostics.storage.authFileInfo?.exists ? diagnostics.storage.authFileInfo.mode : t('未创建', 'not created'))),
              h('div', { className: 'sd-inline-row' },
                h(Btn, { variant: 'ghost', busy: pinging, onClick: ping }, h(Icons.refresh, null), t('探测网络', 'Probe network')),
                diagnostics.ping?.npm ? h(Chip, { tone: diagnostics.ping.npm.ok ? 'ok' : 'danger' }, `npm ${diagnostics.ping.npm.ok ? `${diagnostics.ping.npm.ms}ms` : 'fail'}`) : null,
                diagnostics.ping?.github ? h(Chip, { tone: diagnostics.ping.github.ok ? 'ok' : 'danger' }, `GitHub ${diagnostics.ping.github.ok ? `${diagnostics.ping.github.ms}ms` : 'fail'}`) : null),
              h('div', { className: 'sd-note' },
                t('插件会自动读取系统代理与系统证书库；代理也可在插件行配置 proxy（auto / direct / http://host:port）。',
                  'The plugin reads the system proxy and OS certificate store; set proxy on the plugin row (auto / direct / http://host:port).')))),
        h('section', { className: 'sd-card sd-settings-card sd-security' },
          h('div', { className: 'sd-subhead' }, h('h3', null, t('安全说明', 'Security')), h(Icons.shield, null)),
          h('ul', { className: 'sd-list' },
            h('li', null, t('npm Token 与 GitHub Token 保存在 DSH home 的 .dsh-release-depot/auth.json（0600），插件更新不会丢失。', 'npm and GitHub tokens live in .dsh-release-depot/auth.json (0600) under your DSH home, so plugin updates do not erase them.')),
            h('li', null, t('令牌只作为 Authorization 头发往 registry 与 api.github.com；面板和 AI 工具都读不到明文。', 'Tokens are sent only as an Authorization header to the registry and api.github.com; the panel and agent tools cannot read them.')),
            h('li', null, t('发布前会真实打包目录，并在 dry run 中显示文件数、大小与 integrity。', 'Publishes pack the real directory and show file count, size and integrity in the dry run.')),
            h('li', null, t('卸载插件不会删除凭据；如需彻底清除，请删除该目录。', 'Uninstalling does not delete credentials; remove that directory to erase them completely.')))))
    }

    function diag(label, value) {
      return h('div', { className: 'sd-diag' }, h('span', null, label), h('strong', { className: 'sd-mono' }, value ?? '—'))
    }

    function NpmAccountCard(props) {
      const { status, t, toast, fail, refreshStatus, packageCount } = props
      const lang = useLang()
      const [token, setToken] = React.useState('')
      const [registry, setRegistry] = React.useState(status?.registries?.npm ?? '')
      const [busy, setBusy] = React.useState(false)
      const [verifying, setVerifying] = React.useState(false)
      const [expiryDraft, setExpiryDraft] = React.useState(status?.npm?.expiresAt ?? '')
      const [savingExpiry, setSavingExpiry] = React.useState(false)
      const [syncingToken, setSyncingToken] = React.useState(false)

      React.useEffect(() => {
        if (typeof status?.npm?.expiresAt === 'string') setExpiryDraft(status.npm.expiresAt)
      }, [status?.npm?.expiresAt])

      // npm's account-relative token page; `~` resolves to the signed-in user.
      const tokenPage = 'https://www.npmjs.com/settings/~/tokens'

      const connect = async () => {
        setBusy(true)
        try {
          await call('npm.connect', { token, registry: registry.trim(), expiresAt: expiryDraft })
          setToken('')
          toast(t('npm 已连接', 'npm connected'), 'ok')
          refreshStatus()
        } catch (error) {
          fail(error)
        } finally {
          setBusy(false)
        }
      }

      const saveExpiry = async () => {
        setSavingExpiry(true)
        try {
          await call('npm.set-token-meta', { expiresAt: expiryDraft })
          toast(t('Token 到期日已记录', 'Token expiry saved'), 'ok')
          refreshStatus()
        } catch (error) {
          fail(error)
        } finally {
          setSavingExpiry(false)
        }
      }

      const verify = async () => {
        setVerifying(true)
        try {
          const result = await call('npm.verify')
          toast(result.verified ? t('Token 仍然有效', 'Token is valid') : (result.invalidated ? t('Token 已失效，已清除', 'Token invalid; removed') : t('暂时无法验证', 'Could not verify right now')), result.verified ? 'ok' : 'error')
          refreshStatus()
        } catch (error) {
          fail(error)
        } finally {
          setVerifying(false)
        }
      }

      const syncTokenInfo = async () => {
        setSyncingToken(true)
        try {
          const result = await call('npm.token-info')
          toast(result.matched
            ? t('Token 信息已同步', 'Token info synced')
            : t('没有匹配到当前 Token 的信息', 'No metadata matched the current token'), result.matched ? 'ok' : 'error')
          refreshStatus()
        } catch (error) {
          fail(error)
        } finally {
          setSyncingToken(false)
        }
      }

      const disconnect = () => {
        call('npm.disconnect').then(() => {
          toast(t('npm 已断开', 'npm disconnected'), 'ok')
          refreshStatus()
        }).catch(fail)
      }

      return h('section', { className: 'sd-card sd-account-card' },
        h('div', { className: 'sd-subhead' },
          h('h3', null, h(Icons.npm, null), ' npm'),
          status?.npm?.connected ? h(Chip, { tone: 'ok' }, t('已连接', 'connected')) : h(Chip, { tone: 'warn' }, t('未连接', 'offline'))),
        status?.npm?.connected
          ? h(React.Fragment, null,
            h('div', { className: 'sd-account-hero' },
              h('span', { className: 'sd-avatar sd-avatar-lg sd-avatar-npm' }, (status.npm.username ?? 'N').slice(0, 1).toUpperCase()),
              h('div', { className: 'sd-account-hero-copy' },
                h('strong', null, `@${status.npm.username ?? '?'}`),
                h('span', null, status.npm.email || t('npm registry 账号', 'npm registry account')),
                status.npm.username
                  ? h('a', { className: 'sd-link', href: `https://www.npmjs.com/~${encodeURIComponent(status.npm.username)}`, target: '_blank', rel: 'noopener noreferrer' }, t('打开 npm 主页', 'Open npm profile'))
                  : null),
              h('span', { className: 'sd-mono sd-stat-inline' }, `${packageCount ?? status.counts?.npmPackages ?? '—'} ${t('个包', 'packages')}`)),
            h('div', { className: 'sd-account-line' }, h('span', null, 'registry'), h('span', { className: 'sd-mono sd-ellipsis' }, status.npm.registry ?? '—')),
            h('div', { className: 'sd-account-line' }, h('span', null, t('Token 名称', 'Token name')), h('span', null, status.npm.tokenName || '—')),
            status.npm.tokenPermissions?.length > 0
              ? h('div', { className: 'sd-account-line sd-account-line-wrap' }, h('span', null, t('Token 权限', 'Token permissions')),
                h('span', { className: 'sd-chips' }, status.npm.tokenPermissions.map((permission) => h(Chip, { key: `${permission.name}:${permission.action}`, tone: permission.action === 'write' ? 'ok' : 'plain' }, `${permission.name}:${permission.action}`))))
              : null,
            status.npm.tokenScopes?.length > 0
              ? h('div', { className: 'sd-account-line sd-account-line-wrap' }, h('span', null, 'scopes'),
                h('span', { className: 'sd-chips' }, status.npm.tokenScopes.map((scope, index) => h(Chip, { key: `${scope.type}-${scope.name}-${index}`, tone: 'plain' }, scope.name ? `${scope.type}:${scope.name}` : scope.type))))
              : null,
            status.npm.bypass2fa === true
              ? h('div', { className: 'sd-account-line' }, h('span', null, t('Token 类型', 'Token type')), h('span', { className: 'sd-inline-row' },
                h(Chip, { tone: 'danger' }, 'Bypass 2FA'),
                h('span', { className: 'sd-field-hint' }, t('2027-01 会被 npm 撤销；新建 Token 时可取消勾选，改用 TOTP 仍可发布', 'revoked by npm in Jan 2027; create a non-bypass token and use TOTP to keep publishing'))))
              : null,
            h('div', { className: 'sd-account-line' }, h('span', null, t('连接时间', 'Connected')), h('span', null, formatTime(status.npm.connectedAt, lang))),
            h('div', { className: 'sd-account-line' }, h('span', null, t('最近验证', 'Last verified')), h('span', null, formatTime(status.npm.lastVerifiedAt, lang))),
            h('div', { className: 'sd-account-line' }, h('span', null, t('Token 到期', 'Token expiry')), h('span', null,
              status.npm.expiresAt === null
                ? t('未记录', 'not set')
                : `${status.npm.expiresAt} · ${status.npm.expiresInDays !== null ? t(`还有 ${status.npm.expiresInDays} 天`, `${status.npm.expiresInDays} days left`) : ''}`),
            status.npm.expiresInDays !== null && status.npm.expiresInDays <= 14
              ? h(Chip, { tone: 'danger' }, t('即将到期', 'expiring'))
              : null),
            h('div', { className: 'sd-inline-row' },
              h(TextInput, {
                type: 'date',
                value: expiryDraft,
                'aria-label': t('Token 到期日', 'Token expiry date'),
                className: 'sd-input-date',
                onChange: (event) => setExpiryDraft(event.target.value),
              }),
              h(Btn, { size: 'sm', variant: 'ghost', busy: savingExpiry, onClick: saveExpiry }, t('保存到期日', 'Save expiry'))),
            tokenPage !== null
              ? h('a', { className: 'sd-link', href: tokenPage, target: '_blank', rel: 'noopener noreferrer' }, t('管理 / 重新生成 Token', 'Manage or regenerate token'))
              : null,
            h('div', { className: 'sd-inline-row' },
              h(Btn, { size: 'sm', variant: 'ghost', busy: verifying, onClick: verify }, t('验证', 'Verify')),
              h(Btn, { size: 'sm', variant: 'ghost', busy: syncingToken, onClick: syncTokenInfo }, t('同步 Token 信息', 'Sync token info')),
              h(Btn, { size: 'sm', variant: 'danger', onClick: disconnect }, t('断开', 'Disconnect'))))
          : h(React.Fragment, null,
            h(Field, { label: t('npm Access Token', 'npm access token'), hint: t('Permission 选 Read and write (publish and stage)。如账户用 TOTP，可不必勾 Bypass 2FA，在发布向导里填 6 位验证码；Bypass 2FA 的 Token 会在 2027-01 被 npm 撤销。', 'Choose Read and write (publish and stage). With TOTP you can leave Bypass 2FA off and enter the 6-digit code in the wizard; npm revokes Bypass-2FA tokens in January 2027.') },
              h(TextInput, {
                type: 'password', value: token, placeholder: 'npm_…', autoComplete: 'new-password',
                onChange: (event) => setToken(event.target.value),
              })),
            h(Field, { label: t('Token 到期日', 'Token expiry'), optional: true, hint: t('连接后会自动读取 npm 记录的到期日；这里可手动覆盖，仅用于提醒，不会自动续期。', 'Read automatically from npm after connecting; set it manually to override. Used for reminders only, renewal is not automatic.') },
              h(TextInput, { type: 'date', value: expiryDraft, onChange: (event) => setExpiryDraft(event.target.value) })),
            h(Field, { label: 'registry', optional: true, hint: t('留空使用 npmjs.com；可填私有 registry 地址。', 'Leave empty for npmjs.com, or use a private registry.') },
              h(TextInput, { value: registry, placeholder: 'https://registry.npmjs.org', onChange: (event) => setRegistry(event.target.value) })),
            h('div', { className: 'sd-inline-row' },
              h(Btn, { variant: 'primary', busy, onClick: connect }, t('验证并保存', 'Verify & save')),
              h('a', { className: 'sd-link', href: tokenPage, target: '_blank', rel: 'noopener noreferrer' }, t('打开 Token 页面', 'Open token page')),
              h('a', { className: 'sd-link', href: 'https://docs.npmjs.com/creating-and-viewing-access-tokens', target: '_blank', rel: 'noopener noreferrer' }, t('创建说明', 'Docs')))))
    }

    function GithubAccountCard(props) {
      const { status, t, toast, fail, refreshStatus } = props
      const lang = useLang()
      const [tab, setTab] = React.useState('device')
      const [clientId, setClientId] = React.useState(status?.github?.clientId ?? '')
      const [scopes, setScopes] = React.useState('repo workflow read:org write:packages')
      const [token, setToken] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [device, setDevice] = React.useState(null)
      const [error, setError] = React.useState(null)

      React.useEffect(() => {
        if (status?.github?.connected !== true) return
        if (status.github.publicRepos !== null || status.github.htmlUrl !== null) return
        call('github.verify').then(() => refreshStatus()).catch(() => {
          /* metadata is best-effort; the profile still works without it */
        })
      }, [status?.github?.connected, status?.github?.publicRepos, status?.github?.htmlUrl, refreshStatus])
      const [copied, setCopied] = React.useState(false)
      const pollTimer = React.useRef(null)
      const mounted = React.useRef(true)

      React.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
          if (pollTimer.current !== null) window.clearTimeout(pollTimer.current)
        }
      }, [])

      React.useEffect(() => {
        if (clientId === '' && typeof status?.github?.clientId === 'string' && status.github.clientId !== '') {
          setClientId(status.github.clientId)
        }
      }, [status?.github?.clientId, clientId])

      const stop = () => {
        if (pollTimer.current !== null) {
          window.clearTimeout(pollTimer.current)
          pollTimer.current = null
        }
      }

      const poll = (id, code, intervalMs) => {
        call('github.device-poll', { clientId: id, deviceCode: code })
          .then((result) => {
            if (!mounted.current) return
            if (result.status === 'authorized') {
              stop()
              toast(t('GitHub 已连接', 'GitHub connected'), 'ok')
              setDevice(null)
              refreshStatus()
              return
            }
            if (result.status === 'expired' || result.status === 'denied' || result.status === 'error') {
              stop()
              setError(result.message ?? t('连接失败', 'Connection failed'))
              setDevice(null)
              return
            }
            const next = result.slowDown ? Math.min(intervalMs + 5000, 15000) : intervalMs
            pollTimer.current = window.setTimeout(() => poll(id, code, next), next)
          })
          .catch(() => {
            if (!mounted.current) return
            pollTimer.current = window.setTimeout(() => poll(id, code, intervalMs), intervalMs)
          })
      }

      const startDevice = async () => {
        setBusy(true)
        setError(null)
        try {
          const result = await call('github.device-start', { clientId: clientId.trim(), scopes })
          if (!mounted.current) return
          setDevice(result)
          window.open(result.verificationUri, '_blank', 'noopener')
          pollTimer.current = window.setTimeout(() => poll(clientId.trim(), result.deviceCode, result.interval * 1000), result.interval * 1000)
        } catch (err) {
          setError(errorText(err))
        } finally {
          setBusy(false)
        }
      }

      const savePat = async () => {
        setBusy(true)
        setError(null)
        try {
          await call('github.connect-pat', { token })
          if (!mounted.current) return
          setToken('')
          toast(t('GitHub 已连接', 'GitHub connected'), 'ok')
          refreshStatus()
        } catch (err) {
          setError(errorText(err))
        } finally {
          setBusy(false)
        }
      }

      const disconnect = () => {
        call('github.disconnect').then(() => {
          toast(t('GitHub 已断开', 'GitHub disconnected'), 'ok')
          refreshStatus()
        }).catch(fail)
      }

      return h('section', { className: 'sd-card sd-account-card' },
        h('div', { className: 'sd-subhead' },
          h('h3', null, h(Icons.github, null), ' GitHub'),
          status?.github?.connected ? h(Chip, { tone: 'ok' }, t('已连接', 'connected')) : h(Chip, { tone: 'warn' }, t('未连接', 'offline'))),
        status?.github?.connected
          ? h(React.Fragment, null,
            h('div', { className: 'sd-github-user' },
              status.github.avatarUrl
                ? h('img', { className: 'sd-avatar sd-avatar-lg', src: status.github.avatarUrl, alt: '' })
                : h('span', { className: 'sd-avatar sd-avatar-lg sd-avatar-fallback' }, h(Icons.github, null)),
              h('div', { className: 'sd-github-copy' },
                h('strong', null, status.github.name || `@${status.github.login ?? '?'}`),
                h('span', { className: 'sd-mono' }, `@${status.github.login ?? '?'}`)),
              status.github.htmlUrl
                ? h('a', { className: 'sd-link', href: status.github.htmlUrl, target: '_blank', rel: 'noopener noreferrer' }, t('打开 GitHub 主页', 'Open GitHub profile'))
                : null),
            h('div', { className: 'sd-account-line' }, h('span', null, t('认证方式', 'Auth')), h('span', null, status.github.kind === 'pat' ? 'Personal Access Token' : 'OAuth device flow')),
            h('div', { className: 'sd-account-line' }, h('span', null, t('公开仓库', 'Public repos')), h('span', { className: 'sd-mono' }, status.github.publicRepos ?? '—')),
            h('div', { className: 'sd-account-line' }, h('span', null, t('连接时间', 'Connected')), h('span', null, formatTime(status.github.connectedAt, lang))),
            h('div', { className: 'sd-account-line' }, h('span', null, t('最近验证', 'Last verified')), h('span', null, formatTime(status.github.lastVerifiedAt, lang))),
            h('div', { className: 'sd-account-line sd-account-line-wrap' }, h('span', null, 'scopes'),
              h('span', { className: 'sd-chips' }, (status.github.scopes ?? []).length === 0
                ? h('span', { className: 'sd-field-hint' }, t('未返回 scopes（fine-grained PAT 正常）', 'No scopes returned (normal for fine-grained PATs)'))
                : (status.github.scopes ?? []).map((scope) => h(Chip, { key: scope, tone: 'plain' }, scope)))),
            h('div', { className: 'sd-inline-row' },
              h(Btn, { size: 'sm', variant: 'ghost', onClick: () => call('github.verify').then(() => { toast(t('验证完成', 'Verified'), 'ok'); refreshStatus() }).catch(fail) }, t('验证', 'Verify')),
              h(Btn, { size: 'sm', variant: 'danger', onClick: disconnect }, t('断开', 'Disconnect'))))
          : h(React.Fragment, null,
            h('div', { className: 'sd-tabs', role: 'tablist' },
              h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'device', className: 'sd-tab' + (tab === 'device' ? ' is-active' : ''), onClick: () => setTab('device') }, t('设备流（推荐）', 'Device flow')),
              h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'pat', className: 'sd-tab' + (tab === 'pat' ? ' is-active' : ''), onClick: () => setTab('pat') }, 'PAT')),
            error !== null ? h('div', { className: 'sd-note sd-note-danger' }, error) : null,
            tab === 'device'
              ? (device !== null
                ? h('div', null,
                  h('div', { className: 'sd-field-hint' }, t('在 GitHub 授权页输入下面的验证码：', 'Enter this code on the GitHub authorization page:')),
                  h('div', { className: 'sd-code-row' },
                    h('span', { className: 'sd-code' }, device.userCode),
                    h(Btn, {
                      size: 'sm', variant: 'ghost',
                      onClick: async () => {
                        try {
                          await navigator.clipboard.writeText(device.userCode)
                          setCopied(true)
                          window.setTimeout(() => setCopied(false), 1500)
                        } catch {
                          /* clipboard unavailable */
                        }
                      },
                    }, copied ? t('已复制', 'Copied') : t('复制', 'Copy'))),
                  h('a', { className: 'sd-link', href: device.verificationUri, target: '_blank', rel: 'noopener noreferrer' }, device.verificationUri),
                  h('div', { className: 'sd-field-hint' }, t('正在等待授权…', 'Waiting for authorization…')),
                  h(Btn, { size: 'sm', variant: 'ghost', onClick: () => { stop(); setDevice(null) } }, t('取消', 'Cancel')))
                : h(React.Fragment, null,
                  h(Field, { label: t('OAuth App Client ID', 'OAuth App client ID'), hint: t('在 GitHub → Settings → Developer settings 创建 OAuth App，无需回调地址。', 'Create an OAuth App under GitHub → Settings → Developer settings; no callback URL is needed.') },
                    h(TextInput, { value: clientId, placeholder: 'Ov23… 或 Iv1.…', onChange: (event) => setClientId(event.target.value) })),
                  h('a', { className: 'sd-link', href: 'https://github.com/settings/developers', target: '_blank', rel: 'noopener noreferrer' }, t('创建一个 OAuth App', 'Create an OAuth App')),
                  h(Field, { label: 'scopes' }, h(TextInput, { value: scopes, onChange: (event) => setScopes(event.target.value) })),
                  h(Btn, { variant: 'primary', busy, onClick: startDevice }, t('开始连接', 'Start device flow'))))
              : h(React.Fragment, null,
                h(Field, { label: t('Personal Access Token', 'Personal access token'), hint: t('fine-grained PAT 需要目标仓库 Contents 写权限；发布 GitHub Packages 需要 packages 写权限。', 'A fine-grained PAT needs Contents write on the target repository and packages write for GitHub Packages.') },
                  h(TextInput, { type: 'password', value: token, placeholder: 'github_pat_…', autoComplete: 'new-password', onChange: (event) => setToken(event.target.value) })),
                h('a', { className: 'sd-link', href: 'https://github.com/settings/tokens/new', target: '_blank', rel: 'noopener noreferrer' }, t('创建一个 Token', 'Create a token')),
                h(Btn, { variant: 'primary', busy, onClick: savePat }, t('验证并保存', 'Verify & save')))))
    }

    // ── publish wizard ─────────────────────────────────────────────────────

    function PublishWizard(props) {
      const { prefill, status, t, lang, toast, fail, onClose, refreshStatus } = props
      const [step, setStep] = React.useState(1)
      const [dir, setDir] = React.useState(prefill?.dir ?? status?.prefs?.lastDir ?? '')
      const [inspect, setInspect] = React.useState(null)
      const [inspectBusy, setInspectBusy] = React.useState(false)
      const [targets, setTargets] = React.useState(() => new Set(
        (Array.isArray(status?.prefs?.defaultTargets) && status.prefs.defaultTargets.length > 0
          ? status.prefs.defaultTargets
          : ['npm'])
          .filter((target) => (target === 'npm' ? status?.npm?.connected === true : status?.github?.connected === true)),
      ))
      const [access, setAccess] = React.useState(status?.prefs?.access === 'restricted' ? 'restricted' : 'public')
      const [tag, setTag] = React.useState(status?.prefs?.tag ?? 'latest')
      const [otp, setOtp] = React.useState('')
      const [github, setGithub] = React.useState({
        owner: status?.github?.login ?? '',
        repo: '',
        create: true,
        private: true,
        branch: '',
        releaseTag: '',
        releaseName: '',
        body: '',
        draft: false,
        prerelease: false,
        attachTarball: true,
        syncMode: 'replace',
      })
      const [dry, setDry] = React.useState(null)
      const [dryBusy, setDryBusy] = React.useState(false)
      const [ack, setAck] = React.useState(false)
      const [publishing, setPublishing] = React.useState(false)
      const [result, setResult] = React.useState(null)

      const npmReady = status?.npm?.connected === true
      const githubReady = status?.github?.connected === true
      const selected = [...targets]
      const needsNpm = targets.has('npm') || targets.has('github-packages')
      const needsGithub = targets.has('github-packages') || targets.has('github-release')
      const dryFailed = dry?.record?.targets?.some((target) => target.ok !== true) === true

      const inspectProject = React.useCallback(async (value) => {
        const target = String(value ?? dir).trim()
        if (target === '') {
          toast(t('先选择项目目录', 'Choose a project directory first'), 'error')
          return null
        }
        setInspectBusy(true)
        try {
          const info = await call('project.inspect', { dir: target })
          setInspect(info)
          setDir(info.dir)
          setGithub((current) => ({
            ...current,
            owner: current.owner || status?.github?.login || info.githubRepo?.owner || '',
            repo: current.repo || info.githubRepo?.repo || info.suggestedRepoName || '',
            releaseTag: current.releaseTag || `v${info.version}`,
            releaseName: current.releaseName || `${info.packageName} v${info.version}`,
          }))
          setDry(null)
          return info
        } catch (error) {
          setInspect(null)
          fail(error)
          return null
        } finally {
          setInspectBusy(false)
        }
      }, [dir, fail, status, t, toast])

      React.useEffect(() => {
        if (dir.trim() !== '' && inspect === null && inspectBusy === false) inspectProject(dir)
      }, [])

      const goAccounts = () => {
        window.dispatchEvent(new CustomEvent('ship-deck:tab', { detail: npmReady ? 'repos' : 'packages' }))
        onClose()
      }

      const browse = async () => {
        const workspace = hostServices.uiWorkspace
        if (workspace === undefined || typeof workspace.pickDirectory !== 'function') {
          toast(t('当前环境不支持目录选择器，请粘贴绝对路径。', 'This host has no directory picker; paste an absolute path.'), 'error')
          return
        }
        try {
          const picked = await workspace.pickDirectory()
          if (typeof picked === 'string' && picked !== '') {
            setDir(picked)
            setInspect(null)
            setDry(null)
            await inspectProject(picked)
          }
        } catch (error) {
          fail(error)
        }
      }

      const toggleTarget = (value) => {
        setTargets((current) => {
          const next = new Set(current)
          if (next.has(value)) next.delete(value)
          else next.add(value)
          return next
        })
        setDry(null)
        setAck(false)
      }

      const payload = (dryRun) => ({
        dir,
        targets: [...targets],
        access,
        tag: tag.trim() || 'latest',
        otp: otp.trim() || undefined,
        dryRun,
        github: {
          owner: github.owner.trim(),
          repo: github.repo.trim(),
          create: github.create === true,
          private: github.private !== false,
          branch: github.branch.trim() || undefined,
          releaseTag: github.releaseTag.trim() || undefined,
          releaseName: github.releaseName.trim() || undefined,
          body: github.body.trim() || undefined,
          draft: github.draft === true,
          prerelease: github.prerelease === true,
          attachTarball: github.attachTarball !== false,
          syncMode: github.syncMode,
        },
      })

      const runDry = React.useCallback(async () => {
        if (dryBusy) return
        setDryBusy(true)
        setDry(null)
        try {
          const value = await call('publish.run', payload(true))
          setDry(value)
        } catch (error) {
          fail(error)
          setDry({ ok: false, error })
        } finally {
          setDryBusy(false)
        }
      }, [dir, targets, access, tag, otp, github, dryBusy, fail])

      React.useEffect(() => {
        if (step === 3 && dry === null && dryBusy === false) runDry()
      }, [step, dry, dryBusy, runDry])

      const nextFromSource = async () => {
        if (inspect === null) {
          const info = await inspectProject(dir)
          if (info !== null && Array.isArray(info.problems) && info.problems.length === 0) setStep(2)
          else if (info !== null && info.problems?.length > 0) {
            toast(t('package.json 还有问题，修好后再继续。', 'Fix the package.json problems before continuing.'), 'error')
          }
          return
        }
        if (inspect.problems?.length > 0) {
          toast(t('先修复 package.json 的问题', 'Fix the package.json problems first'), 'error')
          return
        }
        setStep(2)
      }

      const nextFromTargets = () => {
        if (targets.size === 0) {
          toast(t('至少选择一个发布目标', 'Select at least one target'), 'error')
          return
        }
        if (needsNpm && !npmReady) {
          toast(t('所选目标需要 npm 账号，请先在设置里连接', 'This target needs npm; connect it in Settings first'), 'error')
          return
        }
        if (needsGithub && !githubReady) {
          toast(t('所选目标需要 GitHub 账号，请先在设置里连接', 'This target needs GitHub; connect it in Settings first'), 'error')
          return
        }
        if (targets.has('github-release') && (github.owner.trim() === '' || github.repo.trim() === '')) {
          toast(t('填写 GitHub owner 与仓库名', 'Enter the GitHub owner and repository'), 'error')
          return
        }
        setDry(null)
        setAck(false)
        setStep(3)
      }

      const publishNow = async () => {
        setPublishing(true)
        try {
          const value = await call('publish.run', payload(false))
          setResult(value)
          setStep(4)
          refreshStatus()
          const pending = Array.isArray(value.record?.targets) && value.record.targets.some((target) => target.pending === true)
          toast(value.ok
            ? pending ? t('npm 已受理，registry 正在同步', 'npm accepted; registry is syncing') : t('发布完成', 'Publish complete')
            : t('部分目标失败，请查看结果', 'Some targets failed; see results'), value.ok ? 'ok' : 'error')
        } catch (error) {
          fail(error)
        } finally {
          setPublishing(false)
        }
      }

      const title = t('发布向导', 'Publish wizard')
      const subtitle = inspect !== null
        ? `${inspect.packageName}@${inspect.version}`
        : t('打包 → 校验 → 发布', 'pack → verify → publish')

      const footer = h(React.Fragment, null,
        h('span', { className: 'sd-wizard-foot-note' },
          step === 3 ? t('发布是不可撤销的；npm 版本发布后不能覆盖。', 'Publishing is irreversible; an npm version cannot be overwritten.') : ''),
        h('div', { className: 'sd-inline-row' },
          step === 1 && h(React.Fragment, null,
            h(Btn, { variant: 'ghost', onClick: onClose }, t('取消', 'Cancel')),
            h(Btn, { variant: 'primary', busy: inspectBusy, onClick: nextFromSource }, h(Icons.chevron, null), t('下一步', 'Next'))),
          step === 2 && h(React.Fragment, null,
            h(Btn, { variant: 'ghost', onClick: () => setStep(1) }, t('上一步', 'Back')),
            h(Btn, { variant: 'primary', onClick: nextFromTargets }, h(Icons.chevron, null), t('下一步', 'Next'))),
          step === 3 && h(React.Fragment, null,
            h(Btn, { variant: 'ghost', onClick: () => setStep(2) }, t('上一步', 'Back')),
            h(Btn, { variant: 'ghost', busy: dryBusy, onClick: runDry }, h(Icons.refresh, null), t('重新预检', 'Re-run preflight')),
            h(Btn, { variant: 'primary', busy: publishing, disabled: ack !== true || dry === null || dryBusy || dryFailed, onClick: publishNow },
              h(Icons.arrow, null), t('确认发布', 'Publish now'))),
          step === 4 && h(Btn, { variant: 'primary', onClick: onClose }, t('完成', 'Done'))))

      return h(Modal, {
        title,
        subtitle,
        wide: true,
        onClose,
        footer,
      },
        h('div', { className: 'sd-wizard-steps' },
          wizardStep(1, t('项目', 'Project'), step),
          wizardStep(2, t('目标', 'Targets'), step),
          wizardStep(3, t('确认', 'Confirm'), step),
          wizardStep(4, t('结果', 'Result'), step)),
        step === 1 && h('div', { className: 'sd-wizard-body' },
          h(Field, { label: t('项目目录', 'Project directory'), hint: t('目录里需要有 package.json；打包与上传都从本机读取。', 'The directory must contain package.json; packing and uploads read from this machine.') },
            h('div', { className: 'sd-inline-row' },
              h(TextInput, { value: dir, placeholder: 'C:/work/my-package', onChange: (event) => { setDir(event.target.value); setInspect(null); setDry(null) } }),
              h(Btn, { variant: 'ghost', onClick: browse }, h(Icons.folder, null), t('选择目录', 'Browse')),
              h(Btn, { busy: inspectBusy, onClick: () => inspectProject(dir) }, t('读取', 'Inspect')))),
          h('div', { className: 'sd-note' }, t('发布仓直接打包目录里的现有文件，不会执行 prepack / prepare 等生命周期脚本；请先自行构建。',
            'Release Depot packs the files already in the directory and does not run prepack / prepare lifecycle scripts; build first.')),
          inspect !== null
            ? h('div', { className: 'sd-inspect' },
              h('div', { className: 'sd-inspect-head' },
                h('div', { className: 'sd-inspect-name' }, h('span', { className: 'sd-mono sd-strong' }, inspect.packageName || '(no name)'), h(Chip, { tone: 'plain' }, `v${inspect.version || '?'}`)),
                h(Chip, { tone: inspect.problems.length === 0 ? 'ok' : 'danger' }, inspect.problems.length === 0 ? t('可以发布', 'ready') : `${inspect.problems.length} ${t('个问题', 'problems')}`)),
              h('p', { className: 'sd-inspect-desc' }, inspect.manifest.description || t('（没有描述）', '(no description)')),
              h('div', { className: 'sd-inspect-facts' },
                h('span', { className: 'sd-mono sd-ellipsis', title: inspect.dir }, inspect.dir),
                h('span', null, inspect.manifest.license ?? '—'),
                inspect.githubRepo ? h('span', { className: 'sd-mono' }, `${inspect.githubRepo.owner}/${inspect.githubRepo.repo}`) : h('span', null, t('未声明 repository', 'no repository field'))),
              inspect.problems.length > 0
                ? h('div', { className: 'sd-note sd-note-danger' }, h('ul', { className: 'sd-list' }, inspect.problems.map((problem, index) => h('li', { key: index }, problem))))
                : null)
            : h('div', { className: 'sd-note' }, t('还没有读取项目。填好路径后点「读取」，我们会先校验 package.json，再打包。',
              'No project inspected yet. Enter a path and click Inspect; package.json is validated before packing.'))),
        step === 2 && h('div', { className: 'sd-wizard-body' },
          (!npmReady || !githubReady)
            ? h('div', { className: 'sd-note sd-note-warn sd-inline-row' },
              h('span', { style: { flex: 1 } },
                !npmReady && !githubReady
                  ? t('npm 与 GitHub 都未连接：先在「npm 包库 / GitHub 仓库」顶部连接账号，发布目标才可选。', 'Neither npm nor GitHub is connected; connect an account at the top of npm packages / GitHub repos to pick a target.')
                  : !npmReady
                    ? t('npm 未连接：npm 与 GitHub Packages 目标需要它。', 'npm is not connected; npm and GitHub Packages targets need it.')
                    : t('GitHub 未连接：GitHub Packages 与 Release 目标需要它。', 'GitHub is not connected; GitHub Packages and release targets need it.')),
              h(Btn, { size: 'sm', variant: 'default', onClick: goAccounts }, t('去连接', 'Connect')))
            : null,
          h('div', { className: 'sd-target-grid' },
            targetCard('npm', 'npm registry', status?.registries?.npm ?? 'registry.npmjs.org', npmReady, t('发布到 npmjs.com', 'Publish to npmjs.com')),
            targetCard('github-packages', 'GitHub Packages', status?.registries?.github ?? 'npm.pkg.github.com', githubReady, t('发布到 npm.pkg.github.com', 'Publish to GitHub Packages')),
            targetCard('github-release', 'GitHub Release', 'api.github.com', githubReady, t('推送仓库并创建 Release', 'Push repo and create a release'))),
          h('div', { className: 'sd-wizard-grid' },
            h('section', { className: 'sd-subcard' },
              h('div', { className: 'sd-subhead' }, h('h3', null, t('registry 参数', 'Registry options'))),
              h('div', { className: 'sd-field-grid' },
                h(Field, { label: t('访问级别', 'Access') },
                  h('select', { className: 'sd-input', value: access, onChange: (event) => { setAccess(event.target.value); setDry(null) } },
                    h('option', { value: 'public' }, 'public'),
                    h('option', { value: 'restricted' }, t('restricted（仅 scoped 包）', 'restricted (scoped only)'))),
                h(Field, { label: t('dist-tag', 'dist-tag') }, h(TextInput, { value: tag, onChange: (event) => { setTag(event.target.value); setDry(null) } })),
                h(Field, { label: t('一次性验证码', 'One-time code'), optional: true, hint: t('npm 开启 2FA 时需要；预检不需要。', 'Needed when npm 2FA is on; not needed for preflight.') },
                  h(TextInput, { value: otp, maxLength: 6, placeholder: '123456', onChange: (event) => { setOtp(event.target.value); setDry(null) } })))),
            targets.has('github-release')
              ? h('section', { className: 'sd-subcard' },
                h('div', { className: 'sd-subhead' }, h('h3', null, t('GitHub 目标', 'GitHub target'))),
                h('div', { className: 'sd-field-grid' },
                  h(Field, { label: 'owner' }, h(TextInput, { value: github.owner, onChange: (event) => { setGithub({ ...github, owner: event.target.value }); setDry(null) } })),
                  h(Field, { label: t('仓库名', 'Repository') }, h(TextInput, { value: github.repo, onChange: (event) => { setGithub({ ...github, repo: event.target.value }); setDry(null) } })),
                  h(Field, { label: t('分支', 'Branch'), optional: true, hint: t('留空使用仓库默认分支', 'Leave empty for the default branch') },
                    h(TextInput, { value: github.branch, onChange: (event) => setGithub({ ...github, branch: event.target.value }) })),
                  h(Field, { label: 'release tag', optional: true, hint: t('默认 v<version>', 'defaults to v<version>') },
                    h(TextInput, { value: github.releaseTag, onChange: (event) => setGithub({ ...github, releaseTag: event.target.value }) })),
                  h(Field, { label: t('Release 标题', 'Release title'), optional: true },
                    h(TextInput, { value: github.releaseName, onChange: (event) => setGithub({ ...github, releaseName: event.target.value }) })),
                  h(Field, { label: t('同步方式', 'Sync mode') },
                    h('select', { className: 'sd-input', value: github.syncMode, onChange: (event) => setGithub({ ...github, syncMode: event.target.value }) },
                      h('option', { value: 'replace' }, t('镜像目录', 'replace')),
                      h('option', { value: 'merge' }, t('合并保留远端', 'merge'))))),
                h(Field, { label: t('Release 说明', 'Release notes'), optional: true },
                  h('textarea', { className: 'sd-input sd-textarea', rows: 3, value: github.body, placeholder: t('留空自动生成安装说明', 'Leave empty to generate install notes'), onChange: (event) => setGithub({ ...github, body: event.target.value }) })),
                h('div', { className: 'sd-check-row' },
                  h('label', { className: 'sd-check' }, h('input', { type: 'checkbox', checked: github.create, onChange: (event) => setGithub({ ...github, create: event.target.checked }) }), h('span', null, t('仓库不存在时自动创建', 'Create the repository if missing'))),
                  h('label', { className: 'sd-check' }, h('input', { type: 'checkbox', checked: github.private, onChange: (event) => setGithub({ ...github, private: event.target.checked }) }), h('span', null, t('私有', 'private'))),
                  h('label', { className: 'sd-check' }, h('input', { type: 'checkbox', checked: github.attachTarball, onChange: (event) => setGithub({ ...github, attachTarball: event.target.checked }) }), h('span', null, t('附带 tarball', 'attach tarball'))),
                  h('label', { className: 'sd-check' }, h('input', { type: 'checkbox', checked: github.draft, onChange: (event) => setGithub({ ...github, draft: event.target.checked }) }), h('span', null, 'draft')),
                  h('label', { className: 'sd-check' }, h('input', { type: 'checkbox', checked: github.prerelease, onChange: (event) => setGithub({ ...github, prerelease: event.target.checked }) }), h('span', null, 'prerelease'))))
              : h('section', { className: 'sd-subcard sd-subcard-muted' },
                h('div', { className: 'sd-subhead' }, h('h3', null, t('GitHub 目标', 'GitHub target'))),
                h('p', { className: 'sd-field-hint' }, t('勾选 GitHub Release 后可以配置仓库推送与 Release。', 'Select GitHub Release to configure the push and release.')))),
          h('div', { className: 'sd-note' }, t('预检会真实打包目录并在 registry 上检查版本是否存在，不会写入任何数据。',
            'Preflight packs the real directory and checks the registry for an existing version without writing anything.'))),
        step === 3 && h('div', { className: 'sd-wizard-body' },
          h('div', { className: 'sd-confirm-summary' },
            h('div', { className: 'sd-confirm-main' },
              h('span', { className: 'sd-eyebrow' }, 'READY TO SHIP'),
              h('div', { className: 'sd-confirm-pkg' }, h('span', { className: 'sd-mono' }, `${inspect?.packageName ?? ''}@${inspect?.version ?? ''}`)),
              h('div', { className: 'sd-confirm-meta' },
                h('span', null, selected.join(' · ')),
                h('span', null, access),
                h('span', null, tag))),
            h('div', { className: 'sd-confirm-accounts' },
              h(Chip, { tone: npmReady ? 'ok' : 'warn' }, `npm ${npmReady ? '✓' : '—'}`),
              h(Chip, { tone: githubReady ? 'ok' : 'warn' }, `GitHub ${githubReady ? '✓' : '—'}`))),
          dryBusy
            ? h('div', { className: 'sd-loading' }, h(Spinner, { large: true }), h('span', null, t('正在预检（打包 + registry 检查）…', 'Preflight: packing + registry check…')))
            : dry === null || dry.record === undefined
              ? h('div', { className: 'sd-note sd-note-danger' }, dry?.error ? errorText(dry.error) : t('预检没有返回结果，请重新预检。', 'Preflight returned no result; run it again.'))
              : h('div', null,
                h('div', { className: 'sd-subhead' }, h('h3', null, t('预检结果', 'Preflight result'))),
                h('div', { className: 'sd-purposes' },
                  dry.record.targets.map((target) => h('div', { key: target.target, className: 'sd-purpose' },
                    h('div', { className: 'sd-purpose-head' },
                      h('strong', null, target.target),
                      h(Chip, { tone: target.ok ? 'ok' : 'danger' }, target.ok ? (target.dryRun ? 'preflight ok' : 'ok') : 'fail')),
                    target.error ? h('div', { className: 'sd-purpose-error' }, target.error.message) : null,
                    target.existing ? h('div', { className: 'sd-field-hint' },
                      `existing: latest=${target.existing.latest ?? '—'} · versions=${target.existing.versionCount ?? 0}`) : null,
                    target.repoExists === false ? h('div', { className: 'sd-field-hint' }, t('仓库不存在', 'repository missing')) : null,
                    target.warnings?.length > 0 ? h('ul', { className: 'sd-warn-list' }, target.warnings.map((warning, index) => h('li', { key: index }, warning))) : null))),
                dry.record.tarball
                  ? h('div', { className: 'sd-dry-facts' },
                    h('span', null, t('文件', 'files'), h('strong', null, String(dry.record.tarball.fileCount))),
                    h('span', null, t('压缩后', 'packed'), h('strong', null, formatBytes(dry.record.tarball.size))),
                    h('span', null, 'integrity', h('strong', { className: 'sd-mono sd-ellipsis' }, dry.record.tarball.integrity)))
                  : null,
                h('label', { className: 'sd-ack' },
                  h('input', { type: 'checkbox', checked: ack, onChange: (event) => setAck(event.target.checked) }),
                  h('span', null, t('我已确认目标与版本；理解 npm 发布后不能覆盖删除同一版本。',
                    'I have checked the targets and version; npm versions cannot be overwritten.'))),
                dryFailed
                  ? h('div', { className: 'sd-note sd-note-danger' }, t('预检里有目标失败，确认发布按钮已禁用；请先修复或取消该目标。', 'A target failed preflight, so publishing is disabled. Fix it or remove that target first.'))
                  : null)),
        step === 4 && result !== null && h('div', { className: 'sd-wizard-body' },
          h('div', { className: 'sd-result-hero' + (result.ok ? ' is-ok' : ' is-fail') },
            h('div', { className: 'sd-result-hero-icon' }, result.ok ? h(Icons.check, null) : h(Icons.warn, null)),
            h('div', null,
              h('div', { className: 'sd-result-hero-title' }, result.ok
                ? (Array.isArray(result.record.targets) && result.record.targets.some((target) => target.pending === true)
                  ? t('已受理 · registry 同步中', 'Accepted · registry syncing')
                  : t('发布完成', 'Published'))
                : t('部分目标失败', 'Partly failed')),
              h('div', { className: 'sd-result-hero-sub' }, `${result.record.package}@${result.record.version} · ${result.record.dryRun ? 'dry run' : formatTime(result.record.at, lang)}`))),
          h('div', { className: 'sd-purposes' },
            result.record.targets.map((target) => h('div', { key: target.target, className: 'sd-purpose' + (target.ok ? ' is-ok' : ' is-fail') },
              h('div', { className: 'sd-purpose-head' },
                h('strong', null, target.target),
                h(Chip, { tone: target.ok ? 'ok' : 'danger' }, target.ok ? 'ok' : 'fail'),
                target.pending === true ? h(Chip, { tone: 'warn' }, t('同步中', 'syncing')) : null),
              h('div', { className: 'sd-record-links' },
                target.url ? h('a', { className: 'sd-link', href: target.url, target: '_blank', rel: 'noopener noreferrer' }, 'npm package') : null,
                target.release?.htmlUrl ? h('a', { className: 'sd-link', href: target.release.htmlUrl, target: '_blank', rel: 'noopener noreferrer' }, `Release ${target.release.tag}`) : null,
                target.commitUrl ? h('a', { className: 'sd-link', href: target.commitUrl, target: '_blank', rel: 'noopener noreferrer' }, 'commit') : null,
                target.repoUrl ? h('a', { className: 'sd-link', href: target.repoUrl, target: '_blank', rel: 'noopener noreferrer' }, 'repository') : null,
                target.asset?.url ? h('a', { className: 'sd-link', href: target.asset.url, target: '_blank', rel: 'noopener noreferrer' }, `asset ${target.asset.name}`) : null),
              target.error ? h('div', { className: 'sd-purpose-error' }, target.error.message, target.error.hint ? h('div', { className: 'sd-field-hint' }, target.error.hint) : null) : null))),
          h('div', { className: 'sd-note' }, t('这次发布已写入本地发布记录；可以关闭向导继续发布其他项目。',
            'This publish is in the local log; close the wizard to publish another project.')))))

      function targetCard(id, label, registry, ready, desc) {
        const active = targets.has(id)
        return h('label', { className: 'sd-target' + (active ? ' is-active' : '') + (ready ? '' : ' is-disabled') },
          h('input', {
            type: 'checkbox',
            checked: active,
            disabled: !ready && !active,
            onChange: () => toggleTarget(id),
          }),
          h('div', { className: 'sd-target-copy' },
            h('div', { className: 'sd-target-title' }, label, ready ? null : h(Chip, { tone: 'warn' }, t('需连接', 'connect'))),
            h('div', { className: 'sd-target-sub' }, desc),
            h('div', { className: 'sd-target-reg sd-mono' }, registry)))
      }

      function wizardStep(number, label, current) {
        return h('div', { className: 'sd-wstep' + (current === number ? ' is-active' : '') + (current > number ? ' is-done' : '') },
          h('span', { className: 'sd-wstep-num' }, current > number ? '✓' : String(number)),
          h('span', null, label))
      }
    }

    // ── styles ─────────────────────────────────────────────────────────────

    const STYLES = `
.sd-backdrop, .sd-mainpanel {
  --sd-bg: #f7eedb; --sd-panel: #fffaf0; --sd-panel-2: #f2e7cf;
  --sd-ink: #141414; --sd-muted: #5f5748; --sd-line: #141414;
  --sd-yellow: #ffd84d; --sd-pink: #ffadc9; --sd-blue: #a9c7ff; --sd-mint: #a6ebc9; --sd-lilac: #cbb9ff;
  --sd-primary: #2f5bff; --sd-primary-ink: #ffffff; --sd-danger: #d93a3f; --sd-danger-soft: #ffd9da;
  --sd-danger-text: #a91f27;
  --sd-shadow: #141414; --sd-success: #0f8a4c;
  font-family: "Noto Sans SC", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  color: var(--sd-ink); -webkit-font-smoothing: antialiased;
}
.sd-backdrop {
  position: fixed; inset: 0; z-index: 400; display: flex; align-items: center; justify-content: center;
  padding: 2.4vh 2.4vw; background: rgba(12, 11, 9, .56); box-sizing: border-box; pointer-events: auto;
}
.sd-theme-dark {
  --sd-bg: #141316; --sd-panel: #201e23; --sd-panel-2: #2a272d;
  --sd-ink: #f6ecd7; --sd-muted: #b9ae9a; --sd-line: #f6ecd7;
  --sd-yellow: #ffd84d; --sd-pink: #ff9fc0; --sd-blue: #93b7ff; --sd-mint: #8fe4b9; --sd-lilac: #bda6ff;
  --sd-primary: #6f8cff; --sd-primary-ink: #0f1020; --sd-danger: #cf4a4f; --sd-danger-soft: #3a1e22;
  --sd-danger-text: #ffb3b5;
  --sd-shadow: #6a6470; --sd-success: #4ad48c;
}
.sd-backdrop.sd-theme-dark { background: rgba(0, 0, 0, .66); }
.sd-mainpanel {
  box-sizing: border-box; height: 100%; min-height: 0; padding: 8px;
  display: flex; flex-direction: column; background: transparent;
}
.sd-app {
  position: relative;
  width: 100%; height: 100%; min-height: 0; box-sizing: border-box;
  display: grid; grid-template-columns: 270px minmax(0, 1fr);
  background: var(--sd-bg); color: var(--sd-ink);
  border: 3px solid var(--sd-line); border-radius: 16px; overflow: hidden;
  box-shadow: 7px 7px 0 var(--sd-shadow);
}
.sd-app *, .sd-backdrop *, .sd-mainpanel * { box-sizing: border-box; }
.sd-app, .sd-app * { scrollbar-width: none; -ms-overflow-style: none; }
.sd-app *::-webkit-scrollbar { width: 0; height: 0; }
.sd-app button { font-family: inherit; }
.sd-i { width: 16px; height: 16px; flex: none; display: block; }
.sd-mono { font-family: "Cascadia Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; letter-spacing: -.2px; }
.sd-strong { font-weight: 800; }
.sd-ellipsis { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; vertical-align: bottom; }

/* trigger styles kept for older hosts that still show the composer entry */
.sd-trigger {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px 0 4px;
  border: 1.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35)); border-radius: 999px;
  background: transparent; color: var(--dsw-alias-label-secondary, #8a8a8a); cursor: pointer;
  font-family: inherit; font-size: 12px; line-height: 1; transition: background 120ms ease, color 120ms ease;
}
.sd-trigger:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary, #eee); }
.sd-trigger.is-open { border-color: #141414; color: var(--dsw-alias-label-primary, #eee); }
.sd-trigger-mark { width: 20px; height: 20px; display: inline-flex; flex: none; }
.sd-trigger-mark .sd-logo-mark { width: 20px; height: 20px; }
.sd-trigger-label { max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-trigger-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-border-l2, rgba(127,127,127,.5)); flex: none; }
.sd-trigger-dot.is-on { background: #2ecc71; box-shadow: 0 0 0 2px rgba(46,204,113,.2); }

/* sidebar */
.sd-side { display: flex; flex-direction: column; gap: 10px; min-height: 0; padding: 18px 16px; background: var(--sd-panel); border-right: 3px solid var(--sd-line); overflow: auto; }
.sd-logo { display: flex; align-items: center; gap: 10px; }
.sd-logo-tile { width: 50px; height: 50px; flex: none; }
.sd-logo-mark { width: 100%; height: 100%; display: block; }
.sd-logo-text { min-width: 0; }
.sd-logo-title { font-size: 21px; font-weight: 900; letter-spacing: -0.6px; line-height: 1.1; }
.sd-logo-sub { font-family: "Cascadia Mono", ui-monospace, monospace; font-size: 10px; letter-spacing: 3px; color: var(--sd-muted); margin-top: 2px; }
.sd-dash { border-top: 2px dashed var(--sd-line); opacity: .65; margin: 4px 0; }
.sd-nav-label { font-family: "Cascadia Mono", ui-monospace, monospace; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--sd-muted); margin: 4px 2px 0; }
.sd-nav { display: flex; flex-direction: column; gap: 8px; }
.sd-nav-item {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 42px; padding: 8px 10px;
  border: 2.5px solid var(--sd-line); border-radius: 11px; background: var(--sd-panel); color: var(--sd-ink);
  cursor: pointer; font-size: 13.5px; font-weight: 700; text-align: left;
  box-shadow: 3px 3px 0 var(--sd-shadow); transition: transform 90ms ease, box-shadow 90ms ease, background 90ms ease;
}
.sd-nav-item:hover { transform: translate(-1px, -1px); box-shadow: 4px 4px 0 var(--sd-shadow); }
.sd-nav-item.is-active { background: var(--sd-yellow); color: #141414; }
.sd-nav-item.is-active .sd-nav-icon { color: #141414; }
.sd-nav-icon { display: inline-flex; color: var(--sd-ink); }
.sd-nav-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-nav-badge { min-width: 22px; padding: 1px 6px; border-radius: 6px; background: #141414; color: #fff8e7; font-family: ui-monospace, monospace; font-size: 10.5px; text-align: center; font-weight: 700; }
.sd-nav-item.is-active .sd-nav-badge { background: #141414; color: #ffd84d; }
.sd-side-spacer { flex: 1; min-height: 10px; }
.sd-conn-card { border: 2.5px solid var(--sd-line); border-radius: 11px; padding: 10px; background: var(--sd-panel); box-shadow: 3px 3px 0 var(--sd-shadow); display: flex; flex-direction: column; gap: 7px; }
.sd-conn-row { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 11.5px; }
.sd-conn-dot { width: 8px; height: 8px; border-radius: 50%; border: 2px solid var(--sd-line); background: transparent; flex: none; }
.sd-conn-dot.is-on { background: var(--sd-mint); }
.sd-conn-name { font-weight: 800; font-family: ui-monospace, monospace; font-size: 11px; }
.sd-conn-user { margin-left: auto; color: var(--sd-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 130px; }
.sd-mini-note { display: flex; gap: 8px; align-items: flex-start; border: 2.5px solid var(--sd-line); border-radius: 11px; padding: 9px 10px; background: var(--sd-pink); color: #141414; box-shadow: 3px 3px 0 var(--sd-shadow); font-size: 11px; line-height: 1.4; }
.sd-mini-note-dot { width: 8px; height: 8px; margin-top: 4px; border-radius: 50%; background: #141414; flex: none; }
.sd-mini-note strong { display: block; font-size: 11.5px; }
.sd-side-foot { display: flex; justify-content: space-between; font-family: ui-monospace, monospace; font-size: 10px; color: var(--sd-muted); padding-top: 2px; }

/* main */
.sd-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--sd-bg); }
.sd-top { display: flex; align-items: center; gap: 12px; padding: 12px 20px; background: var(--sd-panel); border-bottom: 0; }
.sd-crumb { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 800; min-width: 0; }
.sd-crumb-root { color: var(--sd-muted); }
.sd-crumb-sep { color: var(--sd-muted); }
.sd-crumb-current { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-top-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.sd-pill { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border: 2px solid var(--sd-line); border-radius: 8px; font-family: ui-monospace, monospace; font-size: 10.5px; font-weight: 700; white-space: nowrap; }
.sd-pill-ok { background: var(--sd-mint); color: #141414; }
.sd-pill-warn { background: var(--sd-yellow); color: #141414; }
.sd-dot { width: 7px; height: 7px; border-radius: 50%; background: #141414; }
.sd-theme-seg { display: inline-flex; border: 2.5px solid var(--sd-line); border-radius: 9px; overflow: hidden; box-shadow: 2px 2px 0 var(--sd-shadow); }
.sd-theme-btn { display: inline-flex; align-items: center; gap: 5px; border: 0; background: var(--sd-panel); color: var(--sd-ink); padding: 6px 9px; font-family: inherit; font-size: 11px; font-weight: 700; cursor: pointer; }
.sd-theme-btn + .sd-theme-btn { border-left: 2.5px solid var(--sd-line); }
.sd-theme-btn.is-active { background: #141414; color: #fff8e7; }
.sd-theme-btn .sd-i { width: 13px; height: 13px; }
.sd-close { width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border: 2.5px solid var(--sd-line); border-radius: 9px; background: var(--sd-panel); color: var(--sd-ink); cursor: pointer; box-shadow: 2px 2px 0 var(--sd-shadow); }
.sd-close:hover { background: var(--sd-pink); color: #141414; }
.sd-hazard { height: 14px; flex: none; background: repeating-linear-gradient(135deg, #141414 0 9px, var(--sd-yellow) 9px 18px); border-top: 3px solid var(--sd-line); border-bottom: 3px solid var(--sd-line); }
.sd-content { flex: 1; min-height: 0; overflow: auto; padding: 20px 26px 34px; scrollbar-width: thin; }
.sd-content::-webkit-scrollbar { width: 11px; height: 11px; }
.sd-content::-webkit-scrollbar-thumb { background: var(--sd-line); border: 3px solid var(--sd-bg); border-radius: 8px; }

/* common bits */
.sd-page { display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 1500px; }
.sd-glance { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.sd-eyebrow { display: inline-block; background: #141414; color: var(--sd-yellow); font-family: ui-monospace, monospace; font-size: 10px; font-weight: 800; letter-spacing: 2px; padding: 4px 8px; border-radius: 3px; text-transform: uppercase; }
.sd-eyebrow-danger { background: var(--sd-danger); color: #fff; }
.sd-h1 { margin: 10px 0 4px; font-size: 44px; line-height: 1; font-weight: 900; letter-spacing: -1.8px; }
.sd-sub { margin: 0; color: var(--sd-muted); font-size: 13px; line-height: 1.55; max-width: 660px; }
.sd-mini-badge { border: 2px solid var(--sd-line); border-radius: 6px; padding: 4px 8px; font-family: ui-monospace, monospace; font-size: 10px; font-weight: 700; white-space: nowrap; background: var(--sd-panel); }
.sd-page-head { align-items: flex-end; }
.sd-page-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.sd-section { display: flex; flex-direction: column; gap: 10px; }
.sd-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.sd-section-title { margin: 0; font-size: 19px; font-weight: 900; letter-spacing: -.4px; }
.sd-section-hint { font-size: 11px; color: var(--sd-muted); }
.sd-card, .sd-subcard { border: 2.5px solid var(--sd-line); border-radius: 13px; background: var(--sd-panel); box-shadow: 4px 4px 0 var(--sd-shadow); padding: 15px; }
.sd-subcard { box-shadow: 3px 3px 0 var(--sd-shadow); border-radius: 11px; padding: 13px; display: flex; flex-direction: column; gap: 10px; }
.sd-subcard-muted { background: var(--sd-panel-2); box-shadow: none; border-style: dashed; }
.sd-subhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sd-subhead h3 { margin: 0; font-size: 13.5px; font-weight: 900; letter-spacing: .2px; display: inline-flex; align-items: center; gap: 6px; }
.sd-link-btn { border: 0; background: transparent; color: var(--sd-ink); font-family: inherit; font-size: 12px; font-weight: 700; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; padding: 2px 0; }
.sd-link-btn:hover { color: var(--sd-primary); }
.sd-link { color: var(--sd-primary); font-weight: 700; text-decoration: none; font-size: 12px; }
.sd-link:hover { text-decoration: underline; }
.sd-danger-text { color: var(--sd-danger-text); }
.sd-loading { display: flex; align-items: center; gap: 10px; padding: 26px; justify-content: center; color: var(--sd-muted); font-size: 12.5px; }
.sd-spin { width: 14px; height: 14px; border: 2.5px solid currentColor; border-right-color: transparent; border-radius: 50%; display: inline-block; animation: sd-spin .7s linear infinite; flex: none; }
.sd-spin-lg { width: 22px; height: 22px; border-width: 3px; }
@keyframes sd-spin { to { transform: rotate(360deg); } }

/* notice */
.sd-notice { display: flex; align-items: center; gap: 10px; padding: 11px 13px; border: 2px dashed var(--sd-line); border-radius: 11px; background: var(--sd-panel); font-size: 12.5px; line-height: 1.45; }
.sd-notice-icon { color: var(--sd-ink); display: inline-flex; flex: none; }
.sd-notice-text { flex: 1; min-width: 0; }

/* buttons */
.sd-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 2.5px solid var(--sd-line); border-radius: 9px; background: var(--sd-panel); color: var(--sd-ink); font-family: inherit; font-size: 12.5px; font-weight: 800; padding: 7px 12px; cursor: pointer; box-shadow: 2.5px 2.5px 0 var(--sd-shadow); transition: transform 80ms ease, box-shadow 80ms ease; text-decoration: none; line-height: 1.2; white-space: nowrap; }
.sd-btn:hover { transform: translate(-1px, -1px); box-shadow: 3.5px 3.5px 0 var(--sd-shadow); }
.sd-btn:active { transform: translate(1px, 1px); box-shadow: 1px 1px 0 var(--sd-shadow); }
.sd-btn:disabled { opacity: .55; cursor: not-allowed; transform: none; }
.sd-btn .sd-i { width: 14px; height: 14px; }
.sd-btn-primary { background: var(--sd-primary); color: var(--sd-primary-ink); }
.sd-btn-primary:hover { background: var(--sd-primary); }
.sd-btn-ghost { background: transparent; box-shadow: none; border-style: dashed; }
.sd-btn-ghost:hover { background: var(--sd-panel-2); box-shadow: none; }
.sd-btn-danger { background: var(--sd-danger); color: #fff; }
.sd-btn-sm { padding: 4px 8px; font-size: 11px; border-width: 2px; box-shadow: 2px 2px 0 var(--sd-shadow); }
.sd-btn-block { width: 100%; }
.sd-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: 0; border-radius: 7px; background: transparent; color: var(--sd-muted); cursor: pointer; }
.sd-icon-btn:hover { background: var(--sd-panel-2); color: var(--sd-ink); }

/* forms */
.sd-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.sd-field-label { font-family: ui-monospace, monospace; font-size: 10px; font-weight: 800; letter-spacing: 1.2px; text-transform: uppercase; color: var(--sd-muted); display: flex; gap: 6px; align-items: baseline; }
.sd-field-opt { font-weight: 500; letter-spacing: .4px; text-transform: none; opacity: .75; }
.sd-field-hint { font-size: 11px; color: var(--sd-muted); line-height: 1.45; }
.sd-input { width: 100%; border: 2.5px solid var(--sd-line); border-radius: 8px; background: var(--sd-panel); color: var(--sd-ink); padding: 7px 9px; font-family: inherit; font-size: 12.5px; outline: none; min-width: 0; }
.sd-input-mini { width: 90px; min-width: 70px; }
.sd-input-date { width: 132px; min-width: 120px; }
.sd-input:focus { outline: 3px solid var(--sd-blue); outline-offset: 1px; }
.sd-input::placeholder { color: var(--sd-muted); opacity: .7; }
.sd-textarea { resize: vertical; min-height: 70px; font-family: ui-monospace, monospace; font-size: 11.5px; line-height: 1.5; }
.sd-field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.sd-inline-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sd-inline-row > .sd-input { flex: 1; min-width: 110px; }
.sd-inline-form { display: flex; flex-direction: column; gap: 7px; padding-top: 4px; }
.sd-inline-wide { width: 100%; }
.sd-inline-card { border: 2px dashed var(--sd-line); border-radius: 9px; padding: 10px; margin: 6px 0 10px; }
.sd-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; user-select: none; }
.sd-check input { width: 15px; height: 15px; accent-color: var(--sd-primary); margin: 0; }
.sd-check-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.sd-check-block { display: flex; margin: 4px 0; }
.sd-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sd-search { position: relative; flex: 1; min-width: 200px; max-width: 460px; }
.sd-search-icon { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: var(--sd-muted); display: inline-flex; }
.sd-search-input { padding-left: 31px; }
.sd-toolbar-note { font-family: ui-monospace, monospace; font-size: 10.5px; color: var(--sd-muted); }

/* chips */
.sd-chip { display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px; border: 1.5px solid var(--sd-line); border-radius: 5px; font-family: ui-monospace, monospace; font-size: 9.5px; font-weight: 800; letter-spacing: .5px; text-transform: uppercase; background: var(--sd-panel); color: var(--sd-ink); white-space: nowrap; }
.sd-chip-ok { background: var(--sd-mint); color: #141414; }
.sd-chip-warn { background: var(--sd-yellow); color: #141414; }
.sd-chip-danger { background: var(--sd-danger); color: #fff; }
.sd-chip-plain { background: var(--sd-panel-2); }
.sd-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.sd-owner-chip { display: inline-flex; align-items: center; gap: 5px; border: 1.5px solid var(--sd-line); border-radius: 999px; padding: 2px 4px 2px 9px; background: var(--sd-panel-2); font-size: 10.5px; }
.sd-owner-remove { border: 0; background: transparent; color: var(--sd-danger-text); cursor: pointer; font-size: 14px; line-height: 1; padding: 0 3px; }
.sd-status { font-family: ui-monospace, monospace; font-size: 10px; font-weight: 900; padding: 2px 7px; border-radius: 5px; border: 1.5px solid var(--sd-line); }
.sd-status.is-ok { background: var(--sd-mint); color: #141414; }
.sd-status.is-fail { background: var(--sd-danger); color: #fff; }

/* dashboard */
.sd-dash-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(240px, 1fr); gap: 16px; align-items: stretch; }
.sd-state-card { border: 2.5px solid var(--sd-line); border-radius: 15px; background: var(--sd-panel); box-shadow: 5px 5px 0 var(--sd-shadow); padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.sd-state-head { display: flex; gap: 14px; align-items: flex-start; }
.sd-state-tile { width: 62px; height: 62px; flex: none; }
.sd-state-copy { min-width: 0; }
.sd-state-title { margin: 2px 0 5px; font-size: 22px; font-weight: 900; letter-spacing: -.7px; line-height: 1.15; }
.sd-state-body { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--sd-muted); }
.sd-state-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.sd-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.sd-step { display: flex; align-items: center; gap: 7px; border: 2px solid var(--sd-line); border-radius: 8px; padding: 6px 8px; font-size: 11.5px; font-weight: 700; background: var(--sd-panel); }
.sd-step.is-active { background: var(--sd-yellow); color: #141414; }
.sd-step-num { width: 18px; height: 18px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; background: #141414; color: #fff8e7; font-family: ui-monospace, monospace; font-size: 10px; flex: none; }
.sd-stat-stack { display: flex; flex-direction: column; gap: 12px; }
.sd-stat-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
.sd-page-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.sd-stat { border: 2.5px solid var(--sd-line); border-radius: 13px; padding: 13px 15px; box-shadow: 4px 4px 0 var(--sd-shadow); color: #141414; flex: 1; display: flex; flex-direction: column; justify-content: space-between; min-height: 105px; }
.sd-stat-mint { background: var(--sd-mint); }
.sd-stat-blue { background: var(--sd-blue); }
.sd-stat-pink { background: var(--sd-pink); }
.sd-stat-label { font-family: ui-monospace, monospace; font-size: 9.5px; font-weight: 800; letter-spacing: 1.4px; text-transform: uppercase; }
.sd-stat-value { font-size: 46px; font-weight: 900; line-height: 1; letter-spacing: -2px; margin: 4px 0; }
.sd-stat-sub { font-size: 10.5px; line-height: 1.35; opacity: .85; }
.sd-project-empty { display: flex; align-items: center; gap: 14px; border: 2px dashed var(--sd-line); border-radius: 13px; padding: 16px; background: var(--sd-panel); }
.sd-project-empty strong { font-size: 14px; }
.sd-project-empty p { margin: 3px 0 0; font-size: 11.5px; color: var(--sd-muted); }
.sd-project-empty .sd-btn { margin-left: auto; }
.sd-projects { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.sd-project { border: 2.5px solid var(--sd-line); border-radius: 12px; overflow: hidden; background: var(--sd-panel); box-shadow: 4px 4px 0 var(--sd-shadow); display: flex; flex-direction: column; }
.sd-project-band { display: flex; align-items: center; gap: 6px; padding: 9px 11px; border-bottom: 2.5px solid var(--sd-line); color: #141414; min-width: 0; }
.sd-project-name { font-weight: 900; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-project-tags { margin-left: auto; display: flex; gap: 3px; flex: none; }
.sd-project-tag { font-family: ui-monospace, monospace; font-size: 8.5px; font-weight: 800; border: 1.5px solid #141414; border-radius: 3px; padding: 1px 3px; }
.sd-project-blue .sd-project-band { background: var(--sd-blue); }
.sd-project-mint .sd-project-band { background: var(--sd-mint); }
.sd-project-lilac .sd-project-band { background: var(--sd-lilac); }
.sd-project-pink .sd-project-band { background: var(--sd-pink); }
.sd-project-body { padding: 10px 11px; display: flex; flex-direction: column; gap: 6px; }
.sd-project-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.sd-project-time { margin-left: auto; color: var(--sd-muted); font-size: 10px; }
.sd-project-dir { font-family: ui-monospace, monospace; font-size: 10px; color: var(--sd-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-project-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 2px; }

/* history */
.sd-mini-table { border: 2.5px solid var(--sd-line); border-radius: 11px; overflow: hidden; background: var(--sd-panel); box-shadow: 3px 3px 0 var(--sd-shadow); }
.sd-mini-row { display: flex; align-items: center; gap: 10px; padding: 8px 11px; border-bottom: 1.5px dashed var(--sd-line); font-size: 11.5px; }
.sd-mini-row:last-child { border-bottom: 0; }
.sd-mini-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.sd-mini-dir { color: var(--sd-muted); font-size: 10px; }
.sd-mini-tags { display: flex; gap: 3px; flex-wrap: wrap; }
.sd-record-list { display: flex; flex-direction: column; gap: 10px; }
.sd-record { border: 2.5px solid var(--sd-line); border-radius: 12px; background: var(--sd-panel); box-shadow: 3px 3px 0 var(--sd-shadow); padding: 12px; }
.sd-record.is-fail { border-left: 8px solid var(--sd-danger); }
.sd-record-head { display: flex; align-items: flex-start; gap: 10px; justify-content: space-between; }
.sd-record-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; }
.sd-record-meta { display: flex; gap: 10px; flex-wrap: wrap; color: var(--sd-muted); font-size: 10.5px; margin-top: 3px; }
.sd-record-tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 8px; }
.sd-record-body { margin-top: 10px; border-top: 2px dashed var(--sd-line); padding-top: 9px; display: flex; flex-direction: column; gap: 9px; }
.sd-record-target { border: 1.5px solid var(--sd-line); border-radius: 8px; padding: 8px; }
.sd-record-target-head { display: flex; justify-content: space-between; font-size: 11.5px; margin-bottom: 5px; }
.sd-record-links { display: flex; gap: 8px; flex-wrap: wrap; }
.sd-record-error { color: var(--sd-danger-text); font-size: 11.5px; line-height: 1.45; margin-top: 4px; }
.sd-warn-list { margin: 6px 0 0; padding-left: 17px; font-size: 11px; color: var(--sd-muted); line-height: 1.5; }
.sd-note { border: 2px dashed var(--sd-line); border-radius: 9px; padding: 9px 11px; font-size: 11.5px; line-height: 1.5; background: var(--sd-panel); }
.sd-note-warn { background: var(--sd-yellow); color: #141414; border-style: solid; }
.sd-note-danger { background: var(--sd-danger-soft); border-color: var(--sd-danger); color: var(--sd-ink); border-style: solid; }
.sd-note-hint { font-size: 10.5px; opacity: .85; margin-top: 2px; }
.sd-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px; text-align: center; padding: 40px 20px; border: 2.5px dashed var(--sd-line); border-radius: 14px; background: var(--sd-panel); color: var(--sd-muted); }
.sd-empty-icon { width: 48px; height: 48px; border: 2.5px solid var(--sd-line); border-radius: 12px; background: var(--sd-yellow); color: #141414; display: flex; align-items: center; justify-content: center; box-shadow: 3px 3px 0 var(--sd-shadow); }
.sd-empty-icon .sd-i { width: 24px; height: 24px; }
.sd-empty-title { font-size: 15px; font-weight: 900; color: var(--sd-ink); }
.sd-empty-body { margin: 0; font-size: 12px; max-width: 420px; }
.sd-empty-flat { padding: 18px; flex-direction: row; justify-content: flex-start; text-align: left; border-style: dashed; font-size: 12px; }

/* npm packages */
.sd-pkg-list { display: flex; flex-direction: column; gap: 9px; }
.sd-pkg { display: flex; align-items: stretch; gap: 14px; border: 2.5px solid var(--sd-line); border-radius: 12px; background: var(--sd-panel); padding: 12px 14px; box-shadow: 3px 3px 0 var(--sd-shadow); }
.sd-pkg-main { flex: 1; min-width: 0; }
.sd-pkg-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 14px; }
.sd-pkg-desc { margin: 4px 0 6px; font-size: 11.5px; color: var(--sd-muted); line-height: 1.45; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.sd-pkg-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 10.5px; color: var(--sd-muted); }
.sd-pkg-side { display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; gap: 8px; flex: none; }
.sd-pkg-version { font-family: ui-monospace, monospace; font-size: 20px; font-weight: 900; letter-spacing: -.5px; }
.sd-pkg-actions { display: flex; gap: 5px; flex-wrap: wrap; justify-content: flex-end; }
.sd-pkg-error { margin-top: 8px; }

/* detail modal */
.sd-detail-grid { display: flex; gap: 16px; justify-content: space-between; margin-bottom: 12px; }
.sd-detail-desc { font-size: 12.5px; line-height: 1.55; color: var(--sd-muted); max-width: 60%; }
.sd-detail-facts { display: flex; flex-direction: column; gap: 4px; min-width: 180px; }
.sd-fact { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; border-bottom: 1px dotted var(--sd-line); padding-bottom: 3px; }
.sd-fact span { color: var(--sd-muted); }
.sd-fact strong { font-family: ui-monospace, monospace; font-weight: 700; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-split { display: grid; grid-template-columns: 1fr 1.1fr; gap: 12px; margin-bottom: 12px; }
.sd-tag-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px dotted var(--sd-line); font-size: 11.5px; }
.sd-tag-name { min-width: 70px; font-weight: 800; }
.sd-version-list { display: flex; flex-direction: column; max-height: 300px; overflow: auto; }
.sd-version-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px dotted var(--sd-line); font-size: 11.5px; flex-wrap: wrap; }
.sd-version-time { color: var(--sd-muted); font-size: 10px; }
.sd-version-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sd-readme-box { border: 2px dashed var(--sd-line); border-radius: 9px; padding: 8px 10px; margin-top: 10px; }
.sd-readme-box summary { cursor: pointer; font-family: ui-monospace, monospace; font-size: 11px; font-weight: 800; }
.sd-readme { max-height: 240px; overflow: auto; font-family: ui-monospace, monospace; font-size: 10.5px; line-height: 1.55; white-space: pre-wrap; margin: 8px 0 0; color: var(--sd-muted); }

/* GitHub */
.sd-account-strip { display: flex; align-items: center; gap: 12px; padding: 10px 13px; border: 2.5px solid var(--sd-line); border-radius: 11px; background: var(--sd-panel); box-shadow: 3px 3px 0 var(--sd-shadow); }
.sd-avatar { width: 38px; height: 38px; border-radius: 50%; border: 2.5px solid var(--sd-line); object-fit: cover; flex: none; background: var(--sd-panel-2); }
.sd-avatar-fallback { display: inline-flex; align-items: center; justify-content: center; }
.sd-account-copy { display: flex; flex-direction: column; gap: 2px; font-size: 12px; min-width: 0; }
.sd-account-copy strong { font-size: 13px; font-family: ui-monospace, monospace; }
.sd-account-copy span { color: var(--sd-muted); font-size: 11px; }
.sd-account-tags { margin-left: auto; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; justify-content: flex-end; }
.sd-repo-layout { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(250px, 1fr); gap: 16px; align-items: start; }
.sd-repo-main { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.sd-repo-list { display: flex; flex-direction: column; gap: 9px; }
.sd-repo { display: flex; gap: 10px; justify-content: space-between; border: 2.5px solid var(--sd-line); border-radius: 11px; background: var(--sd-panel); padding: 11px 13px; box-shadow: 3px 3px 0 var(--sd-shadow); }
.sd-repo-info { min-width: 0; flex: 1; }
.sd-repo-title { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 13px; }
.sd-repo-info p { margin: 4px 0 6px; font-size: 11.5px; color: var(--sd-muted); line-height: 1.4; }
.sd-repo-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 10.5px; color: var(--sd-muted); }
.sd-repo-actions { display: flex; align-items: flex-start; gap: 5px; flex-wrap: wrap; justify-content: flex-end; flex: none; max-width: 220px; }
.sd-repo-side { display: flex; flex-direction: column; gap: 12px; }
.sd-create-card { display: flex; flex-direction: column; gap: 9px; }
.sd-release-list { display: flex; flex-direction: column; gap: 8px; }
.sd-release-row { display: flex; gap: 10px; justify-content: space-between; border: 2px solid var(--sd-line); border-radius: 9px; padding: 9px 11px; background: var(--sd-panel); }
.sd-release-title { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 12.5px; }
.sd-release-meta { color: var(--sd-muted); font-size: 10.5px; margin-top: 2px; }
.sd-release-actions { display: flex; gap: 5px; align-items: center; flex: none; }
.sd-result-box { border: 2.5px solid var(--sd-line); border-radius: 11px; background: var(--sd-mint); color: #141414; padding: 14px; display: flex; flex-direction: column; gap: 6px; box-shadow: 3px 3px 0 var(--sd-shadow); }
.sd-result-title { display: flex; align-items: center; gap: 6px; font-weight: 900; font-size: 15px; }
.sd-result-line { display: flex; justify-content: space-between; gap: 12px; font-size: 11.5px; }

.sd-bundle-card { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary, inherit); margin: 8px 0; }
.sd-bundle-icon { width: 40px; height: 40px; flex: none; }
.sd-bundle-icon .sd-logo-mark { width: 100%; height: 100%; }
.sd-bundle-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.sd-bundle-copy strong { font-size: 13px; }
.sd-bundle-copy span { font-size: 12px; line-height: 1.45; color: var(--dsw-alias-label-secondary, #888); }
.sd-bundle-error { color: var(--dsw-alias-label-danger, #d33); font-size: 11px; }
.sd-switch { flex: none; width: 48px; height: 28px; padding: 2px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35)); border-radius: 999px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.2)); cursor: pointer; transition: background 140ms ease; }
.sd-switch.is-on { background: var(--dsw-alias-fill-primary, #2f5bff); }
.sd-switch-knob { display: block; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.25); transform: translateX(0); transition: transform 140ms ease; }
.sd-switch.is-on .sd-switch-knob { transform: translateX(20px); }
.sd-switch:disabled { opacity: .6; cursor: wait; }
.sd-bundle-action { flex: none; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4)); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary, inherit); border-radius: 8px; padding: 6px 11px; font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.sd-bundle-action:hover { background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.18)); }

/* settings */
.sd-settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
.sd-settings-card { display: flex; flex-direction: column; gap: 11px; }
.sd-account-card { display: flex; flex-direction: column; gap: 9px; min-height: 230px; }
.sd-account-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 11.5px; border-bottom: 1px dotted var(--sd-line); padding-bottom: 4px; }
.sd-account-line > span:first-child { color: var(--sd-muted); }
.sd-github-user { display: flex; align-items: center; gap: 10px; }
.sd-github-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sd-github-copy strong { font-size: 14px; }
.sd-github-copy span { color: var(--sd-muted); font-size: 11px; }
.sd-account-hero { display: flex; align-items: center; gap: 12px; padding-bottom: 4px; }
.sd-account-hero-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.sd-account-hero-copy strong { font-size: 15px; font-family: ui-monospace, monospace; }
.sd-account-hero-copy > span { color: var(--sd-muted); font-size: 11px; }
.sd-stat-inline { margin-left: auto; font-size: 12px; color: var(--sd-muted); }
.sd-avatar-lg { width: 52px; height: 52px; }
.sd-avatar-npm { display: inline-flex; align-items: center; justify-content: center; background: var(--sd-yellow); color: #141414; font-size: 22px; font-weight: 900; border-radius: 12px; }
.sd-account-line-wrap { align-items: flex-start; }
.sd-account-line-wrap > .sd-chips { justify-content: flex-end; max-width: 70%; }
.sd-tabs { display: flex; gap: 3px; border: 2px solid var(--sd-line); border-radius: 8px; padding: 2px; background: var(--sd-panel-2); }
.sd-tab { flex: 1; border: 0; border-radius: 5px; background: transparent; color: var(--sd-muted); font-family: inherit; font-size: 11px; font-weight: 700; padding: 5px 8px; cursor: pointer; }
.sd-tab.is-active { background: #141414; color: #fff8e7; }
.sd-code-row { display: flex; align-items: center; gap: 8px; margin: 7px 0; flex-wrap: wrap; }
.sd-code { font-family: ui-monospace, monospace; font-size: 19px; font-weight: 900; letter-spacing: 4px; border: 2.5px dashed var(--sd-line); border-radius: 8px; padding: 6px 12px; background: var(--sd-panel-2); }
.sd-diag-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; margin-bottom: 10px; }
.sd-diag { display: flex; justify-content: space-between; gap: 10px; font-size: 10.5px; border-bottom: 1px dotted var(--sd-line); padding-bottom: 3px; min-width: 0; }
.sd-diag span { color: var(--sd-muted); flex: none; }
.sd-diag strong { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
.sd-list { margin: 0; padding-left: 18px; font-size: 11.5px; line-height: 1.6; color: var(--sd-muted); }
.sd-security { background: var(--sd-panel); box-shadow: 3px 3px 0 var(--sd-shadow); }

/* modals */
.sd-modal-backdrop { position: absolute; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(10,9,8,.5); }
.sd-modal { width: min(760px, 100%); max-height: 90%; display: flex; flex-direction: column; border: 3px solid var(--sd-line); border-radius: 15px; background: var(--sd-panel); color: var(--sd-ink); box-shadow: 8px 8px 0 var(--sd-shadow); overflow: hidden; }
.sd-modal-wide { width: min(1040px, 100%); }
.sd-modal-sm { width: min(460px, 100%); }
.sd-modal-confirm { z-index: 80; }
.sd-modal-head { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-bottom: 2.5px solid var(--sd-line); background: var(--sd-panel-2); }
.sd-modal-title { margin: 0; font-size: 19px; font-weight: 900; letter-spacing: -.4px; }
.sd-modal-sub { margin: 3px 0 0; font-size: 11.5px; color: var(--sd-muted); font-family: ui-monospace, monospace; }
.sd-modal-head > button { margin-left: auto; }
.sd-modal-body { padding: 15px 16px; overflow: auto; min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 11px; }
.sd-modal-foot { display: flex; align-items: center; gap: 8px; justify-content: space-between; padding: 11px 16px; border-top: 2.5px solid var(--sd-line); background: var(--sd-panel-2); flex-wrap: wrap; }
.sd-confirm-band { padding: 9px 16px 0; }
.sd-confirm-otp { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; padding: 11px; border: 1.5px dashed var(--sd-line); border-radius: 8px; }
.sd-confirm-warn { font-size: 12.5px; font-weight: 800; }
.sd-confirm-otp-warn { font-size: 11px; line-height: 1.5; color: #8a2b2b; background: rgba(255, 120, 120, .14); border-radius: 5px; padding: 6px 8px; }
.sd-confirm-text { margin: 8px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--sd-muted); }
.sd-toasts { position: absolute; left: 22px; bottom: 20px; z-index: 90; display: flex; flex-direction: column; gap: 7px; max-width: 440px; }
.sd-toast { display: flex; align-items: flex-start; gap: 8px; border: 2.5px solid var(--sd-line); border-radius: 10px; padding: 9px 11px; font-size: 12px; line-height: 1.45; box-shadow: 4px 4px 0 var(--sd-shadow); background: var(--sd-mint); color: #141414; animation: sd-toast-in 160ms ease; }
.sd-toast-error { background: var(--sd-pink); }
.sd-toast-icon { display: inline-flex; margin-top: 1px; flex: none; }
.sd-toast-body { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.sd-toast-links { display: flex; flex-wrap: wrap; gap: 6px; }
.sd-toast-link { display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px; border: 1.5px solid var(--sd-line); border-radius: 5px; background: #fff8e7; color: #141414; font-size: 11px; font-weight: 700; text-decoration: none; }
.sd-toast-link:hover { background: var(--sd-mint); }
.sd-toast-link .sd-i { width: 11px; height: 11px; }
@keyframes sd-toast-in { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }

/* wizard */
.sd-wizard-steps { display: flex; gap: 8px; flex-wrap: wrap; }
.sd-wstep { display: inline-flex; align-items: center; gap: 6px; border: 2px solid var(--sd-line); border-radius: 7px; padding: 4px 9px; font-size: 11px; font-weight: 800; background: var(--sd-panel); color: var(--sd-muted); }
.sd-wstep.is-active { background: var(--sd-yellow); color: #141414; }
.sd-wstep.is-done { background: var(--sd-mint); color: #141414; }
.sd-wstep-num { width: 17px; height: 17px; border-radius: 4px; border: 1.5px solid var(--sd-line); display: inline-flex; align-items: center; justify-content: center; font-family: ui-monospace, monospace; font-size: 9.5px; }
.sd-wizard-body { display: flex; flex-direction: column; gap: 12px; padding-top: 2px; }
.sd-wizard-foot-note { font-size: 10.5px; color: var(--sd-muted); max-width: 420px; }
.sd-inspect { border: 2.5px solid var(--sd-line); border-radius: 11px; background: var(--sd-panel-2); padding: 12px; display: flex; flex-direction: column; gap: 7px; }
.sd-inspect-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.sd-inspect-name { display: flex; align-items: center; gap: 7px; font-size: 14px; }
.sd-inspect-desc { margin: 0; font-size: 12px; color: var(--sd-muted); }
.sd-inspect-facts { display: flex; gap: 10px; flex-wrap: wrap; font-size: 10.5px; color: var(--sd-muted); }
.sd-target-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
.sd-target { display: flex; gap: 8px; align-items: flex-start; border: 2.5px solid var(--sd-line); border-radius: 10px; padding: 10px; background: var(--sd-panel); cursor: pointer; box-shadow: 2px 2px 0 var(--sd-shadow); }
.sd-target input { margin-top: 2px; width: 15px; height: 15px; accent-color: var(--sd-primary); }
.sd-target.is-active { background: var(--sd-yellow); color: #141414; }
.sd-target.is-disabled { opacity: .7; cursor: not-allowed; box-shadow: none; border-style: dashed; }
.sd-target-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sd-target-title { display: flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 900; flex-wrap: wrap; }
.sd-target-sub { font-size: 10px; opacity: .8; }
.sd-target-reg { font-size: 9px; opacity: .7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-wizard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
.sd-confirm-summary { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; border: 2.5px solid var(--sd-line); border-radius: 12px; padding: 13px; background: var(--sd-blue); color: #141414; box-shadow: 3px 3px 0 var(--sd-shadow); }
.sd-confirm-main { display: flex; flex-direction: column; gap: 5px; }
.sd-confirm-pkg { font-size: 20px; font-weight: 900; letter-spacing: -.5px; }
.sd-confirm-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 10.5px; }
.sd-confirm-accounts { display: flex; gap: 5px; flex-direction: column; align-items: flex-end; }
.sd-purposes { display: flex; flex-direction: column; gap: 7px; }
.sd-purpose { border: 2px solid var(--sd-line); border-radius: 9px; padding: 9px 11px; background: var(--sd-panel); display: flex; flex-direction: column; gap: 5px; }
.sd-purpose.is-ok { border-left: 7px solid var(--sd-success); }
.sd-purpose.is-fail { border-left: 7px solid var(--sd-danger); background: var(--sd-danger-soft); }
.sd-purpose-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; }
.sd-purpose-error { color: var(--sd-danger-text); font-size: 11px; line-height: 1.45; }
.sd-dry-facts { display: flex; gap: 16px; flex-wrap: wrap; font-size: 10.5px; border: 2px dashed var(--sd-line); border-radius: 8px; padding: 8px 10px; }
.sd-dry-facts span { display: inline-flex; gap: 5px; align-items: center; color: var(--sd-muted); }
.sd-dry-facts strong { color: var(--sd-ink); }
.sd-ack { display: flex; gap: 8px; align-items: flex-start; border: 2px solid var(--sd-line); border-radius: 9px; padding: 9px 11px; background: var(--sd-yellow); color: #141414; font-size: 11.5px; line-height: 1.45; cursor: pointer; }
.sd-ack input { margin-top: 2px; width: 15px; height: 15px; accent-color: #141414; }
.sd-result-hero { display: flex; gap: 12px; align-items: center; border: 2.5px solid var(--sd-line); border-radius: 12px; padding: 13px; box-shadow: 3px 3px 0 var(--sd-shadow); color: #141414; }
.sd-result-hero.is-ok { background: var(--sd-mint); }
.sd-result-hero.is-fail { background: var(--sd-pink); }
.sd-result-hero-icon { width: 42px; height: 42px; border-radius: 10px; border: 2.5px solid #141414; display: flex; align-items: center; justify-content: center; background: #fff8e7; flex: none; }
.sd-result-hero-icon .sd-i { width: 22px; height: 22px; }
.sd-result-hero-title { font-size: 17px; font-weight: 900; }
.sd-result-hero-sub { font-size: 11px; opacity: .8; font-family: ui-monospace, monospace; }

/* responsive */
@media (max-width: 1120px) {
  .sd-app { grid-template-columns: 234px minmax(0, 1fr); }
  .sd-h1 { font-size: 36px; }
  .sd-dash-grid { grid-template-columns: 1fr; }
  .sd-stat-stack { flex-direction: row; flex-wrap: wrap; }
  .sd-stat-grid { grid-template-columns: 1fr; }
  .sd-stat { min-width: 150px; }
  .sd-repo-layout, .sd-settings-grid { grid-template-columns: 1fr; }
  .sd-split, .sd-wizard-grid { grid-template-columns: 1fr; }
  .sd-target-grid { grid-template-columns: 1fr; }
}
@media (max-width: 820px) {
  .sd-backdrop { padding: 0; }
  .sd-mainpanel { padding: 6px; }
  .sd-app { height: 100%; border-radius: 14px; border-width: 2px; box-shadow: 5px 5px 0 var(--sd-shadow); grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .sd-side { flex-direction: row; align-items: center; overflow-x: auto; border-right: 0; border-bottom: 3px solid var(--sd-line); padding: 10px; }
  .sd-logo-text, .sd-nav-label, .sd-conn-card, .sd-mini-note, .sd-side-foot, .sd-side-spacer { display: none; }
  .sd-logo-tile { width: 38px; height: 38px; }
  .sd-dash { display: none; }
  .sd-nav { flex-direction: row; }
  .sd-nav-item { min-height: 34px; padding: 5px 8px; box-shadow: 2px 2px 0 var(--sd-shadow); }
  .sd-nav-text { display: none; }
  .sd-nav-badge { display: none; }
  .sd-content { padding: 14px; }
  .sd-h1 { font-size: 30px; }
  .sd-top { padding: 9px 12px; }
  .sd-pill { display: none; }
  .sd-page-head { align-items: flex-start; flex-direction: column; }
  .sd-page-actions { justify-content: flex-start; }
  .sd-projects { grid-template-columns: 1fr; }
  .sd-pkg, .sd-repo { flex-direction: column; }
  .sd-pkg-side, .sd-repo-actions { align-items: flex-start; justify-content: flex-start; max-width: none; }
  .sd-modal-backdrop { padding: 6px; }
  .sd-detail-grid { flex-direction: column; }
  .sd-detail-desc { max-width: none; }
  .sd-field-grid, .sd-diag-grid { grid-template-columns: 1fr; }
  .sd-theme-btn span { display: none; }
}
.sd-app, .sd-app * { scrollbar-width: none !important; }
.sd-app *::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none; }
`

    module.exports = {
      name: NS,
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get?.('locale')
        if (locale !== null && locale !== undefined) localeService = locale
        ctx.inject(['uiWorkspace'], (scoped) => {
          hostServices.uiWorkspace = scoped.uiWorkspace
          return () => {
            if (hostServices.uiWorkspace === scoped.uiWorkspace) hostServices.uiWorkspace = undefined
          }
        })
        ctx.inject(['layout'], (scoped) => {
          hostServices.layout = scoped.layout
          return () => {
            if (hostServices.layout === scoped.layout) hostServices.layout = undefined
          }
        })
        ctx.inject(['theme'], (scoped) => {
          const theme = scoped.theme
          const readTheme = () => {
            try {
              setThemeScheme(theme.getTheme()?.active?.colorScheme)
            } catch {
              /* keep the current scheme */
            }
          }
          readTheme()
          const off = scoped.on('theme/change', readTheme)
          return () => off()
        })
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.setAttribute('data-plugin', NS)
          tag.textContent = STYLES
          document.head.appendChild(tag)
          return () => tag.remove()
        }, `${NS}: styles`)

        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          { name: 'plugins.bundle.config', key: 'dsh-release-depot' },
          () => h(BundleEntryCard, null),
        ))

        let mainStop = null
        let sidebarStop = null
        const enableSidebar = () => {
          if (mainStop === null) {
            mainStop = ctx.slots.inject('main', () => ctx.slots.register(
              { name: 'main', key: 'ship-deck' },
              () => h(Panel, null),
            ))
          }
          if (sidebarStop === null) {
            sidebarStop = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: 'ship-deck',
                order: 30,
                label: () => (detectLang() === 'zh' ? '发布仓' : 'Release Depot'),
              },
              (props) => h(SidebarIcon, props),
            ))
          }
        }
        const disableSidebar = () => {
          if (mainStop !== null) {
            mainStop()
            mainStop = null
          }
          if (sidebarStop !== null) {
            sidebarStop()
            sidebarStop = null
          }
          const layout = hostServices.layout
          try {
            if (layout?.panelInfo?.getSnapshot?.()?.activePanelId === 'ship-deck') layout.selectPanel(null)
          } catch {
            /* ignore panel navigation failures */
          }
        }
        const readStoredVisibility = () => {
          try {
            return localStorage.getItem('sd.sidebarVisible') !== 'false'
          } catch {
            return true
          }
        }
        const applyVisibility = (visible) => {
          setSidebarVisibleState(visible)
          if (visible) enableSidebar()
          else disableSidebar()
          try {
            localStorage.setItem('sd.sidebarVisible', visible ? 'true' : 'false')
          } catch {
            /* ignore */
          }
        }
        hostServices.sidebar = {
          isEnabled: () => sidebarVisible,
          subscribe: subscribeSidebar,
          setEnabled: (next) => applyVisibility(next !== false),
        }
        applyVisibility(readStoredVisibility())
        call('prefs.get')
          .then((result) => {
            const visible = result?.prefs?.sidebarVisible !== false
            if (visible !== sidebarVisible) applyVisibility(visible)
          })
          .catch(() => {
            /* keep the local preference */
          })
      },
    }
    return module.exports
  },
})