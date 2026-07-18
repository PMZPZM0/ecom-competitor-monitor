import assert from 'node:assert/strict'
import test from 'node:test'
import { overlongImagePrompt } from '../src/features/image-generation/imagePromptLimits.ts'

test('AI image prompt transfer accepts exact limits without truncation', () => {
  assert.equal(overlongImagePrompt('正'.repeat(4_000), '负'.repeat(2_000)), null)
})

test('AI image prompt transfer reports the overlong field instead of truncating it', () => {
  assert.deepEqual(overlongImagePrompt('正'.repeat(4_001)), {
    label: '正向提示词',
    length: 4_001,
    limit: 4_000,
  })
  assert.deepEqual(overlongImagePrompt('正常', '负'.repeat(2_001)), {
    label: '排除要求',
    length: 2_001,
    limit: 2_000,
  })
})
