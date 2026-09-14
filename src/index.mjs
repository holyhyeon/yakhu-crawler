import { collectBobaedream, collectBobaedreamGirl } from './sources/bobaedream.mjs';
import { collectInven, collectInvenCategory } from './sources/inven.mjs';
import { checkExistingCandidates, sendToSite } from './ingest.mjs';
import { reportFunnel } from './funnel.mjs';

const pages = process.env.CRAWL_PAGES || '3';
const postId = process.env.CRAWL_POST_ID || '';
const requestedSource = (process.env.CRAWL_SOURCE || 'inven').toLowerCase();
const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const categorySources = {
  inven_cheer_gif: { board: 'party/6296', category: '움짤', categoryLabel: '인벤 치어리더 움짤' },
  inven_game_model: { board: 'webzine/2898', category: '게임모델', categoryLabel: '인벤 게임모델' },
};
// The Inven game-model lane is intentionally paused after its recent quality audit.
// Keep its metadata for historical identity/reporting, but do not schedule or run it.
const disabledCategorySourceIds = new Set(['inven_game_model']);
const categorySourceIds = Object.keys(categorySources).filter((source) => !disabledCategorySourceIds.has(source));
const sourceIds = disabledCategorySourceIds.has(requestedSource)
  ? []
  : requestedSource === 'all'
  ? ['inven', 'bobaedream', ...categorySourceIds]
  : requestedSource === 'inven_categories'
    ? categorySourceIds
  : requestedSource === 'bobaedream'
    ? ['bobaedream']
    : requestedSource === 'boba_girl'
      ? ['boba_girl']
    : categorySources[requestedSource]
      ? [requestedSource]
    : ['inven'];

if (!process.env.YAKHU_SITE_URL && !dryRun) {
  console.error('YAKHU_SITE_URL is required unless DRY_RUN is enabled');
  process.exitCode = 1;
} else {
  for (const source of sourceIds) {
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const runId = crypto.randomUUID();
    let crawl;
    try {
      const existingChecker = categorySources[source] && !dryRun
        ? (candidates) => checkExistingCandidates(candidates, {
            siteUrl: process.env.YAKHU_SITE_URL,
            secret: process.env.YAKHU_INGEST_SECRET,
          })
        : undefined;
      crawl = source === 'bobaedream'
        ? await collectBobaedream({ pages })
        : source === 'boba_girl'
          ? await collectBobaedreamGirl({ pages })
        : categorySources[source]
          ? await collectInvenCategory({ ...categorySources[source], pages, existingChecker })
        : await collectInven({ pages, postId });
    } catch (error) {
      let funnelReported = false;
      try {
        const report = await reportFunnel({ runId, source, candidates: [], crawlMetrics: {}, ingest: { resultRows: [] }, siteUrl: process.env.YAKHU_SITE_URL, secret: process.env.YAKHU_INGEST_SECRET, startedAt: startedAtIso, finishedAt: new Date().toISOString(), sourceError: error instanceof Error ? error.message : 'source_error' });
        funnelReported = report.reported;
      } catch { /* the source failure remains visible in the workflow log */ }
      console.error(JSON.stringify({
        source,
        status: 'failed',
        error: error instanceof Error ? error.message : 'source_error',
        funnelReported,
      }));
      process.exitCode = 1;
      continue;
    }

    const ingest = dryRun
      ? { processed: 0, accepted: 0, review: 0, rejected: 0, duplicate: 0, failed: 0, shadowEligible: 0, shadowSampled: 0, shadowStored: 0, shadowErrors: 0, shadowMediaExtracted: 0, transportErrors: [], resultRows: [] }
      : await sendToSite(crawl.candidates, {
          siteUrl: process.env.YAKHU_SITE_URL,
          secret: process.env.YAKHU_INGEST_SECRET,
          runId,
        });
    let funnelReported = false;
    try {
      const report = dryRun ? { reported: false } : await reportFunnel({ runId, source, candidates: crawl.candidates, crawlMetrics: crawl.metrics, ingest, siteUrl: process.env.YAKHU_SITE_URL, secret: process.env.YAKHU_INGEST_SECRET, startedAt: startedAtIso, finishedAt: new Date().toISOString() });
      funnelReported = Boolean(report.reported);
    } catch (error) {
      console.error(JSON.stringify({ source, status: 'funnel_metrics_failed', error: error instanceof Error ? error.message : 'metrics_error' }));
    }
    const summary = {
      source,
      ...crawl.metrics,
      ...Object.fromEntries(Object.entries(ingest).filter(([key]) => key !== 'transportErrors' && key !== 'resultRows')),
      runtimeMs: Date.now() - startedAt,
      funnelReported,
    };
    console.log(JSON.stringify(summary));
    if (crawl.metrics.blocked || (crawl.metrics.pageFailures > 0 && crawl.metrics.discovered === 0) || ingest.transportErrors.length) {
      process.exitCode = 1;
    }
  }
}
