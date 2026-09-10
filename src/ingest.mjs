const BATCH_SIZE = 2;

export async function sendToSite(candidates, { siteUrl, secret }) {
  if (!siteUrl || !secret) throw new Error('missing_ingest_configuration');
  const endpoint = new URL('/api/ingest', siteUrl).href;
  const totals = { processed: 0, accepted: 0, review: 0, rejected: 0, duplicate: 0, failed: 0 };
  const transportErrors = [];
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
        continue;
      }
      const result = await response.json();
      totals.processed += Number(result.processed ?? 0);
      for (const key of ['accepted', 'review', 'rejected', 'duplicate', 'failed']) totals[key] += Number(result[key] ?? 0);
    } catch {
      totals.failed += batch.length;
      transportErrors.push('site_request_failed');
    }
  }
  return { ...totals, transportErrors };
}
