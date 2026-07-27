import { describe, expect, test } from 'bun:test'
import { formatCountdown, remainingSeconds } from './ConnectMobileDialog'

describe('ConnectMobileDialog countdown', () => {
  test('rounds up partial valid seconds and never goes negative', () => {
    expect(remainingSeconds(10_001, 10_000)).toBe(1)
    expect(remainingSeconds(11_001, 10_000)).toBe(2)
    expect(remainingSeconds(9_999, 10_000)).toBe(0)
  })

  test('formats minute and second boundaries', () => {
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(8)).toBe('0:08')
    expect(formatCountdown(115)).toBe('1:55')
  })
})
