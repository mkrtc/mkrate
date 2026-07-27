import * as React from 'react'
import { Clock3, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface ConnectMobileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  qrValue: string
  expiresAt: number
  onRefresh: () => void
  /** Playground-only disclosure. Never use this to represent a real pairing ticket. */
  preview?: boolean
}

export function ConnectMobileDialog({
  open,
  onOpenChange,
  qrValue,
  expiresAt,
  onRefresh,
  preview = false,
}: ConnectMobileDialogProps) {
  const { t } = useTranslation()
  const [secondsLeft, setSecondsLeft] = React.useState(() => remainingSeconds(expiresAt))

  React.useEffect(() => {
    if (!open) return
    const update = () => setSecondsLeft(remainingSeconds(expiresAt))
    update()
    const timer = window.setInterval(update, 1_000)
    return () => window.clearInterval(timer)
  }, [expiresAt, open])

  const expired = secondsLeft === 0
  const countdown = formatCountdown(secondsLeft)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-[500px]">
        <div className="border-b border-border/60 bg-foreground/[0.025] px-6 pb-5 pt-6">
          <DialogHeader className="items-center text-center sm:text-center">
            <div className="mb-2 flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Smartphone className="size-5" aria-hidden="true" />
            </div>
            <DialogTitle className="text-xl">{t('dialog.mobileConnect.title')}</DialogTitle>
            <DialogDescription className="max-w-[390px] text-sm leading-5">
              {t('dialog.mobileConnect.description')}
            </DialogDescription>
            {preview && (
              <div className="mt-2 rounded-full border border-amber-500/25 bg-amber-500/10 px-3 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                {t('dialog.mobileConnect.previewBadge')}
              </div>
            )}
          </DialogHeader>
        </div>

        <div className="flex flex-col items-center gap-5 px-6 py-5">
          {expired ? (
            <div className="flex min-h-[276px] w-full flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-muted/30 px-8 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-foreground/5 text-muted-foreground">
                <Clock3 className="size-5" aria-hidden="true" />
              </div>
              <p className="mt-4 text-base font-semibold">{t('dialog.mobileConnect.expired')}</p>
              <p className="mt-1 max-w-[290px] text-sm leading-5 text-muted-foreground">
                {t('dialog.mobileConnect.expiredDescription')}
              </p>
              <Button className="mt-5" onClick={onRefresh}>
                <RefreshCw className="size-4" aria-hidden="true" />
                {t('dialog.mobileConnect.generateNew')}
              </Button>
            </div>
          ) : (
            <>
              <div className="relative rounded-2xl border border-border/70 bg-white p-4 shadow-minimal">
                <QRCodeSVG
                  value={qrValue}
                  size={240}
                  level="M"
                  bgColor="#FFFFFF"
                  fgColor="#0A0F1F"
                  title={t('dialog.mobileConnect.qrLabel')}
                />
                <div className="pointer-events-none absolute -left-px -top-px size-7 rounded-tl-2xl border-l-2 border-t-2 border-primary" />
                <div className="pointer-events-none absolute -right-px -top-px size-7 rounded-tr-2xl border-r-2 border-t-2 border-primary" />
                <div className="pointer-events-none absolute -bottom-px -left-px size-7 rounded-bl-2xl border-b-2 border-l-2 border-primary" />
                <div className="pointer-events-none absolute -bottom-px -right-px size-7 rounded-br-2xl border-b-2 border-r-2 border-primary" />
              </div>

              <div className="flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground">
                <Clock3 className="size-3.5" aria-hidden="true" />
                <span>{t('dialog.mobileConnect.expiresIn', { time: countdown })}</span>
              </div>
            </>
          )}

          <div className="grid w-full grid-cols-[28px_1fr] gap-x-3 gap-y-3 rounded-xl border border-border/60 bg-foreground/[0.02] p-4 text-sm">
            <StepNumber>1</StepNumber>
            <p className="self-center text-foreground/80">{t('dialog.mobileConnect.stepOpen')}</p>
            <StepNumber>2</StepNumber>
            <p className="self-center text-foreground/80">{t('dialog.mobileConnect.stepScan')}</p>
          </div>

          <div className="flex w-full items-start gap-3 rounded-xl bg-emerald-500/[0.08] px-4 py-3 text-sm text-foreground/75">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            <p className="leading-5">{t('dialog.mobileConnect.approvalNote')}</p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-foreground/[0.02] px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          {!expired && (
            <Button onClick={onRefresh}>
              <RefreshCw className="size-4" aria-hidden="true" />
              {t('dialog.mobileConnect.refresh')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function StepNumber({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
      {children}
    </span>
  )
}

export function remainingSeconds(expiresAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1_000))
}

export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const minutesPart = Math.floor(seconds / 60)
  const secondsPart = seconds % 60
  return `${minutesPart}:${secondsPart.toString().padStart(2, '0')}`
}
