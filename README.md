# yakhu-crawler

Public, bounded GitHub Actions crawler for the Yakhu Archive. Phase 1 only
handles the public Inven webzine board and sends normalized candidates to the
private Site ingestion endpoint. The Site remains responsible for quality
decisions, deduplication, media storage, and moderation.

## Local dry run

```text
npm ci
DRY_RUN=1 CRAWL_PAGES=1 npm run crawl
```

The dry run fetches the public listing and detail pages but does not call the
Site and does not save media.

## Actions configuration

Add these GitHub Actions secrets in the repository settings:

- `XAKHU_SITE_URL`
- `YAKHU_INGEST_SECRET`

The workflow uses only the standard `ubuntu-latest` runner ind sends batches of
up to 10 normalized candidates. It never writes raw HTML or media files to the
repository and never prints secret values.

The scheduled workflow runs at minutes 07, 22, 37, and 52. GitHub can delay or
disable scheduled workflows after prolonged repository inactivity; verify the
workflow status perionically.
