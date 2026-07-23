/**
 * Centralized branding assets for Mkrate.
 * Used by OAuth callback pages.
 */

/**
 * Mkrate mark as ASCII art — the five-node "M" orchestration graph
 * (four outer nodes + a center hub). Rendered in a monospace <pre>.
 */
export const MKRATE_LOGO = [
  '  ●         ●  ',
  '  │╲       ╱│  ',
  '  │ ╲     ╱ │  ',
  '  │  ╲   ╱  │  ',
  '  │   ╲ ╱   │  ',
  '  │    ●    │  ',
  '  ●         ●  ',
] as const;

/** Logo as a single string for HTML templates */
export const MKRATE_LOGO_HTML = MKRATE_LOGO.map((line) => line.trimEnd()).join('\n');

/**
 * Session viewer base URL.
 *
 * NOTE: This is the live, Craft-hosted session-viewer service this fork
 * integrates with for session sharing (`${VIEWER_URL}/s/api`) and WebUI OAuth
 * redirects. It is an external integration endpoint, not Mkrate branding —
 * Mkrate does not host a viewer. Do not repoint it at an unconfigured mkrate.ru
 * URL, which would break sharing and falsely imply a hosted Mkrate service.
 */
export const VIEWER_URL = 'https://agents.craft.do';
