import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const siteUrl = process.env.YAKHU_SITE_URL;
const secret = process.env.YAKHU_INGEST_SECRET;
const limit = Math.min(25, Math.max(1, Number(process.env.VIDEO_THUMBNAIL_LIMIT || 5)));
const cursor = process.env.VIDEO_THUMBNAIL_CURSOR || '';
const mediaId = process.env.VIDEO_THUMBNAIL_MEDIA_ID || '';
const postId = process.env.VIDEO_THUMBNAIL_POST_ID || '';
const requestTimeout = 60_000;
const posterFilter = "scale=w='if(gte(iw,ih),min(640,iw),-2)':h='if(gte(iw,ih),-2,min(640,ih))'";

if (!siteUrl || !secret) throw new Error('missing_thumbnail_configuration');

async function requestJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${secret}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(requestTimeout),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`site_${response.status}`);
  return body;
}

async function run(program, args) {
  return execFileAsync(program, args, { maxBuffer: 2_000_000 });
}

async function frameLooksBlack(inputPath, timestamp) {
  try {
    const result = await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-ss', String(timestamp), '-i', inputPath,
      '-frames:v', '1', '-vf', 'scale=1:1,format=gray', '-f', 'rawvideo', '-',
    ], { maxBuffer: 1024, encoding: 'buffer' });
    const bytes = Buffer.from(result.stdout);
    if (!bytes.length) return true;
    const average = bytes.reduce((sum, value) => sum + value, 0) / bytes.length;
    return average <= 12 && Math.max(...bytes) <= 24;
  } catch {
    return false;
  }
}

async function extractPoster(inputPath, outputPath) {
  const attempts = [0.3, 1.0, 2.0];
  let lastError = 'frame_extract_failed';
  for (let index = 0; index < attempts.length; index += 1) {
    const timestamp = attempts[index];
    try {
      await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-ss', String(timestamp), '-i', inputPath,
        '-frames:v', '1', '-vf', posterFilter, '-c:v', 'libwebp', '-quality', '73', '-y', outputPath,
      ]);
      const output = await stat(outputPath);
      if (output.size > 0) {
        const black = await frameLooksBlack(inputPath, timestamp);
        if (black && index < attempts.length - 1) continue;
        const probe = await run('ffprobe', [
          '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', outputPath,
        ]);
        const parsed = JSON.parse(probe.stdout);
        const stream = parsed.streams?.[0];
        if (Number.isInteger(stream?.width) && Number.isInteger(stream?.height)) {
          return { timestamp, width: stream.width, height: stream.height, size: output.size, blackFrameFallback: index > 0 };
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 160) : String(error);
    }
  }
  throw new Error(lastError);
}

async function processOne(item, directory) {
  const inputPath = join(directory, `${item.id}.mp4`);
  const outputPath = join(directory, `${item.id}.webp`);
  let mediaResponse;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    mediaResponse = await fetch(item.mediaUrl, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(requestTimeout),
    });
    if (mediaResponse.status !== 404 || attempt === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!mediaResponse.ok) throw new Error(`media_${mediaResponse.status}`);
  await writeFile(inputPath, Buffer.from(await mediaResponse.arrayBuffer()));
  const poster = await extractPoster(inputPath, outputPath);
  const form = new FormData();
  form.set('mediaId', item.id);
  form.set('width', String(poster.width));
  form.set('height', String(poster.height));
  form.set('frameTimestamp', String(poster.timestamp));
  if (mediaId || postId) form.set('replace', '1');
  form.set('poster', new Blob([await readFile(outputPath)], { type: 'image/webp' }), `${item.id}.webp`);
  const upload = await requestJson(new URL('/api/video-thumbnails/upload', siteUrl), { method: 'POST', body: form });
  return { ...poster, status: upload.status ?? 'generated', thumbnailObjectKey: upload.thumbnailObjectKey ?? null };
}

const queueUrl = new URL('/api/video-thumbnails/queue', siteUrl);
queueUrl.searchParams.set('limit', String(limit));
if (cursor) queueUrl.searchParams.set('cursor', cursor);
if (mediaId) queueUrl.searchParams.set('mediaId', mediaId);
else if (postId) queueUrl.searchParams.set('postId', postId);
const queue = await requestJson(queueUrl);
const items = Array.isArray(queue.items) ? queue.items : [];
const directory = await mkdtemp(join(tmpdir(), 'yakhu-video-thumbnail-'));
const results = [];
try {
  for (const item of items) {
    if (item.thumbnailObjectKey) {
      results.push({ mediaId: item.id, status: 'skipped', reason: 'already_processed' });
      continue;
    }
    try {
      results.push({ mediaId: item.id, status: 'generated', ...(await processOne(item, directory)) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === 'media_404') {
        results.push({
          mediaId: item.id,
          postId: item.postId ?? null,
          source: item.source ?? null,
          status: 'skipped',
          reason: 'original_unavailable',
          objectKey: item.objectKey ?? null,
          mediaUrl: item.mediaUrl,
        });
      } else {
        results.push({ mediaId: item.id, status: 'error', reason });
      }
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

const generated = results.filter((item) => item.status === 'generated');
const skipped = results.filter((item) => item.status === 'skipped');
const errors = results.filter((item) => item.status === 'error');
const skippedReasons = Object.fromEntries(
  skipped.reduce((counts, item) => {
    const reason = item.reason ?? 'other';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    return counts;
  }, new Map()),
);
console.log(JSON.stringify({
  scanned: items.length,
  generated: generated.length,
  skipped: skipped.length,
  skippedReasons,
  errors: errors.length,
  nextCursor: queue.nextCursor ?? null,
  results,
}));
if (errors.length) process.exitCode = 1;
