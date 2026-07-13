# 天猫竞品监控本地部署 App

本项目是一个本地运行的天猫/淘宝竞品监控工作台，用于添加商品链接、抓取主图/SKU 图/SKU 价格、每 10 分钟自动监控，并生成 AI 或本地规则分析。

## 功能

- 商品链接管理：录入天猫/淘宝商品链接、分组、启停监控。
- 图片与价格抓取：提取主图、SKU 图、SKU 价格与价格区间。
- 定时监控：后端默认每 10 分钟运行一次抓取任务。
- 淘宝账号授权：支持启动独立 Chrome 打开淘宝登录页，用淘宝 App 扫码登录并同步 taobao/tmall Cookie；也支持本地保存你自己的 Cookie 会话用于抓取。
- AI 分析：配置 OpenAI 兼容接口后生成 AI 分析；未配置时使用本地规则输出趋势洞察。
- 本地数据：数据保存在 `server/data/db.json`。
- 飞书联动：项目内置官方 `@larksuite/cli`，支持扫码授权、自动写飞书价格文档，以及通过群自定义机器人发送价格卡片。

## 目录结构

```text
server/
  index.js                 # Express API 入口
  data/db.json             # 本地数据文件，首次运行自动创建
  routes/                  # 预留路由分层目录
  services/
    analysisService.js     # AI/规则分析
    authService.js         # 淘宝开放平台 OAuth 辅助
    browserService.js      # 本地 Chrome 扫码登录与渲染页面抓取
    monitorService.js      # 10 分钟监控调度
    tmallScraper.js        # 商品页面抓取与解析
  storage/db.js            # JSON 数据读写
  utils/env.js             # .env 加载

src/
  components/ui/           # shadcn 风格基础组件
  features/
    analysis/              # AI 分析面板
    auth/                  # 淘宝授权与 Cookie 会话
    dashboard/             # 指标卡
    monitoring/            # 抓取记录
    products/              # 商品表格与录入
  lib/                     # API 客户端与工具函数
  types/                   # 业务类型
```

## 本地运行

```bash
npm install
copy .env.example .env
npm run dev
```

`npm install` 会自动安装项目内的飞书官方 CLI。首次使用请在“数据记录 → 飞书价格提醒”完成应用创建和扫码授权；无需手动执行终端命令。

前端默认地址：`http://localhost:5173`  
后端默认地址：`http://localhost:4317`

## 环境变量

复制 `.env.example` 为 `.env` 后按需配置：

- `OPENAI_API_KEY`：AI 分析用；留空则使用本地规则。
- `OPENAI_BASE_URL`：OpenAI 兼容接口地址。
- `OPENAI_MODEL`：AI 分析模型。
- `CHROME_PATH`：可选，自定义 Chrome/Edge 路径。
- `TAOBAO_BROWSER_PORT`：可选，本地扫码登录 Chrome 调试端口，默认 `9223`。
- `TAOBAO_APP_KEY` / `TAOBAO_APP_SECRET` / `TAOBAO_REDIRECT_URI`：可选，淘宝开放平台 OAuth 参数。

## 注意

淘宝/天猫页面可能存在登录、地区、反爬、验证码或动态渲染。当前抓取器会优先使用扫码后的本地 Chrome 登录态渲染页面，再从 HTML、结构化 JSON 和页面文本中提取图片与价格；如果触发登录或验证，会记录错误状态，不会绕过平台安全机制。
