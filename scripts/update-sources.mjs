import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractCandidates,
  fetchText,
  hostnameOf,
  isBlockedHost,
  mapLimit,
  mergeCandidates,
  parseJsonText,
  probeLiveSource,
  testVodSource,
} from './lib/source-tools.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.resolve(ROOT, process.env.CONFIG_PATH || 'config/sources.json');

const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
const outputPath = path.resolve(ROOT, process.env.OUTPUT_PATH || cfg.outputPath || 'dist/libretv-sources.json');
const keywords = Array.isArray(cfg.testKeywords) && cfg.testKeywords.length > 0 ? cfg.testKeywords : ['庆余年', '流浪地球'];
const upstreamTimeoutMs = Number(cfg.upstreamTimeoutMs || 20000);
const probeTimeoutMs = Number(cfg.probeTimeoutMs || 10000);
const concurrency = Number(cfg.concurrency || 8);
const probeRetries = Number(cfg.probeRetries ?? 1);
const blockedHosts = Array.isArray(cfg.blockedHosts) ? cfg.blockedHosts : [];
const userAgent = cfg.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/135.0 Safari/537.36';

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function isAllowedSource(source) {
  return !isBlockedHost(source.url, blockedHosts);
}

function limitPerHost(items, maxPerHost) {
  const counts = new Map();
  return items.filter((item) => {
    const host = hostnameOf(item.url);
    const count = counts.get(host) || 0;
    if (count >= maxPerHost) return false;
    counts.set(host, count + 1);
    return true;
  });
}

async function fetchUpstream(url) {
  const response = await fetchText(url, {
    timeoutMs: upstreamTimeoutMs,
    retries: 1,
    maxBytes: 12 * 1024 * 1024,
    userAgent,
  });
  return parseJsonText(response.text);
}

const upstreamGroups = [];
const upstreamStats = [];
const upstreamUrls = Array.isArray(cfg.upstreams) ? cfg.upstreams : [];

const upstreamResults = await mapLimit(upstreamUrls, 4, async (url) => {
  try {
    const payload = await fetchUpstream(url);
    const candidates = extractCandidates(payload);
    return { ok: true, url, candidates };
  } catch (error) {
    return { ok: false, url, error: error instanceof Error ? error.message : String(error) };
  }
});

for (const result of upstreamResults) {
  const host = hostnameOf(result.url);
  if (!result.ok) {
    log(`上游失败 ${host}: ${result.error}`);
    upstreamStats.push({ host, ok: false, error: result.error });
    continue;
  }
  log(`上游完成 ${host}: 点播 ${result.candidates.sources.length} / 直播 ${result.candidates.liveSources.length} / 跳过 ${result.candidates.skipped}`);
  upstreamStats.push({
    host,
    ok: true,
    vod: result.candidates.sources.length,
    live: result.candidates.liveSources.length,
    skipped: result.candidates.skipped,
  });
  upstreamGroups.push({ ...result.candidates, priority: 0 });
}

if (Array.isArray(cfg.seedSources) && cfg.seedSources.length > 0) {
  const seeded = extractCandidates({ sources: cfg.seedSources });
  upstreamGroups.push({ ...seeded, priority: 10 });
}

if (Array.isArray(cfg.seedLiveSources) && cfg.seedLiveSources.length > 0) {
  upstreamGroups.push({ sources: [], liveSources: cfg.seedLiveSources, skipped: 0, priority: 10 });
}

const merged = mergeCandidates(upstreamGroups);
const vodCandidates = merged.sources.filter(isAllowedSource);
const liveCandidates = merged.liveSources.filter(isAllowedSource);

log(`候选：点播 ${vodCandidates.length} / 直播 ${liveCandidates.length}；测试关键词 ${keywords.join('、')}`);

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

const passedVod = limitPerHost(
  vodTested
    .filter((source) => source.passCount >= Number(cfg.minKeywordPasses || 1))
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (b.passCount !== a.passCount) return b.passCount - a.passCount;
      if (b.playableHitCount !== a.playableHitCount) return b.playableHitCount - a.playableHitCount;
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
      return a.url.localeCompare(b.url);
    }),
  Number(cfg.maxSourcesPerHost || 1)
).slice(0, Number(cfg.maxSources || 30));

const minSources = Number(cfg.minSources || 8);
if (passedVod.length < minSources) {
  throw new Error(`通过测活的点播源只有 ${passedVod.length} 个，低于 minSources=${minSources}，拒绝覆盖现有文件`);
}

const liveTested = await mapLimit(liveCandidates, Math.min(concurrency, 4), async (source) => {
  try {
    const result = await probeLiveSource(source, {
      timeoutMs: Number(cfg.liveTimeoutMs || 25000),
      retries: 0,
      userAgent,
      minChannels: Number(cfg.minLiveChannels || 10),
    });
    log(`直播通过 ${source.name}: ${result.channelCount} 个频道`);
    return result;
  } catch (error) {
    log(`直播失败 ${source.name}: ${error instanceof Error ? error.message : String(error)}`);
    return { ...source, error: error instanceof Error ? error.message : String(error), channelCount: 0 };
  }
});

const passedLive = limitPerHost(
  liveTested
    .filter((source) => source.channelCount > 0)
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (b.channelCount !== a.channelCount) return b.channelCount - a.channelCount;
      return a.url.localeCompare(b.url);
    }),
  Number(cfg.maxLiveSourcesPerHost || 1)
).slice(0, Number(cfg.maxLiveSources || 8));

const nameCount = new Map();
function uniqueName(source) {
  const base = source.name || hostnameOf(source.url) || '未命名源';
  const count = nameCount.get(base) || 0;
  nameCount.set(base, count + 1);
  return count === 0 ? base : `${base} (${hostnameOf(source.url)})`;
}

const payload = {
  name: cfg.name || 'LibreTV 自维护源清单',
  version: 2,
  generatedAt: new Date().toISOString().slice(0, 10),
  sources: passedVod.map((source) => ({
    name: uniqueName(source),
    url: source.url,
    ...(source.detail ? { detail: source.detail } : {}),
    ...(source.isAdult ? { isAdult: true } : {}),
  })),
  liveSources: passedLive.map((source) => ({
    name: source.name,
    url: source.url,
    ...(source.epg ? { epg: source.epg } : {}),
  })),
  stats: {
    upstreams: upstreamStats.length,
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
