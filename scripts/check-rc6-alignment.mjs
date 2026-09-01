#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const json = async (path) => JSON.parse(await readFile(resolve(ROOT, path), 'utf8'))
const [baseline, evidence, plan, review] = await Promise.all([
  json('official-baseline.json'),
  json('intake/reports/session-teleport@0.6.0-rc.2.rc6-alignment.json'),
  json('intake/plans/session-teleport@0.6.0-rc.2.json'),
  json('intake/reviews/session-teleport@0.6.0-rc.2.json'),
])
const errors = []
const requireFact = (condition, message) => { if (!condition) errors.push(message) }
const runtime = baseline.runtime

requireFact(evidence.schema === 'omdsh-workshop-rc6-alignment-evidence/v1', 'unsupported RC.6 alignment evidence schema')
requireFact(evidence.releaseId === 'session-teleport@0.6.0-rc.2', 'alignment evidence release coordinate changed')
requireFact(evidence.source?.ref === plan.source.ref && evidence.source?.ref === review.source.ref, 'alignment evidence is not bound to the reviewed fixed source')
requireFact(evidence.baseline?.package === runtime.package, 'alignment evidence runtime package differs from official baseline')
requireFact(evidence.baseline?.version === runtime.version, 'alignment evidence runtime version differs from official baseline')
requireFact(evidence.baseline?.integrity === runtime.integrity, 'alignment evidence runtime integrity differs from official baseline')
requireFact(plan.baseline?.package === runtime.package && plan.baseline?.version === runtime.version && plan.baseline?.integrity === runtime.integrity, 'typed plan is not exactly bound to official RC.6')
requireFact(evidence.fixedSourceRun?.testsPassed === 51 && evidence.fixedSourceRun?.testsFailed === 1 && evidence.fixedSourceRun?.status === 'failed', 'fixed-source RC.6 suite result changed')
requireFact(evidence.fixedSourceRun?.rootCause?.code === 'rc6-unknown-event-not-ignorable', 'RC.6 incompatibility root cause is missing')
requireFact(evidence.candidateFixValidation?.admissionEvidence === false, 'candidate-only fix must not become admission evidence')
requireFact(evidence.candidateFixValidation?.testsPassed === 52 && evidence.candidateFixValidation?.testsFailed === 0, 'candidate fix validation result changed')
requireFact(evidence.decision?.state === 'blocked-source-fix-required' && evidence.decision?.rc6Verified === false && evidence.decision?.registryEligible === false, 'Session Teleport must remain fail-closed')
requireFact(review.trustReview?.state === 'needs-fix', 'Session Teleport review must reflect the RC.6 source fix requirement')
requireFact(review.trustReview?.findings?.some((finding) => finding.severity === 'blocker' && finding.code === 'rc6-unknown-event-not-ignorable'), 'Session Teleport review is missing the RC.6 blocker')
requireFact(review.claims?.rc6Verified === false && review.admission?.state !== 'admitted', 'Session Teleport review grants unsupported RC.6 authority')

const secretPattern = /(?:github_pat_|\bgh[opusr]_[A-Za-z0-9_]{16,}|\bnpm_[A-Za-z0-9]{20,}|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b)/i
requireFact(!secretPattern.test(JSON.stringify(evidence)), 'RC.6 alignment evidence contains a credential-like value')
if (errors.length) throw new Error(errors.join('\n'))

console.log(`RC.6 alignment accepted: ${evidence.releaseId} fixed source ${evidence.fixedSourceRun.testsPassed}/${evidence.fixedSourceRun.testsPassed + evidence.fixedSourceRun.testsFailed}; candidate fixture ${evidence.candidateFixValidation.testsPassed}/${evidence.candidateFixValidation.testsPassed + evidence.candidateFixValidation.testsFailed}; admission remains blocked`)
