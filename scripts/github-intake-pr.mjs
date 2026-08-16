#!/usr/bin/env node

const [command] = process.argv.slice(2)
const token = process.env.GITHUB_TOKEN
const repository = process.env.GITHUB_REPOSITORY
const issueNumber = process.env.ISSUE_NUMBER
const kind = process.env.INTAKE_KIND === 'distribution' ? 'distribution' : 'plugin'
if (!token || !repository || !issueNumber) throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY, and ISSUE_NUMBER are required')

const headers = {
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'user-agent': 'omdsh-workshop-intake',
  'x-github-api-version': '2022-11-28',
}

async function request(path, body) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(value.message || `GitHub HTTP ${response.status}`)
  return value
}

async function comment(body) {
  await request(`/issues/${issueNumber}/comments`, { body })
}

if (command === 'open') {
  const branch = process.env.INTAKE_BRANCH
  const recordId = process.env.INTAKE_RECORD_ID
  if (!branch || !recordId) throw new Error('INTAKE_BRANCH and INTAKE_RECORD_ID are required')
  const distribution = kind === 'distribution'
  const pull = await request('/pulls', {
    title: `Queue ${recordId} for ${distribution ? 'composition ' : ''}review`,
    head: branch,
    base: 'main',
    body: [
      `Automated pending-review ${distribution ? 'Distribution ' : ''}intake for #${issueNumber}.`,
      '',
      `- The public repository, immutable commit, and declared ${distribution ? 'manifest' : 'source'} path were checked without executing submitted code.`,
      distribution
        ? '- Every component already exists in the bound Registry snapshot; composition cannot elevate component authority.'
        : '- This PR does not approve the project and does not grant Registry installation authority.',
      `- This PR does not ${distribution ? 'approve the composition' : 'approve the project'} or grant new installation authority.`,
      `- Closes #${issueNumber} only after the PR is reviewed and merged.`,
    ].join('\n'),
  })
  await comment(`自动化预检已通过，并创建待审核 PR：${pull.html_url}\n\n这不会自动批准${distribution ? '整合包，且整合关系不会提升组件权限' : '项目，也不会授予 Registry 安装权限'}。`)
  console.log(pull.html_url)
} else if (command === 'failure') {
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
  await comment(`自动化${kind === 'distribution' ? '整合包' : '插件'}预检未通过，尚未创建待审核记录。请查看 [本次检查](${runUrl})，修正固定来源或清单后重新提交。`)
} else {
  throw new Error('usage: node scripts/github-intake-pr.mjs open|failure')
}
