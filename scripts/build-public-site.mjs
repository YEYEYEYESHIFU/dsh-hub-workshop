#!/usr/bin/env node

import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TARGET = resolve(ROOT, '.public-site')
const FILES = [
  'api/v1/ecosystem.json',
  'api/v1/market.json',
  'api/v1/plugin-types.json',
  'api/v1/plugins.json',
  'agent-ecosystem-v1.json',
  'agent-submission-prompt.en.md',
  'agent-submission-prompt.zh.md',
  'assets/atlas-symbol.png',
  'assets/app.js',
  'assets/composition-preflight.js',
  'assets/configurations.js',
  'assets/discovery.js',
  'assets/distribution-studio.js',
  'assets/i18n.json',
  'assets/publish.js',
  'assets/site.js',
  'assets/styles.css',
  'assets/workshop-hero-v2.webp',
  'candidates-v1.json',
  'candidates.schema.json',
  'catalog.json',
  'catalog.schema.json',
  'collections-v1.json',
  'community-v1.json',
  'configurations.html',
  'contributing.html',
  'developer-guide.html',
  'distribution.schema.json',
  'ecosystem-repositories.json',
  'harness-plan.schema.json',
  'harness-report.schema.json',
  'index.html',
  'install.html',
  'intake-evidence.schema.json',
  'intake-queue.json',
  'intake.schema.json',
  'market-layers.json',
  'market-layers.schema.json',
  'official-baseline.json',
  'package-manifest.schema.json',
  'plugins.html',
  'projects.html',
  'publish.html',
  'public-discovery.json',
  'recipes-v1.json',
  'recipes.schema.json',
  'registry-v1.json',
  'registry.html',
  'run-records.json',
  'run-records.schema.json',
  'submission.schema.json',
  'topic-repositories.json',
  'topic-plugin-audit.json',
  'verification-inventory.json',
  'workshop-v1.json',
]

await rm(TARGET, { recursive: true, force: true })
for (const path of FILES) {
  const target = resolve(TARGET, path)
  await mkdir(dirname(target), { recursive: true })
  await cp(resolve(ROOT, path), target)
}
console.log(`built public site with ${FILES.length} allowlisted files`)
