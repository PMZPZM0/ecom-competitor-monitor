import assert from 'node:assert/strict'
import test from 'node:test'
import { createPromptGardenClient, PromptGardenError } from '../src/features/prompt-studio/promptGarden.ts'

function memoryStorage() {
  const values = new Map()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

function suggestionPayload() {
  return {
    items: [{
      id: 'garden-1',
      title: '电商产品场景图',
      summary: '生成真实的商品使用场景',
      tags: ['电商', '场景图'],
      categoryPath: ['电商设计', '场景图'],
      importCode: 'ZH-T2I-001',
      mode: 'image-text2image',
      thumbnailUrl: 'https://cdn.example/garden-1.webp',
      source: 'featured',
    }],
    browseUrl: 'https://garden.example/?type=image',
    nextExclude: ['ZH-T2I-001'],
    ttlSeconds: 60,
  }
}

function detailPayload(overrides = {}) {
  return {
    id: 'garden-1',
    importCode: 'ZH-T2I-001',
    schema: 'prompt-garden.prompt.v1',
    schemaVersion: 1,
    optimizerTarget: { subModeKey: 'image-text2image' },
    prompt: { format: 'text', text: '保留 {{product}} 的结构和文字。' },
    variables: [{ name: 'product', description: '商品名称', required: true, defaultValue: '水杯', options: [] }],
    meta: {
      title: '电商产品场景图',
      description: '生成真实的商品使用场景',
      tags: ['电商', '场景图'],
      author: 'Prompt Garden',
      source: '原创模板',
      sourceUrl: 'https://source.example/prompt',
      license: 'Source-specific license',
    },
    ...overrides,
  }
}

test('suggestions are parsed and cached in session storage for ttlSeconds', async () => {
  const storage = memoryStorage()
  let now = 1_000
  let calls = 0
  let requestedUrl = ''
  const client = createPromptGardenClient({
    baseUrl: 'https://garden.example',
    storage,
    now: () => now,
    fetch: async (url) => {
      calls += 1
      requestedUrl = String(url)
      return Response.json(suggestionPayload())
    },
  })

  const first = await client.getSuggestions('image-text2image')
  const cached = await client.getSuggestions('image-text2image')

  assert.equal(first.items[0].title, '电商产品场景图')
  assert.deepEqual(first.nextExclude, ['ZH-T2I-001'])
  assert.deepEqual(cached, first)
  assert.equal(calls, 1)
  assert.equal(storage.values.size, 1)
  assert.match(requestedUrl, /mode=image-text2image/)
  assert.match(requestedUrl, /limit=5/)
  assert.match(requestedUrl, /strategy=mixed/)
  assert.match(requestedUrl, /locale=zh-CN/)

  now += 60_001
  await client.getSuggestions('image-text2image')
  assert.equal(calls, 2)
})

test('detail strictly rejects prompts outside image-text2image', async () => {
  const client = createPromptGardenClient({
    baseUrl: 'https://garden.example',
    storage: null,
    fetch: async () => Response.json(detailPayload({ optimizerTarget: { subModeKey: 'basic-system' } })),
  })

  await assert.rejects(
    client.getPrompt('ZH-T2I-001'),
    (error) => error instanceof PromptGardenError && /只接受文生图/.test(error.message),
  )
})

test('detail stays out of storage and repeated reads hit the same client memory cache', async () => {
  const storage = memoryStorage()
  let calls = 0
  const client = createPromptGardenClient({
    baseUrl: 'https://garden.example',
    storage,
    fetch: async () => {
      calls += 1
      return Response.json(detailPayload(), { headers: { 'cache-control': 'public, max-age=300' } })
    },
  })

  const first = await client.getPrompt('ZH-T2I-001')
  const cached = await client.getPrompt('ZH-T2I-001')

  assert.equal(first.text, '保留 {{product}} 的结构和文字。')
  assert.equal(first.variables[0].name, 'product')
  assert.deepEqual(cached, first)
  assert.equal(calls, 1)
  assert.equal(storage.values.size, 0)
})

for (const status of [429, 503]) {
  test(`${status} retries once and then stops`, async () => {
    let calls = 0
    const client = createPromptGardenClient({
      baseUrl: 'https://garden.example',
      storage: null,
      fetch: async () => {
        calls += 1
        return new Response('{}', { status })
      },
    })

    await assert.rejects(
      client.getSuggestions('image-text2image'),
      (error) => error instanceof PromptGardenError && error.status === status,
    )
    assert.equal(calls, 2)
  })
}

test('ordinary 4xx and abort failures are not retried', async (context) => {
  await context.test('400', async () => {
    let calls = 0
    const client = createPromptGardenClient({
      baseUrl: 'https://garden.example',
      storage: null,
      fetch: async () => {
        calls += 1
        return new Response('{}', { status: 400 })
      },
    })

    await assert.rejects(client.getSuggestions('image-text2image'))
    assert.equal(calls, 1)
  })

  await context.test('abort', async () => {
    let calls = 0
    const client = createPromptGardenClient({
      baseUrl: 'https://garden.example',
      storage: null,
      timeoutMs: 5,
      fetch: async (_url, init) => {
        calls += 1
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        })
      },
    })

    await assert.rejects(client.getSuggestions('image-text2image'), /取消或超时/)
    assert.equal(calls, 1)
  })
})
