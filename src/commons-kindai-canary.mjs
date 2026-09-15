import { mkdir, writeFile } from 'node:fs/promises';
import {
  DEFAULT_CATEGORIES,
  collectKindaiCommons,
} from './sources/commons-kindai.mjs';
import { textQualityReplay } from './quality-replay.mjs';

const maxFiles = Math.min(50, Math.max(1, Number(process.env.COMMONS_MAX_FILES || 25)));
const maxPosts = Math.min(20, Math.max(1, Number(process.env.COMMONS_MAX_POSTS || 20)));
const maxMediaPerPost = Math.min(10, Math.max(1, Number(process.env.COMMONS_MAX_MEDIA || 10)));
const filesPerCategory = Math.min(50, Math.max(1, Number(process.env.COMMONS_FILES_PER_CATEGORY || 25)));
const categories = String(process.env.COMMONS_CATEGORIES || DEFAULT_CATEGORIES.join('|'))
  .split('|').map((value) => value.trim()).filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probeMedia(url) {
  let lastStatus = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': 'YakhuArchiveCrawler/0.1 (Commons bounded canary; media probe)',
          range: 'bytes=0-2047',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
      lastStatus = response.status;
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(Math.min(30_000, Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 750 * (2 ** attempt)));
        continue;
      }
      if (response.body) await response.body.cancel().catch(() => {});
      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length'),
      };
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
      await sleep(Math.min(30_000, 750 * (2 ** attempt)));
    }
  }
  return { ok: false, status: lastStatus, contentType: null, contentLength: null };
}

function decisionFor(candidate) {
  if (!candidate.mediaUrls.length) return { decision: 'UNSUPPORTED', reason: 'media_missing' };
  return textQualityReplay(candidate.title, candidate.bodyText);
}

const collected = await collectKindaiCommons({
  categories,
  filesPerCategory,
  maxPosts,
  maxMediaPerPost,
});

const results = collected.candidates.map((candidate) => {
  const gate = decisionFor(candidate);
  return {
    sourcePostId: candidate.sourcePostId,
    sourceUrl: candidate.sourceUrl,
    title: candidate.title,
    bodySummary: candidate.bodyText.slice(0, 400),
    eventDate: candidate.eventDate,
    depictedPerson: candidate.depictedPerson,
    mediaCount: candidate.mediaUrls.length,
    mediaTypes: candidate.mediaMetadata.map((file) => file.mime?.startsWith('video/') ? 'video' : 'image'),
    mediaUrls: candidate.mediaUrls,
    originalMediaUrls: candidate.mediaMetadata.map((file) => file.directMediaUrl),
    licenseVerified: candidate.mediaMetadata.every((file) => file.licenseVerified),
    attributionComplete: candidate.attributionComplete,
    attribution: candidate.mediaMetadata.map((file) => ({
      pageid: file.pageid,
      fileTitle: file.fileTitle,
      canonicalFileUrl: file.canonicalFileUrl,
      author: file.author,
      license: file.license,
      licenseVersion: file.licenseVersion,
      licenseUrl: file.licenseUrl,
      uploadTimestamp: file.uploadTimestamp,
      captureDate: file.captureDate,
      attributionText: file.attributionText,
      consentStatus: file.consentStatus,
    })),
    gateDecision: gate.decision.toUpperCase(),
    gateReason: gate.reason,
    manualClassification: 'PENDING_MEDIA_REVIEW',
  };
});

const probeEnabled = String(process.env.COMMONS_PROBE_MEDIA || '1') !== '0';
const mediaProbes = [];
if (probeEnabled) {
  for (const result of results) {
    const probe = await probeMedia(result.mediaUrls[0]);
    mediaProbes.push({ sourcePostId: result.sourcePostId, url: result.mediaUrls[0], ...probe });
    await sleep(900);
  }
}

const summary = {
  source: 'commons_kindai',
  api: 'https://commons.wikimedia.org/w/api.php',
  categories,
  maxFiles,
  filesPerCategory,
  maxPosts,
  maxMediaPerPost,
  mode: 'read_only_dry_run',
  categoryStats: collected.categoryStats,
  rawFiles: collected.rawFiles,
  metrics: {
    ...collected.metrics,
    candidates: results.length,
    detailSuccess: results.length,
    detailFailure: 0,
    mediaSuccess: results.filter((row) => row.mediaCount > 0).length,
    mediaFailure: results.filter((row) => row.mediaCount === 0).length,
    licenseVerified: results.filter((row) => row.licenseVerified).length,
    attributionComplete: results.filter((row) => row.attributionComplete).length,
    ACCEPT: results.filter((row) => row.gateDecision === 'ACCEPT').length,
    REVIEW: results.filter((row) => row.gateDecision === 'REVIEW').length,
    REJECT: results.filter((row) => row.gateDecision === 'REJECT').length,
    unsupported: results.filter((row) => row.gateDecision === 'UNSUPPORTED').length,
    errors: collected.metrics.errors,
    mediaProbeAttempted: mediaProbes.length,
    mediaProbeSuccess: mediaProbes.filter((probe) => probe.ok).length,
    mediaProbeFailures: mediaProbes.filter((probe) => !probe.ok).length,
    mediaProbe429: mediaProbes.filter((probe) => probe.status === 429).length,
  },
  results,
  mediaProbes,
  writeEndpointsCalled: false,
  productionIngestExecuted: false,
  note: 'This workflow never configures Site credentials and never calls ingest, DB, R2, publish, or mutation endpoints.',
};

await mkdir('diagnostic-output', { recursive: true });
await writeFile('diagnostic-output/commons-kindai-canary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, rawFiles: undefined, results: undefined }, null, 2));
