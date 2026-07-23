# Security Policy

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability in Mkrate, please report it responsibly.

### How to Report

**Please do NOT report security vulnerabilities through public GitHub issues.**

Instead, report privately through GitHub's private vulnerability reporting:

- Open **[github.com/mkrtc/mkrate](https://github.com/mkrtc/mkrate) → Security → Advisories → "Report a vulnerability"**, or go directly to
  **<https://github.com/mkrtc/mkrate/security/advisories/new>**.

This keeps the report private to the maintainers until a fix is available. (No
dedicated security mailbox is operated for this project — please use the GitHub
private advisory flow above rather than email.)

Include the following information:
- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Any suggested fixes (optional)

### What to Expect

- **Acknowledgment**: We aim to acknowledge receipt within a few days
- **Initial Assessment**: We aim to provide an initial assessment within ~7 days
- **Resolution Timeline**: We aim to resolve critical issues as quickly as we can

(This is a community-maintained fork; these are best-effort targets, not guarantees.)

### Scope

This policy applies to:
- The Mkrate desktop application
- The `@craft-agent/*` npm packages
- The Mkrate repositories (mkrtc/mkrate)

### Out of Scope

- Third-party dependencies (report to their maintainers)
- Social engineering attacks
- Denial of service attacks

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |
| < Latest | :x:               |

We only provide security updates for the latest version. Please keep your installation up to date.

## Security Best Practices

When using Mkrate:

1. **Keep credentials secure**: Never commit `.env` files or credentials
2. **Use environment variables**: Store secrets in environment variables
3. **Review permissions**: Be cautious with "Execute" permission mode
4. **Update regularly**: Keep the application updated

## Acknowledgments

We appreciate responsible disclosure and will acknowledge security researchers who report valid vulnerabilities (with their permission).
