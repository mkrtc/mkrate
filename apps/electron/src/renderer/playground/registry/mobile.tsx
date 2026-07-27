import type { ComponentEntry } from './types'
import { ConnectMobileDialogPreview } from '../demos/mobile/ConnectMobileDialogPreview'

export const mobileComponents: ComponentEntry[] = [
  {
    id: 'mobile-connect-dialog',
    name: 'Connect Mkrate Mobile dialog',
    category: 'Mobile',
    description: 'UI-only desktop QR/manual pairing entry. Uses non-secret preview material and no backend.',
    component: ConnectMobileDialogPreview,
    layout: 'centered',
    previewOverflow: 'visible',
    props: [
      {
        name: 'method',
        description: 'Initially selected pairing input method.',
        control: {
          type: 'select',
          options: [
            { label: 'QR code', value: 'qr' },
            { label: 'Manual code', value: 'manual' },
          ],
        },
        defaultValue: 'qr',
      },
      {
        name: 'expiresInSeconds',
        description: 'Seconds remaining before the preview hides its QR.',
        control: { type: 'number', min: 0, max: 300, step: 1 },
        defaultValue: 115,
      },
    ],
    variants: [
      {
        name: 'Active QR',
        props: { method: 'qr', expiresInSeconds: 115 },
      },
      {
        name: 'Active manual code',
        props: { method: 'manual', expiresInSeconds: 115 },
      },
      {
        name: 'Manual code near expiry',
        props: { method: 'manual', expiresInSeconds: 8 },
      },
      {
        name: 'Expired',
        props: { method: 'manual', expiresInSeconds: 0 },
      },
    ],
  },
]
