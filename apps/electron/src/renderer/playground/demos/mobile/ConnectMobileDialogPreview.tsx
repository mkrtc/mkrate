import * as React from 'react'
import {
  ConnectMobileDialog,
  type MobilePairingMethod,
} from '../../../components/mobile/ConnectMobileDialog'

export interface ConnectMobileDialogPreviewProps {
  method: MobilePairingMethod
  expiresInSeconds: number
}

export function ConnectMobileDialogPreview({
  method: methodPreset,
  expiresInSeconds,
}: ConnectMobileDialogPreviewProps) {
  const [open, setOpen] = React.useState(true)
  const [method, setMethod] = React.useState<MobilePairingMethod>(methodPreset)
  const [generation, setGeneration] = React.useState(1)
  const [expiresAt, setExpiresAt] = React.useState(() => expiryFromNow(expiresInSeconds))

  React.useEffect(() => {
    setOpen(true)
    setMethod(methodPreset)
    setGeneration((value) => value + 1)
    setExpiresAt(expiryFromNow(expiresInSeconds))
  }, [methodPreset, expiresInSeconds])

  const refresh = React.useCallback(() => {
    setGeneration((value) => value + 1)
    setExpiresAt(expiryFromNow(Math.max(expiresInSeconds, 115)))
  }, [expiresInSeconds])

  return (
    <>
      <ConnectMobileDialog
        open={open}
        onOpenChange={setOpen}
        method={method}
        onMethodChange={setMethod}
        qrValue={`mkrate-ui-preview://connect-mobile/${generation}`}
        manualCode="ABCD-2345"
        expiresAt={expiresAt}
        onRefresh={refresh}
        preview
      />
      {!open && (
        <div className="p-6 text-sm text-foreground/60">
          Dialog dismissed.{' '}
          <button
            type="button"
            className="underline hover:text-foreground"
            onClick={() => setOpen(true)}
          >
            Reopen
          </button>
        </div>
      )}
    </>
  )
}

function expiryFromNow(seconds: number): number {
  return Date.now() + Math.max(0, seconds) * 1_000
}
