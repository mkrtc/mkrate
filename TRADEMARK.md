# Trademark & Branding Policy

## Mkrate is an independent fork

**Mkrate** is an independent, community-maintained fork of **Craft Agents**
(<https://github.com/craft-ai-agents/craft-agents-oss>). Mkrate is **not affiliated with, sponsored
by, or endorsed by Craft Docs Ltd.**

The Mkrate name and any Mkrate logos/icons are the branding of this fork. The underlying source code
is used under the Apache License 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) for the license
and the required upstream attribution.

## Craft Docs Ltd. trademarks

The following remain trademarks of **Craft Docs Ltd.** and are **not** claimed by Mkrate:

- **Craft** (word mark)
- **Craft Agents** (word mark)
- The Craft logo and the Craft Agents logo and icon

Mkrate references these marks only **nominatively** — to state factual, permitted things such as:

- "Mkrate is an independent fork of Craft Agents"
- "Mkrate is based on Craft Agents"
- "Compatible with the Craft Agents ecosystem"

Mkrate does **not** use "Craft" or "Craft Agents" as its product name, does not use the Craft logo as
its application icon, and does not imply that Craft Docs Ltd. created or endorses this fork.

## How this fork complies with the upstream trademark policy

The upstream Craft Agents trademark policy asks forks to (1) choose a different name that does not
include "Craft", (2) replace all Craft logos and icons, and (3) update the bundle identifier. Mkrate
follows these requirements:

| Requirement | Status in Mkrate |
|---|---|
| Different product name | **Mkrate** — `productName` and all visible product strings, menus, window titles, installer names, and release titles. |
| New bundle / application ID | **`ru.mkrate.desktop`** (was `com.lukilabs.craft-agent`). |
| New updater repository & artifacts | Releases at `mkrtc/mkrate`; artifacts named `Mkrate-<arch>.<ext>`. |
| Replace Craft logos / icons | **Pending** — visual brand assets are replaced in a separate design task. Until then, the repository still contains the upstream icon/logo files; see [`docs/branding/icon-inventory.md`](docs/branding/icon-inventory.md). Mkrate does **not** claim these icons as its own. |

## Compatibility note — why some internal identifiers still say "craft"

For **drop-in compatibility** with existing installations and with upstream tooling, a small set of
**non-user-facing, technical identifiers are intentionally left unchanged**. These are not brand names
and are not shown to users as Mkrate branding:

- **`@craft-agent/*`** — internal npm workspace/package scopes used only within this monorepo (private, unpublished).
- **`CRAFT_*`** — runtime/build environment variable names (e.g. `CRAFT_CONFIG_DIR`, `CRAFT_DEEPLINK_SCHEME`, `CRAFT_SERVER_TOKEN`).
- **`~/.craft-agent`** — the on-disk configuration directory (config, credentials, workspaces, sessions). Preserving this keeps existing user data in place across the rebrand.
- **`craftagents://`** — the deep-link / OAuth-callback URL scheme registered with the OS. Renaming it would break external links and in-flight OAuth flows. Mkrate does **not** advertise `craftagents://` as Mkrate branding, and no `mkrate://` scheme is introduced at this stage.

Changing any of these would break existing installs, stored credentials, OS protocol registration, or
OAuth callbacks without user benefit. They may be revisited in a later migration.

## Upstream policy

The upstream trademark policy is published by Craft Docs Ltd. in the Craft Agents project. For
questions specifically about the **Craft / Craft Agents** trademarks, refer to the upstream project
and contact Craft Docs Ltd. (`legal@craft.do`). For questions about **Mkrate**, open an issue at
[`mkrtc/mkrate`](https://github.com/mkrtc/mkrate).

---

*This policy adapts the upstream Craft Agents trademark policy, which was in turn inspired by similar
policies from Mozilla, WordPress, and the Apache Software Foundation.*
