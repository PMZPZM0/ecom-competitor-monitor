# 经营罗盘团队网页版

这是经营罗盘的可独立部署团队协作服务。它提供运营报表共享、店铺团队、成员角色、邀请码、设备授权码和整店/品类/单品经营数据看板。

桌面端与本服务使用同一套运营指标核心，因此净 GSV、ROI 和推广费率的计算规则一致：净 GSV = 支付金额 - 成功退款金额；推广类型整体费率 = 类型总花费 ÷ 关联商品净 GSV；展开后的计划费率 = 计划花费 ÷ 计划推广成交金额。

## 功能范围

- QQ 邮箱 + 团队邀请码免验证码注册、账号密码登录和团队切换。
- 一个店铺对应一个独立团队，成员按授权查看一个或多个店铺团队的数据。
- 团队管理员维护成员备注、角色、人数上限、邀请码、同步设备和店铺访问权限。
- 平台管理员控制自助创建团队，创建、编辑、封禁、恢复或永久删除团队，并调整人数和存储额度。
- 整店总览、品类 360、商品排行、数据仓库和统一日期/店铺筛选。
- 指标卡环比自动跟随当前日期口径：日、周、月、近 7 日、近 15 日和自定义区间分别对比对应前一周期；无同期数据时不补零、不猜测。
- 整店、品类和商品均可从经营表与推广表字段新增自定义指标卡；整店自定义指标可直接加入多选趋势，系列使用独立比例尺。
- 整店总览同屏展示类目净 GSV、销售占比、推广花费、花费占比和类目推广费率，并明确显示计算公式。
- 品类 360 与商品排行提供跟随当前日期、店铺和周期的 TOP 10 销售/花费图、费率标记及相互联动的品类/型号筛选。
- 品类与商品经营矩阵在每一行直接展示当前周期环比；支付、退款、净 GSV、花费、推广成交、ROI、费率和自定义字段均按对应实体独立计算，品类和商品可分别关闭环比。
- 经营矩阵可从标准化经营与付费字段中选择最多 8 个附加数据列；附加列支持排序、拖动换位、上下微调，并按用户与团队分别持久化。
- 大数据量矩阵复用筛选结果、汇总和同期实体索引，展开推广计划、切换排序与调整字段时避免重复扫描全部报表。
- 桌面与手机分别优化信息密度；移动端将经营矩阵转为可读卡片，推广计划在独立抽屉中打开，避免大表格展开卡顿。
- 初始化异常时显示错误原因和重试入口，不会把暂时的接口失败呈现为空白页面。
- 日/周/月/自定义周期报表支持多文件批量导入、逐份进度、预览、日期修正、失败重试、上传人权限隔离，以及按“店铺 > 统计日期 > 报表”的三级归档和批量管理。
- 商品 ID、型号、店铺和品类映射支持模板下载、导入、手工维护、分页批量修改与导出；修改保留追加式版本链，重复或过期提交会被拦截。
- 销售扣除完整展示历史记录，只有命中当前店铺和日期范围的扣除参与净 GSV、经营 ROI 与费率重算。
- 桌面端设备授权码只读同步，支持店铺范围、设备上限、撤销和来源去重。

## 数据边界

- 云端保存：团队、店铺、成员关系、邀请码、设备授权、运营报表和商品资料映射。
- 云端不保存：淘宝登录、Cookie、浏览器资料、商品价格抓取证据、飞书凭证、模型 Key、QwenPaw 运行时和桌面端聊天记录。
- 桌面端同步方向：云端团队报表下发到本机；本机手动导入报表保留在本机，不会自动回传。
- 每台桌面应用必须使用团队管理员创建的授权码绑定，管理员可以限制设备数量、可同步店铺并随时撤销授权。

## Docker Compose 部署

要求 Docker Engine 24+ 与 Docker Compose v2。

```bash
git clone https://github.com/PMZPZM0/ecom-competitor-monitor.git
cd ecom-competitor-monitor/cloud-data-hub
cp .env.example .env
```

编辑 `.env`，至少替换以下两个随机值：

- `CLOUD_ADMIN_PASSWORD`：首次启动创建平台管理员的密码。
- `MANAGED_CODE_ENCRYPTION_SECRET`：用于加密可恢复的邀请码和设备授权码，部署后不要更换。

启动服务：

```bash
docker compose up -d --build
docker compose logs -f operations-cloud
```

默认监听 `4328`。生产环境请在 Caddy、Nginx 或 Cloudflare Tunnel 后提供 HTTPS，再由浏览器访问公开域名。`COOKIE_SECURE=true` 是生产默认值；仅在本机 HTTP 调试时可改为 `false`。

升级时在仓库根目录拉取新版本后执行：

```bash
cd cloud-data-hub
docker compose up -d --build
```

命名卷 `operations-cloud-data` 保存团队数据库与上传报表。升级、重建容器或更新镜像都不会删除它；请按实际团队数据价值做异机备份。

## Node.js + systemd 部署

要求 Node.js 20+，建议 Node.js 22 LTS。以下示例假定仓库目录为 `/opt/ecom-operations-cloud-hub`：

```bash
cd /opt/ecom-operations-cloud-hub
npm ci --omit=dev
sudo install -d -o ubuntu -g ubuntu /var/lib/ecom-operations-cloud-hub
sudo cp cloud-data-hub/.env.example /etc/ecom-operations-cloud-hub.env
sudoedit /etc/ecom-operations-cloud-hub.env
```

将 `cloud-data-hub/ecom-operations-cloud-hub.service` 复制到 `/etc/systemd/system/` 后启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ecom-operations-cloud-hub
sudo systemctl status ecom-operations-cloud-hub
```

使用 Caddy 时，可参考 `cloud-data-hub/jvspp-cloud-hub.caddy`，将其中的域名改为自己的域名后加载配置。配置完成后检查：

```bash
curl -fsS http://127.0.0.1:4328/api/health
```

## 团队初始化与桌面端连接

1. 使用 `.env` 中的 `CLOUD_ADMIN_USERNAME` 和 `CLOUD_ADMIN_PASSWORD` 登录团队网页。
2. 在平台管理中创建一个店铺团队；一个店铺对应一个独立团队。
3. 在团队管理中生成“同步授权码”，选择可同步店铺并设置设备上限。
4. 同事在桌面端进入“运营数据 > 数据仓库 > 云端团队数据”，输入网页地址与授权码后绑定电脑。
5. 同事点击“立即同步”获取已授权店铺的团队报表，并在本机继续分析。

## 本地开发与测试

在仓库根目录安装依赖后，运行团队服务测试：

```bash
npm ci
cd cloud-data-hub
npm test
npm start
```

开发服务器默认地址为 `http://127.0.0.1:4328`。本地 HTTP 开发请在 `.env` 设置 `COOKIE_SECURE=false`，并使用一个空的数据目录。

桌面开发版与团队网页共享同一套经营口径，但属于两个独立运行面：根目录的 React/Electron 应用用于本机分析和价格监控，`cloud-data-hub` 用于团队共享报表。发布时两端版本号保持一致；团队网页可以单独部署，不依赖 Electron，也不会获得本机淘宝账号、Cookie 或价格证据。

## 运行安全

- 不要提交 `.env`、`.runtime-env`、`data/`、上传报表或数据库备份。
- 使用 HTTPS、强管理员密码和稳定的 `MANAGED_CODE_ENCRYPTION_SECRET`。
- 仅把 `4328` 暴露给反向代理；不要直接向公网开放未加 HTTPS 的端口。
- 定期备份数据目录，并在升级前验证 `GET /api/health`。
- 团队成员、邀请码、授权码和上传报表属于业务数据，应按公司权限与保留策略管理。
