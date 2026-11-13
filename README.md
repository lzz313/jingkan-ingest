# 静看抓取任务

静看（JingKan）的定时抓取仓库。它只负责从各个来源拉取内容，并通过 Worker 的 `/api/ingest` 接口写入 D1；Worker、Web 界面和数据库配置在私有仓库中。

它同时每 5 分钟把 D1 中最近 35 天的公开内容导出为 R2 快照，并在完整校验后原子切换线上读取版本。

## 抓取来源

- X（`X 榜单` 收录 xbangdan 的 `ai_coding` 内容，`Tech Twitter` 补充近期 AI / 开发趋势）
- V2EX
- NodeSeek
- LINUX DO
- Hacker News（卡片链接使用 YC 讨论页，历史条目保留原链接）
- GitHub Trending
- Reddit（r/programming / r/technology / r/LocalLLaMA / r/webdev 合并热榜，RSS）
- Hugging Face Daily Papers（官方 JSON）
- Simon Willison（Atom，只保留 AI 相关标签）
- Google AI Blog（官方 RSS）
- Product Hunt（公开 Atom，收录全部新品）

新增的 AI 与产品来源只回填最近 48 小时内容。Hugging Face 使用赞同 / 评论参与热点；
Simon Willison、Google AI 和 Product Hunt 没有可靠的互动指标，因此只进入最新视图。

X 在页面上仍是一个频道，内部由两个公开入口互补：`X 榜单` 优先提供中文 AI 编程热榜与曝光数据；
`Tech Twitter` 补充最近 48 小时的英文 AI、开发工具和创业讨论，并通过 X syndication
补齐原帖、作者、点赞、回复和媒体。两路按 X 状态 ID 去重；任一入口失败时，另一入口仍会继续入库。

## 定时安排

按北京时间（UTC+8），每天在这些时段运行：

| 时间 | 频率 |
| --- | --- |
| 08:30–11:50 | 每 10 分钟 |
| 12:30 | 一次 |
| 13:00–17:50 | 每 10 分钟 |
| 18:30 | 一次 |
| 19:00–23:30 | 每 10 分钟 |

其余时间不抓取。GitHub Actions 的 schedule 是尽力而为，实际执行可能晚几分钟。

`Snapshot` workflow 每个整 5 分钟运行一次，也会在每轮 `Ingest` 完成后触发。它使用同一个 `INGEST_TOKEN`，先生成并上传快照，再切换当前指针；上传或校验失败时线上继续使用上一有效版本。

## 配置

在仓库的 **Settings → Secrets and variables → Actions** 中设置：

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `INGEST_TOKEN` | Secret | 与 Worker 的 `INGEST_TOKEN` secret 相同 |
| `PREWARM_TRANSLATIONS` | Variable | 可选，设为 `0` 可关闭翻译预热与回填（HN 标题/正文、Reddit 标题、GitHub 简介、AI 来源标题/摘要；Product Hunt 保留产品名并翻译简介） |
| `AI_MODERATION` | Variable | 可选，设为 `0` 可关闭社区内容 AI 审核（V2EX / NodeSeek / LINUX DO） |

Worker 地址直接写在 `.github/workflows/ingest.yml` 里（目前是 `https://jing.show`）；换自定义域名时同步修改即可。

`INGEST_TOKEN` 只保存在 GitHub Actions Secrets 中，不会随仓库公开。fork 的 Pull Request 默认拿不到该 secret。

## 本地运行

```bash
npm ci
npm run typecheck
npm test
JINGKAN_BASE_URL=http://127.0.0.1:8787 INGEST_TOKEN=<local-dev-token> npm run ingest
JINGKAN_BASE_URL=http://127.0.0.1:8787 INGEST_TOKEN=<local-dev-token> npm run backfill
JINGKAN_BASE_URL=http://127.0.0.1:8787 INGEST_TOKEN=<local-dev-token> npm run moderate
JINGKAN_BASE_URL=http://127.0.0.1:8787 INGEST_TOKEN=<local-dev-token> npm run snapshot
```

`npm run backfill` 会补抓取轮次没翻完的 HN 标题和正文：最多 12 轮、每轮 20 条、8 分钟墙钟上限；workflow 在每次 ingest 之后自动执行，`continue-on-error`，失败不影响抓取结果。

`npm run moderate` 在回填之后调用 Worker 的 `/api/admin/moderate`，分批审核 V2EX / NodeSeek / LINUX DO 的新条目：垃圾广告/引流和低质量水帖直接隐藏。最多 6 轮、每轮 60 条、3 分钟墙钟上限；连续两轮没有进展（例如 Workers AI 不可用）就停止。两次调用间隔里如果有新条目，会在下一轮 workflow 继续。

`npm run snapshot` 导出全部来源、构建热门/上升榜和各日期筛选的预序列化响应，再上传约 29 MB 的当前数据包。构建完全在 GitHub runner 上完成，不占用 Cloudflare 免费 Worker 的 10ms CPU 配额。

## 维护提示

- 公开发布仓库的定时 workflow 在 60 天没有仓库活动后可能被 GitHub 自动禁用；仓库已内置 `Keepalive` workflow，每月 1 日自动提交一次来重置计时。
- 建议开启分支保护，并要求外部贡献者的 Actions 运行需人工批准。

## R2 增量快照

`Snapshot` 每 5 分钟及 Ingest 结束后运行。首次导出 35 天窗口，之后按条目修订号读取变化与隐藏记录，未变化的数据从 R2 复用；排名和日期窗口仍会重算。Worker 为导出设置每日 200 万读取行预算，触及预算或 D1 额度后自动退避到下一个 UTC 零点，现有快照持续提供服务。

v2 快照按目标 8 MiB 拆包，最多 32 个包；manifest 包含大小、SHA-256、响应范围、分片 ID 索引和轻量排名目录。全部上传校验成功后才切换当前指针；v1 读取仍兼容。

仅转换现有 R2 快照格式、跳过 D1 时，可手动运行：

```bash
gh workflow run snapshot.yml --repo lzz313/jingkan-ingest -f repack_from_r2=true
```

此操作保留原内容更新时间和增量水位，不代表重新抓取了来源数据。正常定时运行会恢复 D1 增量同步。
