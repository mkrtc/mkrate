# Mkrate Brand Assets

Durable home for the shared **Mkrate** visual identity across Desktop, Relay, Mobile, and future clients.

The canonical logo is the white **kraken** on the abyss rounded-square plate supplied and approved on 2026-07-27. Its exact source is [`assets/mkrate-icon-1024.png`](./assets/mkrate-icon-1024.png), SHA-256 `941584a70cef656815c36e6ab48885579f8c428f6847e81edfbf5e7b970b41b6`.

[`brand-guidelines.md`](./brand-guidelines.md) defines usage rules. [`asset-manifest.json`](./asset-manifest.json) records dimensions, derivation, and checksums.

## Assets

| File | Type | Purpose |
|---|---|---|
| `assets/mkrate-icon-1024.png` | PNG | **Canonical, user-approved source raster** |
| `assets/mkrate-icon-square.svg` | SVG | Self-contained exact PNG wrapper for vector-aware consumers; it does not redraw the mark |
| `assets/mkrate-icon-512.png` … `-64.png`, `assets/mkrate-favicon-32.png` | PNG | Deterministic Lanczos downscales of the canonical source |
| `assets/mkrate-mark.svg` | SVG | Standalone full app mark |
| `assets/mkrate-mark-mono-light.svg` | SVG | White kraken silhouette for dark/colored backgrounds |
| `assets/mkrate-mark-mono-dark.svg` | SVG | Ink kraken silhouette for light backgrounds |
| `assets/mkrate-wordmark.svg` | SVG | Lowercase `mkrate` logotype (live Inter SemiBold text) |
| `assets/mkrate-lockup-horizontal.svg` | SVG | Kraken icon + wordmark lockup |

## Source policy

- The PNG is authoritative. Do not manually trace, simplify, recolor, or regenerate its kraken geometry.
- The SVG icon/mark wrappers embed the exact approved PNG so SVG consumers cannot drift from the source.
- Mono silhouettes are derived only for surfaces that require a single-color glyph, including Android monochrome adaptive icons.
- Production app icons remain text-free.
- Wordmark and lockup SVGs contain live text and are documentation/marketing sources, not packaged runtime dependencies.

## Production copies

- `apps/electron/resources/icon.svg`, `icon.png`, `icon.ico`, and `source.png` — packaged desktop icons.
- `apps/electron/src/renderer/assets/mkrate_app_icon.svg` — in-app menus, onboarding, and splash branding.
- `apps/electron/resources/mkrate-logos/` — resource copies.
- `apps/webui/src/public/` and `apps/viewer/public/` — browser/viewer icons.
- Mkrate Mobile keeps a synchronized documentation subset and generates Expo/adaptive assets from the same PNG.

Run `apps/electron/resources/generate-icons-linux.sh` after changing the canonical PNG, then update `asset-manifest.json` checksums.

## Typography

The wordmark uses **Inter SemiBold (600)** under the SIL Open Font License 1.1. No font file is embedded. Convert text to outlines before pixel-exact print/design export.

## License

Brand assets are covered by this repository's [`LICENSE`](../../LICENSE) and [`NOTICE`](../../NOTICE). Inter is separately licensed under SIL OFL 1.1.

## Deferred platform work

macOS `.icns` and `Assets.car` generation still requires Apple tooling and remains deferred. macOS production packaging is blocked until those containers are generated and validated on macOS. Windows `.ico` is generated from the approved PNG using ImageMagick.
