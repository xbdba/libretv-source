import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hostnameOf,
  isBlockedHost,
  mapLimit,
  probeLiveSource,
  testVodSource,
} from './lib/source-tools.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.resolve(ROOT, process.env.CONFIG_PATH || 'config/sources.json');

const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
const outputPath = path.resolve(ROOT, process.env.OUTPUT_PATH || cfg.outputPath || 'dist/libretv-sources.json');
const keywords = Array.isArray(cfg.testKeywords) && cfg.testKeywords.length > 0 ? cfg.testKeywords : ['繁花', '狂飙', '流浪地球2'];
const concurrency = Number(cfg.concurrency || 5);
const probeTimeoutMs = Number(cfg.probeTimeoutMs || 12000);
const probeRetries = Number(cfg.probeRetries ?? 1);
const blockedHosts = Array.isArray(cfg.blockedHosts) ? cfg.blockedHosts : [];
const userAgent = cfg.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/135.0 Safari/537.36';
const reviewPolicy = cfg.reviewPolicy ?? {};

if (reviewPolicy.selectionMode !== 'reviewed-only' || reviewPolicy.visualReviewRequired !== true) {
  throw new Error('config must use reviewed-only selection with visualReviewRequired=true');
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function isAllowedSource(source) {
  return !isBlockedHost(source.url, blockedHosts);
}

function validateReviewedSource(source) {
  if (!source || typeof source !== 'object') throw new Error('reviewed source must be an object');
  if (typeof source.name !== 'string' || !source.name.trim()) throw new Error('reviewed source requires name');
  if (typeof source.url !== 'string' || !/^https?:\/\//i.test(source.url)) throw new Error(`${source.name}: invalid URL`);
  if (source.review?.watermark !== 'none-observed') throw new Error(`${source.name}: missing visual watermark review`);
  if (!Array.isArray(source.review?.titles) || source.review.titles.length === 0) throw new Error(`${source.name}: missing reviewed titles`);
  if (!Array.isArray(source.review?.resolutions) || source.review.resolutions.length === 0) throw new Error(`${source.name}: missing reviewed resolutions`);
}

const reviewedSources = Array.isArray(cfg.reviewedSources) ? cfg.reviewedSources : [];
const reviewedLiveSources = Array.isArray(cfg.reviewedLiveSources) ? cfg.reviewedLiveSources : [];
reviewedSources.forEach(validateReviewedSource);

const vodCandidates = reviewedSources.filter(isAllowedSource);
const liveCandidates = reviewedLiveSources.filter(isAllowedSource);
log(`审核源：点播 ${vodCandidates.length} / 直播 ${liveCandidates.length}；测试关键词 ${keywords.join('、')}`);

const vodTested = await mapLimit(vodCandidates, concurrency, async (source) => {
  const result = await testVodSource(source, keywords, {
    timeoutMs: probeTimeoutMs,
    retries: probeRetries,
    userAgent,
  });
  const summary = result.passes.map((item) => `${item.keyword}:${item.hits}`).join(',') || result.failures.map((item) => item.error).join('; ');
  log(`点播 ${result.passCount > 0 ? '通过' : '失败'} ${source.name}: ${summary}`);
  return result;
});

const passedVod = vodTested
  .filter((source) => source.passCount >= Number(cfg.minKeywordPasses || 1))
  .slice(0, Number(cfg.maxSources || 10));

const minSources = Number(cfg.minSources || 3);
if (passedVod.length < minSources) {
  throw new Error(`通过测活的审核点播源只有 ${passedVod.length} 个，低于 minSources=${minSources}，拒绝覆盖现有文件`);
}

const liveTested = await mapLimit(liveCandidates, Math.min(concurrency, 4), async (source) => {
  try {
    const result = await probeLiveSource(source, {
      timeoutMs: Number(cfg.liveTimeoutMs || 30000),
      retries: 0,
      userAgent,
      minChannels: Number(cfg.minLiveChannels || 10),
    });
    log(`直播通过 ${source.name}: ${result.channelCount} 个频道`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`直播失败 ${source.name}: ${message}`);
    return { ...source, error: message, channelCount: 0 };
  }
});

const passedLive = liveTested
  .filter((source) => source.channelCount > 0)
  .slice(0, Number(cfg.maxLiveSources || 6));

const minLiveSources = Number(cfg.minLiveSources || 2);
if (passedLive.length < minLiveSources) {
  throw new Error(`通过测活的审核直播源只有 ${passedLive.length} 个，低于 minLiveSources=${minLiveSources}，拒绝覆盖现有文件`);
}

function uniqueName(source, seen) {
  const base = source.name || hostnameOf(source.url) || '未命名源';
  const count = seen.get(base) || 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base} (${hostnameOf(source.url)})`;
}

const nameCount = new Map();
const payload = {
  name: cfg.name || 'LibreTV 人工审核源清单',
  version: 2,
  generatedAt: new Date().toISOString().slice(0, 10),
  sources: passedVod.map((source) => ({
    name: uniqueName(source, nameCount),
    url: source.url,
    ...(source.detail ? { detail: source.detail } : {}),
  })),
  liveSources: passedLive.map((source) => ({
    name: source.name,
    url: source.url,
    ...(source.epg ? { epg: source.epg } : {}),
  })),
  quality: {
    selectionMode: reviewPolicy.selectionMode,
    visualReviewRequired: reviewPolicy.visualReviewRequired,
    reviewedAt: reviewPolicy.reviewedAt,
    watermarkPolicy: reviewPolicy.watermarkPolicy,
  },
  stats: {
    candidates: { vod: vodCandidates.length, live: liveCandidates.length },
    selected: { vod: passedVod.length, live: passedLive.length },
    testKeywords: keywords,
  },
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const tempPath = `${outputPath}.tmp`;
await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
await fs.rename(tempPath, outputPath);

log(`完成：点播 ${payload.sources.length} / 直播 ${payload.liveSources.length} -> ${path.relative(ROOT, outputPath)}`);
