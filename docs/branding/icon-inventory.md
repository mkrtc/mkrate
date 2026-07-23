# Craft Visual Asset Inventory (for Task E — brand asset replacement)

> Status: **Phase-1 external rebrand (this task) intentionally did NOT modify any visual/icon
> assets.** The files below still carry Craft branding and must be replaced with Mkrate brand assets
> by the dedicated design/asset task (Task E). Do not assume any icon is already rebranded.

This inventory lists every Craft logo/icon/brand image asset in the working tree so Task E can
replace or delete them. Text-based, product-facing strings were rebranded to **Mkrate** in Phase 1;
only **binary images and source-embedded logo art/SVGs** remain to be replaced here.

## 1. Application icons (packaged app)

| File | Type | Used by |
|---|---|---|
| `apps/electron/resources/icon.icns` | macOS app icon (multi-res, 178 KB) | `electron-builder.yml` → `mac.icon`, `dmg.icon` |
| `apps/electron/resources/icon.ico` | Windows app icon (108 KB) | `electron-builder.yml` → `win.icon` |
| `apps/electron/resources/icon.png` | Linux app icon (512×512, 22 KB) | `electron-builder.yml` → `linux.icon` |
| `apps/electron/resources/icon.svg` | Source SVG for the app icon | icon generation source |
| `apps/electron/resources/Assets.car` | Compiled macOS 26 Liquid Glass icon (18 KB) | copied into the bundle by `scripts/afterPack.cjs` (references `Mkrate.app` after rebrand) |
| `apps/electron/resources/icon.icon/icon.json` | macOS asset-catalog manifest | `actool` source for `Assets.car` (see `afterPack.cjs` header) |
| `apps/electron/resources/icon.icon/Assets/icon.svg` | Asset-catalog source SVG | compiled into `Assets.car` |

**Regeneration note:** after replacing `icon.icon/Assets/icon.svg`, recompile `Assets.car` with the
`xcrun actool` command documented at the top of `apps/electron/scripts/afterPack.cjs`.

## 2. Installer / DMG imagery

| File | Type | Used by |
|---|---|---|
| `apps/electron/resources/dmg-background.tiff` | macOS DMG background, multi-res retina (12 MB) | `electron-builder.yml` → `dmg.background` |
| `apps/electron/resources/dmg-background.png` | DMG background 1× source | source for the TIFF |
| `apps/electron/resources/dmg-background@2x.png` | DMG background 2× source | source for the TIFF |

## 3. Craft logo image files

| File | Type |
|---|---|
| `apps/electron/resources/craft-logos/craft_app_icon.png` | App-icon raster (light) |
| `apps/electron/resources/craft-logos/craft_app_icon_dark.png` | App-icon raster (dark) |
| `apps/electron/resources/craft-logos/craft_logo_black.png` | Wordmark/logo (black) |
| `apps/electron/resources/craft-logos/craft_logo_white.png` | Wordmark/logo (white) |
| `apps/electron/src/renderer/assets/craft_logo_c.svg` | Stylized "C" logo (renderer asset) |
| `apps/electron/resources/tool-icons/craft-agent.svg` | Tool-icon registry entry for the app itself |

> The entire `apps/electron/resources/craft-logos/` directory is Craft branding. Task E should
> replace or delete it. **Do not delete in Phase 1.**

## 4. Source-embedded logo art / React SVG logo components

These render Craft logo art directly from source (not standalone image files). Task E must replace
the SVG paths / art with Mkrate equivalents.

| File | What it is | Notable consumers |
|---|---|---|
| `packages/shared/src/branding.ts` | `CRAFT_LOGO` / `CRAFT_LOGO_HTML` — ASCII-art block logo | OAuth callback page (`packages/shared/src/auth/callback-page.ts` renders `CRAFT_LOGO_HTML`; the page's text title/link were rebranded to Mkrate in Phase 1, the ASCII art was left for Task E) |
| `apps/electron/src/renderer/components/icons/CraftAgentsLogo.tsx` | React SVG full logo | splash / onboarding / menus |
| `apps/electron/src/renderer/components/icons/CraftAgentsSymbol.tsx` | React SVG "E" pixel-art symbol | app UI |
| `apps/electron/src/renderer/components/icons/CraftAppIcon.tsx` | React SVG app icon | app UI |
| `apps/electron/src/renderer/components/SplashScreen.tsx` | Splash screen using the logo components | app launch |
| `apps/electron/src/renderer/components/onboarding/*` (WelcomeStep, ProviderSelectStep, ReauthScreen, CompletionStep) | Onboarding screens using logo components | onboarding |
| `apps/electron/src/renderer/components/app-menu/{DesktopAppMenu,MobileAppMenu}.tsx` | App menus using logo components | app menus |
| `packages/ui/src/components/chat/SessionViewer.tsx` | Uses a logo component | session viewer |
| `apps/viewer/src/components/Header.tsx` | `CraftAgentLogo` inline SVG (viewer web app) | viewer header (visible text title rebranded to Mkrate in Phase 1; the SVG art was left for Task E) |
| `apps/electron/src/renderer/playground/registry/icons.tsx` | Playground icon registry entries/descriptions | internal design playground only |

## 5. WebUI favicons

| File | Type |
|---|---|
| `apps/webui/src/public/favicon.svg` | WebUI favicon (vector) |
| `apps/webui/src/public/favicon.ico` | WebUI favicon (fallback) |

## Notes for Task E

- After swapping raster icons, re-verify `electron-builder.yml` icon paths still resolve.
- After swapping `icon.icon/Assets/icon.svg`, recompile `Assets.car` (see §1).
- The React SVG logo components in §4 are the in-app runtime logos; replacing the standalone image
  files alone will **not** change what users see inside the running app.
- `packages/shared/src/branding.ts` is a source file but functions as a **visual asset** (ASCII
  logo); Phase 1 left it untouched by design.
