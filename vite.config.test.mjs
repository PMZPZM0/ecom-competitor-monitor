import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Vite ignores generated release output instead of reloading the app', async () => {
  const config = await readFile(new URL('./vite.config.ts', import.meta.url), 'utf8')

  for (const pattern of ['**/output/**', '**/dist/**', '**/.git/**']) {
    assert.ok(config.includes(`'${pattern}'`), `expected Vite to ignore ${pattern}`)
  }
})
