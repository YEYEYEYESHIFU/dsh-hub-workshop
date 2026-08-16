import { createSkillStaticAdapter } from '../harness-adapters.mjs'

export async function createAdapter({ plan, sourceRoot, sourceCommit }) {
  return createSkillStaticAdapter({ plan, sourceRoot, sourceCommit })
}
