const siteUrl = process.env.YAKHU_SITE_URL;
const secret = process.env.YAKHU_INGEST_SECRET;
const limit = Math.min(50, Math.max(1, Number(process.env.MAINTENANCE_LIMIT || 25)));
if (!siteUrl || !secret) throw new Error('missing_maintenance_configuration');
const endpoint = new URL('/api/admin/maintenance', siteUrl);
endpoint.searchParams.set('limit', String(limit));
const response = await fetch(endpoint, {
  method: 'POST',
  headers: { authorization: `Bearer ${secret}` },
  signal: AbortSignal.timeout(60_000),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(`maintenance_${response.status}`);
console.log(JSON.stringify(body));
