interface MkrateLogoProps {
  className?: string
}

/**
 * Mkrate logo — the five-node "M" orchestration-graph mark in full brand color
 * (Signal Blue nodes/strokes, Node Violet center hub). Text-free by design so it
 * never depends on the Inter wordmark font being present; pair with app-name text
 * where a lockup is needed.
 */
export function MkrateLogo({ className }: MkrateLogoProps) {
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
        stroke="#2452FF"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="25" r="2.6" fill="#2452FF" />
      <circle cx="7" cy="7" r="2.6" fill="#2452FF" />
      <circle cx="25" cy="7" r="2.6" fill="#2452FF" />
      <circle cx="25" cy="25" r="2.6" fill="#2452FF" />
      <circle cx="16" cy="18" r="3.4" fill="#7C5CFF" />
    </svg>
  )
}
