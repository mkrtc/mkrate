import { describe, expect, it } from 'bun:test'

import { isExpectedUvVersionOutput, UV_VERSION } from '../build/common'

describe('bundled uv version identity', () => {
  it('accepts the exact release version with or without official build metadata', () => {
    expect(isExpectedUvVersionOutput(`uv ${UV_VERSION}`)).toBe(true)
    expect(isExpectedUvVersionOutput(`uv ${UV_VERSION} (a91bcf268 2026-02-24)`)).toBe(true)
  })

  it('rejects semantic-version drift and malformed metadata', () => {
    expect(isExpectedUvVersionOutput('uv 0.10.5 (a91bcf268 2026-02-24)')).toBe(false)
    expect(isExpectedUvVersionOutput(`uv ${UV_VERSION} (unverified build)`)).toBe(false)
    expect(isExpectedUvVersionOutput(`uv ${UV_VERSION} extra`)).toBe(false)
  })
})
