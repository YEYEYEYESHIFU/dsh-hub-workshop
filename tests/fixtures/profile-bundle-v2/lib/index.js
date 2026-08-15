import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const harnessProfileProbe = (_ctx, config = {}) => {
  const root = process.env.OMDSH_HARNESS_PROBE_DIR
  if (!root) throw new Error('OMDSH_HARNESS_PROBE_DIR is required')
  const ready = { capability: 'profile-probe', version: '1.1.0', marker: config.marker || 'unset', pid: process.pid }
  writeFileSync(join(root, 'ready.json'), `${JSON.stringify(ready)}\n`, 'utf8')
  return () => {
    writeFileSync(join(root, 'disposed.json'), `${JSON.stringify({ version: '1.1.0', pid: process.pid })}\n`, 'utf8')
  }
}

export default harnessProfileProbe
