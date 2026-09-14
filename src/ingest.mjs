import { selectShadowAudits } from './shadow-audit.mjs';

const BATCH_SIZE = 2;

export async function checkExistingCandidates(candidates, { siteUrl, secret }) {
  if (!siteUrl || !secret) throw new Error('missing_ingest_configuration');
  const response = await fetch(new URL('/api/ingest/existing', siteUrl).href, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'inven', candidates: candidates.map(({ sourcePostId, sourceUrl }) => ({ sourcePostId, sourceUrl })) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('site_existing_' + response.status);
  const result = await response.json();
  if (!Array.isArray(result.existing)) throw new Error('invalid_existing_response');
  return result.existing.filter((value) => typeof value === 'string');
}

export async function sendToSite(candidates, { siteUrl, secret, runId }) {
  if (!siteUrl || !secret) throw new Error('missing_ingest_configuration');
  const endpoint = new URL('/api/ingest', siteUrl).href;
  const totals = { processed: 0, accepted: 0, review: 0, rejected: 0, duplicate: 0, failed: 0 };
  const transportErrors = [];
  const resultRows = [];
  for (let index = 0; index < candidates.length; index += BATCH_SIZE) {
    const batch = candidates.slice(index, index + BATCH_SIZE);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
        body: JSON.stringify({ candidates: batch }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        totals.failed += batch.length;
        transportErrors.push('site_' + response.status);
        for (const candidate of batch) resultRows.push({ sourcePostId: candidate.sourcePostId, status: 'failed', reason: 'site_' + response.status });
        continue;
      }
      const result = await response.json();
      totals.processed += Number(result.processed ?? 0);
      for (const key of ['accepted', 'review', 'rejected', 'duplicate', 'failed']) totals[key] += Number(result[key] ?? 0);
      if (Array.isArray(result.results)) resultRows.push(...result.results);
    } catch {
      totals.failed += batch.length;
      transportErrors.push('site_request_failed');
      for (const candidate of batch) resultRows.push({ sourcePostId: candidate.sourcePostId, status: 'failed', reason: 'site_request_failed' });
    }
  }
  const shadow = selectShadowAudits(candidates, resultRows, runId);
  const shadowTotals = {
    shadowEligible: shadow.eligibleCount,
    shadowSampled: shadow.sampledCount,
    shadowStored: 0,
    shadowErrors: 0,
    shadowMediaExtracted: shadow.audits.reduce((sum, audit) => sum + Number(audit.mediaCount || 0), 0),
  };
  if (shadow.audits.length) {
    try {
      const shadowResponse = await fetch(new URL('/api/ingest/shadow-audit', siteUrl).href, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
        body: JSON.stringify({ audits: shadow.audits }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!shadowResponse.ok) {
        shadowTotals.shadowErrors += shadow.audits.length;
        console.error(JSON.stringify({ type: 'shadow_audit_failed', status: shadowResponse.status, sampled: shadow.audits.length }));
      } else {
        const shadowResult = await shadowResponse.json();
        shadowTotals.shadowStored = Number(shadowResult.stored ?? 0);
        shadowTotals.shadowErrors += Number(shadowResult.invalid ?? 0) + Number(shadowResult.errors ?? 0);
      }
    } catch (error) {
      shadowTotals.shadowErrors += shadow.audits.length;
      console.error(JSON.stringify({ type: 'shadow_audit_failed', error: error instanceof Error ? error.message : 'request_failed', sampled: shadow.audits.length }));
    }
  }
  return { ...totals, ...shadowTotals, transportErrors, resultRows };
}
