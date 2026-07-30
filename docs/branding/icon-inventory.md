# Visual Asset Inventory & Rebrand Closure (Task E)

> Status: **updated 2026-07-30 for v0.0.1 packaging.** Every desktop/mobile-facing
> logo source and Linux/Windows/WebUI derivative comes from the exact approved 1024×1024 PNG;
> the former five-node graph mark is retired. The release macOS build produces and validates a
> standard native `.icns` on macOS from that PNG only. Liquid Glass `Assets.car` remains deferred
> and no retired Craft artwork is eligible for restoration. Canonical brand sources, guidelines,
> license, and the asset manifest live in [`../brand/`](../brand/).

## Brand source integration

- `docs/brand/` — canonical brand home. `assets/mkrate-icon-1024.png` is the exact
  user-approved source raster; SVG wrappers, wordmark/lockup sources, and platform PNGs are catalogued in `asset-manifest.json`.
- `apps/electron/resources/mkrate-logos/` — in-repo raster/vector copies (replaces the deleted
  `craft-logos/`).

## 1. Application icons (packaged app)

| File | Status |
|---|---|
| `apps/electron/resources/icon.svg` | **Replaced** → Mkrate app-icon source (`mkrate-icon-square.svg`). |
| `apps/electron/resources/icon.png` | **Replaced** → 512×512 Mkrate app icon. |
| `apps/electron/resources/icon.ico` | **Regenerated** on Linux (ImageMagick) → multi-res 16–256 Mkrate, alpha preserved. |
| `apps/electron/resources/source.png` | **Replaced** → 1024×1024 Mkrate app icon (generator source). |
| `apps/electron/resources/icon.icns` | **Generated and validated on macOS per release build** from the exact canonical PNG by `scripts/generate-macos-icon.sh`; required by `mac.icon` and `dmg.icon`. It is not checked in and must not be substituted. |
| `apps/electron/resources/Assets.car` | **Deferred** (macOS 26 Liquid Glass enhancement); no retired Craft catalog is reused. |
| `apps/electron/resources/icon.icon/` | **Deferred** (future asset-catalog source); not a v0.0.1 packaging requirement. |

**macOS v0.0.1 generation:** `scripts/build-dmg.sh` runs
`scripts/generate-macos-icon.sh` before packaging. The helper verifies the canonical PNG SHA-256,
generates the standard 16–1024px iconset with `sips`, compiles with `iconutil`, and re-expands
and validates the resulting `.icns`. `afterPack.cjs` then verifies the canonical source and the
native icon inside `Mkrate.app`. The build fails closed for a missing or mismatched icon.

**Linux/Windows regeneration:** `apps/electron/resources/generate-icons-linux.sh`
(ImageMagick, no Apple tooling) reproduces `icon.png` / `icon.ico` / `source.png` / `icon.svg`
from the approved brand PNGs.

## 2. Installer / DMG imagery

| File | Status |
|---|---|
| `apps/electron/resources/dmg-background.tiff` | **Removed** (Craft DMG art). |
| `apps/electron/resources/dmg-background.png` | **Removed**. |
| `apps/electron/resources/dmg-background@2x.png` | **Removed**. |

v0.0.1 DMG packaging is macOS-only and uses a plain native DMG with the generated Mkrate
`.icns` volume icon. `dmg.background` remains intentionally unset: a custom branded background
is a future enhancement, never a reason to restore retired Craft DMG art.

## 3. Logo image files

| Old file | Status |
|---|---|
| `apps/electron/resources/craft-logos/` (whole dir) | **Removed**, replaced by `resources/mkrate-logos/` (Mkrate app-icon PNG + mark SVGs). |
| `apps/electron/src/renderer/assets/craft_logo_c.svg` | **Removed**, replaced by `assets/mkrate_app_icon.svg`. |
| `apps/electron/resources/tool-icons/craft-agent.svg` | **Removed**, replaced by `tool-icons/mkrate-agent.svg`; `tool-icons.json` displayName → "Mkrate", icon → `mkrate-agent.svg`. The `id`/`commands` (`craft-agent`) are a preserved hidden compatibility identifier and are unchanged. |

## 4. Source-embedded logo art / React SVG logo components

| Old | New | Notes |
|---|---|---|
| `icons/CraftAgentsLogo.tsx` (`CraftAgentsLogo`) | `icons/MkrateLogo.tsx` (`MkrateLogo`) | Canonical kraken app icon. |
| `icons/CraftAgentsSymbol.tsx` (`CraftAgentsSymbol`) | `icons/MkrateSymbol.tsx` (`MkrateSymbol`) | Compact canonical kraken app icon. |
| `icons/CraftAppIcon.tsx` (`CraftAppIcon`) | `icons/MkrateAppIcon.tsx` (`MkrateAppIcon`) | `<img>` of `mkrate_app_icon.svg`. |
| inline `CraftAgentLogo` in `apps/viewer/src/components/Header.tsx` | `MkrateLogo` | Loads the canonical kraken derivative from viewer public assets. |
| inline `CraftAgentLogo` in `packages/ui/src/components/chat/SessionViewer.tsx` | `MkrateLogo` | Uses the embedded canonical kraken derivative. |
| `packages/shared/src/branding.ts` (`CRAFT_LOGO`/`CRAFT_LOGO_HTML`) | `MKRATE_LOGO_DATA_URI` | Standalone OAuth callback now embeds the canonical kraken derivative; retired ASCII graph removed. |
| `playground/registry/icons.tsx` | updated | Ids/descriptions rebranded (internal design playground). |

Consumers updated: `SplashScreen`, onboarding (`WelcomeStep`, `ProviderSelectStep`,
`ReauthScreen`, `CompletionStep`), app menus (`DesktopAppMenu`, `MobileAppMenu`),
`PlaygroundApp`, `playground/registry/icons.tsx`.

## 5. WebUI favicons

| File | Status |
|---|---|
| `apps/webui/src/public/favicon.svg` | **Replaced** → approved kraken app icon. |
| `apps/webui/src/public/favicon.ico` | **Regenerated** (16+32 Mkrate). |

## Preserved (not visual identity — do not "rebrand")

- `VIEWER_URL = https://agents.craft.do` — live Craft-hosted session-viewer service this fork
  integrates with (session sharing + WebUI OAuth redirect). External integration endpoint, not
  Mkrate branding.
- Hidden compatibility identifiers: `@craft-agent/*` package scopes, `CRAFT_*` env vars,
  `~/.craft-agent` config dir, `craftagents://` deep-link scheme, the `craft-agent` tool id/command,
  and the legacy `Craft Agents Backend` provider label. These are intentionally unchanged and not
  advertised. See `apps/electron/src/__tests__/branding.test.ts`.
