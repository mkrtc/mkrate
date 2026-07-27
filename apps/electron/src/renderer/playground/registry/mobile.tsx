import type { ComponentEntry } from './types'
import { ConnectMobileDialogPreview } from '../demos/mobile/ConnectMobileDialogPreview'

export const mobileComponents: ComponentEntry[] = [
  {
    id: 'mobile-connect-dialog',
    name: 'Connect Mkrate Mobile dialog',
    category: 'Mobile',
    description: 'UI-only desktop QR pairing entry. Uses a deliberately non-canonical preview QR and no backend.',
    component: ConnectMobileDialogPreview,
    layout: 'centered',
    previewOverflow: 'visible',
    props: [
      {
        name: 'expiresInSeconds',
        description: 'Seconds remaining before the preview hides its QR.',
        control: { type: 'number', min: 0, max: 300, step: 1 },
        defaultValue: 115,
      },
    ],
    variants: [
      {
        name: 'Active code',
        props: { expiresInSeconds: 115 },
      },
      {
        name: 'Near expiry',
        props: { expiresInSeconds: 8 },
      },
      {
        name: 'Expired',
        props: { expiresInSeconds: 0 },
      },
    ],
  },
]
