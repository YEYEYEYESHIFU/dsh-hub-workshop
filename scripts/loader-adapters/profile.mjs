import { createRc6ProfileAdapter } from '../harness-adapters.mjs'

export async function createAdapter({ plan, sourceRoot, sourceCommit, previousSourceRoot, pnpmStoreRoot }) {
  return createRc6ProfileAdapter({
    plan,
    sourceRoot,
    sourceCommit,
    previousSourceRoot,
    previousSourceCommit: plan.updateFrom?.ref,
    pnpmStoreRoot
  })
}
