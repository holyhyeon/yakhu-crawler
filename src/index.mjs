import { collectBobaedream } from './sources/bobaedream.mjs';
import { collectInven, collectInvenCategory } from './sources/inven.mjs';
import { sendToSite } from './ingest.mjs';

const pages = process.env.CRAWL_PAGES || '3';
const requestedSource = (process.env.CRAWL_SOURCE || 'inven').toLowerCase();
const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const categorySources = {
  inven_cheer_gif: { board: 'party/6296', category: '움짤', label: '치어리더 움짤' },
  inven_game_model: { board: 'webzine/2898', category: '게임모델', label: '게임모델' },
};
const categorySourceIds = Object.keys(categorySources);
const sourceIds = requestedSource === 'all'
  ? ['inven', 'bobaedream', ...categorySourceIds]
  : requestedSource === 'inven_categories'
    ? categorySourceIds
  : requestedSource === 'bobaedream'
    ? ['bobaedream']
    : categorySources[requestedSource]
      ? [requestedSource]
    : ['inven'];

if (!process.env.YAKHU_SITE_URL && !dryRun) {
  console.error('YAKHU_SITE_URL is required unless DRY_RUN is enabled');
  process.exitCode = 1;
} else {
  for (const source of sourceIds) {
    const startedAt = Date.now();
    let crawl;
    try {
      crawl = source === 'bobaedream'
        ? await collectBobaedream({ pages })
        : categorySources[source]
          ? await collectInvenCategory({ ...categorySources[source], pages })
        : await collectInven({ pages });
    } catch (error) {
      console.error(JSON.stringify({
        source,
        status: 'failed',
        error: error instanceof Error ? error.message : 'source_error',
      }));
      process.exitCode = 1;
      continue;
    }

    const ingest = dryRun
      ? { processed: 0, accepted: 0, review: 0, rejected: 0, duplicate: 0, failed: 0, transportErrors: [] }
      : await sendToSite(crawl.candidates, {
          siteUrl: process.env.YAKHU_SITE_URL,
          secret: process.env.YAKHU_INGEST_SECRET,
        });
    const summary = {
      source,
      ...crawl.metrics,
      ...Object.fromEntries(Object.entries(ingest).filter(([key]) => key !== 'transportErrors')),
      runtimeMs: Date.now() - startedAt,
    };
    console.log(JSON.stringify(summary));
    if (crawl.metrics.blocked || (crawl.metrics.pageFailures > 0 && crawl.metrics.discovered === 0) || ingest.transportErrors.length) {
      process.exitCode = 1;
    }
  }
}
