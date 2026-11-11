# 静看抓取任务

静看（JingKan）的定时抓取仓库。它只负责从各个来源拉取内容，并通过 Worker 的 `/api/ingest` 接口写入 D1；Worker、Web 界面和数据库配置在私有仓库中。

## 抓取来源

- X
- V2EX
- NodeSeek
- LINUX DO
- Hacker News
- GitHub Trending

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

## 配置

在仓库的 **Settings → Secrets and variables → Actions** 中设置：

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `INGEST_TOKEN` | Secret | 与 Worker 的 `INGEST_TOKEN` secret 相同 |
| `PREWARM_TRANSLATIONS` | Variable | 可选，设为 `0` 可关闭 HN / GitHub 的翻译预热 |

Worker 地址直接写在 `.github/workflows/ingest.yml` 里（目前是 `https://jingkan.lzz313-690.workers.dev`）；换自定义域名时同步修改即可。

`INGEST_TOKEN` 只保存在 GitHub Actions Secrets 中，不会随仓库公开。fork 的 Pull Request 默认拿不到该 secret。

## 本地运行

```bash
npm ci
npm run typecheck
npm test
JINGKAN_BASE_URL=http://127.0.0.1:8787 INGEST_TOKEN=<local-dev-token> npm run ingest
```

## 维护提示

- 公开发布仓库的定时 workflow 在 60 天没有仓库活动后可能被 GitHub 自动禁用；仓库已内置 `Keepalive` workflow，每月 1 日自动提交一次来重置计时。
- 建议开启分支保护，并要求外部贡献者的 Actions 运行需人工批准。
