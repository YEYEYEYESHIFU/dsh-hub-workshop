#!/usr/bin/env node

const token = process.env.GITHUB_TOKEN
const repository = process.env.GITHUB_REPOSITORY
const branch = process.env.AUTOMATION_BRANCH
const title = process.env.AUTOMATION_TITLE
const body = process.env.AUTOMATION_BODY || ''
const base = process.env.AUTOMATION_BASE || 'main'
if (!token || !repository || !branch || !title) {
  throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY, AUTOMATION_BRANCH, and AUTOMATION_TITLE are required')
}

const headers = {
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'user-agent': 'omdsh-hub-automation',
  'x-github-api-version': '2022-11-28'
}
const api = `https://api.github.com/repos/${repository}`
async function request(path, init = {}) {
  const response = await fetch(`${api}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`GitHub ${init.method || 'GET'} ${path} failed (${response.status}): ${JSON.stringify(data).slice(0, 800)}`)
  return data
}

const pulls = await request(`/pulls?state=open&head=${encodeURIComponent(`${repository.split('/')[0]}:${branch}`)}&base=${encodeURIComponent(base)}`)
const pull = pulls[0] || await request('/pulls', {
  method: 'POST',
  body: JSON.stringify({ title, head: branch, base, body, draft: false })
})
console.log(pull.html_url)
