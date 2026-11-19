// Preview-only stand-in for the Kiro Crew window chrome (nav rail + badge), so the app can be
// judged in context. Theme and language toggles live in the rail. Not part of the app.
export function mountPreview({ React, createRoot, lucide, App, root }) {
  const h = React.createElement
  const { useEffect, useState } = React
  const icon = (name, size = 18) => (lucide[name] ? h(lucide[name], { size, strokeWidth: 2 }) : null)
  const params = new URLSearchParams(location.search)
  const lang = (params.get('lang') || 'pt').startsWith('en') ? 'en' : 'pt'
  const NAV = [
    ['MessagesSquare', 'Chat'],
    ['Bot', 'Crewmates'],
    ['LayoutGrid', 'Apps'],
  ]
  const withParam = (key, value) => {
    const next = new URLSearchParams(location.search)
    next.set(key, value)
    return `?${next.toString()}`
  }

  function Rail() {
    const [badge, setBadge] = useState(0)
    const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'dark')
    useEffect(() => {
      const on = (event) => setBadge(Number(event.detail) || 0)
      window.addEventListener('pv-badge', on)
      return () => window.removeEventListener('pv-badge', on)
    }, [])
    const flipTheme = () => {
      const value = theme === 'dark' ? 'light' : 'dark'
      document.documentElement.dataset.theme = value
      history.replaceState(null, '', withParam('theme', value))
      setTheme(value)
    }
    const other = lang === 'pt' ? 'en' : 'pt'
    return h(
      'aside',
      { className: 'pv-rail' },
      h('div', { className: 'pv-logo', title: 'Kiro Crew (preview)' }, icon('Ghost', 20)),
      h('span', { className: 'pv-tag', title: lang === 'pt' ? 'Dados simulados' : 'Simulated data' }, 'Preview'),
      h(
        'nav',
        { className: 'pv-nav' },
        NAV.map(([name, label]) => h('span', { key: label, className: 'pv-item', title: label }, icon(name))),
        h('span', { className: 'pv-item is-active', title: 'Crew Lobby' }, icon('Users'), badge ? h('b', { className: 'pv-badge' }, badge > 99 ? '99+' : String(badge)) : null),
      ),
      h(
        'div',
        { className: 'pv-rail-foot' },
        h('button', { type: 'button', className: 'pv-item', title: theme === 'dark' ? 'Tema claro' : 'Tema escuro', onClick: flipTheme }, icon(theme === 'dark' ? 'Sun' : 'Moon')),
        h('a', { className: 'pv-item', href: withParam('lang', other), title: other === 'en' ? 'English' : 'Português' }, other.toUpperCase()),
        h('span', { className: 'pv-item', title: 'Settings' }, icon('Settings')),
        h('span', { className: 'pv-me' }, 'N'),
      ),
    )
  }

  // ?bare=1 drops the fake rail, for store screenshots of the app page alone.
  function Shell() {
    if (params.get('bare') === '1') return h('main', { className: 'pv-main' }, h(App))
    return h('div', { className: 'pv-shell' }, h(Rail), h('main', { className: 'pv-main' }, h(App)))
  }

  createRoot(root).render(h(Shell))
}
