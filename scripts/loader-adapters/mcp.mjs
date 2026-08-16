import { join } from 'node:path'

import { createMcpProcessAdapter } from '../harness-adapters.mjs'

export async function createAdapter({ plan, declaration, sourceRoot, sourceCommit }) {
  const testing = declaration.testing
  if (!testing?.entry) throw new Error('MCP automation requires package.json#dshWorkshop.testing.entry')
  return createMcpProcessAdapter({
    plan,
    sourceRoot,
    sourceCommit,
    args: [join(sourceRoot, testing.entry)],
    toolArguments: testing.arguments,
    failureToolName: testing.failureTool
  })
}
