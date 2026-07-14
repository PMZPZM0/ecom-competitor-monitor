import { BellRing, BookOpen, CircleAlert, CircleCheck, CloudDownload, Download, KeyRound, ListChecks, Search, ShieldCheck, TimerReset } from 'lucide-react'

const sections = [
  ['guide-start', '快速开始'],
  ['guide-monitor', '监控逻辑'],
  ['guide-account', '账号授权'],
  ['guide-product', '添加与抓取'],
  ['guide-price', '价格与优惠'],
  ['guide-queue', '监控队列'],
  ['guide-feishu', '飞书提醒'],
  ['guide-media', '素材与买家秀'],
  ['guide-risk', '采集保护'],
  ['guide-update', '版本更新'],
  ['guide-troubleshoot', '异常处理'],
] as const

const steps = [
  ['授权账号', '先添加并检测普通账号；需要礼金价或 88VIP 价时，再添加对应账号。'],
  ['添加商品', '可粘贴淘宝/天猫链接，也可切换商品 ID 模式直接输入纯数字 ID。'],
  ['核对结果', '第一次抓取后打开“核对价格”和 SKU“明细”，确认账号、SKU 和优惠证据。'],
  ['设置监控价', '每个 SKU 单独设置阈值；价格低于阈值时才触发飞书低价提醒。'],
  ['保存计划', '在商品卡片底部设置开始日期、时间和重复间隔。'],
  ['打开两层开关', '同时启用“本商品”和“全局自动监控”，定时计划才会执行。'],
  ['查看队列', '在“监控队列”按执行顺序检查下次时间、账号、周期和运行状态。'],
] as const

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return <section id={id} className="scroll-mt-24 border-t border-slate-200 py-7 first:border-t-0 first:pt-0"><h2 className="text-lg font-semibold text-slate-950">{title}</h2><div className="mt-4 space-y-4 text-sm leading-7 text-slate-650">{children}</div></section>
}

function Checklist({ items }: { items: string[] }) {
  return <ul className="space-y-2">{items.map((item) => <li key={item} className="flex items-start gap-2"><CircleCheck className="mt-1.5 h-4 w-4 shrink-0 text-emerald-600" /><span>{item}</span></li>)}</ul>
}

export function HelpCenter() {
  return (
    <div className="grid grid-cols-[220px_minmax(0,1fr)] items-start gap-8 max-[1180px]:grid-cols-1">
      <aside className="sticky top-24 border-r border-slate-200 pr-5 max-[1180px]:static max-[1180px]:border-b max-[1180px]:border-r-0 max-[1180px]:pb-4 max-[1180px]:pr-0">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><BookOpen className="h-4 w-4 text-blue-600" />说明目录</div>
        <nav className="mt-3 space-y-1 max-[1180px]:flex max-[1180px]:flex-wrap max-[1180px]:gap-1 max-[1180px]:space-y-0">
          {sections.map(([id, label]) => <a key={id} href={`#${id}`} className="block rounded px-2 py-1.5 text-sm text-slate-600 hover:bg-blue-50 hover:text-blue-700">{label}</a>)}
        </nav>
      </aside>

      <main className="min-w-0 max-w-5xl pb-12">
        <div className="border-b border-slate-200 pb-6">
          <div className="flex items-center gap-2 text-sm font-medium text-blue-700"><BookOpen className="h-4 w-4" />电商竞品监控使用说明</div>
          <h1 className="mt-2 text-2xl font-semibold text-slate-950">从首次授权到自动预警的完整流程</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">按本页顺序配置即可。软件所有数据默认保存在当前电脑；暂停监控不会删除商品、价格记录、监控价或定时计划。</p>
        </div>

        <Section id="guide-start" title="快速开始：7 步完成首次监控">
          <div className="grid grid-cols-2 gap-3 max-[900px]:grid-cols-1">
            {steps.map(([title, description], index) => (
              <div key={title} className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 rounded-md border border-slate-200 bg-white p-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-600 text-sm font-semibold text-white">{index + 1}</div>
                <div><div className="font-semibold text-slate-900">{title}</div><div className="mt-1 text-sm leading-6 text-slate-600">{description}</div></div>
              </div>
            ))}
          </div>
          <div className="flex items-start gap-2 border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-amber-900"><CircleAlert className="mt-1.5 h-4 w-4 shrink-0" /><span>第一次使用时，先用 1 个商品完成授权、抓取、核价和定时测试，确认价格与前台一致后再批量添加。</span></div>
        </Section>

        <Section id="guide-monitor" title="监控逻辑：三个条件同时满足才会自动抓取">
          <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] items-stretch gap-2 max-[900px]:grid-cols-1">
            {[
              ['全局自动监控', '控制整个软件是否执行后台定时任务'],
              ['本商品已启用', '决定这个商品是否进入监控队列'],
              ['到达计划时间', '单次定时或循环监控只生效一种'],
              ['开始抓取', '按账号池和并发限制执行'],
            ].map(([title, text], index) => <div key={title} className="contents max-[900px]:block"><div className={`rounded-md border p-3 ${index === 3 ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-white'}`}><div className="font-semibold text-slate-900">{title}</div><div className="mt-1 text-xs leading-5 text-slate-500">{text}</div></div>{index < 3 && <div className="flex items-center justify-center font-semibold text-slate-300 max-[900px]:py-1">+</div>}</div>)}
          </div>
          <Checklist items={[
            '顶部“全局自动监控”是总开关。暂停后，所有商品都不会按时间自动抓取，但单品启停与计划会保留。',
            '商品卡片“启用本商品”只影响当前商品。启用后会进入监控队列；移出队列不会删除商品和历史数据。',
            '商品卡片底部二选一：单次定时只执行所选日期时间并在完成后暂停；循环监控只按分钟周期执行。',
            '手动点击“抓取”不依赖定时计划，但仍会遵守当前账号状态和采集保护设置。',
          ]} />
        </Section>

        <Section id="guide-account" title="账号授权与账号类型">
          <div className="flex items-start gap-3"><KeyRound className="mt-1 h-5 w-5 shrink-0 text-blue-600" /><div><p>打开“账号授权”，填写账号备注并选择类型，然后点击扫码授权。淘宝 App 扫码完成后，必须点击“检测登录”，状态有效才会参与抓取。</p></div></div>
          <div className="overflow-x-auto"><table className="w-full border-collapse text-left text-sm"><thead><tr className="border-y border-slate-200 bg-slate-50 text-slate-600"><th className="px-3 py-2">账号类型</th><th className="px-3 py-2">主要用途</th><th className="px-3 py-2">重要说明</th></tr></thead><tbody className="divide-y divide-slate-100"><tr><td className="px-3 py-3 font-medium">普通账号</td><td className="px-3 py-3">普通价、活动价、惊喜立减价、淘金币价</td><td className="px-3 py-3">礼金与 88VIP 计算也需要普通价基准，建议至少保持一个普通账号在线。</td></tr><tr><td className="px-3 py-3 font-medium">礼金账号</td><td className="px-3 py-3">首单礼金、新人专享等资格价</td><td className="px-3 py-3">没有真实礼金资格时显示“未获取”，不会拿标价代替。</td></tr><tr><td className="px-3 py-3 font-medium">88VIP 账号</td><td className="px-3 py-3">88VIP 专享价格</td><td className="px-3 py-3">必须由对应账号页面返回可信权益依据。</td></tr></tbody></table></div>
          <Checklist items={['“一键检测全部”只检查登录状态，不会开始抓取。', '账号失效时优先点击“重新授权”，不必删除账号卡片。', '一个账号固定使用自己的浏览器资料目录，关闭抓取窗口不会删除登录状态。']} />
        </Section>

        <Section id="guide-product" title="添加商品与抓取">
          <div className="flex items-start gap-3"><Search className="mt-1 h-5 w-5 shrink-0 text-blue-600" /><div><p><strong>链接模式：</strong>粘贴淘宝或天猫商品链接，软件会自动删除跟踪参数，只保留平台、商品路径和商品 ID。</p><p className="mt-2"><strong>商品 ID 模式：</strong>只输入纯数字 ID，选择淘宝或天猫，软件会自动补全有效地址前缀。</p></div></div>
          <Checklist items={[
            '单个添加会创建商品并立即抓取；新商品默认处于“本商品未启用”，先核对数据再加入监控。',
            '批量添加用于多个新链接或 ID，一次最多 30 个；每组最多 5 个并发，其余按顺序排队。',
            '商品简称不是必填。抓取成功后优先展示平台真实标题、店铺和型号。',
            '抓取完成后先检查主图、SKU 数量、普通价和账号专享价；有疑问时打开“核对价格”。',
          ]} />
        </Section>

        <Section id="guide-price" title="价格、优惠明细与监控价">
          <div className="overflow-x-auto"><table className="w-full border-collapse text-left text-sm"><thead><tr className="border-y border-slate-200 bg-slate-50 text-slate-600"><th className="px-3 py-2">价格</th><th className="px-3 py-2">含义</th><th className="px-3 py-2">未获取时</th></tr></thead><tbody className="divide-y divide-slate-100"><tr><td className="px-3 py-3 font-medium text-sky-700">普通价</td><td className="px-3 py-3">平台公共优惠后的普通账号基准价</td><td className="px-3 py-3">显示未验证，不使用标价猜测</td></tr><tr><td className="px-3 py-3 font-medium text-teal-700">国补价</td><td className="px-3 py-3">普通价减去当前 SKU 明确返回的政府补贴</td><td className="px-3 py-3">显示未获取国补价</td></tr><tr><td className="px-3 py-3 font-medium text-rose-700">惊喜立减价</td><td className="px-3 py-3">国补价或普通价再减明确的惊喜立减权益</td><td className="px-3 py-3">显示当前 SKU 无或未获取</td></tr><tr><td className="px-3 py-3 font-medium text-amber-700">淘金币价</td><td className="px-3 py-3">当前价格层级再减该账号和 SKU 的淘金币抵扣</td><td className="px-3 py-3">显示无淘金币</td></tr><tr><td className="px-3 py-3 font-medium text-orange-700">礼金价</td><td className="px-3 py-3">礼金账号资格价，与普通价独立核对</td><td className="px-3 py-3">显示未获取</td></tr><tr><td className="px-3 py-3 font-medium text-violet-700">88VIP 价</td><td className="px-3 py-3">88VIP 账号专享价，与普通价独立核对</td><td className="px-3 py-3">显示未获取</td></tr></tbody></table></div>
          <Checklist items={[
            '“核对价格”逐 SKU 展示证据、金额和公式；验证不闭合时不会保存猜测值。',
            '“优惠明细”按标价、商品优惠、账号权益和最终价格分层展示，每个 SKU 独立。',
            '监控价必须按 SKU 单独设置。价格更新不会清除监控价。',
            '任一已验证价格低于该 SKU 监控价时，才进入飞书低价提醒判断。',
          ]} />
        </Section>

        <Section id="guide-queue" title="监控队列怎么用">
          <div className="flex items-start gap-3"><ListChecks className="mt-1 h-5 w-5 shrink-0 text-blue-600" /><p>“监控队列”只显示已启用商品，默认按下次抓取时间排列。全局暂停时商品仍保留在队列中，但状态会统一显示“等待全局开启”。</p></div>
          <Checklist items={['队列序号表示当前页面中的执行先后；下次时间相同的商品仍受最多 5 个并发限制。', '“抓取”只立即执行当前商品，并遵守账号状态和采集保护。', '“移出”只暂停本商品自动监控，商品卡片、历史价格、监控价和计划都保留。', '在总览或分类重新点击“启用本商品”，商品会立即回到队列。']} />
        </Section>

        <Section id="guide-feishu" title="飞书文档与机器人提醒">
          <div className="flex items-start gap-3"><BellRing className="mt-1 h-5 w-5 shrink-0 text-blue-600" /><p>在“账号授权”完成飞书扫码授权后，可创建价格文档；群机器人需要在飞书群中创建自定义机器人，再将 Webhook 和可选签名密钥填入软件。</p></div>
          <Checklist items={[
            '飞书文档：每次成功抓取后写入店铺、型号、SKU 和各类价格，不受机器人提醒冷却影响。',
            '机器人提醒：仅在某个 SKU 的有效价格低于该 SKU 监控价时发送。',
            '提醒冷却只抑制同一商品、同一 SKU 的重复消息，不会暂停抓取、趋势记录或文档同步。',
            '保存配置后先点击“发送测试”，确认机器人可达，再等待真实低价触发。',
          ]} />
        </Section>

        <Section id="guide-media" title="素材包与买家秀">
          <div className="flex items-start gap-3"><Download className="mt-1 h-5 w-5 shrink-0 text-blue-600" /><p>素材包按 800 主图、750 主图、SKU 图、详情图和真实视频分类打包。买家秀可预览图片、视频和文案，也可单条或批量下载。</p></div>
          <Checklist items={['买家秀抓取失败时使用“仅重试买家秀”，不会重新计算价格或覆盖 SKU 数据。', '本次失败但历史曾成功时，预览继续显示上次有效缓存，并明确标注缓存状态。', '生成 ZIP 时等待状态变为“下载已开始”后再关闭软件。', '没有真实视频或媒体评价时不会生成占位内容。']} />
        </Section>

        <Section id="guide-risk" title="采集保护、并发和浏览器">
          <div className="flex items-start gap-3"><ShieldCheck className="mt-1 h-5 w-5 shrink-0 text-blue-600" /><p>“采集保护”是本软件设置的访问间隔，不等于淘宝账号被风控。倒计时期间手动抓取按钮会说明剩余时间，可在账号授权页按账号类型调整或关闭。</p></div>
          <Checklist items={['批量添加、批量抓取和自动监控每批最多同时处理 5 个商品，其余排队。', '每个账号使用独立浏览器资料目录，抓取窗口在后台或最小化运行。', '频繁刷新、账号掉线、验证码或登录跳转属于平台状态；软件不会绕过安全验证。', '长期运行建议保留合理间隔；集中测试后再恢复采集保护。']} />
        </Section>

        <Section id="guide-update" title="检查并安装新版本">
          <div className="flex items-start gap-3"><CloudDownload className="mt-1 h-5 w-5 shrink-0 text-blue-600" /><p>侧边栏底部常驻“检查软件更新”。软件启动后会连接本项目 GitHub Releases 检查最新正式版，发现新版本时入口会高亮。</p></div>
          <Checklist items={['点击更新入口可查看当前版本、最新版本、发布日期和更新说明。', '软件会根据 Windows、macOS Intel 或 macOS Apple Silicon 自动选择对应安装包。', '国内网络可优先使用“加速下载”；镜像不可用时切换“GitHub 原地址”。', '下载后先退出软件，再运行安装包覆盖安装；商品、历史记录、账号资料和飞书配置不会删除。', 'GitHub 暂时无法连接只会影响检查更新，不会影响本地监控与抓取。']} />
        </Section>

        <Section id="guide-troubleshoot" title="常见异常与处理顺序">
          <div className="space-y-3">
            {[
              ['抓不到价格或价格不一致', '确认商品链接和 SKU → 检查普通账号在线 → 检查账号类型 → 打开核对价格 → 重新抓取。'],
              ['买家秀只有文字或数量很少', '打开买家秀预览查看状态 → 点击仅重试买家秀 → 检查账号登录 → 保留历史成功缓存。'],
              ['计划不执行', '检查页面顶部全局自动监控 → 检查本商品已启用 → 检查开始时间和周期 → 到监控队列查看下次时间。'],
              ['飞书没有消息', '发送测试 → 检查 SKU 监控价 → 确认本次价格低于阈值 → 检查提醒开关和冷却。'],
              ['账号检测正常但商品要求登录', '该商品可能出现临时登录跳转或平台验证；先重新授权对应账号，再单品重试，不要降低价格验证规则。'],
              ['macOS 无法打开或运行很慢', '在系统设置的隐私与安全性中允许打开；首次启动和首次浏览器授权会较慢，避免同时启动多个抓取任务。'],
            ].map(([title, text]) => <details key={title} className="group border-b border-slate-200 pb-3"><summary className="cursor-pointer list-none font-semibold text-slate-900">{title}</summary><p className="mt-2 text-slate-600">{text}</p></details>)}
          </div>
        </Section>

        <div className="flex items-start gap-2 border-l-4 border-sky-400 bg-sky-50 px-4 py-3 text-sm leading-6 text-sky-900"><TimerReset className="mt-1 h-4 w-4 shrink-0" /><span>数据、账号浏览器目录、Cookie、飞书令牌和 Webhook 默认只保存在当前电脑。分享截图前请隐藏店铺名、商品名、商品 ID、SKU ID、图片和账号信息。</span></div>
      </main>
    </div>
  )
}
