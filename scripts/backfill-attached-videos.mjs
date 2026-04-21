#!/usr/bin/env node
/* eslint-disable */
/**
 * Backfill summary_json.videoPath on runs whose video was uploaded via
 * the pre-ae94a72 "Attach video only" flow — the one that wrote the file
 * to storage but never persisted the path on the run, leaving the Video
 * tab unable to render the player after the page was reloaded.
 *
 * Strategy:
 *   1. Pull every run whose summary_json is null, or whose
 *      summary_json->>'videoPath' is missing.
 *   2. For each, list `runs/<run-id>/` in the `artifacts` bucket and look
 *      for a `video.*` file (.webm / .mp4 / .mov).
 *   3. When found, merge `{ videoPath: '<path>', attachedOnly: true }`
 *      into summary_json. Dry-run by default — pass `--apply` to write.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/backfill-attached-videos.mjs
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/backfill-attached-videos.mjs --apply
 *
 * Safe to re-run. Runs that already have a videoPath are skipped.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in env.')
  process.exit(1)
}

const APPLY = process.argv.includes('--apply')
const BUCKET = 'artifacts'

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function main() {
  console.log(APPLY ? '⚙  APPLY mode — rows will be updated.' : '🔍 DRY RUN — no writes. Pass --apply to commit.')
  console.log('')

  // Pull every run that is missing summary_json.videoPath. We fetch in
  // pages of 1000 to avoid a single massive query on large projects.
  const candidates = []
  const pageSize = 1000
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('runs')
      .select('id, summary_json, doc_page_id, created_at')
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1)
    if (error) {
      console.error('Error querying runs:', error.message)
      process.exit(1)
    }
    if (!data || data.length === 0) break
    for (const row of data) {
      const vp = row.summary_json?.videoPath
      if (!vp) candidates.push(row)
    }
    if (data.length < pageSize) break
    from += pageSize
  }

  console.log(`Found ${candidates.length} run(s) without summary_json.videoPath.`)
  console.log('')

  let fixed = 0
  let skippedNoFile = 0
  let skippedNoPage = 0
  let failed = 0

  for (const run of candidates) {
    // Only fix runs linked to a page — orphaned runs are noise we don't want
    // to surface. If you need to backfill those too, drop this guard.
    if (!run.doc_page_id) {
      skippedNoPage++
      continue
    }

    const prefix = `runs/${run.id}`
    const { data: files, error: listErr } = await supabase.storage
      .from(BUCKET)
      .list(prefix, { limit: 50 })

    if (listErr) {
      console.warn(`  [${run.id}] list failed: ${listErr.message}`)
      failed++
      continue
    }

    const videoFile = (files ?? []).find((f) =>
      /^video\.(webm|mp4|mov)$/i.test(f.name),
    )

    if (!videoFile) {
      skippedNoFile++
      continue
    }

    const videoPath = `${prefix}/${videoFile.name}`
    const nextSummary = {
      ...(run.summary_json ?? {}),
      videoPath,
      attachedOnly: true,
    }

    console.log(`  [${run.id}] → ${videoPath}`)

    if (APPLY) {
      const { error: upErr } = await supabase
        .from('runs')
        .update({
          summary_json: nextSummary,
          updated_at: new Date().toISOString(),
        })
        .eq('id', run.id)
      if (upErr) {
        console.warn(`    update failed: ${upErr.message}`)
        failed++
        continue
      }
    }
    fixed++
  }

  console.log('')
  console.log('Summary:')
  console.log(`  Fixed:              ${fixed}${APPLY ? '' : ' (dry run)'}`)
  console.log(`  Skipped (no file):  ${skippedNoFile}`)
  console.log(`  Skipped (no page):  ${skippedNoPage}`)
  console.log(`  Failed:             ${failed}`)
  if (!APPLY && fixed > 0) {
    console.log('')
    console.log('Re-run with --apply to commit the changes.')
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
