#!/usr/bin/env node

import { appendFile } from 'node:fs/promises'

const token = process.env.GITHUB_TOKEN
const repository = process.env.GITHUB_REPOSITORY
const runId = process.env.GITHUB_RUN_ID
if (!token || !repository || !runId) throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_RUN_ID are required')
const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}/approvals`, {
  headers: {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'omdsh-hub-automation',
    'x-github-api-version': '2022-11-28'
  }
})
const data = await response.json().catch(() => null)
if (!response.ok) throw new Error(`GitHub environment approval lookup failed (${response.status})`)
const approvals = Array.isArray(data) ? data : data?.reviews || []
const approved = approvals.filter((review) => String(review.state || review.status).toLowerCase() === 'approved')
const reviewer = approved.at(-1)?.user?.login || approved.at(-1)?.reviewer?.login
if (!reviewer) throw new Error('the trusted verification run has no identifiable environment approver')
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `reviewer=${reviewer}\n`)
console.log(reviewer)
