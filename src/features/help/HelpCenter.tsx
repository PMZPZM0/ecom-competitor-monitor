import { ArrowRight, BadgeDollarSign, BellRing, BookOpen, CalendarClock, ChevronDown, CircleAlert, CircleCheck, ClipboardCheck, CloudDownload, Download, KeyRound, ListChecks, PlayCircle, Power, Search, TimerReset, WandSparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const sections = [
  ['guide-start', '快速开始'],
  ['guide-launch', '启动方式'],
  ['guide-monitor', '监控逻辑'],
  ['guide-account', '账号授权'],
  ['guide-product', '添加与抓取'],
  ['guide-price', '价格与优惠'],
  ['guide-queue', '监控计划'],
  ['guide-capture-queue', '抓取进度'],
  ['guide-feishu', '飞书提醒'],
  ['guide-media', '素材与买家秀'],
  ['guide-ai-creation', 'AI 创作'],
  ['guide-update', '版本更新'],
  ['guide-troubleshoot', '异常处理'],
] as const

const steps = [
  { title: '授权账号', caption: '在设置中心扫码', icon: KeyRound, tone: 'border-blue-500 bg-blue-50 text-blue-700', page: 'settings' },
  { title: '添加商品', caption: '粘贴链接或商品 ID', icon: Search, tone: 'border-cyan-500 bg-cyan-50 text-cyan-700', page: 'monitoring' },
  { title: '核对价格', caption: '检查公式与 SKU', icon: ClipboardCheck, tone: 'border-emerald-500 bg-emerald-50 text-emerald-700', page: 'monitoring' },
  { title: '设置监控价', caption: '每个 SKU 填阈值', icon: BadgeDollarSign, tone: 'border-amber-500 bg-amber-50 text-amber-700', page: 'monitoring' },
  { title: '保存计划', caption: '选择单次或循环', icon: CalendarClock, tone: 'border-violet-500 bg-violet-50 text-violet-700', page: 'monitoring' },
  { title: '打开开关', caption: '本商品 + 全局', icon: Power, tone: 'border-green-600 bg-green-50 text-green-700', page: 'monitoring' },
  { title: '查看任务', caption: '打开右侧任务中心', icon: ListChecks, tone: 'border-slate-500 bg-slate-50 text-slate-700', page: 'monitoring' },
] as const

function Section({ id, title, summary, icon: Icon, featured = false, children }: { id: string; title: string; summary: string; icon: LucideIcon; featured?: boolean; children: React.ReactNode }) {
  return <details id={id} open={featured} className="group scroll-mt-24 border-t border-slate-200 py-2 first:border-t-0 first:pt-0"><summary className="flex cursor-pointer list-none items-center gap-3 py-4"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-700 group-open:bg-blue-50 group-open:text-blue-700"><Icon className="h-5 w-5" /></span><span className="min-w-0 flex-1"><span className="block text-base font-semibold text-slate-950">{title}</span><span className="mt-0.5 block text-sm text-slate-500">{summary}</span></span><ChevronDown className="h-5 w-5 shrink-0 text-slate-400 transition-transform group-open:rotate-180" /></summary><div className="space-y-4 pb-6 pl-12 text-sm leading-7 text-slate-650 max-[700px]:pl-0">{children}</div></details>
}

function Checklist({ items }: { items: string[] }) {
  return <ul className="space-y-2">{items.map((item) => <li key={item} className="flex items-start gap-2"><CircleCheck className="mt-1.5 h-4 w-4 shrink-0 text-emerald-600" /><span>{item}</span></li>)}</ul>
}

export function HelpCenter({ onNavigate }: { onNavigate: (page: 'settings' | 'monitoring' | 'image-workbench') => void }) {
  function openSection(id: string) {
    const element = document.getElementById(id)
    if (element instanceof HTMLDetailsElement) element.open = true
    element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="grid grid-cols-[220px_minmax(0,1fr)] items-start gap-8 max-[1180px]:grid-cols-1">
      <aside className="sticky top-24 border-r border-slate-200 pr-5 max-[1180px]:static max-[1180px]:border-b max-[1180px]:border-r-0 max-[1180px]:pb-4 max-[1180px]:pr-0">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><BookOpen className="h-4 w-4 text-blue-600" />说明目录</div>
        <nav className="mt-3 space-y-1 max-[1180px]:flex max-[1180px]:flex-wrap max-[1180px]:gap-1 max-[1180px]:space-y-0">
          {sections.map(([id, label]) => <a key={id} href={`#${id}`} onClick={(event) => { event.preventDefault(); openSection(id) }} className="block rounded px-2 py-1.5 text-sm text-slate-600 hover:bg-blue-50 hover:text-blue-700">{label}</a>)}
        </nav>
      </aside>

      <main className="min-w-0 max-w-5xl pb-12">
        <div className="border-b border-slate-200 pb-6">
          <div className="flex items-center gap-2 text-sm font-medium text-blue-700"><BookOpen className="h-4 w-4" />电商竞品监控使用说明</div>
          <h1 className="mt-2 text-2xl font-semibold text-slate-950">从首次授权到自动预警的完整流程</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">按本页顺序配置即可。软件所有数据默认保存在当前电脑；暂停监控不会删除商品、价格记录、监控价或定时计划。</p>
        </div>

        <Section id="guide-start" title="快速开始：照着图走" summary="7 步完成首次监控，先跑通 1 个商品" icon={PlayCircle} featured>
          <div className="grid grid-cols-7 gap-2 max-[1100px]:grid-cols-4 max-[700px]:grid-cols-2">
            {steps.map(({ title, caption, icon: Icon, tone, page }, index) => (
              <button key={title} type="button" onClick={() => onNavigate(page)} className="relative min-h-32 rounded-md border border-slate-200 border-t-4 bg-white p-3 text-left shadow-sm transition-colors hover:border-blue-300 hover:bg-blue-50/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600" aria-label={`${title}，打开对应功能`}>
                <div className={`flex h-9 w-9 items-center justify-center rounded-md border-t-2 ${tone}`}><Icon className="h-5 w-5" /></div>
                <div className="mt-3 text-[11px] font-medium text-slate-400">第 {index + 1} 步</div>
                <div className="mt-0.5 font-semibold leading-5 text-slate-900">{title}</div>
                <div className="mt-1 text-xs leading-5 text-slate-500">{caption}</div>
                {index < steps.length - 1 && <ArrowRight className="absolute -right-3 top-1/2 z-[1] h-4 w-4 -translate-y-1/2 rounded-full bg-white text-slate-300 max-[1100px]:hidden" />}
              </button>
            ))}
          </div>
          <div className="flex items-start gap-2 border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-amber-900"><CircleAlert className="mt-1.5 h-4 w-4 shrink-0" /><span>第一次使用时，先用 1 个商品完成授权、抓取、核价和定时测试，确认价格与前台一致后再批量添加。</span></div>
          <div className="flex items-start gap-2 border-l-4 border-blue-400 bg-blue-50 px-4 py-3 text-blue-900"><BookOpen className="mt-1.5 h-4 w-4 shrink-0" /><span>主菜单按使用顺序只保留“使用说明书、商品监控、AI 创作、数据记录”。右上角“设置中心”集中管理淘宝账号、飞书、AI 模型和软件更新；“商品监控”右侧任务中心集中查看监控计划和抓取进度。</span></div>
        </Section>

        <Section id="guide-launch" title="选择桌面 APP 或浏览器网页" summary="两种方式共用本机服务、账号和商品数据" icon={PlayCircle}>
          <div className="flex items-start gap-3"><PlayCircle className="mt-1 h-5 w-5 shrink-0 text-blue-600" /><p>首次启动会询问使用“桌面 APP”还是“浏览器网页”。桌面方式使用独立窗口；网页方式会启动同一套本机服务，再用系统默认浏览器打开。勾选“记住我的选择”后，下次会直接进入。</p></div>
          <Checklist items={['网页方式仍只在当前电脑运行，不会把商品、账号或飞书配置上传到远程服务器。', '右键系统托盘图标，可随时切换桌面 APP/浏览器网页，或清除选择并在下次启动时重新询问。', '网页方式关闭浏览器标签后，本机服务仍驻留托盘；桌面 APP 方式关闭窗口会退出软件。需要确认完全停止时，可在托盘菜单点击“退出”。']} />
        </Section>

        <Section id="guide-monitor" title="监控为什么会执行" summary="总开关、本商品和计划时间必须同时满足" icon={Power}>
          <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] items-stretch gap-2 max-[900px]:grid-cols-1">
            {[
              ['全局自动监控', '控制整个软件是否执行后台定时任务'],
              ['本商品已启用', '决定这个商品是否进入监控计划'],
              ['到达计划时间', '单次定时或循环监控只生效一种'],
              ['开始抓取', '按账号池和并发限制执行'],
            ].map(([title, text], index) => <div key={title} className="contents max-[900px]:block"><div className={`rounded-md border p-3 ${index === 3 ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-white'}`}><div className="font-semibold text-slate-900">{title}</div><div className="mt-1 text-xs leading-5 text-slate-500">{text}</div></div>{index < 3 && <div className="flex items-center justify-center font-semibold text-slate-300 max-[900px]:py-1">+</div>}</div>)}
          </div>
          <Checklist items={[
            '顶部“全局自动监控”是总开关。暂停后，所有商品都不会按时间自动抓取，但单品启停与计划会保留。',
            '商品卡片“启用本商品”只影响当前商品。启用后会进入右侧任务中心的监控计划；移出计划不会删除商品和历史数据。',
            '商品卡片底部二选一：单次定时只执行所选日期时间并在完成后暂停；循环监控只按分钟周期执行。',
            '手动点击“抓取”不依赖定时计划；同一账号仍会按顺序执行，避免多个任务同时操作一个浏览器。',
          ]} />
        </Section>

        <Section id="guide-account" title="账号授权与账号类型" summary="一个账号会采集页面可见的全部价格通道" icon={KeyRound}>
          <div className="flex items-start gap-3"><KeyRound className="mt-1 h-5 w-5 shrink-0 text-blue-600" /><div><p>打开右上角“设置中心”的账号授权，填写账号备注并选择类型，然后点击扫码授权。淘宝 App 扫码完成后点击“检测登录”；未明确标记“登录失效”的扫码账号才会进入抓取候选。</p><p className="mt-2">设置中心还集中管理飞书文档与机器人、AI 模型通道和软件更新，日常监控时不需要在多个菜单之间寻找配置。</p></div></div>
          <div className="overflow-x-auto"><table className="w-full border-collapse text-left text-sm"><thead><tr className="border-y border-slate-200 bg-slate-50 text-slate-600"><th className="px-3 py-2">账号类型</th><th className="px-3 py-2">可采集价格</th><th className="px-3 py-2">重要说明</th></tr></thead><tbody className="divide-y divide-slate-100"><tr><td className="px-3 py-3 font-medium">普通账号</td><td className="px-3 py-3">普通、淘宝秒杀、国补、惊喜立减、淘金币等公共通道</td><td className="px-3 py-3">一个普通账号即可采集其页面实际可见的全部公共价格。</td></tr><tr><td className="px-3 py-3 font-medium">礼金账号</td><td className="px-3 py-3">全部可见公共通道 + 礼金价</td><td className="px-3 py-3">不再要求另有普通账号；没有真实礼金资格时显示“未获取”。</td></tr><tr><td className="px-3 py-3 font-medium">88VIP 账号</td><td className="px-3 py-3">全部可见公共通道 + 页面实际返回的礼金价、88VIP 价</td><td className="px-3 py-3">能抓多少取决于该账号对当前商品的真实权益证据。</td></tr></tbody></table></div>
          <Checklist items={['选择账号类型是在指定首选监控视角；首选不可用时，会在其余可用账号中按 88VIP → 礼金 → 普通的能力顺序回退。', '多个账号的价格结果完全隔离，不会互相覆盖；商品卡片可切换账号视角查看，其中标记“监控”的主账号视角才用于监控阈值和飞书。', '页面没有返回可信价格证据时仍会失败或显示“未获取”，不会用标价或其他账号结果补造。', '“检测登录”只读取账号浏览器现有登录状态，不打开商品页；登录失效时点击“重新授权”扫码更新原账号。', '账号卡片的“导出登录包”会生成本机加密 JSON；点顶部“导入登录包”可写入新的独立浏览器并自动验证。登录包仅供本机恢复，Cookie 过期、文件被修改或换电脑都会拒绝导入。', '“一键检测全部”只检查登录状态，不会开始商品抓取。一个账号固定使用自己的浏览器资料目录。']} />
        </Section>

        <Section id="guide-product" title="添加商品与抓取" summary="链接和商品 ID 都能用，买家秀按需开启" icon={Search}>
          <div className="flex items-start gap-3"><Search className="mt-1 h-5 w-5 shrink-0 text-blue-600" /><div><p><strong>链接模式：</strong>粘贴淘宝或天猫商品链接，软件会自动删除跟踪参数，只保留平台、商品路径和商品 ID。</p><p className="mt-2"><strong>商品 ID 模式：</strong>只输入纯数字 ID，选择淘宝或天猫，软件会自动补全有效地址前缀。</p></div></div>
          <Checklist items={[
            '单个添加的主按钮是“自动采集并本地解析”：软件会使用已授权账号在后台打开商品页面，每个账号视角可能分别访问；采集完成后先脱敏保存原始证据，再从本地文件读取和解析价格。',
            '自动采集仍会访问淘宝商品页面；本地落盘用于保证解析来源可核对、同一份证据可重复验证，不代表绕过淘宝验证，也不能保证不会遇到平台风控。',
            '新商品默认处于“本商品未启用”，先核对主图、SKU 和各价格通道，再按需要启用定时监控。之后的手动抓取、批量抓取和定时监控也使用相同的“采集 → 脱敏落盘 → 读盘解析”流程。',
            '“同时抓取买家秀”默认关闭；勾选后，该商品的首次、手动和定时抓取才会自动包含买家秀。',
            '批量自动采集用于多个新链接或 ID，一次最多 30 个；每个商品都会先保存本地证据再解析，买家秀和完整素材选项对整批统一生效。',
            '商品简称不是必填。抓取成功后优先展示平台真实标题、店铺和型号。',
            '抓取完成后先检查主图、SKU 数量和各账号视角价格；有疑问时切换账号并打开“核对价格”。',
          ]} />
        </Section>

        <Section id="guide-price" title="价格、优惠明细与监控价" summary="不同价格独立核验，监控价按 SKU 设置" icon={BadgeDollarSign}>
          <div className="overflow-x-auto"><table className="w-full border-collapse text-left text-sm"><thead><tr className="border-y border-slate-200 bg-slate-50 text-slate-600"><th className="px-3 py-2">价格</th><th className="px-3 py-2">含义</th><th className="px-3 py-2">未获取时</th></tr></thead><tbody className="divide-y divide-slate-100"><tr><td className="px-3 py-3 font-medium text-sky-700">普通价</td><td className="px-3 py-3">标价减去明确的公共商品优惠，不再被秒杀或百亿补贴价覆盖</td><td className="px-3 py-3">显示未验证，不使用标价猜测</td></tr><tr><td className="px-3 py-3 font-medium text-cyan-700">百亿补贴/淘宝秒杀价</td><td className="px-3 py-3">在普通价基础上减去当前活动的补贴，作为独立价格通道展示</td><td className="px-3 py-3">对应活动价格显示未获取</td></tr><tr><td className="px-3 py-3 font-medium text-teal-700">国补价</td><td className="px-3 py-3">当前公共或活动价格减去当前 SKU 明确返回的政府补贴</td><td className="px-3 py-3">显示未获取国补价</td></tr><tr><td className="px-3 py-3 font-medium text-rose-700">惊喜立减价</td><td className="px-3 py-3">国补价或当前活动价格再减明确的惊喜立减权益</td><td className="px-3 py-3">显示当前 SKU 无或未获取</td></tr><tr><td className="px-3 py-3 font-medium text-amber-700">淘金币价</td><td className="px-3 py-3">当前价格层级再减该账号和 SKU 的淘金币抵扣</td><td className="px-3 py-3">显示无淘金币</td></tr><tr><td className="px-3 py-3 font-medium text-orange-700">礼金价</td><td className="px-3 py-3">当前账号明确可见的礼金资格价，与其他价格独立核对</td><td className="px-3 py-3">显示未获取</td></tr><tr><td className="px-3 py-3 font-medium text-violet-700">88VIP 价</td><td className="px-3 py-3">88VIP 账号专享价格，与其他价格独立核对</td><td className="px-3 py-3">显示未获取</td></tr></tbody></table></div>
          <Checklist items={[
            '“核对价格”逐 SKU 展示证据、金额和公式；验证不闭合时不会保存猜测值。',
            '“优惠明细”按标价、商品优惠、账号权益和最终价格分层展示，每个 SKU 独立。',
            '监控价必须按 SKU 单独设置。价格更新不会清除监控价。',
            '只有标记“监控”的主账号视角中，已验证价格低于该 SKU 监控价时，才进入飞书低价提醒判断；切换卡片账号只改变展示。',
          ]} />
        </Section>

        <Section id="guide-queue" title="任务中心：监控计划" summary="只看已启用商品、计划时间和执行顺序" icon={ListChecks}>
          <div className="flex items-start gap-3"><ListChecks className="mt-1 h-5 w-5 shrink-0 text-blue-600" /><p>在“商品监控”右侧打开任务中心并选择“监控计划”，即可查看已启用商品和下次抓取时间。全局暂停时商品仍保留在计划中，但状态会统一显示“等待全局开启”。</p></div>
          <Checklist items={['计划序号表示当前页面中的执行先后；同一账号严格按顺序抓取，不同账号才会并行。', '“抓取”只立即执行当前商品，优先使用首选账号；不可用时按账号能力回退。', '“移出”只暂停本商品自动监控，商品卡片、历史价格、监控价和计划都保留。', '在商品列表重新点击“启用本商品”，商品会立即回到监控计划。']} />
        </Section>

        <Section id="guide-capture-queue" title="任务中心：抓取进度" summary="查看当前排队和进度，刷新页面不会丢任务" icon={TimerReset}>
          <div className="flex items-start gap-3"><ListChecks className="mt-1 h-5 w-5 shrink-0 text-blue-600" /><p>在“商品监控”右侧任务中心选择“抓取进度”，可查看单品、批量和定时抓取的排队顺序、实时进度与结果。任务由后端执行，刷新页面或切换菜单只会重载界面，不会取消任务。</p></div>
          <Checklist items={['同一时间执行一个队列任务；批量任务按账号隔离，同一账号串行、不同账号并行，调度上限为 5 个。', '完成或失败项保留 5 秒后自动移出；“数据记录”会长期保存逐商品结果和错误，并提供“重试失败商品”。', '退出整个软件会停止后端进程；未完成任务不会自动续跑，重新打开后按失败记录重试。']} />
        </Section>

        <Section id="guide-feishu" title="飞书文档与机器人提醒" summary="文档每次写入，机器人只在低于监控价时提醒" icon={BellRing}>
          <div className="flex items-start gap-3"><BellRing className="mt-1 h-5 w-5 shrink-0 text-blue-600" /><p>在右上角“设置中心”完成飞书扫码授权后，可创建价格文档；群机器人需要在飞书群中创建自定义机器人，再将 Webhook 和可选签名密钥填入软件。</p></div>
          <Checklist items={[
            '飞书文档：每次成功抓取后写入店铺、型号、SKU 和主账号视角的各类价格，并标注账号类型。',
            '机器人提醒：主账号视角中，某个 SKU 的有效价格每次严格低于该 SKU 监控价时都会发送。',
            '保存配置后先点击“发送测试”，确认机器人可达，再等待真实低价触发。',
          ]} />
        </Section>

        <Section id="guide-media" title="素材包与买家秀" summary="预览、单独下载和 ZIP 打包的使用方法" icon={Download}>
          <div className="flex items-start gap-3"><Download className="mt-1 h-5 w-5 shrink-0 text-blue-600" /><p>默认只抓价格、800 主图和 SKU 图。需要 750 主图、详情图、视频及素材包下载时，先勾选“抓取完整素材”；买家秀是另一项独立开关，可单独抓取、预览和下载。</p></div>
          <Checklist items={['新增商品时按需勾选“同时抓取买家秀”；不需要时关闭可缩短抓取时间。', '买家秀未开启或抓取失败时，仍可使用“仅重试买家秀”，不会重新计算价格或覆盖 SKU 数据。', '本次失败但历史曾成功时，预览继续显示上次有效缓存，并明确标注缓存状态。', '生成 ZIP 时等待状态变为“下载已开始”后再关闭软件。', '没有真实视频或媒体评价时不会生成占位内容。']} />
        </Section>

        <Section id="guide-ai-creation" title="AI 创作怎么用" summary="一句需求完成提示词整理、生图排队和图片修改" icon={WandSparkles}>
          <div className="flex items-start gap-3"><WandSparkles className="mt-1 h-5 w-5 shrink-0 text-blue-600" /><div><p>“AI 创作”已经合并提示词和生图。普通使用只需选择商品生图或自由生图、上传参考图并写一句想要的效果；需要精确控制时再进入“专业提示词”。</p><button type="button" onClick={() => onNavigate('image-workbench')} className="mt-3 inline-flex h-9 items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 text-sm font-medium text-blue-700 hover:bg-blue-100"><WandSparkles className="h-4 w-4" />打开 AI 创作</button></div></div>
          <div className="grid gap-2 sm:grid-cols-3">
            {[['1', '说明需求', '商品生图先上传参考图；自由生图可以不传。'], ['2', '确认提示词', 'AI 自动补全保真、文字防错和画面规范，整理结果仍可修改。'], ['3', '加入队列', '默认生成 1 张；多方案可选 2 张或 4 张。']].map(([step, title, text]) => <div key={step} className="border-l-2 border-blue-500 bg-slate-50 px-3 py-2.5"><div className="text-xs font-semibold text-blue-700">第 {step} 步</div><div className="mt-0.5 font-semibold text-slate-900">{title}</div><div className="mt-1 text-xs leading-5 text-slate-600">{text}</div></div>)}
          </div>
          <Checklist items={['首次使用打开右上角“设置中心”的模型配置。每位使用者填写自己的 Key；稳定、高速和自定义通道分别保存，切换不会串用。提示词模型负责理解需求，图片模型负责最终生图。', '商品生图默认要求产品参考图，用于锁定产品结构、颜色、Logo 和原有文字；自由生图适合不依赖具体商品的画面。参考图可选择、拖入或粘贴，超过 8 MB 会先在本机自动压缩。', '系统自动加入文字与标识规范：要求的原文、数字、单位和标点必须准确；未要求时不自行添加文案、价格、二维码、水印或品牌。', '“专业提示词”保留七类电商任务、产品事实、风格方案、三套提示词、风险检查和提示词历史。同步后会回到 AI 创作，仍需确认后才产生生图费用。', '1K 是标准输出；2K、4K 会在模型生成后由本机增强。选择比例、质量、格式、背景和数量后加入生图队列。', '任务进入队列后可马上准备下一张；生成在后台继续，切换到专业提示词、其他菜单或刷新页面都不会取消任务，失败任务可在队列重试。“清空队列”会移除排队任务和任务记录，但保留正在生成的任务与图片资产。', '图片自动进入生成历史和相册。打开详情可下载、删除、收藏、复用参数、基于此图继续修改，或用框选批注指定局部修改。', '需要设计师精修时点击“Photoshop 编辑”。在 PS 中保存工作副本后返回同步，修改会作为新版本进入历史，原图不会覆盖。', 'API Key 加密保存在当前电脑，界面和接口不会回显完整密钥。']} />
        </Section>

        <Section id="guide-update" title="检查并安装新版本" summary="自动检查、选择对应系统安装包并覆盖更新" icon={CloudDownload}>
          <div className="flex items-start gap-3"><CloudDownload className="mt-1 h-5 w-5 shrink-0 text-blue-600" /><p>右上角“设置中心”提供软件更新入口。软件会在启动以及从后台回到前台时连接 GitHub Releases，不会在后台频繁轮询；发现新版本会自动打开更新提醒，同一版本只主动提醒一次，关闭后入口仍会持续高亮。</p></div>
          <Checklist items={['在设置中心点击软件更新可查看当前版本、最新版本、发布日期和更新说明。', '软件会根据 Windows、macOS Intel 或 macOS Apple Silicon 自动选择对应安装包。', '国内网络可优先使用“加速下载”；镜像不可用时切换“GitHub 原地址”。', '下载后先退出软件，再运行安装包覆盖安装；商品、历史记录、账号资料和飞书配置不会删除。', 'GitHub 暂时无法连接只会影响检查更新，不会影响本地监控与抓取。']} />
        </Section>

        <Section id="guide-troubleshoot" title="常见异常与处理顺序" summary="按问题展开，只看当前需要的处理步骤" icon={CircleAlert}>
          <div className="space-y-3">
            {[
              ['抓不到价格或价格不一致', '确认商品链接和 SKU → 检查首选账号状态 → 切换账号视角核对 → 打开核对价格 → 重新抓取。证据不足时软件会拒绝保存。'],
              ['买家秀只有文字或数量很少', '打开买家秀预览查看状态 → 点击仅重试买家秀 → 检查账号登录 → 保留历史成功缓存。'],
              ['计划不执行', '检查页面顶部全局自动监控 → 检查本商品已启用 → 检查开始时间和周期 → 打开右侧任务中心的监控计划查看下次时间。'],
              ['飞书没有消息', '发送测试 → 检查 SKU 监控价 → 确认主账号视角的有效价格严格低于阈值 → 检查自动提醒开关。'],
              ['账号显示待检测或登录失效', '待检测表示现有浏览器凭据暂时无法确认，登录资料仍保留，可稍后再检测；登录失效时点击“重新授权”扫码更新原账号。'],
              ['macOS 提示已损坏或运行很慢', '“已损坏”表示旧包缺少 Apple 签名与公证，请下载最新的 mac-arm64 安装包；可信旧包的临时处理命令见完整使用说明。首次浏览器授权会较慢，避免同时启动多个抓取任务。'],
            ].map(([title, text]) => <details key={title} className="group border-b border-slate-200 pb-3"><summary className="cursor-pointer list-none font-semibold text-slate-900">{title}</summary><p className="mt-2 text-slate-600">{text}</p></details>)}
          </div>
        </Section>

        <div className="flex items-start gap-2 border-l-4 border-sky-400 bg-sky-50 px-4 py-3 text-sm leading-6 text-sky-900"><TimerReset className="mt-1 h-4 w-4 shrink-0" /><span>数据、账号浏览器目录、Cookie、飞书令牌和 Webhook 默认只保存在当前电脑。分享截图前请隐藏店铺名、商品名、商品 ID、SKU ID、图片和账号信息。</span></div>
      </main>
    </div>
  )
}
