const DEFAULT_HEADERS = {
  'User-Agent': 'LibreTV-Source-Maintainer/1.0',
  Accept: 'application/json,text/plain,*/*',
};

export function normalizeHttpUrl(raw, { trimTrailingSlash = true, stripApiQuery = false } = {}) {
  if (typeof raw !== 'string') return undefined;
  let value = raw.trim().replace(/[?#]+$/, '');
  if (!/^https?:\/\//i.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    if (stripApiQuery) {
      for (const key of ['ac', 'wd', 'pg']) parsed.searchParams.delete(key);
      if ([...parsed.searchParams.keys()].length === 0) parsed.search = '';
    }
    if (trimTrailingSlash) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
      value = parsed.toString().replace(/\/+$/, '');
    } else {
      value = parsed.toString();
    }
    return value;
  } catch {
    return undefined;
  }
}

export function hostnameOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isBlockedHost(url, blockedHosts = []) {
  const host = hostnameOf(url);
  return blockedHosts.some((blocked) => host === blocked.toLowerCase() || host.endsWith(`.${blocked.toLowerCase()}`));
}

export function sanitizeJsonText(input) {
  const text = String(input).replace(/^\uFEFF/, '');
  let withoutComments = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inString) {
      withoutComments += char;
      if (escaped) escaped = false;
      else if (char.charCodeAt(0) === 92) escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      withoutComments += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      withoutComments += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }

    withoutComments += char;
  }

  let withoutTrailingCommas = '';
  inString = false;
  escaped = false;
  for (let i = 0; i < withoutComments.length; i += 1) {
    const char = withoutComments[i];
    if (inString) {
      withoutTrailingCommas += char;
      if (escaped) escaped = false;
      else if (char.charCodeAt(0) === 92) escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutTrailingCommas += char;
      continue;
    }
    if (char === ',') {
      let j = i + 1;
      while (j < withoutComments.length && /\s/.test(withoutComments[j])) j += 1;
      if (withoutComments[j] === '}' || withoutComments[j] === ']') continue;
    }
    withoutTrailingCommas += char;
  }
  return withoutTrailingCommas;
}

export function parseJsonText(text) {
  const clean = sanitizeJsonText(text).trim();
  if (!clean) throw new Error('响应为空');
  return JSON.parse(clean);
}

export async function fetchText(url, options = {}) {
  const {
    timeoutMs = 15000,
    retries = 0,
    maxBytes = 8 * 1024 * 1024,
    headers = {},
    userAgent,
  } = options;
  const target = normalizeHttpUrl(url, { trimTrailingSlash: false });
  if (!target) throw new Error('不是合法的 http/https 地址');

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(target, {
        redirect: 'follow',
        headers: { ...DEFAULT_HEADERS, ...(userAgent ? { 'User-Agent': userAgent } : {}), ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error(`响应超过 ${maxBytes} 字节`);
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new Error(`响应超过 ${maxBytes} 字节`);
      }
      return { text, status: response.status, contentType: response.headers.get('content-type') || '' };
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw lastError;
}

export function parseM3u(text) {
  const groups = new Set();
  let channelCount = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim().toUpperCase().startsWith('#EXTINF')) continue;
    channelCount += 1;
    const group = /group-title="([^"]*)"/i.exec(line)?.[1];
    if (group) groups.add(group);
  }
  return { channelCount, groupCount: groups.size };
}

function cleanName(raw, fallbackUrl) {
  const value = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  return value || hostnameOf(fallbackUrl) || '未命名源';
}

function addVod(result, seen, raw, options = {}) {
  if (!raw || typeof raw !== 'object') return;
  const url = normalizeHttpUrl(raw.url ?? raw.api ?? raw.baseUrl, { trimTrailingSlash: true, stripApiQuery: true });
  if (!url || seen.has(url)) return;
  seen.add(url);
  result.sources.push({
    name: cleanName(raw.name ?? options.defaultName, url),
    url,
    ...(normalizeHttpUrl(raw.detail, { trimTrailingSlash: true })
      ? { detail: normalizeHttpUrl(raw.detail, { trimTrailingSlash: true }) }
      : {}),
    ...(raw.isAdult === true ? { isAdult: true } : {}),
  });
}

function addLive(result, seen, raw, options = {}) {
  if (!raw || typeof raw !== 'object') return;
  const url = normalizeHttpUrl(raw.url ?? raw.api, { trimTrailingSlash: false });
  if (!url || seen.has(url)) return;
  seen.add(url);
  const epg = normalizeHttpUrl(raw.epg, { trimTrailingSlash: false });
  result.liveSources.push({
    name: cleanName(raw.name ?? options.defaultName, url),
    url,
    ...(epg ? { epg } : {}),
  });
}

/**
 * 同时支持 LibreTV-SourceList、裸点播数组、接口目录和 TVBOX 单仓配置。
 * 返回值中的 skipped 便于日志观察上游格式变化，不参与最终订阅文件。
 */
export function extractCandidates(payload) {
  const result = { sources: [], liveSources: [], skipped: 0 };
  const seenVod = new Set();
  const seenLive = new Set();

  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (typeof item !== 'object' || item === null) {
        result.skipped += 1;
        continue;
      }
      if (typeof item.baseUrl === 'string') {
        if (item.enabled === false) continue;
        addVod(result, seenVod, { name: item.name, url: item.baseUrl });
      } else if (typeof item.url === 'string') {
        addVod(result, seenVod, item);
      } else {
        result.skipped += 1;
      }
    }
    return result;
  }

  if (!payload || typeof payload !== 'object') throw new Error('订阅内容不是 JSON 对象或数组');

  if (Array.isArray(payload.sources) || Array.isArray(payload.liveSources)) {
    for (const item of payload.sources ?? []) addVod(result, seenVod, item);
    for (const item of payload.liveSources ?? []) addLive(result, seenLive, item);
  }

  if (Array.isArray(payload.sites)) {
    for (const site of payload.sites) {
      if (!site || typeof site !== 'object') {
        result.skipped += 1;
        continue;
      }
      const type = site.type === undefined || site.type === null ? undefined : Number(site.type);
      if (type === 3 || site.searchable === 0) {
        result.skipped += 1;
        continue;
      }
      const url = site.api ?? site.url;
      if (typeof url !== 'string') {
        result.skipped += 1;
        continue;
      }
      const looksLikeCms = /\/api\.php\/provide\/vod|\/provide\/vod|\/inc\/api(?:json|_mac10)?\.php/i.test(url);
      if (type !== 1 && !looksLikeCms) {
        result.skipped += 1;
        continue;
      }
      addVod(result, seenVod, { name: site.name, url });
    }

    for (const live of payload.lives ?? []) {
      if (!live || typeof live !== 'object') {
        result.skipped += 1;
        continue;
      }
      const type = Number(live.type ?? 0);
      if (type !== 0) {
        result.skipped += 1;
        continue;
      }
      addLive(result, seenLive, live);
    }
  }

  if (Array.isArray(payload.urls) && !Array.isArray(payload.sites)) {
    result.skipped += payload.urls.length;
  }

  if (result.sources.length === 0 && result.liveSources.length === 0) {
    throw new Error('未从配置中提取到可导入的点播或直播源');
  }
  return result;
}

export function mergeCandidates(groups) {
  const sources = new Map();
  const liveSources = new Map();

  const mergeList = (target, list, priority) => {
    for (const item of list) {
      const existing = target.get(item.url);
      if (!existing) target.set(item.url, { ...item, priority });
      else if (priority > existing.priority) target.set(item.url, { ...existing, ...item, priority });
    }
  };

  for (const group of groups) {
    mergeList(sources, group.sources, group.priority ?? 0);
    mergeList(liveSources, group.liveSources, group.priority ?? 0);
  }
  return { sources: [...sources.values()], liveSources: [...liveSources.values()] };
}

export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeTitle(value) {
  return String(value ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

export async function probeVodSource(source, keyword, options = {}) {
  const {
    timeoutMs = 10000,
    retries = 0,
    userAgent,
    maxResponseBytes = 5 * 1024 * 1024,
  } = options;
  const api = new URL(source.url);
  api.searchParams.set('ac', 'videolist');
  api.searchParams.set('wd', keyword);
  api.searchParams.set('pg', '1');
  const startedAt = Date.now();
  const response = await fetchText(api.toString(), {
    timeoutMs,
    retries,
    maxBytes: maxResponseBytes,
    userAgent,
  });
  const json = parseJsonText(response.text);

  if (json?.code !== undefined && !['1', '200'].includes(String(json.code))) {
    throw new Error(`接口 code=${json.code}`);
  }
  const list = Array.isArray(json?.list) ? json.list.filter((item) => item && typeof item === 'object') : [];
  if (list.length === 0) throw new Error('搜索无结果');

  const playable = list.filter((item) => typeof item.vod_play_url === 'string' && item.vod_play_url.trim());
  if (playable.length === 0) throw new Error('结果缺少 vod_play_url');
  const needle = normalizeTitle(keyword);
  const relevant = list.filter((item) => normalizeTitle(item.vod_name ?? item.name).includes(needle));
  if (relevant.length === 0) throw new Error('结果与关键词不相关');

  return {
    hits: list.length,
    playableHits: playable.length,
    relevantHits: relevant.length,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function testVodSource(source, keywords, options = {}) {
  const passes = [];
  const failures = [];
  for (const keyword of keywords) {
    try {
      const result = await probeVodSource(source, keyword, options);
      passes.push({ keyword, ...result });
    } catch (error) {
      failures.push({ keyword, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    ...source,
    passes,
    failures,
    passCount: passes.length,
    hitCount: passes.reduce((sum, item) => sum + item.hits, 0),
    playableHitCount: passes.reduce((sum, item) => sum + item.playableHits, 0),
  };
}

export async function probeLiveSource(source, options = {}) {
  const {
    timeoutMs = 20000,
    retries = 0,
    userAgent,
    maxResponseBytes = 6 * 1024 * 1024,
    minChannels = 10,
  } = options;
  const response = await fetchText(source.url, {
    timeoutMs,
    retries,
    maxBytes: maxResponseBytes,
    userAgent,
    headers: { Accept: 'audio/x-mpegurl,text/plain,*/*' },
  });
  const parsed = parseM3u(response.text);
  if (parsed.channelCount < minChannels) {
    throw new Error(`频道数不足（${parsed.channelCount} < ${minChannels}）`);
  }
  return { ...source, ...parsed, bytes: Buffer.byteLength(response.text, 'utf8') };
}
