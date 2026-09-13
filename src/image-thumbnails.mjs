import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const siteUrl = process.env.YAKHU_SITE_URL;
const secret = process.env.YAKHU_INGEST_SECRET;
const mediaId = process.env.IMAGE_THUMBNAIL_MEDIA_ID || '';
const postId = process.env.IMAGE_THUMBNAIL_POST_ID || '';
const limit = Math.min(25, Math.max(1, Number(process.env.IMAGE_THUMBNAIL_LIMIT || 10)));
const requestTimeout = 60_000;
const thumbnailFilter = "scale=w='if(gte(iw,ih),min(640,iw),-2)':h='if(gte(iw,ih),-2,min(640,ih))'";

if (!siteUrl || !secret) throw new Error('missing_image_thumbnail_configuration');

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

async function probeDuration(inputPath) {
  try {
    const result = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath,
    ]);
    const duration = Number.parseFloat(String(result.stdout).trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

function frameCandidates(duration) {
  if (!duration) return [0];
  const lastSafe = Math.max(0, duration - Math.min(0.001, duration / 10));
  return [...new Set([0.25, 0.5, 0.7].map((ratio) => Math.min(lastSafe, Math.max(0, duration * ratio))))];
}

async function frameLooksBlack(inputPath, timestamp) {
  try {
    const result = await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'info', '-ss', String(timestamp), '-i', inputPath,
      '-frames:v', '1', '-vf', 'blackdetect=d=0:pix_th=0.20:pic_th=0.98', '-f', 'null', '-',
    ], { maxBuffer: 1_000_000, encoding: 'utf8' });
    const diagnostic = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
    if (/black_start:/i.test(diagnostic)) return true;

    const pixels = await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-ss', String(timestamp), '-i', inputPath,
      '-frames:v', '1', '-vf', 'scale=16:16,format=gray', '-f', 'rawvideo', '-',
    ], { maxBuffer: 1024, encoding: 'buffer' });
    const bytes = Buffer.from(pixels.stdout);
    if (!bytes.length) return true;
    const average = bytes.reduce((sum, value) => sum + value, 0) / bytes.length;
    const brightFraction = bytes.filter((value) => value > 48).length / bytes.length;
    return average <= 32 && brightFraction <= 0.12;
  } catch {
    return false;
  }
}

async function extractThumbnail(inputPath, outputPath) {
  const duration = await probeDuration(inputPath);
  const attempts = frameCandidates(duration);
  let lastError = 'frame_extract_failed';
  for (let index = 0; index < attempts.length; index += 1) {
    const timestamp = attempts[index];
    try {
      await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-ss', String(timestamp), '-i', inputPath,
        '-frames:v', '1', '-vf', thumbnailFilter, '-c:v', 'libwebp', '-quality', '73', '-y', outputPath,
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
          return { duration, timestamp, width: stream.width, height: stream.height, size: output.size, blackFrameFallback: index > 0 };
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 160) : String(error);
    }
  }
  throw new Error(lastError);
}

async function processOne(item, directory) {
  const inputPath = join(directory, `${item.id}.gif`);
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
  const originalBytes = Buffer.from(await mediaResponse.arrayBuffer());
  await writeFile(inputPath, originalBytes);
  const thumbnail = await extractThumbnail(inputPath, outputPath);
  const form = new FormData();
  form.set('mediaId', item.id);
  form.set('width', String(thumbnail.width));
  form.set('height', String(thumbnail.height));
  form.set('frameTimestamp', String(thumbnail.timestamp));
  if (mediaId || postId) form.set('replace', '1');
  form.set('thumbnail', new Blob([await readFile(outputPath)], { type: 'image/webp' }), `${item.id}.webp`);
  const upload = await requestJson(new URL('/api/image-thumbnails/upload', siteUrl), { method: 'POST', body: form });
  return { originalSize: originalBytes.byteLength, ...thumbnail, status: upload.status ?? 'generated', thumbnailObjectKey: upload.thumbnailObjectKey ?? null };
}

const queueUrl = new URL('/api/image-thumbnails/queue', siteUrl);
if (mediaId) queueUrl.searchParams.set('mediaId', mediaId);
else if (postId) queueUrl.searchParams.set('postId', postId);
else queueUrl.searchParams.set('limit', String(limit));
const queue = await requestJson(queueUrl);
const items = Array.isArray(queue.items) ? queue.items : [];
const directory = await mkdtemp(join(tmpdir(), 'yakhu-gif-thumbnail-'));
const results = [];
try {
  for (const item of items) {
    try {
      results.push({ mediaId: item.id, postId: item.postId ?? null, status: 'generated', ...(await processOne(item, directory)) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      results.push({ mediaId: item.id, postId: item.postId ?? null, status: 'error', reason });
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

const generated = results.filter((item) => item.status === 'generated');
const errors = results.filter((item) => item.status === 'error');
console.log(JSON.stringify({ scanned: items.length, generated: generated.length, skipped: 0, errors: errors.length, results }));
if (errors.length) process.exitCode = 1;
