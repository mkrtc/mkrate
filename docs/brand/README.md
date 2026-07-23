# Mkrate Brand Assets

Durable home for the **Mkrate** visual identity (Mkrate Desktop, Mkrate Relay, Mkrate
Mobile). The mark is a five-node orchestration graph that doubles as the letter "M." Full
rationale, palette, contrast data, and usage rules live in
[`brand-guidelines.md`](./brand-guidelines.md); every shipped file is catalogued with
dimensions and SHA-256 in [`asset-manifest.json`](./asset-manifest.json). Manifest
`files[].file`, `renderedFrom`, and `sourceOf` paths are relative to `docs/brand/`;
`repositoryOutputs[].path` is relative to the repository root, while its `derivedFrom`
references use the same `docs/brand/`-relative canonical paths.

## Assets

All source vectors and rendered rasters live in [`assets/`](./assets/):

| File | Type | Purpose |
|---|---|---|
| `assets/mkrate-mark.svg` | SVG | Standalone full-color mark |
| `assets/mkrate-mark-mono-light.svg` | SVG | Single-color white mark (dark backgrounds) |
| `assets/mkrate-mark-mono-dark.svg` | SVG | Single-color ink mark (light backgrounds) |
| `assets/mkrate-wordmark.svg` | SVG | Logotype "mkrate" (live Inter SemiBold text) |
| `assets/mkrate-lockup-horizontal.svg` | SVG | Mark + wordmark, primary combined logo |
| `assets/mkrate-icon-square.svg` | SVG | App-icon source (no text, safe-area padded) |
| `assets/mkrate-icon-1024.png` … `-64.png`, `assets/mkrate-favicon-32.png` | PNG | Rasters rendered from `mkrate-icon-square.svg` |

## Typography

The wordmark and lockup use **Inter SemiBold (600)**, an open-source typeface under the
[SIL Open Font License 1.1](https://openfontlicense.org/). **No font file is embedded or
vendored** in this repository — the SVGs declare the font by name with a system fallback
stack (`Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica
Neue", Arial, sans-serif`). Consequently:

- `mkrate-wordmark.svg` and `mkrate-lockup-horizontal.svg` contain **live `<text>`** and
  render font-dependently. They are documentation/marketing sources, **not** packaged
  runtime/product assets. For pixel-exact reproduction convert text to outlines on a
  machine with Inter installed (Inkscape `Path → Object to Path`).
- **Production/packaged surfaces are text-free by construction:** the app icon
  (`mkrate-icon-square.svg`) and every in-app logo component use the geometric mark only,
  so nothing packaged depends on a font being present.

## Rendering notes

All PNG rasters were rendered from the approved SVG source with **librsvg + cairo** and
verified for exact pixel dimensions and correct alpha (transparent outside the
rounded-square icon plate, opaque within). All SVGs are well-formed XML.

## Production copies

These brand sources are the canonical reference. Copies used at build/runtime live at:

- `apps/electron/resources/icon.svg` / `icon.png` / `icon.ico` — packaged desktop app icons
  (see [`../branding/icon-inventory.md`](../branding/icon-inventory.md)).
- `apps/electron/resources/mkrate-logos/` — mark/icon rasters for in-repo use.
- `apps/webui/src/public/favicon.svg` / `favicon.ico` — WebUI favicons.

When a derived output changes, update `asset-manifest.json` (including SHA-256) accordingly.

## License

These brand assets are part of the Mkrate repository and are covered by the repository
[`LICENSE`](../../LICENSE) (Apache-2.0) and [`NOTICE`](../../NOTICE). Inter is licensed
separately under the SIL OFL 1.1 by its authors and is not redistributed here.

## Known limitation / deferred work

- **macOS `.icns` and `Assets.car` (Liquid Glass asset catalog) generation is deferred.**
  Those containers require Apple tooling (`iconutil`, `actool`) running on macOS, which is
  out of scope for this pass. This handoff ships the platform-neutral PNGs Apple's pipelines
  consume (1024/512/256 + smaller UI sizes). **macOS production packaging is blocked until a
  native `.icns`/`Assets.car` is generated and validated on macOS** — see
  [`../branding/icon-inventory.md`](../branding/icon-inventory.md).
- Windows `.ico` is generated locally from the approved PNGs (librsvg-rendered) via
  ImageMagick; see `apps/electron/resources/generate-icons-linux.sh`.
