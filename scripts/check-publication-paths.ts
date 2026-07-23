import { readFileSync } from 'node:fs'

const PORTABLE_USERNAMES = new Set([
  '...',
  'alice',
  'craftagents',
  'demo',
  'example',
  'foo',
  'john',
  'me',
  'project',
  'test',
  'tester',
  'user',
  'user2',
  'username',
  'x',
])

const tracked = Bun.spawnSync(['git', 'ls-files', '-z'], {
  stdout: 'pipe',
  stderr: 'pipe',
})

if (tracked.exitCode !== 0) {
  const message = new TextDecoder().decode(tracked.stderr).trim()
  console.error(`Unable to list tracked files: ${message}`)
  process.exit(2)
}

const files = new TextDecoder()
  .decode(tracked.stdout)
  .split('\0')
  .filter(Boolean)

const findings: string[] = []

for (const file of files) {
  const bytes = readFileSync(file)
  if (bytes.includes(0)) continue

  const lines = bytes.toString('utf8').split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    const reasons = new Set<string>()

    if (/(?:^|[\\/])Desktop[\\/]projects[\\/](?:sessions|worktrees)(?:[\\/]|$)/i.test(line)) {
      reasons.add('local session/worktree path')
    }

    for (const match of line.matchAll(/(?<![A-Za-z0-9_-])\/(?:home|Users)\/([^/\s"'<>`\\:]+)(?=\/)/g)) {
      const username = match[1]!.toLowerCase()
      if (!PORTABLE_USERNAMES.has(username)) {
        reasons.add(`concrete POSIX home path (${match[0]})`)
      }
    }

    for (const match of line.matchAll(/\b[A-Z]:[\\/]+Users[\\/]+([^\\/\s"'<>`:]+)(?=[\\/])/gi)) {
      const username = match[1]!.toLowerCase()
      if (!PORTABLE_USERNAMES.has(username)) {
        reasons.add(`concrete Windows user path (${match[0]})`)
      }
    }

    for (const reason of reasons) {
      findings.push(`${file}:${index + 1}: ${reason}`)
    }
  }
}

if (findings.length > 0) {
  console.error('Publication path hygiene check failed:')
  for (const finding of findings) console.error(`  ${finding}`)
  console.error('\nUse repository-relative commands or portable placeholders such as /path/to/mkrate.')
  process.exit(1)
}

console.log(`Publication path hygiene check passed (${files.length} tracked files scanned).`)
