import * as React from 'react'
import { ConnectMobileDialog } from '../../../components/mobile/ConnectMobileDialog'

export interface ConnectMobileDialogPreviewProps {
  expiresInSeconds: number
}

export function ConnectMobileDialogPreview({
  expiresInSeconds,
}: ConnectMobileDialogPreviewProps) {
  const [open, setOpen] = React.useState(true)
  const [generation, setGeneration] = React.useState(1)
  const [expiresAt, setExpiresAt] = React.useState(() => expiryFromNow(expiresInSeconds))

  React.useEffect(() => {
    setOpen(true)
    setGeneration((value) => value + 1)
    setExpiresAt(expiryFromNow(expiresInSeconds))
  }, [expiresInSeconds])

  const refresh = React.useCallback(() => {
    setGeneration((value) => value + 1)
    setExpiresAt(expiryFromNow(Math.max(expiresInSeconds, 115)))
  }, [expiresInSeconds])

  return (
    <>
      <ConnectMobileDialog
        open={open}
        onOpenChange={setOpen}
        qrValue={`mkrate-ui-preview://connect-mobile/${generation}`}
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
