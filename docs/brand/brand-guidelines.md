# Mkrate Brand Guidelines

## 1. Name and pronunciation

- **Official name:** Mkrate
- **Casing:** Always lowercase in the wordmark and logotype (`mkrate`). In running prose, capitalize as a proper noun at the start of a sentence or per house style (`Mkrate`), but never render it as `MKRATE`, `MkRate`, or `mKrate`.
- **Pronunciation:** "muh-KRATE" (rhymes with "create") — the name is a contraction of **mkrtc** + **create**, signaling continuity with the project's origin while standing as its own identity.
- **Product family names:** Mkrate Desktop, Mkrate Relay, Mkrate Mobile. Always two words, family name first.
- **Tagline:** "Create. Orchestrate. Automate." — three short imperative verbs, period-separated, sentence case only on the first word of each clause as shown.
- **Domain:** mkrate.ru

## 2. Design rationale

The mark is a single motif read two ways at once:

1. **The letter "M"** — the classic five-point zigzag skeleton of a sans-serif capital M (down, up, valley, up, down).
2. **A five-node orchestration graph** — the same five points doubled as circular nodes, with the center "valley" node enlarged and set in a second color to represent the **relay/hub** that coordinates the four outer **agent/endpoint** nodes (Desktop, Mobile, Relay, and beyond).

This gives Mkrate a mark that is simultaneously a legible letterform and a literal diagram of what the product does — orchestrate distributed agents and nodes — without resorting to a mascot, gradient mesh, or generic "AI spark" cliché. It remains fully legible at 16–32 px because it is built from two visual primitives only: a bold rounded stroke and filled circles, both of which survive downsampling far better than fine detail or thin linework.

**Distinctiveness from Craft/Craft Agents:** this system was designed independently — a five-node graph-as-letterform in a blue/violet/ink palette — and deliberately avoids single-glyph wordmark badges, orange/warm-hued primary marks, and rounded "chat bubble" or "spark" iconography that dominate adjacent developer-tool branding. No Craft asset, path, font, or color value was referenced, copied, or traced in producing these files.

## 3. The mark

`mkrate-mark.svg` — a transparent-background glyph combining:
- An open polyline stroke tracing the M skeleton: `(7,25) → (7,7) → (16,18) → (25,7) → (25,25)` on a 32×32 grid.
- Four outer node circles (r = 2.6) in **Signal Blue**.
- One center "hub" node circle (r = 3.4, intentionally larger) in **Node Violet** — this is the only place Node Violet appears in the default system, reserved for signaling the relay/orchestrator role.

Use the mark alone only where the wordmark would be redundant or illegible (favicons, avatars, small app tiles, loading spinners).

## 4. Wordmark and lockup

- `mkrate-wordmark.svg` — the word "mkrate," lowercase, set in **Inter SemiBold (600)** at tight tracking (-2 tracking units at 96px). Inter is an open-source (SIL OFL) typeface widely available as a system/web font; no font file is embedded in the SVG.
- `mkrate-lockup-horizontal.svg` — the mark and wordmark combined, mark-height matched to the wordmark's cap-height band, with a fixed gap equal to one mark-width's clear space between them. This is the default lockup for READMEs, headers, and marketing surfaces.

**Do not** recreate the wordmark in a different typeface, re-kern it, italicize it, or stretch it non-uniformly. If Inter is unavailable in a target environment, fall back to the declared stack (`Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`) rather than substituting a serif or display face. For pixel-exact reproduction independent of installed fonts (print, design tools), convert the text to outlines first (e.g. Illustrator "Create Outlines," Inkscape "Path → Object to Path").

## 5. Color palette

| Token | Hex | Role |
|---|---|---|
| `mkrate-ink-950` | `#0A0F1F` | Primary dark neutral — wordmark fill on light backgrounds, app-icon background, dark-mode surfaces |
| `mkrate-blue-600` | `#2452FF` | Primary brand color — mark strokes/nodes on light backgrounds, links, primary actions |
| `mkrate-blue-700` | `#1636B8` | Accessible-text variant of primary blue; hover/pressed states |
| `mkrate-violet-500` | `#7C5CFF` | Reserved accent — the mark's center hub node only; sparing secondary accent elsewhere |
| `mkrate-mist-50` | `#EEF2FF` | Light tint background / hover fill on light surfaces |
| `mkrate-white` | `#FFFFFF` | Mark/wordmark on dark backgrounds; app-icon foreground |
| `mkrate-slate-500` | `#64748B` | Secondary/muted text |
| `mkrate-slate-200` | `#E2E8F0` | Hairlines, dividers, borders on light surfaces |

### Contrast (WCAG 2.1, measured)

| Foreground | Background | Ratio | Passes |
|---|---|---|---|
| `mkrate-ink-950` | white | 19.07:1 | AAA (normal text) |
| `mkrate-blue-600` | white | 5.64:1 | AA (normal text) |
| `mkrate-blue-700` | white | 9.32:1 | AAA (normal text) |
| `mkrate-violet-500` | white | 4.35:1 | AA (large text/UI only — **do not** use for small body text) |
| white | `mkrate-ink-950` | 19.07:1 | AAA (normal text) |
| `mkrate-slate-500` | white | 4.76:1 | AA (normal text) |
| `mkrate-blue-600` | `mkrate-mist-50` | 5.04:1 | AA (normal text) |

Use `mkrate-blue-700` instead of `mkrate-blue-600` wherever brand blue carries small text on a light background. `mkrate-violet-500` is reserved for the mark's hub node and large-scale accents — never for body copy.

## 6. Light/dark usage

- **On light backgrounds:** full-color mark/lockup (blue + violet + ink wordmark), or `mkrate-mark-mono-dark.svg` for a single-color-only context (e.g. printed on a colored surface, stamped/engraved use).
- **On dark backgrounds:** `mkrate-mark-mono-light.svg` (all-white mark) paired with a white-filled wordmark (swap the wordmark's single `fill` attribute to `#FFFFFF`). Do not place the full-color mark (which assumes a light backdrop for the ink wordmark) directly on dark surfaces — use the mono-light mark instead.
- **App icon:** `mkrate-icon-square.svg` is a fixed, self-contained composition (ink background, white mark, violet hub) and should not be recolored or placed on another background; it is already dark-surface-safe by construction.

## 7. Minimum size and clear space

- **Minimum size, mark alone:** 16 × 16 px (digital), 6 mm (print). Below 16 px the hub node and outer nodes may visually merge; test before shipping at any smaller size.
- **Minimum size, horizontal lockup:** 96 px wide (digital), 20 mm (print), to keep the wordmark legible.
- **Clear space:** maintain a minimum clear space around the mark and lockup equal to the height of one outer node circle in the mark (i.e., the "hub" radius at that scale) on all sides — no text, edges, or other graphics inside that margin.

## 8. App icon safe area

`mkrate-icon-square.svg` is built on a 1024×1024 canvas:
- Background: full-bleed rounded square, `mkrate-ink-950`, corner radius 224 px (≈21.9%, a generic "squircle" suitable for platforms without automatic OS icon masking).
- Mark: centered, occupying a 504×504 px bounding box (≈49% of canvas width), leaving generous clear space to the rounded corners so the glyph is never clipped by platform-specific icon masks (iOS/iPadOS/Android apply their own additional masking on top of a full-bleed square source).
- No text appears in the square icon, per app-icon conventions and the design brief.

For platforms that auto-mask icons (iOS, Android adaptive icons), a full-bleed variant without the pre-baked rounded corners can be derived by removing the background `<rect>`'s `rx`/`ry` and letting the OS apply its own mask; this is a one-line edit to `mkrate-icon-square.svg` and is intentionally not shipped as a separate file to avoid asset sprawl.

## 9. Forbidden usage

- Do not recolor the mark outside the documented tokens (no gradients, no arbitrary hues).
- Do not separate the hub node's violet accent onto more than one node — it signals a singular relay/orchestrator and loses meaning if repeated.
- Do not distort, skew, rotate, or mirror the mark or wordmark.
- Do not add drop shadows, bevels, outlines, or 3D effects.
- Do not place the full-color mark on busy photographic backgrounds — use a mono variant with a solid-color plate instead.
- Do not reproduce or imitate any Craft/Craft Agents logo geometry, colors, or wordmark alongside or instead of this system.
- Do not typeset the wordmark in any typeface other than Inter (or its declared system-font fallback stack).
- Do not use the square icon template for anything other than app/tile icons — use the horizontal lockup for headers and documents.

## 10. File index

See `asset-manifest.json` for the authoritative list of every shipped file with dimensions, format, intended use, source relationship, and SHA-256 checksum.
