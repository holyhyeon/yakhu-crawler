const EXPECTED_SKIP_REASONS = new Set([
  'media_url_missing',
  'unsupported_embed',
  'source_deleted',
  'original_unavailable',
  'unsupported_or_nonbeneficial',
]);

function increment(map, key) {
  const normalized = String(key || 'unknown').slice(0, 120);
  map[normalized] = (map[normalized] || 0) + 1;
}

function categoryGroups(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const category = String(candidate.category || '기타').trim() || '기타';
    const group = groups.get(category) || [];
    group.push(candidate);
    groups.set(category, group);
  }
  if (!groups.size) groups.set('기타', []);
  return groups;
}

function countRows(rows, candidates, crawlMetrics) {
  const ids = new Set(candidates.map((candidate) => candidate.sourcePostId));
  const scoped = rows.filter((row) => !row.sourcePostId || ids.has(row.sourcePostId));
  const breakdown = { rejected: {}, skipped: {}, errors: {} };
  let accepted = 0;
  let review = 0;
  let rejected = 0;
  let duplicate = 0;
  let unsupported = candidates.filter((candidate) => !Array.isArray(candidate.mediaUrls) || candidate.mediaUrls.length === 0).length;
  let expectedUnsupportedRows = 0;
  let errors = Number(crawlMetrics.detailFailure || 0) + Number(crawlMetrics.pageFailures || 0);
  for (const row of scoped) {
    if (row.status === 'accepted') accepted += 1;
    else if (row.status === 'review') review += 1;
    else if (row.status === 'rejected') { rejected += 1; increment(breakdown.rejected, row.reason); }
    else if (row.status === 'duplicate') duplicate += 1;
    else if (row.status === 'failed') {
      if (EXPECTED_SKIP_REASONS.has(row.reason)) { expectedUnsupportedRows += 1; increment(breakdown.skipped, row.reason); }
      else { errors += 1; increment(breakdown.errors, row.reason); }
    }
  }
  return { accepted, review, rejected, duplicate, unsupported: Math.max(unsupported, expectedUnsupportedRows, 0), errors, breakdown, ingestAttempted: scoped.length };
}

export async function reportFunnel({ source, candidates, crawlMetrics, ingest, siteUrl, secret, startedAt, finishedAt, sourceError }) {
  if (!siteUrl || !secret) return { reported: false, error: 'missing_ingest_configuration' };
  const endpoint = new URL('/api/ingest/metrics', siteUrl).href;
  const reports = [];
  for (const [category, group] of categoryGroups(candidates)) {
    const result = countRows(ingest?.resultRows || [], group, crawlMetrics || {});
    const discovered = categoryGroups(candidates).size === 1
      ? Number(crawlMetrics?.discovered ?? group.length)
      : group.length;
    const payload = {
      runId: crypto.randomUUID(), source, category, startedAt, finishedAt,
      discovered, detailFetched: group.length, mediaExtracted: group.filter((candidate) => Array.isArray(candidate.mediaUrls) && candidate.mediaUrls.length > 0).length,
      ingestAttempted: result.ingestAttempted, accepted: result.accepted, review: result.review, rejected: result.rejected,
      published: result.accepted, duplicate: result.duplicate, unsupported: result.unsupported,
      errors: result.errors + (sourceError ? 1 : 0),
      breakdown: sourceError ? { ...result.breakdown, errors: { ...result.breakdown.errors, source: sourceError } } : result.breakdown,
    };
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('metrics_' + response.status);
    reports.push({ category, status: 'recorded', errors: payload.errors });
  }
  return { reported: true, reports };
}
