# 静看抓取任务

静看（JingKan）的统一抓取与发布仓库。每 5 分钟读取 R2 生成状态及待处理输入，按时段抓取来源，完成过滤、审核、翻译、热度计算并发布不可变快照。Worker、Web 界面及存储配置在私有仓库中，运行时不依赖 D1。

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

`Ingest` 每 5 分钟检查事件、翻译/审核积压与排名，来源在上述时段且距上次尝试至少 10 分钟时抓取。手动运行默认强制抓取。`Snapshot` 只手动重打包，不自动运行；两个 workflow 共用 `jingkan-publisher` concurrency。上传或校验失败时线上继续使用旧版本。

## 配置

在仓库的 **Settings → Secrets and variables → Actions** 中设置：

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `INGEST_TOKEN` | Secret | 与 Worker 的 `INGEST_TOKEN` secret 相同 |
| `PREWARM_TRANSLATIONS` | Variable | 可选，设为 `0` 可关闭翻译预热与回填（HN 标题/正文、Reddit 标题、GitHub 简介、AI 来源标题/摘要；Product Hunt 保留产品名并翻译简介） |

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

`npm run ingest` 运行统一发布器；`FORCE_FETCH=1` 强制立即抓取。`backfill` 和 `moderate` 保留为统一发布器的兼容命令，均获取同一发布租约，不再调用旧 SQL 管理接口。

每轮最多审核 60 个 pending 社区记录，审核服务失败保持 pending；翻译约 30 个标题、30 个简介和 20 个 HN 正文，失败不阻塞其他内容发布。社区审核不能通过环境开关绕过；旧 `AI_MODERATION` variable 不再使用。品牌/产品标题保留原文。

`npm run snapshot` 只重打包已有 R2 数据，保留来源更新时间，跳过新输入、抓取及 AI。构建在 GitHub runner 上完成。

## 维护提示

- 公开发布仓库的定时 workflow 在 60 天没有仓库活动后可能被 GitHub 自动禁用；仓库已内置 `Keepalive` workflow，每月 1 日自动提交一次来重置计时。
- 建议开启分支保护，并要求外部贡献者的 Actions 运行需人工批准。

## R2 状态与发布

首次从当前 R2 公开快照启动，保留既有可见内容；以后从 `generatorStateParts` 恢复完整状态，包括被隐藏/待审核条目、verdict/hash 与观察时间。文章保留 35 天，X 的两个提供方、HN 旧链接和原发表时间规则保持不变；互动指标每小时更新，热度跨门槛和内容修改立即更新。

公开 canonical、ID 索引、目录和预序列化响应只含通过规则与审核的内容。私有生成状态与公开数据在同一不可变包中，但只能通过鉴权管理接口下载。v2 按目标 8 MiB 拆包、最多 32 包，读取基础包和上传时均校验 SHA-256；兼容 v1。

控制 DO 保存 180 秒发布租约、每 60 秒续租。激活必须同时持有有效租约、匹配前一版本，并通过 R2 条件写；失去锁或版本冲突立即停止激活。只有发布成功后才确认输入日志；崩溃重试可幂等回放，超 35 天的事件与 enrichment 缓存分批清理。全来源失败/仅重算排名不会伪造内容更新时间。

仅重打包现有数据：

```bash
gh workflow run snapshot.yml --repo lzz313/jingkan-ingest
```

发布器要求已有合法 R2 基础快照；空 bucket 需先导入基础快照，损坏或缺失时停止以保护线上内容。
