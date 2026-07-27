import mkrateAppIcon from "@/assets/mkrate_app_icon.svg"

interface MkrateSymbolProps {
  className?: string
}

/** Compact Mkrate kraken app icon for menus, onboarding, and splash surfaces. */
export function MkrateSymbol({ className }: MkrateSymbolProps) {
  return <img src={mkrateAppIcon} alt="Mkrate" className={className} />
}
