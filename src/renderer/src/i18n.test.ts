import { describe, expect, it } from 'vitest'
import { formatMessage, getInitialLocale, isLocale } from './i18n'

describe('renderer i18n', () => {
  it('accepts only supported locales', () => {
    expect(isLocale('zh-CN')).toBe(true)
    expect(isLocale('en-US')).toBe(true)
    expect(isLocale('fr-FR')).toBe(false)
  })

  it('prefers a persisted locale and falls back to the browser language', () => {
    expect(getInitialLocale({ getItem: () => 'zh-CN' }, 'en-US')).toBe('zh-CN')
    expect(getInitialLocale({ getItem: () => null }, 'zh-Hans')).toBe('zh-CN')
    expect(getInitialLocale({ getItem: () => null }, 'en-US')).toBe('en-US')
  })

  it('interpolates dynamic values without losing unknown placeholders', () => {
    expect(formatMessage('Added {count} materials to {name}.', { count: 3, name: 'Research' })).toBe('Added 3 materials to Research.')
    expect(formatMessage('Hello {name}.')).toBe('Hello {name}.')
  })
})
