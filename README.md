# LibreTV 人工审核源清单

这个仓库每天自动检测一组 **已人工审核** 的 LibreTV 点播源和直播源，并生成标准订阅文件：

```text
https://fastly.jsdelivr.net/gh/xbdba/libretv-source@main/dist/libretv-sources.json
```

生成的 `dist/libretv-sources.json` 同时包含：

```json
{
  "sources": [
    { "name": "点播源", "url": "https://example.com/api.php/provide/vod" }
  ],
  "liveSources": [
    { "name": "直播源", "url": "https://example.com/live.m3u", "epg": "https://example.com/epg.xml" }
  ]
}
```

## 质量控制规则

Actions 不会从公开源仓库自动收录新源。这样做的原因是：自动测活只能证明接口能返回搜索结果，不能证明视频没有第三方水印或广告。

新增点播源必须满足：

1. 实际播放并截取至少两个时间点，检查画面左上、右上、底部和中央叠加层；
2. 至少抽查两个影片或剧集，且原生宽度不低于 720；
3. 排除带第三方域名、博彩广告、App 标、频道标或来源平台 Logo 的视频；
4. 在 `config/sources.json` 的 `reviewedSources` 中写入审核记录后，才会进入正式订阅。

当前白名单中的点播源及抽查记录：

| 源 | 抽查内容 | 原生分辨率 | 第三方水印 |
| --- | --- | --- | --- |
| 暴风2 | 狂飙、流浪地球2 | 1080p、1280x536 | 未发现 |
| 如意资源 | 繁花、流浪地球2 | 1080x606、1920x800 | 未发现 |
| 非凡直连 | 繁花、狂飙 | 720p、1080p | 未发现 |
| 虎牙资源 | 流浪地球2 | 1920x804 | 未发现 |
| 电影天堂资源 | 繁花、狂飙 | 1080p、1920x1080 | 未发现 |

审核时已排除的代表性源包括：

- `69850.com` 叠加广告：豪华资源、速播资源、红牛备用、光速资源、金鹰资源；
- `448478.com` 叠加大幅博彩广告：魔都备用；
- `360z.…` 插播广告：360资源；
- `1802.com` 插播广告：百度资源；
- `99442.com` 叠加广告：U酷资源；
- B 站右上角 Logo：量子资源部分影片；
- `116.am` 插播广告：优质资源部分影片。

这套审核是抽样，不是对所有历史影片的永久保证。上游资源站可以随时替换片源；如果以后发现某源重新出现水印，应把该 URL 从 `reviewedSources` 删除，Actions 就不会再发布它。

直播源保留 Guovin、IPTV-org、vbskycn 等公开维护的聚合列表。直播画面中的电视台台标属于频道自身内容，不按“第三方叠加水印”处理；若直播源插入博彩或推广台标，应直接移除该源。

## GitHub Actions 的工作方式

每天北京时间 **03:17** 执行，也可以手动运行或推送配置变更触发：

1. 读取 `config/sources.json` 中的人工审核白名单；
2. 用“繁花、狂飙、流浪地球2”测试点播接口；
3. 探测直播 M3U 的频道数量；
4. 点播不足 2 个或直播不足 2 个时直接失败，不覆盖上一版文件；
5. 生成 `dist/libretv-sources.json` 并自动提交。

当前构建网络中可达的点播源才会进入 `dist/libretv-sources.json`；不同地区、运营商和 GitHub Runner 的结果可能不同。点播或直播源失效时，脚本只会从白名单里剔除暂时不可用的项，不会自动加入未经审核的新源。

## LibreTV 配置

```yaml
services:
  libretv:
    image: ghcr.io/librespark/libretv:latest
    container_name: libretv
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      PASSWORD: ${PASSWORD:?请先设置 PASSWORD}
      DEFAULT_SUBSCRIPTIONS: '[{"url":"https://fastly.jsdelivr.net/gh/xbdba/libretv-source@main/dist/libretv-sources.json","name":"人工审核源","refreshDays":1}]'
```

`DEFAULT_SUBSCRIPTIONS` 必须使用公网 HTTP/HTTPS 地址，不能使用本地文件、`127.0.0.1`、局域网 IP 或 Docker 内部服务名。

## 本地验证

```bash
npm test
npm run build
```

`npm test` 会验证白名单策略和审核记录是否完整；`npm run build` 会实际访问网络并重新生成订阅文件。

## 备用订阅地址

```text
https://gcore.jsdelivr.net/gh/xbdba/libretv-source@main/dist/libretv-sources.json
https://raw.githubusercontent.com/xbdba/libretv-source/main/dist/libretv-sources.json
```

这些是第三方公开接口，稳定性和内容合法性不由本项目保证；只接入你有权访问的内容。
