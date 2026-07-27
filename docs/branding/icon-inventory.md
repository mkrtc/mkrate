# Visual Asset Inventory & Rebrand Closure (Task E)

> Status: **updated 2026-07-27 for the approved Mkrate kraken logo.** Every current
> desktop/mobile-facing logo source and Linux/Windows/WebUI derivative now comes from the
> exact approved 1024×1024 PNG; the former five-node graph mark is retired. macOS native icon containers
> (`.icns`, `Assets.car`) are intentionally **not** regenerated in this phase — macOS
> production packaging is **blocked/deferred** until they are produced natively on macOS.
> Canonical brand sources, guidelines, license, and the asset manifest live in
> [`../brand/`](../brand/).

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
| `apps/electron/resources/icon.icns` | **Removed** (Craft macOS icon). macOS `.icns` deferred. |
| `apps/electron/resources/Assets.car` | **Removed** (Craft Liquid Glass catalog). Deferred. |
| `apps/electron/resources/icon.icon/` | **Removed** (Craft asset-catalog source + manifest). Deferred. |

**macOS regeneration (deferred):** recreate `resources/icon.icon/` from
`docs/brand/assets/mkrate-icon-square.svg`, recompile `Assets.car`, and regenerate `icon.icns`
on macOS (see `apps/electron/scripts/afterPack.cjs` and `resources/generate-icons.sh`), then
restore the `mac.icon` / `CFBundleIconName` / `dmg.icon` references in `electron-builder.yml`.
Until then `electron-builder.yml` points `mac.icon` at the platform-neutral PNG and
`afterPack.cjs` emits a loud "do not release macOS build" warning.

**Linux/Windows regeneration:** `apps/electron/resources/generate-icons-linux.sh`
(ImageMagick, no Apple tooling) reproduces `icon.png` / `icon.ico` / `source.png` / `icon.svg`
from the approved brand PNGs.

## 2. Installer / DMG imagery

| File | Status |
|---|---|
| `apps/electron/resources/dmg-background.tiff` | **Removed** (Craft DMG art). |
| `apps/electron/resources/dmg-background.png` | **Removed**. |
| `apps/electron/resources/dmg-background@2x.png` | **Removed**. |

DMG packaging is macOS-only and deferred; `dmg.background` / `dmg.icon` references were removed
from `electron-builder.yml` (electron-builder falls back to defaults). A branded Mkrate DMG
background must be produced before any macOS DMG is shipped.

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
