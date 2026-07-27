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

test('the QwenPaw toolbar tolerates installer fields from an older backend', async () => {
  const agent = await source('src/features/operations/OperationsAgentChat.tsx')
  assert.match(agent, /runtimeStatus\.installTask \|\| idleInstallTask/)
  assert.match(agent, /installDirectory \|\| workspace\.qwenPaw\.defaultInstallDirectory \|\| ''/)
  assert.match(agent, /String\(directory \|\| ''\)\.trim\(\)/)
})

test('switching pages keeps the QwenPaw conversation mounted without periodic workspace refreshes', async () => {
  const [app, agent] = await Promise.all([
    source('src/App.tsx'),
    source('src/features/operations/OperationsAgentChat.tsx'),
  ])

  assert.doesNotMatch(app, /setInterval\(refreshWhenVisible/)
  assert.match(agent, /hasLoadedRuntime\.current/)
  assert.match(agent, /title="打开当前安装目录"/)
  assert.doesNotMatch(agent, /runtimeStatus\.version\}\|\$\{workspace\.qwenPaw\.signature/)
})
