import { collectInvenCategory } from '../src/sources/inven.mjs';
import { sendToSite } from '../src/ingest.mjs';

const requested = (process.env.INVEN_CATEGORY_CANARY || 'both').toLowerCase();
const definitions = {
  cheer_gif: { label: '치어리더 움짤', board: 'party/6296', category: '움짤' },
  game_model: { label: '게임모델', board: 'webzine/2898', category: '게임모델' },
};
const selected = requested === 'both'
  ? Object.keys(definitions)
  : requested.split(',').map((value) => value.trim()).filter((value) => definitions[value]);

if (!process.env.YAKHU_SITE_URL || !process.env.YAKHU_INGEST_SECRET) {
  console.error(JSON.stringify({ status: 'failed', error: 'missing_ingest_configuration' }));
  process.exitCode = 1;
} else {
  for (const id of selected) {
    const def = definitions[id];
    const started = Date.now();
    try {
      const crawl = await collectInvenCategory({ ...def, categoryLabel: `인벤 ${def.label}`, pages: 2, candidateCap: 15 });
      const ingest = await sendToSite(crawl.candidates, {
        siteUrl: process.env.YAKHU_SITE_URL,
        secret: process.env.YAKHU_INGEST_SECRET,
      });
      console.log(JSON.stringify({
        category: id,
        label: def.label,
        ...crawl.metrics,
        submitted: crawl.candidates.length,
        ...Object.fromEntries(Object.entries(ingest).filter(([key]) => key !== 'transportErrors')),
        errors: ingest.failed + ingest.transportErrors.length,
        transportErrors: ingest.transportErrors,
        runtimeMs: Date.now() - started,
      }));
    } catch (error) {
      console.log(JSON.stringify({ category: id, label: def.label, status: 'failed', errors: 1, error: error instanceof Error ? error.message : 'canary_error' }));
      process.exitCode = 1;
    }
  }
}
