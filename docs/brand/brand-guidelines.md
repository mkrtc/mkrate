# Mkrate Brand Guidelines

## 1. Name

- **Official name:** Mkrate
- **Wordmark:** lowercase `mkrate`
- **Product family:** Mkrate Desktop, Mkrate Relay, Mkrate Mobile
- **Tagline:** “Create. Orchestrate. Automate.”
- **Domain:** mkrate.ru

## 2. Canonical logo

The approved mark is a white **kraken** on an abyss (`#0A0F1F`) rounded-square plate. It replaces the former five-node “M” graph on every Mkrate product surface.

The kraken expresses one coordinated intelligence with many capable arms: a direct visual metaphor for Mkrate orchestrating tools, agents, devices, and workflows while retaining a single product identity.

The exact approved source is `assets/mkrate-icon-1024.png` (1024×1024 RGBA), SHA-256:

`941584a70cef656815c36e6ab48885579f8c428f6847e81edfbf5e7b970b41b6`

This raster is authoritative. Do not redraw or trace it. `mkrate-icon-square.svg` and `mkrate-mark.svg` are self-contained wrappers around those exact bytes, not alternative geometry.

## 3. Variants

- **Primary app mark:** white kraken + abyss plate. Use for app icons, product navigation, onboarding, splash, avatars, and branded tiles.
- **Mono light:** white kraken silhouette with transparent background. Use only where a platform requires a monochrome/foreground glyph.
- **Mono dark:** abyss kraken silhouette with transparent background. Use on plain light backgrounds when a plate is unsuitable.
- **Horizontal lockup:** primary icon plus lowercase `mkrate` wordmark. Use in documents and marketing headers where space permits.

Do not substitute the former graph mark on legacy surfaces.

## 4. Wordmark

The wordmark is lowercase `mkrate` in **Inter SemiBold (600)** with tight tracking. Its SVG uses live text with a system fallback stack and therefore is a documentation/marketing source. Convert text to outlines for pixel-exact print exports.

Do not re-case, italicize, stretch, rotate, or re-kern the wordmark.

## 5. Core palette

| Token | Hex | Role |
|---|---|---|
| `mkrate-ink-950` | `#0A0F1F` | Approved icon plate, primary dark neutral, dark surfaces |
| `mkrate-white` | `#FFFFFF` | Kraken silhouette and text on dark surfaces |
| `mkrate-blue-600` | `#2452FF` | Existing UI action/accent color; no longer part of logo geometry |
| `mkrate-blue-700` | `#1636B8` | Accessible small-text/action variant |
| `mkrate-violet-500` | `#7C5CFF` | Optional product UI accent; no longer part of logo geometry |
| `mkrate-mist-50` | `#EEF2FF` | Light tint background |
| `mkrate-slate-500` | `#64748B` | Secondary text |
| `mkrate-slate-200` | `#E2E8F0` | Hairlines and dividers |

Existing contrast rules for UI colors remain unchanged; the logo itself uses white on `#0A0F1F`.

## 6. Digital/app-icon usage

- Use the complete primary icon in desktop/mobile navigation even at small sizes; do not crop out the plate.
- Preserve the source aspect ratio and alpha.
- iOS/base Expo icon derivatives must flatten transparent corners onto `#0A0F1F`; the OS applies the final mask.
- Android adaptive icons use `#0A0F1F` as the background layer and the derived white kraken as foreground/monochrome layers.
- Keep foreground art within the existing adaptive-icon safe area. Never place the complete pre-masked icon into the foreground layer.
- Do not add text to launcher icons.

## 7. Minimum size and clear space

The curled tentacle details are more intricate than the former graph mark. Verify every platform at its real rendered size.

- Prefer 20 px or larger for in-product navigation.
- 16 px is permitted only for favicon/system constraints and must use an approved generated derivative.
- Maintain clear space around free-standing mono marks equal to at least 10% of the rendered width.
- The primary icon already contains its own internal clear space; do not crop inside the 1024×1024 canvas.

## 8. Forbidden usage

- Do not redraw, simplify, mirror, rotate, stretch, animate, or alter the kraken geometry.
- Do not recolor the primary icon or replace its `#0A0F1F` plate.
- Do not add gradients, shadows, bevels, outlines, glows, or extra facial details.
- Do not use the former five-node “M” graph as Mkrate product identity.
- Do not place the mono mark on busy imagery without a solid contrast plate.
- Do not expose adaptive foreground/monochrome assets as the normal full-color app icon.
- Do not reproduce Craft/Craft Agents visual identity alongside or instead of Mkrate.

## 9. Provenance and derivatives

All generated files and repository copies must be listed in `asset-manifest.json` with SHA-256 checksums. The Mkrate Mobile documentation subset and launcher assets must stay byte-derived from this desktop-owned canonical source.
