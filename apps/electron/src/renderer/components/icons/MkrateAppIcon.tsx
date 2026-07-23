import mkrateAppIcon from "@/assets/mkrate_app_icon.svg"

interface MkrateAppIconProps {
  className?: string
  size?: number
}

/**
 * MkrateAppIcon - Displays the Mkrate app icon (ink squircle, white mark, violet hub).
 */
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
