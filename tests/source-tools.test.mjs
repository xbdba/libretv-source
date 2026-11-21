import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  extractCandidates,
  isBlockedHost,
  normalizeHttpUrl,
  parseJsonText,
  parseM3u,
} from '../scripts/lib/source-tools.mjs';

test('normalizeHttpUrl trims trailing slash and rejects non-http schemes', () => {
  assert.equal(normalizeHttpUrl('https://example.com/api/vod/'), 'https://example.com/api/vod');
  assert.equal(normalizeHttpUrl('https://example.com/api.php/provide/vod?ac=list&pg=1', { stripApiQuery: true }), 'https://example.com/api.php/provide/vod');
  assert.equal(normalizeHttpUrl('https://proxy.example.com/?url=https://api.example.com/vod'), 'https://proxy.example.com/?url=https://api.example.com/vod');
  assert.equal(normalizeHttpUrl('ftp://example.com/api'), undefined);
  assert.equal(normalizeHttpUrl('not-a-url'), undefined);
});

test('LibreTV SourceList extracts vod and live sources', () => {
  const result = extractCandidates({
    name: 'test',
    sources: [
      { name: 'A', url: 'https://a.example.com/api.php/provide/vod/' },
      { name: 'A duplicate', url: 'https://a.example.com/api.php/provide/vod' },
    ],
    liveSources: [{ name: 'L', url: 'https://a.example.com/live.m3u' }],
  });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, 'https://a.example.com/api.php/provide/vod');
  assert.equal(result.liveSources.length, 1);
});

test('TVBOX config keeps CMS sites and M3U lives, drops spider', () => {
  const result = extractCandidates({
    sites: [
      { name: 'CMS', type: 1, api: 'https://cms.example.com/api.php/provide/vod' },
      { name: 'Spider', type: 3, api: 'https://spider.example.com/api.php/provide/vod' },
      { name: 'search disabled', type: 1, searchable: 0, api: 'https://skip.example.com/api.php/provide/vod' },
    ],
    lives: [
      { name: 'Live', type: 0, url: 'https://live.example.com/list.m3u' },
      { name: 'Spider live', type: 3, url: 'https://live.example.com/spider.jar' },
    ],
  });
  assert.deepEqual(result.sources.map((item) => item.name), ['CMS']);
  assert.deepEqual(result.liveSources.map((item) => item.name), ['Live']);
  assert.equal(result.skipped, 3);
});

test('bare baseUrl catalog is accepted', () => {
  const result = extractCandidates([
    { name: 'A', baseUrl: 'https://a.example.com/api.php/provide/vod' },
    { name: 'B', baseUrl: 'https://b.example.com/api.php/provide/vod', enabled: false },
  ]);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].name, 'A');
});

test('JSON parser tolerates comments and trailing commas without damaging URLs', () => {
  const parsed = parseJsonText(`{
    // a comment
    "sources": [
      { "name": "A", "url": "https://example.com/api.php/provide/vod", },
    ],
  }`);
  assert.equal(parsed.sources[0].url, 'https://example.com/api.php/provide/vod');
});

test('M3U parser counts channels and groups', () => {
  const result = parseM3u(`#EXTM3U
#EXTINF:-1 group-title="央视",CCTV1
https://example.com/1.m3u8
#EXTINF:-1 group-title="卫视",湖南卫视
https://example.com/2.m3u8
`);
  assert.deepEqual(result, { channelCount: 2, groupCount: 2 });
});

test('blockedHosts includes subdomains', () => {
  assert.equal(isBlockedHost('https://a.example.com/api', ['example.com']), true);
  assert.equal(isBlockedHost('https://example.net/api', ['example.com']), false);
});

test('source config is reviewed-only and records visual review evidence', () => {
  const cfg = JSON.parse(readFileSync(new URL('../config/sources.json', import.meta.url), 'utf8'));
  assert.equal(cfg.reviewPolicy.selectionMode, 'reviewed-only');
  assert.equal(cfg.reviewPolicy.visualReviewRequired, true);
  assert.ok(Array.isArray(cfg.reviewedSources));
  assert.ok(cfg.reviewedSources.length >= cfg.minSources);

  for (const source of cfg.reviewedSources) {
    assert.match(source.url, /^https:\/\//);
    assert.equal(source.review.watermark, 'none-observed');
    assert.ok(source.review.titles.length > 0);
    assert.ok(source.review.resolutions.length > 0);
  }

  assert.equal('upstreams' in cfg, false);
  assert.equal('seedSources' in cfg, false);
});

test('automatic publishing cannot import unreviewed candidates', () => {
  const script = readFileSync(new URL('../scripts/update-sources.mjs', import.meta.url), 'utf8');
  assert.match(script, /reviewed-only/);
  assert.match(script, /reviewedSources/);
  assert.doesNotMatch(script, /fetchUpstream/);
  assert.doesNotMatch(script, /cfg\.upstreams/);
});
