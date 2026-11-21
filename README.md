# LibreTV 自动维护源清单

这个目录把多个公开源集合聚合成一份标准的 **LibreTV-SourceList JSON**，并每天自动实测、更新。

生成的 `dist/libretv-sources.json` 同时包含：

```json
{
  "name": "LibreTV 自维护源清单",
  "version": 2,
  "sources": [
    { "name": "点播源", "url": "https://example.com/api.php/provide/vod" }
  ],
  "liveSources": [
    { "name": "直播源", "url": "https://example.com/list.m3u", "epg": "http://example.com/epg.xml.gz" }
  ]
}
```

- `sources`：Apple CMS 点播接口；
- `liveSources`：M3U 直播列表，`epg` 可选。

## 为什么不能直接挂载本地 JSON

LibreTV 的 `DEFAULT_SUBSCRIPTIONS` 只接受 **公网 HTTP/HTTPS URL**。源码中的订阅拉取会经过 SSRF 校验，因此下面这些都不能直接使用：

- `file:///data/libretv-sources.json`
- `http://127.0.0.1/...`
- `http://192.168.x.x/...`
- Docker 内部服务名，例如 `http://source-server/...`

所以推荐让 GitHub Actions 每天生成文件，LibreTV 订阅文件的公开 URL。不需要在群晖上手工维护，也不需要重启 LibreTV 容器。

## 部署方式

1. 把整个目录上传到一个公开 GitHub 仓库，仓库中保留下面的目录结构：

```text
.github/workflows/update-sources.yml
config/sources.json
scripts/update-sources.mjs
scripts/lib/source-tools.mjs
dist/libretv-sources.json
package.json
docker-compose.example.yml
```

2. 打开仓库的 **Actions → Update LibreTV sources → Run workflow**，先手动跑一次。

3. 本项目的 `docker-compose.example.yml` 已经指向 `xbdba/libretv-source`，把它合入现有的 LibreTV Compose 即可。

4. 首次部署时重建一次 LibreTV：

```bash
docker compose up -d --force-recreate
```

之后每天 GitHub Actions 会重新生成 `dist/libretv-sources.json`。LibreTV 会在打开站点时按 `refreshDays: 1` 自动拉取，不需要再次重启容器。

推荐订阅地址：

```text
https://fastly.jsdelivr.net/gh/xbdba/libretv-source@main/dist/libretv-sources.json
```

备用地址：

```text
https://gcore.jsdelivr.net/gh/xbdba/libretv-source@main/dist/libretv-sources.json
https://raw.githubusercontent.com/xbdba/libretv-source/main/dist/libretv-sources.json
```

国内网络下优先使用 Fastly jsDelivr；如果 Fastly 不可达，再切换 Gcore 或 Raw。

## 工作方式

1. 读取 `config/sources.json` 中的上游订阅、TVBOX 配置和种子源；
2. 支持 LibreTV-SourceList、裸源数组、接口目录、TVBOX 单仓配置；
3. 按 URL 去重，并按主机名限制重复接口数量；
4. 对每个点播源搜索“庆余年”和“流浪地球”；
5. 只保留满足以下条件的源：
   - HTTP 成功；
   - 返回可解析 JSON；
   - `list` 非空；
   - 结果带 `vod_play_url`；
   - 至少一条结果与关键词相关；
6. 探测直播 M3U 的 `#EXTINF` 数量；
7. 根据通过次数、可播结果数量稳定排序，截断到配置上限；
8. 写入 `dist/libretv-sources.json`。

如果通过测活的点播源少于 `minSources`，脚本会直接失败，不覆盖上一次可用的文件。

## 主要配置

```json
{
  "testKeywords": ["庆余年", "流浪地球"],
  "minKeywordPasses": 1,
  "minSources": 8,
  "maxSources": 30,
  "maxSourcesPerHost": 1,
  "maxLiveSources": 8,
  "concurrency": 8
}
```

- `upstreams`：上游公开源清单；
- `seedSources`：即使上游失败也参与测活的固定候选；
- `seedLiveSources`：固定直播候选；
- `blockedHosts`：明确排除的域名；
- `maxSources`：最终点播源上限，LibreTV 单次搜索最多使用 50 个源；
- `testKeywords`：建议保留一个剧集关键词和一个电影关键词。

## 本地验证

```bash
npm test
npm run build
```

`npm test` 覆盖格式解析、TVBOX 提取、URL 归一化和 M3U 解析。`npm run build` 会实际访问网络并重新生成 `dist/libretv-sources.json`。

## 注意事项

- GitHub Actions 的运行网络与群晖网络不同，脚本通过不代表 NAS 一定能连上；LibreTV 自带的“一键测活”仍是最终校验。
- 不要把所有源都长期勾选，建议在 LibreTV 中保留 8～15 个实际可用的点播源。
- 这些是第三方公开接口，稳定性和内容合法性不由本项目保证；只接入你有权访问的内容。
