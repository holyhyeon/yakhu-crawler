import { mkdir, writeFile } from 'node:fs/promises';
import { DEFAULT_CATEGORIES, collectKindaiCommons } from './sources/commons-kindai.mjs';
import { textQualityReplay } from './quality-replay.mjs';

const maxPosts = Math.min(100, Math.max(1, Number(process.env.COMMONS_CANARY_MAX_POSTS || 15)));
const filesPerCategory = Math.min(600, Math.max(1, Number(process.env.COMMONS_FILES_PER_CATEGORY || 25)));
const maxMediaPerPost = Math.min(10, Math.max(1, Number(process.env.COMMONS_MAX_MEDIA || 10)));
const groupOffset = Math.max(0, Number(process.env.COMMONS_GROUP_OFFSET || 0));
const categories = String(process.env.COMMONS_CATEGORIES || DEFAULT_CATEGORIES.join('|'))
  .split('|').map((value) => value.trim()).filter(Boolean);
const siteUrl = String(process.env.YAKHU_SITE_URL || '').trim();
const secret = String(process.env.YAKHU_INGEST_SECRET || '').trim();

if (!siteUrl || !secret) throw new Error('missing_ingest_configuration');

const collected = await collectKindaiCommons({
  categories,
  filesPerCategory,
  // Collect a small cushion because unknown-person groups are intentionally excluded.
  maxPosts: Math.min(250, groupOffset + maxPosts + 20),
  maxMediaPerPost,
});

const eligibleCandidates = collected.candidates
  .filter((candidate) => candidate.depictedPerson && candidate.attributionComplete);
const selected = eligibleCandidates.slice(groupOffset, groupOffset + maxPosts);

const candidates = selected.map((candidate) => ({
  source: candidate.source,
  sourcePostId: candidate.sourcePostId,
  sourceUrl: candidate.sourceUrl,
  title: candidate.title,
  bodyText: candidate.bodyText,
  publishedAt: null,
  mediaUrls: candidate.mediaUrls,
  category: candidate.category,
}));

const endpoint = new URL('/api/ingest', siteUrl).href;
const resultRows = [];
const transportErrors = [];
for (let index = 0; index < candidates.length; index += 2) {
  const batch = candidates.slice(index, index + 2);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ candidates: batch }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      transportErrors.push(`site_${response.status}`);
      for (const candidate of batch) resultRows.push({
        sourcePostId: candidate.sourcePostId,
        status: 'failed',
        reason: `site_${response.status}`,
      });
      continue;
    }
    if (Array.isArray(body.results)) resultRows.push(...body.results);
    else transportErrors.push('invalid_site_response');
  } catch (error) {
    transportErrors.push(error instanceof Error ? error.message : 'site_request_failed');
    for (const candidate of batch) resultRows.push({
      sourcePostId: candidate.sourcePostId,
      status: 'failed',
      reason: 'site_request_failed',
    });
  }
}

const gateRows = selected.map((candidate) => {
  const gate = textQualityReplay(candidate.title, candidate.bodyText);
  const result = resultRows.find((row) => row.sourcePostId === candidate.sourcePostId);
  return {
    sourcePostId: candidate.sourcePostId,
    sourceUrl: candidate.sourceUrl,
    title: candidate.title,
    depictedPerson: candidate.depictedPerson,
    mediaCount: candidate.mediaUrls.length,
    mediaTypes: candidate.mediaMetadata.map((file) => file.mime?.startsWith('video/') ? 'video' : 'image'),
    attributionComplete: candidate.attributionComplete,
    licensesVerified: candidate.mediaMetadata.every((file) => file.licenseVerified),
    attribution: candidate.mediaMetadata.map((file) => ({
      pageid: file.pageid,
      fileTitle: file.fileTitle,
      canonicalFileUrl: file.canonicalFileUrl,
      directMediaUrl: file.directMediaUrl,
      author: file.author,
      license: file.license,
      licenseVersion: file.licenseVersion,
      licenseUrl: file.licenseUrl,
      attributionText: file.attributionText,
      captureDate: file.captureDate,
      uploadTimestamp: file.uploadTimestamp,
    })),
    gateDecision: gate.decision.toUpperCase(),
    gateReason: gate.reason,
    ingestStatus: result?.status || 'missing_result',
    ingestReason: result?.reason || null,
    ingestPostId: result?.postId || null,
    storedMediaCount: result?.mediaCount || 0,
  };
});

const count = (status) => resultRows.filter((row) => row.status === status).length;
const summary = {
  source: 'commons_kindai',
  mode: 'manual_bounded_ingest',
  categories,
  filesPerCategory,
  maxPosts,
  groupOffset,
  maxMediaPerPost,
  categoryStats: collected.categoryStats,
  rawFiles: collected.metrics.rawFiles,
  uniqueFiles: collected.metrics.uniqueFiles,
  groupedPosts: collected.metrics.groupedPosts,
  eligibleGroupedPosts: eligibleCandidates.length,
  remainingEligiblePosts: Math.max(0, eligibleCandidates.length - groupOffset - selected.length),
  selectedNamedPosts: selected.length,
  groupedMedia: selected.reduce((sum, candidate) => sum + candidate.mediaUrls.length, 0),
  results: gateRows,
  metrics: {
    postsAttempted: candidates.length,
    accepted: count('accepted'),
    review: count('review'),
    rejected: count('rejected'),
    duplicate: count('duplicate'),
    failed: count('failed') + gateRows.filter((row) => row.ingestStatus === 'missing_result').length,
    mediaAttempted: selected.reduce((sum, candidate) => sum + candidate.mediaUrls.length, 0),
    mediaStored: gateRows.reduce((sum, row) => sum + Number(row.storedMediaCount || 0), 0),
    attributionComplete: gateRows.filter((row) => row.attributionComplete && row.licensesVerified).length,
    errors: [...transportErrors, ...collected.categoryStats.filter((row) => row.errors).map((row) => row.error || 'commons_collection_error')],
  },
  transportErrors,
  writeEndpointsCalled: true,
  productionIngestExecuted: true,
  note: 'Manual bounded canary only. No schedule, shadow-audit, maintenance, or other mutation endpoint is used.',
};

await mkdir('diagnostic-output', { recursive: true });
await writeFile('diagnostic-output/commons-kindai-ingest.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  source: summary.source,
  mode: summary.mode,
  categories: summary.categories,
  categoryStats: summary.categoryStats,
  filesPerCategory: summary.filesPerCategory,
  maxPosts: summary.maxPosts,
  groupOffset: summary.groupOffset,
  collection: {
    rawFiles: summary.rawFiles,
    uniqueFiles: summary.uniqueFiles,
    groupedPosts: summary.groupedPosts,
    eligibleGroupedPosts: summary.eligibleGroupedPosts,
    remainingEligiblePosts: summary.remainingEligiblePosts,
  },
  selectedNamedPosts: summary.selectedNamedPosts,
  metrics: summary.metrics,
  results: summary.results.map(({ sourcePostId, depictedPerson, gateDecision, ingestStatus, storedMediaCount }) => ({
    sourcePostId, depictedPerson, gateDecision, ingestStatus, storedMediaCount,
  })),
}, null, 2));
