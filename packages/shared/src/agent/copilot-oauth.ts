/**
 * Exchange a long-lived GitHub token for a short-lived Copilot credential
 * through Pi's public provider auth contract.
 *
 * Pi 0.83 removed the legacy refresh helper from its compatibility OAuth
 * entrypoint. Keeping this adapter here gives both model discovery and the
 * running Pi agent one supported refresh path without importing SDK internals.
 */
export async function refreshGitHubCopilotCredential(refreshToken: string) {
  const { githubCopilotProvider } = await import('@earendil-works/pi-ai/providers/github-copilot');
  const oauth = githubCopilotProvider().auth.oauth;

  if (!oauth) {
    throw new Error('GitHub Copilot OAuth is unavailable in the Pi SDK');
  }

  return oauth.refresh({
    type: 'oauth',
    refresh: refreshToken,
    access: '',
    expires: 0,
  });
}
