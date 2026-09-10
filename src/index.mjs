import { collectInven } from './sources/inven.mjs';
import { sendToSite } from './ingest.mjs';

const startedAt = Date.now();
const pages = process.env.CRAWL_PAGES || '3';
const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

if (!process.env.YAKHU_SITE_URL && !dryRun) {
  console.error('YAKHU_SITE_URL is required unless DRY_RUN is enabled');
  process.exitCode = 1;
} else {
  const crawl = await collectInven({ pages });
  const ingest = dryRun
    ? { processed: 0, accepted: 0, review: 0, rejected: 0, duplicate: 0, failed: 0, transportErrors: [] }
    : await sendToSite(crawl.candidates, {
        siteUrl: process.env.YAKHU_SITE_URL,
        secret: process.env.YAKHU_INGEST_SECRET,
      });
  const summary = {
    source: 'inven',
    ...crawl.metrics,
    ...Object.fromEntries(Object.entries(ingest).filter(([key]) => key !== 'transportErrors')),
    runtimeMs: Date.now() - startedAt,
  };
  console.log(JSON.stringify(summary));
  if (crawl.metrics.pageFailures === crawl.metrics.discovered && crawl.metrics.discovered === 0) process.exitCode = 1;
  if (ingest.transportErrors.length) process.exitCode = 1;
}
