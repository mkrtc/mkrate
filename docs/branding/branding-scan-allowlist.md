# Product-visible Branding Scan — Allowlist (Task E)

After the Mkrate brand-asset replacement, a product-visible scan for `Craft` was re-run
across renderer/webui/viewer sources and the i18n source of truth (`en.json`). Every
remaining `Craft` occurrence falls into one of the allowlisted categories below. If a future
change introduces a new product-visible `Craft` string that is not one of these, it must be
rebranded to Mkrate.

## A. Official Craft integration (external product/service — factual, keep)

- `packages/shared/src/branding.ts` — `VIEWER_URL = https://agents.craft.do`: the live,
  Craft-hosted session-viewer/OAuth service this fork integrates with. Not Mkrate branding.
- i18n `editPopover.example.addSource` ("Connect to my Craft space"), `hints.reviewGitHubPRs`
  / `hints.summarizeGmail` (`{source:Craft}`): reference **Craft (craft.do)** as a
  connectable data source, like Gmail/GitHub. Factual integration references.
- i18n `onboarding.reauth.expired` ("Your Craft session has expired…") and
  `onboarding.reauth.loginWithCraft` ("Log In with Craft"): the app authenticates via a
  **Craft account** (the Craft-hosted auth this fork consumes). Integration reference, not
  Mkrate's own identity. (Intentionally preserved in Phase 1.)

## B. Documented hidden compatibility identifiers (preserved, not advertised)

Guarded by `apps/electron/src/__tests__/branding.test.ts`:

- `@craft-agent/*` npm/package scopes (imports, `pkg.name`).
- `CRAFT_*` env vars (`CRAFT_CONFIG_DIR`, `CRAFT_DEEPLINK_SCHEME`, `CRAFT_SERVER_TOKEN`, …),
  e.g. i18n `transport.authFailed`.
- `~/.craft-agent` config directory.
- `craftagents://` deep-link scheme.
- Tool-icon registry `id`/`commands` `craft-agent` (displayName is "Mkrate").
- `Craft Agents Backend` — legacy persisted provider identifier (explicitly preserved).
- Internal, non-user-visible channel identifiers: DOM `CustomEvent` names (`craft:focus-input`,
  `craft:submit-input`, …), drag-drop MIME types (`application/x-craft-session-row`,
  `application/x-craft-session-group`), theme ids (`craft-dark`/`craft-light`), and the
  persisted embedding model id (`craft-local-hash-v1`). Renaming these would break persisted
  state / event wiring; they are not shown to users.

## C. Factual attribution (Apache-2.0 upstream — keep)

- `electron-builder.yml` copyright: "Based on Craft Agents, © 2026 Craft Docs Ltd."
- `LICENSE`/`NOTICE`, README "Independent fork of Craft Agents" and upstream links.
- `install-app.sh` desktop-entry comment "independent fork of Craft Agents".

## D. Internal, non-shipped surfaces (dev-only; not a product surface)

- `apps/electron/src/renderer/playground/**` demo/fixture data and the design-system
  playground (dev tool). Example fixtures reference "Craft Agents"/`craft-agents-oss`/Linear
  `craft-docs` URLs as sample content. The playground page `<title>` was rebranded to Mkrate;
  remaining fixture strings are illustrative sample data, not product copy.

## E. Internal code comments

- Non-user-visible source comments and i18n **key names** whose **values** are already Mkrate
  (`menu.aboutCraftAgents` → "About Mkrate", `menu.craftMenu` → "Mkrate menu", etc.).

## Known follow-up (out of Task-E scope)

- Some **non-English locale files** still contain "Craft Agents" where `en.json` is already
  rebranded (e.g. `browser.readyTitle` in `pl.json`/`es.json`). This is Phase-1 translation
  parity drift, not a brand asset; it is reported to the orchestrator as a follow-up rather
  than re-translated here.
