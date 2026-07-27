import mkrateAppIcon from "@/assets/mkrate_app_icon.svg"

interface MkrateLogoProps {
  className?: string
}

/** Mkrate kraken logo, using the canonical user-approved app-icon asset. */
export function MkrateLogo({ className }: MkrateLogoProps) {
  return <img src={mkrateAppIcon} alt="Mkrate" className={className} />
}
