import { mkdir, writeFile } from 'node:fs/promises';
import { DEFAULT_CATEGORIES, collectKindaiCommons } from './sources/commons-kindai.mjs';
import { textQualityReplay } from './quality-replay.mjs';

const ingestMode = String(process.env.COMMONS_INGEST_MODE || 'new_only').trim().toLowerCase();
const maxPosts = Math.min(100, Math.max(1, Number(process.env.COMMONS_CANARY_MAX_POSTS || 15)));
const filesPerCategory = Math.min(600, Math.max(1, Number(process.env.COMMONS_FILES_PER_CATEGORY || 25)));
const maxMediaPerPost = Math.min(10, Math.max(1, Number(process.env.COMMONS_MAX_MEDIA || 10)));
const groupOffset = Math.max(0, Number(process.env.COMMONS_GROUP_OFFSET || 0));
const categories = String(process.env.COMMONS_CATEGORIES || DEFAULT_CATEGORIES.join('|'))
  .split('|').map((value) => value.trim()).filter(Boolean);
const siteUrl = String(process.env.YAKHU_SITE_URL || '').trim();
const secret = String(process.env.YAKHU_INGEST_SECRET || '').trim();

if (!siteUrl || !secret) throw new Error('missing_ingest_configuration');
if (!['baseline', 'new_only'].includes(ingestMode)) throw new Error('invalid_commons_ingest_mode');

const collected = await collectKindaiCommons({
  categories,
  filesPerCategory,
  maxPosts: Math.min(250, groupOffset + maxPosts + 20),
  maxMediaPerPost,
});

function assetForFile(file) {
  const mediaUrl = file.thumbnailUrl || file.directMediaUrl;
  return {
    identity: file.pageid ? `pageid:${file.pageid}` : `url:${file.canonicalFileUrl}`,
    pageid: file.pageid ? String(file.pageid) : null,
    fileTitle: file.fileTitle || null,
    canonicalFileUrl: file.canonicalFileUrl,
    uploadTimestamp: file.uploadTimestamp || null,
    mediaUrl,
    thumbnailUrl: mediaUrl,
  };
}

const endpoint = new URL('/api/ingest/commons-kindai', siteUrl).href;
const resultRows = [];
const transportErrors = [];

async function postJson(payload) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`site_${response.status}:${body.error || 'request_failed'}`);
  return body;
}

if (ingestMode === 'baseline') {
  const files = collected.rawFiles.map(assetForFile);
  for (let index = 0; index < files.length; index += 250) {
    try {
      resultRows.push(await postJson({ mode: 'baseline', files: files.slice(index, index + 250) }));
    } catch (error) {
      transportErrors.push(error instanceof Error ? error.message : 'site_request_failed');
    }
  }
} else {
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
    sourceAssets: candidate.mediaMetadata.map(assetForFile),
    category: candidate.category,
  }));
  for (let index = 0; index < candidates.length; index += 2) {
    const batch = candidates.slice(index, index + 2);
    try {
      const body = await postJson({ candidates: batch });
      if (Array.isArray(body.results)) resultRows.push(...body.results);
      else transportErrors.push('invalid_site_response');
    } catch (error) {
      transportErrors.push(error instanceof Error ? error.message : 'site_request_failed');
      for (const candidate of batch) resultRows.push({ sourcePostId: candidate.sourcePostId, status: 'failed', reason: 'site_request_failed' });
    }
  }
}

const eligibleCandidates = collected.candidates
  .filter((candidate) => candidate.depictedPerson && candidate.attributionComplete);
const selected = ingestMode === 'new_only'
  ? eligibleCandidates.slice(groupOffset, groupOffset + maxPosts)
  : [];
const gateRows = selected.map((candidate) => {
  const gate = textQualityReplay(candidate.title, candidate.bodyText);
  const result = resultRows.find((row) => row.sourcePostId === candidate.sourcePostId);
  return {
    sourcePostId: candidate.sourcePostId,
    sourceUrl: candidate.sourceUrl,
    title: candidate.title,
    depictedPerson: candidate.depictedPerson,
    mediaCount: candidate.mediaUrls.length,
    attributionComplete: candidate.attributionComplete,
    licensesVerified: candidate.mediaMetadata.every((file) => file.licenseVerified),
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
  mode: ingestMode,
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
  baselineResponses: ingestMode === 'baseline' ? resultRows : undefined,
  metrics: {
    postsAttempted: selected.length,
    accepted: count('accepted'),
    review: count('review'),
    rejected: count('rejected'),
    duplicate: count('duplicate'),
    skipped: count('skipped'),
    failed: count('failed') + gateRows.filter((row) => row.ingestStatus === 'missing_result').length,
    mediaAttempted: selected.reduce((sum, candidate) => sum + candidate.mediaUrls.length, 0),
    mediaStored: gateRows.reduce((sum, row) => sum + Number(row.storedMediaCount || 0), 0),
    attributionComplete: gateRows.filter((row) => row.attributionComplete && row.licensesVerified).length,
    errors: transportErrors,
  },
  transportErrors,
  writeEndpointsCalled: true,
  productionIngestExecuted: ingestMode === 'new_only',
  note: ingestMode === 'baseline'
    ? 'Baseline only: files were marked seen and no posts were created.'
    : 'NEW-ONLY manual ingest. No schedule or automatic backfill is used.',
};

await mkdir('diagnostic-output', { recursive: true });
await writeFile('diagnostic-output/commons-kindai-ingest.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  source: summary.source,
  mode: summary.mode,
  categories: summary.categories,
  collection: {
    rawFiles: summary.rawFiles,
    uniqueFiles: summary.uniqueFiles,
    groupedPosts: summary.groupedPosts,
    eligibleGroupedPosts: summary.eligibleGroupedPosts,
    remainingEligiblePosts: summary.remainingEligiblePosts,
  },
  selectedNamedPosts: summary.selectedNamedPosts,
  metrics: summary.metrics,
  transportErrors,
}, null, 2));
