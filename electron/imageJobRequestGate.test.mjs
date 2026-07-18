import assert from 'node:assert/strict'
import test from 'node:test'
import { clearImageJobOutbox, clearRequestOutbox, getOrCreateImageJobOutbox, getOrCreateRequestOutbox } from '../src/features/image-generation/imageJobOutbox.ts'
import { createLatestRequestGate, newlySucceededJobs } from '../src/features/image-generation/imageJobRequestGate.ts'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

function imageFile(content, name = 'source.png') {
  const blob = new Blob([content], { type: 'image/png' })
  return { name, size: blob.size, type: blob.type, lastModified: 10, arrayBuffer: () => blob.arrayBuffer() }
}

async function applyRead(gate, pending, apply) {
  const revision = gate.begin()
  const jobs = await pending
  if (gate.isCurrent(revision)) apply(jobs)
}

test('an older empty read cannot remove a job that was enqueued later', async () => {
  const gate = createLatestRequestGate()
  const oldRead = deferred()
  let jobs = []
  const pending = applyRead(gate, oldRead.promise, (next) => { jobs = next })

  gate.invalidate()
  jobs = [{ id: 'new-job', status: 'queued' }]
  oldRead.resolve([])
  await pending

  assert.deepEqual(jobs, [{ id: 'new-job', status: 'queued' }])
})

test('an older running response cannot roll a newer succeeded response back', async () => {
  const gate = createLatestRequestGate()
  const oldRead = deferred()
  let jobs = []
  const pendingOld = applyRead(gate, oldRead.promise, (next) => { jobs = next })
  await applyRead(gate, Promise.resolve([{ id: 'same-job', status: 'succeeded' }]), (next) => { jobs = next })

  oldRead.resolve([{ id: 'same-job', status: 'running' }])
  await pendingOld

  assert.deepEqual(jobs, [{ id: 'same-job', status: 'succeeded' }])
})

test('a completed job image survives an older initial library response', async () => {
  const libraryGate = createLatestRequestGate()
  const oldLibraryRead = deferred()
  let library = []
  const pendingOld = applyRead(libraryGate, oldLibraryRead.promise, (next) => { library = next })

  libraryGate.invalidate()
  library = [{ id: 'fresh-image' }]
  oldLibraryRead.resolve([])
  await pendingOld

  assert.deepEqual(library, [{ id: 'fresh-image' }])
})

test('a failed response retry reuses the same client request id', async () => {
  const storage = memoryStorage()
  const request = { prompt: 'product', ratio: '1:1', resolution: '1k', quality: 'medium', format: 'png', background: 'auto', count: 1 }
  const files = { referenceImages: [imageFile('same image')] }
  const first = await getOrCreateImageJobOutbox(storage, request, files, 1_000, () => 'request-1')
  const retry = await getOrCreateImageJobOutbox(storage, request, files, 2_000, () => 'request-2')

  assert.equal(first.key, 'request-1')
  assert.equal(retry.key, 'request-1')

  clearImageJobOutbox(storage, first.key)
  const next = await getOrCreateImageJobOutbox(storage, request, files, 3_000, () => 'request-3')
  assert.equal(next.key, 'request-3')
})

test('same file metadata with different content cannot collide', async () => {
  const storage = memoryStorage()
  const request = { prompt: 'product', ratio: '1:1', resolution: '1k', quality: 'medium', format: 'png', background: 'auto', count: 1 }
  await getOrCreateImageJobOutbox(storage, request, { referenceImages: [imageFile('content-a')] }, 1_000, () => 'request-1')
  const changed = await getOrCreateImageJobOutbox(storage, request, { referenceImages: [imageFile('content-b')] }, 2_000, () => 'request-2')

  assert.equal(changed.key, 'request-2')
})

test('same file content with a different name and timestamp reuses the pending id', async () => {
  const storage = memoryStorage()
  const request = { prompt: 'product', ratio: '1:1', resolution: '1k', quality: 'medium', format: 'png', background: 'auto', count: 1 }
  const firstFile = imageFile('same-content', 'first.png')
  const secondFile = { ...imageFile('same-content', 'renamed.png'), lastModified: 999_999 }
  const first = await getOrCreateImageJobOutbox(storage, request, { referenceImages: [firstFile] }, 1_000, () => 'request-1')
  const retry = await getOrCreateImageJobOutbox(storage, request, { referenceImages: [secondFile] }, 2_000, () => 'request-2')

  assert.equal(retry.key, first.key)
})

test('reference image order remains part of the request signature', async () => {
  const storage = memoryStorage()
  const request = { prompt: 'product', ratio: '1:1', resolution: '1k', quality: 'medium', format: 'png', background: 'auto', count: 1 }
  const first = imageFile('first')
  const second = imageFile('second')
  await getOrCreateImageJobOutbox(storage, request, { referenceImages: [first, second] }, 1_000, () => 'request-1')
  const reordered = await getOrCreateImageJobOutbox(storage, request, { referenceImages: [second, first] }, 2_000, () => 'request-2')

  assert.equal(reordered.key, 'request-2')
})

test('multiple uncertain submissions keep independent pending ids', async () => {
  const storage = memoryStorage()
  const base = { ratio: '1:1', resolution: '1k', quality: 'medium', format: 'png', background: 'auto', count: 1 }
  const first = await getOrCreateImageJobOutbox(storage, { ...base, prompt: 'first' }, {}, 1_000, () => 'request-1')
  const second = await getOrCreateImageJobOutbox(storage, { ...base, prompt: 'second' }, {}, 2_000, () => 'request-2')
  const firstRetry = await getOrCreateImageJobOutbox(storage, { ...base, prompt: 'first' }, {}, 3_000, () => 'request-3')

  assert.equal(firstRetry.key, first.key)
  clearImageJobOutbox(storage, first.key, 4_000)
  const secondRetry = await getOrCreateImageJobOutbox(storage, { ...base, prompt: 'second' }, {}, 5_000, () => 'request-4')
  assert.equal(secondRetry.key, second.key)
})

test('storage-unavailable retries reuse the in-memory pending id', async () => {
  const request = { prompt: 'memory-only', ratio: '1:1', resolution: '1k', quality: 'medium', format: 'png', background: 'auto', count: 1 }
  const first = await getOrCreateImageJobOutbox(null, request, {}, 10_000, () => 'memory-1')
  const retry = await getOrCreateImageJobOutbox(null, request, {}, 11_000, () => 'memory-2')
  assert.equal(retry.key, first.key)
  clearImageJobOutbox(null, first.key, 12_000)
})

test('prompt enhancement retries reuse their id without colliding with image jobs', async () => {
  const storage = memoryStorage()
  const promptStorageKey = 'prompt-enhancement-test'
  const request = { userRequest: 'keep the product unchanged', creationMode: 'product', saveHistory: false }
  const files = { referenceImages: [imageFile('prompt-reference')] }
  const first = await getOrCreateRequestOutbox(storage, promptStorageKey, request, files, 1_000, () => 'prompt-1')
  const retry = await getOrCreateRequestOutbox(storage, promptStorageKey, request, files, 2_000, () => 'prompt-2')
  const image = await getOrCreateImageJobOutbox(storage, { ...request, prompt: 'image request' }, files, 3_000, () => 'image-1')

  assert.equal(retry.key, first.key)
  assert.equal(image.key, 'image-1')
  clearRequestOutbox(storage, promptStorageKey, first.key, 4_000)
  const next = await getOrCreateRequestOutbox(storage, promptStorageKey, request, files, 5_000, () => 'prompt-3')
  assert.equal(next.key, 'prompt-3')
})

test('only a newly completed job contributes fresh library images', () => {
  const completed = { id: 'job-1', status: 'succeeded', result: { images: [{ id: 'image-1' }] } }
  assert.deepEqual(newlySucceededJobs([], [completed], false), [])
  assert.deepEqual(newlySucceededJobs([{ id: 'job-1', status: 'running' }], [completed], true), [completed])
  assert.deepEqual(newlySucceededJobs([completed], [completed], true), [])
})
