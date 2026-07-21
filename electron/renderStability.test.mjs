import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('high-frequency page switches do not depend on runtime lazy module downloads', async () => {
  const [app, productCard] = await Promise.all([
    source('src/App.tsx'),
    source('src/features/products/ProductMonitorCard.tsx'),
  ])

  assert.doesNotMatch(app, /\blazy\s*\(|<Suspense/)
  assert.match(app, /import \{ PromptWorkbench \} from '.\/features\/prompt-studio\/PromptWorkbench'/)
  assert.doesNotMatch(productCard, /\blazy\s*\(|<Suspense/)
  assert.match(productCard, /import \{ SkuPriceTrend \} from '.\/SkuPriceTrend'/)
})

test('the React root has a recoverable application error boundary', async () => {
  const [main, boundary] = await Promise.all([
    source('src/main.tsx'),
    source('src/components/AppErrorBoundary.tsx'),
  ])

  assert.match(main, /<AppErrorBoundary>/)
  assert.match(boundary, /getDerivedStateFromError/)
  assert.match(boundary, /window\.location\.reload\(\)/)
  assert.match(boundary, /ACTIVE_PAGE_KEY, 'monitoring'/)
})
