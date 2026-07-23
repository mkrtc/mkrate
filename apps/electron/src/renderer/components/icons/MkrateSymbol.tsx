interface MkrateSymbolProps {
  className?: string
}

/**
 * Mkrate symbol — the five-node "M" orchestration-graph mark, single-color.
 * Uses `currentColor` so it inherits the theme accent (apply e.g. `text-accent`).
 */
export function MkrateSymbol({ className }: MkrateSymbolProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
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
