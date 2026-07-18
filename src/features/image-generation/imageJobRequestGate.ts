import type { ImageGenerationJob } from '../../types/domain'

export function createLatestRequestGate() {
  let revision = 0
  return {
    begin() {
      revision += 1
      return revision
    },
    invalidate() {
      revision += 1
    },
    isCurrent(candidate: number) {
      return candidate === revision
    },
  }
}

export function newlySucceededJobs(previousJobs: ImageGenerationJob[], incoming: ImageGenerationJob[], hydrated: boolean) {
  if (!hydrated) return []
  const previous = new Map(previousJobs.map((job) => [job.id, job.status]))
  return incoming.filter((job) => job.status === 'succeeded' && previous.get(job.id) !== 'succeeded' && job.result?.images.length)
}
