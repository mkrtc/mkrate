import mkrateAppIcon from "@/assets/mkrate_app_icon.svg"

interface MkrateAppIconProps {
  className?: string
  size?: number
}

/** Displays the canonical Mkrate kraken app icon. */
export function MkrateAppIcon({ className, size = 64 }: MkrateAppIconProps) {
  return (
    <img
      src={mkrateAppIcon}
      alt="Mkrate"
      width={size}
      height={size}
      className={className}
    />
  )
}
