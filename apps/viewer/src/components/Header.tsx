/**
 * Header - App header with branding and controls
 */

import { Sun, Moon, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * MkrateLogo - the Mkrate five-node "M" orchestration-graph mark (single-color,
 * inherits currentColor).
 */
function MkrateLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Mkrate"
    >
      <path
        d="M7 25 L7 7 L16 18 L25 7 L25 25"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="25" r="2.6" fill="currentColor" />
      <circle cx="7" cy="7" r="2.6" fill="currentColor" />
      <circle cx="25" cy="7" r="2.6" fill="currentColor" />
      <circle cx="25" cy="25" r="2.6" fill="currentColor" />
      <circle cx="16" cy="18" r="3.4" fill="currentColor" />
    </svg>
  )
}

interface HeaderProps {
  hasSession: boolean
  sessionTitle?: string
  isDark: boolean
  onToggleTheme: () => void
  onClear: () => void
}

export function Header({ hasSession, sessionTitle, isDark, onToggleTheme, onClear }: HeaderProps) {
  const { t } = useTranslation()
  return (
    <header className="shrink-0 grid grid-cols-[auto_1fr_auto] items-center px-4 py-3">
      {/* Logo - links to main site */}
      <a
        href="https://agents.craft.do"
        className="hover:opacity-80 transition-opacity"
        title="Mkrate"
      >
        <MkrateLogo className="w-6 h-6 text-[#2452FF]" />
      </a>

      {/* Session title - centered */}
      <div className="flex justify-center">
        {sessionTitle && (
          <span className="text-sm font-semibold text-foreground truncate max-w-md">
            {sessionTitle}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* Clear button (when session is loaded) */}
        {hasSession && (
          <button
            onClick={onClear}
            className="p-1.5 rounded-md bg-background shadow-minimal text-foreground/40 hover:text-foreground/70 transition-colors"
            title={t('viewer.clearSession')}
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {/* Theme toggle */}
        <button
          onClick={onToggleTheme}
          className="p-1.5 rounded-md bg-background shadow-minimal text-foreground/40 hover:text-foreground/70 transition-colors"
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </div>
    </header>
  )
}
