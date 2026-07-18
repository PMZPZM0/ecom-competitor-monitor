import type { PromptCategory, PromptCopyMode, PromptParameters, PromptStyle } from './types'

export type PromptLibraryGroup = 'optimizer' | 'commerce' | 'poster' | 'editing'

export type PromptLibraryTemplate = {
  id: string
  name: string
  summary: string
  group: PromptLibraryGroup
  category: PromptCategory
  tags: string[]
  userRequest: string
  taskFields?: Record<string, string>
  style?: Partial<PromptStyle>
  parameters?: Partial<PromptParameters>
  copyMode?: PromptCopyMode
  featured?: boolean
}

export const promptLibraryGroups: Array<{ id: 'all' | PromptLibraryGroup; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'optimizer', label: '提示增强' },
  { id: 'commerce', label: '主图场景' },
  { id: 'poster', label: '海报详情' },
  { id: 'editing', label: '改图精修' },
]

export const builtInPromptTemplates: PromptLibraryTemplate[] = [
  {
    id: 'general-image-optimizer',
    name: '通用生图增强',
    summary: '把一句模糊需求整理成可执行的画面指令。',
    group: 'optimizer',
    category: 'product-scene',
    tags: ['通用', '需求整理', '构图', '光线'],
    featured: true,
    userRequest: '将当前商品生图需求整理为清晰、可执行的画面方案：明确主体、使用目的、构图、机位、光线、材质、环境、留白和输出重点。只补充中性的摄影与设计语言，不虚构品牌、型号、规格、价格、功能或活动信息。',
    style: {
      name: '清晰商业表达',
      description: '主体优先、信息克制、画面层级清楚，所有装饰只服务于商品表达',
      lighting: '方向明确的柔和商业光，控制高光和暗部层次',
      composition: '主体是第一视觉，背景与道具不遮挡产品并保留安全边距',
      palette: '根据商品本色选择克制的辅助色，保持主体与背景有清晰对比',
      camera: '符合真实观察高度和产品比例的商业摄影镜头',
      forbidden: ['虚构品牌与功能', '无关装饰抢占主体', '结构变形', '杂乱背景'],
    },
  },
  {
    id: 'chinese-text-safe',
    name: '中文文字防错',
    summary: '优先生成无字底图；必须出字时严格锁定原文。',
    group: 'optimizer',
    category: 'campaign-poster',
    tags: ['中文', '防乱码', '海报', '包装文字'],
    featured: true,
    userRequest: '优先生成可供后期排版的无字底图，并预留完整、干净的文案安全区。不得生成伪文字、随机字母、价格或促销词；产品包装和 Logo 上已有文字必须保持原样、清晰可读。',
    taskFields: {
      copyArea: '预留一块边界清楚、背景干净且不遮挡产品的文案区域',
      visualFocus: '产品为第一视觉，文案区与主体层级明确',
    },
    copyMode: 'reserved',
  },
  {
    id: 'commercial-photography',
    name: '商业摄影语言',
    summary: '补齐镜头、布光、材质与真实接触关系。',
    group: 'optimizer',
    category: 'product-scene',
    tags: ['摄影', '镜头', '布光', '质感'],
    featured: true,
    userRequest: '把需求转成专业商品摄影语言，明确镜头焦段、机位高度、透视关系、主辅光方向、反差、接触阴影和材质高光。画面保持真实可拍摄，不使用违反物理规律的悬浮、反射或景深。',
    taskFields: {
      lighting: '柔和主光配合克制轮廓光，材质高光受控，接触阴影方向一致',
      camera: '50mm 左右的自然透视，机位符合真实使用视角',
    },
    style: {
      name: '真实商业摄影',
      description: '可落地拍摄的写实商品画面，强调结构准确和材质层次',
      lighting: '柔和主光、适量补光与克制轮廓光，阴影和反射符合统一光源',
      camera: '自然透视的商业摄影镜头，避免广角畸变',
      forbidden: ['夸张景深', '错误反射', '悬浮产品', '过度锐化'],
    },
  },
  {
    id: 'creative-composition',
    name: '创意构图增强',
    summary: '在不改变产品的前提下增加画面记忆点。',
    group: 'optimizer',
    category: 'product-scene',
    tags: ['创意', '构图', '视觉焦点', '留白'],
    userRequest: '在产品身份、结构、颜色、比例和文字完全不变的前提下，设计一个有明确视觉焦点的创意构图。创意只来自机位、留白、光影、层次和少量场景道具，不给产品增加不存在的部件或功能。',
    taskFields: {
      props: '只使用少量与真实使用场景相关的道具，形成前中后景层次且不遮挡产品',
      camera: '选择有辨识度但不造成产品变形的机位与构图',
    },
  },
  {
    id: 'standard-white-background',
    name: '标准白底主图',
    summary: '纯白、完整、居中，适合商品列表和平台主图。',
    group: 'commerce',
    category: 'white-background',
    tags: ['白底', '平台主图', '纯白', '居中'],
    featured: true,
    userRequest: '生成标准电商白底主图：完整保留产品结构、颜色、比例、配件、Logo 和包装文字，主体清晰居中，边缘干净，背景为纯白，不添加任何场景装饰、角标、文字或水印。',
    taskFields: {
      angle: '使用最能完整展示产品结构的正面或轻微俯视角度',
      composition: '主体居中，占画面约 82% 至 88%，四周安全边距均衡',
      shadow: '产品底部保留轻微、自然、方向一致的接触阴影',
      backgroundPurity: '纯白 #FFFFFF，无渐变、无纹理、无环境反射',
    },
    parameters: { ratio: '1:1', background: 'opaque', quality: 'high' },
  },
  {
    id: 'premium-studio-main',
    name: '高级棚拍主图',
    summary: '保留平台主图清晰度，同时增强材质和轮廓。',
    group: 'commerce',
    category: 'white-background',
    tags: ['棚拍', '主图', '材质', '轮廓光'],
    userRequest: '生成高级棚拍感商品主图，在保持纯净背景和商品完整展示的同时，增强轮廓、材质纹理和受控高光。不得改变产品颜色、结构、配件、Logo、包装文字和真实比例。',
    taskFields: {
      composition: '主体稳定居中，保留均衡边距，避免裁切产品与配件',
      shadow: '柔和接触阴影，不能出现漂浮感或多重光源冲突',
      backgroundPurity: '接近纯白的中性棚拍背景，不出现明显渐变和装饰',
    },
    style: {
      name: '高端棚拍',
      description: '纯净、克制、重视材质层次的商业棚拍表现',
      lighting: '大面积柔光配合细窄轮廓光，高光不过曝',
      composition: '主体完整居中，边缘和配件清楚',
      forbidden: ['过曝高光', '塑料感', '多重阴影', '产品裁切'],
    },
    parameters: { ratio: '1:1', quality: 'high', background: 'opaque' },
  },
  {
    id: 'real-use-scene',
    name: '真实使用场景',
    summary: '让环境、道具和人物动作符合真实使用逻辑。',
    group: 'commerce',
    category: 'product-scene',
    tags: ['真实场景', '生活方式', '道具', '使用逻辑'],
    featured: true,
    userRequest: '把产品放入符合其真实用途的使用场景。场景尺度、摆放、人物动作、配套道具和光线必须符合常识，产品保持第一视觉且完整清晰，不虚构使用方式或功能效果。',
    taskFields: {
      props: '只保留能说明真实使用关系的必要道具，不遮挡产品和操作区域',
      lighting: '自然环境光与产品受光方向一致，保留真实接触阴影',
      camera: '采用使用者视角或轻微俯视，产品比例自然且无广角畸变',
    },
    style: {
      name: '真实生活方式',
      description: '干净可信的日常使用场景，环境服务于产品而不喧宾夺主',
      forbidden: ['错误使用动作', '道具堆叠', '产品悬浮', '不真实尺度'],
    },
  },
  {
    id: 'multi-image-consistency',
    name: '系列图风格统一',
    summary: '统一多张图片的机位、光线、色彩和留白。',
    group: 'commerce',
    category: 'product-scene',
    tags: ['系列图', '风格统一', '多图', '店铺视觉'],
    userRequest: '以同一套视觉规范生成系列商品图：统一镜头透视、机位高度、主光方向、色温、背景层次、主体占比和留白位置。每张图只改变本次明确要求的场景内容，产品身份和视觉规范保持一致。',
    style: {
      name: '系列视觉统一',
      description: '固定机位、光线、色彩和版式规则，形成可连续浏览的店铺视觉',
      composition: '主体占比和留白区域在系列图片中保持一致',
      palette: '使用固定主色、辅助色和中性色比例',
      camera: '锁定焦段、机位高度和透视关系',
      forbidden: ['随机换风格', '机位跳变', '色温漂移', '主体比例不一致'],
    },
  },
  {
    id: 'campaign-clean-base',
    name: '无字活动底图',
    summary: '先做好视觉和留白，再到 PS 中准确排版。',
    group: 'poster',
    category: 'campaign-poster',
    tags: ['活动海报', '无字底图', '留白', 'PS'],
    featured: true,
    userRequest: '生成电商活动海报的无字底图：产品是第一视觉，活动氛围来自色彩、光影、构图和少量装饰；预留边界清楚的标题、卖点和价格排版区域，不生成任何伪文字、价格、促销词或随机字符。',
    taskFields: {
      copyArea: '在不遮挡产品的位置预留约 30% 至 40% 的干净文案区域',
      visualFocus: '产品为第一视觉，活动装饰形成视线引导但不抢主体',
    },
    copyMode: 'reserved',
    parameters: { quality: 'high', background: 'opaque' },
  },
  {
    id: 'single-selling-point-detail',
    name: '单卖点详情图',
    summary: '一屏只讲一个卖点，避免信息拥挤。',
    group: 'poster',
    category: 'detail-page',
    tags: ['详情页', '单卖点', '功能演示', '信息层级'],
    featured: true,
    userRequest: '生成一张只表达一个核心卖点的详情页配图。通过真实使用动作、局部特写、前后对比或结构说明呈现卖点，产品和证据画面要直接对应，不虚构参数、功效或测试结果。',
    taskFields: {
      sellingPoint: '只填写一个经过确认的核心卖点',
      demonstration: '使用能直接证明该卖点的真实画面，不使用抽象光效冒充功能证据',
      layout: '主体区、演示区和后期文字区层级清楚，阅读顺序明确',
    },
    parameters: { ratio: '3:4', quality: 'high' },
  },
  {
    id: 'structured-detail-layout',
    name: '结构化详情版式',
    summary: '固定主体、证据和文案区，便于连续制作。',
    group: 'poster',
    category: 'detail-page',
    tags: ['详情页', '版式', '留白', '系列化'],
    userRequest: '建立可重复使用的详情页配图版式：产品主体、功能证据、场景辅助和后期文案区域彼此分开，画面从主体到卖点证据再到说明区形成明确阅读路径。',
    taskFields: {
      layout: '顶部标题安全区，中部产品与功能证据，底部补充说明区；各区域之间保留稳定留白',
      demonstration: '功能证据与产品真实结构或使用动作直接关联',
    },
    parameters: { ratio: '3:4', quality: 'high', background: 'opaque' },
  },
  {
    id: 'protected-local-edit',
    name: '强约束局部改图',
    summary: '只改指定位置，其他像素语义全部锁定。',
    group: 'editing',
    category: 'local-edit',
    tags: ['局部改图', '结构保护', '指定区域', '参考图'],
    featured: true,
    userRequest: '严格按照框选或批注位置执行局部修改。只允许改变明确指定的区域和内容；未指定区域、产品主体、结构比例、视角、颜色、材质、配件、Logo、包装文字、背景构图和光线关系全部保持不变。',
    taskFields: {
      preserveAreas: '产品主体结构与比例\nLogo、包装文字和控制面板\n未框选区域\n原有机位、构图和光线关系',
    },
    parameters: { quality: 'high' },
  },
  {
    id: 'exact-packaging-text-edit',
    name: '包装文字精准修改',
    summary: '只替换指定文字，包装其他内容保持原样。',
    group: 'editing',
    category: 'local-edit',
    tags: ['文字修改', '包装', '中文', '局部改图'],
    userRequest: '只修改用户明确指出的包装文字：逐字使用用户提供的新文本，保持原有字体风格、字号层级、颜色、排版位置、透视和印刷质感；包装上其他文字、Logo、图案和产品结构不得变化。输出前检查错别字、漏字、多字、镜像字和伪文字。',
    taskFields: {
      targetAreas: '需要替换文字的具体包装区域',
      changes: '逐字写明“原文字”与“新文字”，不要省略标点和大小写',
      preserveAreas: '包装其他文字与图案\nLogo 和品牌标识\n产品结构、颜色、材质与视角\n背景和未框选区域',
    },
    parameters: { quality: 'high' },
  },
  {
    id: 'natural-background-swap',
    name: '自然换背景',
    summary: '保留产品抠图边缘，重建匹配的光影和接触关系。',
    group: 'editing',
    category: 'background-swap',
    tags: ['换背景', '边缘融合', '接触阴影', '光线匹配'],
    featured: true,
    userRequest: '只替换产品主体以外的背景。产品结构、比例、位置、视角、颜色、材质、配件、Logo 和既有文字保持不变；新背景的透视、光源、色温、反射和接触阴影必须与产品自然融合。',
    taskFields: {
      edgeBlend: '保留产品细小边缘、透明或反光材质，不出现白边、黑边和抠图锯齿',
      contactShadow: '根据目标场景重建方向一致、强度自然的接触阴影和环境反射',
    },
    parameters: { quality: 'high', background: 'opaque' },
  },
  {
    id: 'material-retouch',
    name: '材质商业精修',
    summary: '增强真实纹理和受控高光，不把产品修成塑料。',
    group: 'editing',
    category: 'product-retouch',
    tags: ['精修', '材质', '反射', '清晰度'],
    featured: true,
    userRequest: '进行克制的商业精修：提升真实材质纹理、轮廓清晰度和层次，清理灰尘、污渍与杂乱反射；保持产品原有颜色、表面工艺、使用痕迹尺度和结构细节，避免过度磨皮、锐化、增亮或塑料感。',
    taskFields: {
      material: '增强真实材质纹理与边缘层次，不改变原有表面工艺',
      reflection: '清理干扰性反射，保留符合产品曲面的自然高光',
      cleanup: '只清理灰尘、轻微污渍和非产品结构的杂点',
      sharpness: '局部细节清楚自然，不产生描边、光晕和过度锐化',
    },
    style: {
      name: '克制商业精修',
      description: '真实、干净、有质感，不改变产品本身',
      lighting: '高光受控、暗部有层次、轮廓清楚但不过曝',
      forbidden: ['塑料感', '过度磨皮', '描边光晕', '颜色漂移'],
    },
    parameters: { resolution: '4k', quality: 'high' },
  },
]

export function promptTemplateSearchText(template: PromptLibraryTemplate) {
  return [
    template.name,
    template.summary,
    template.userRequest,
    ...template.tags,
    ...Object.values(template.taskFields || {}),
    ...Object.values(template.style || {}).flatMap((value) => Array.isArray(value) ? value : typeof value === 'string' ? [value] : []),
  ].join(' ').toLowerCase()
}
