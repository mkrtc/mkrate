import { describe, expect, it } from 'bun:test'
import {
  inferModelSelectionMode,
  isLegacyKimiCodingDefaultSelection,
  shouldMigratePiOpenAiProvider,
  shouldRepairPiApiKeyCodexProvider,
} from '../storage'

describe('shouldMigratePiOpenAiProvider', () => {
  it('migrates legacy Pi OAuth OpenAI connections to openai-codex', () => {
    expect(shouldMigratePiOpenAiProvider({
      providerType: 'pi',
      piAuthProvider: 'openai',
      authType: 'oauth',
    })).toBe(true)
  })

  it('does not migrate Pi API key OpenAI connections', () => {
    expect(shouldMigratePiOpenAiProvider({
      providerType: 'pi',
      piAuthProvider: 'openai',
      authType: 'api_key',
    })).toBe(false)
  })

  it('does not migrate Pi custom endpoint connections', () => {
    expect(shouldMigratePiOpenAiProvider({
      providerType: 'pi',
      piAuthProvider: 'openai',
      authType: 'oauth',
      baseUrl: 'https://custom.gateway.example/v1',
    })).toBe(false)
  })

  it('does not migrate already-correct openai-codex connections', () => {
    expect(shouldMigratePiOpenAiProvider({
      providerType: 'pi',
      piAuthProvider: 'openai-codex',
      authType: 'oauth',
    })).toBe(false)
  })
})

describe('shouldRepairPiApiKeyCodexProvider', () => {
  it('repairs Pi API key connections that were incorrectly set to openai-codex', () => {
    expect(shouldRepairPiApiKeyCodexProvider({
      providerType: 'pi',
      piAuthProvider: 'openai-codex',
      authType: 'api_key',
    })).toBe(true)
  })

  it('repairs Pi API key with endpoint connections that were incorrectly set to openai-codex', () => {
    expect(shouldRepairPiApiKeyCodexProvider({
      providerType: 'pi',
      piAuthProvider: 'openai-codex',
      authType: 'api_key_with_endpoint',
    })).toBe(true)
  })

  it('does not repair OAuth openai-codex connections', () => {
    expect(shouldRepairPiApiKeyCodexProvider({
      providerType: 'pi',
      piAuthProvider: 'openai-codex',
      authType: 'oauth',
    })).toBe(false)
  })

  it('does not repair non-OpenAI-Codex providers', () => {
    expect(shouldRepairPiApiKeyCodexProvider({
      providerType: 'pi',
      piAuthProvider: 'openai',
      authType: 'api_key',
    })).toBe(false)
  })
})

describe('inferModelSelectionMode', () => {
  it('infers automaticallySyncedFromProvider when model list equals provider defaults', () => {
    const providerDefaults = ['pi/zai-best', 'pi/zai-balanced', 'pi/zai-fast']
    const mode = inferModelSelectionMode({ models: [...providerDefaults] }, providerDefaults)
    expect(mode).toBe('automaticallySyncedFromProvider')
  })

  it('infers userDefined3Tier when model list is a custom subset', () => {
    const providerDefaults = ['pi/zai-best', 'pi/zai-balanced', 'pi/zai-fast', 'pi/zai-extra']
    const mode = inferModelSelectionMode({ models: ['pi/zai-best', 'pi/zai-fast', 'pi/zai-extra'] }, providerDefaults)
    expect(mode).toBe('userDefined3Tier')
  })

  it('infers automaticallySyncedFromProvider for empty model lists', () => {
    const providerDefaults = ['pi/zai-best', 'pi/zai-balanced', 'pi/zai-fast']
    const mode = inferModelSelectionMode({ models: [] }, providerDefaults)
    expect(mode).toBe('automaticallySyncedFromProvider')
  })
})

describe('isLegacyKimiCodingDefaultSelection', () => {
  const baseConnection = {
    providerType: 'pi' as const,
    piAuthProvider: 'kimi-coding',
  }

  it('recognizes prefixed, bare, and duplicate forms of the old singleton catalog', () => {
    expect(isLegacyKimiCodingDefaultSelection({
      ...baseConnection,
      models: ['pi/kimi-for-coding'],
    })).toBe(true)
    expect(isLegacyKimiCodingDefaultSelection({
      ...baseConnection,
      models: ['kimi-for-coding'],
    })).toBe(true)
    expect(isLegacyKimiCodingDefaultSelection({
      ...baseConnection,
      models: ['pi/kimi-for-coding', 'pi/kimi-for-coding', 'pi/kimi-for-coding'],
    })).toBe(true)
  })

  it('rejects real custom selections and non-Kimi providers', () => {
    expect(isLegacyKimiCodingDefaultSelection({
      ...baseConnection,
      models: ['pi/kimi-for-coding-highspeed'],
    })).toBe(false)
    expect(isLegacyKimiCodingDefaultSelection({
      ...baseConnection,
      models: ['pi/kimi-for-coding', 'pi/kimi-for-coding-highspeed'],
    })).toBe(false)
    expect(isLegacyKimiCodingDefaultSelection({
      providerType: 'pi',
      piAuthProvider: 'openrouter',
      models: ['pi/kimi-for-coding'],
    })).toBe(false)
  })
})
