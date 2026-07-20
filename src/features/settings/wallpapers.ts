export const APP_WALLPAPERS = [
  {
    id: 'none',
    label: '纯净白',
    description: '保持默认工作台背景',
    src: '',
    position: 'center',
    swatch: '#f6f8fa',
  },
  {
    id: 'cinnabar',
    label: '朱砂纳福',
    description: '默认 · 国潮朱砂与哑金',
    src: '/wallpapers/fortune-cinnabar.webp',
    position: 'center right',
    swatch: '#9f2d2d',
  },
  {
    id: 'landscape',
    label: '青绿生财',
    description: '青绿山水与晨雾',
    src: '/wallpapers/fortune-landscape.webp',
    position: 'center right',
    swatch: '#7d9b8b',
  },
  {
    id: 'night-gold',
    label: '鎏金守业',
    description: '炭黑、暗红与鎏金',
    src: '/wallpapers/fortune-night-gold.webp',
    position: 'center left',
    swatch: '#3f302c',
  },
  {
    id: 'paper-cut',
    label: '剪纸迎财',
    description: '现代剪纸与暖白',
    src: '/wallpapers/fortune-paper-cut.webp',
    position: 'center right',
    swatch: '#d85f4a',
  },
  {
    id: 'jade-bronze',
    label: '碧玉聚财',
    description: '青铜、玉石与静谧云纹',
    src: '/wallpapers/fortune-jade-bronze.webp',
    position: 'center right',
    swatch: '#719488',
  },
  {
    id: 'dunhuang-blue',
    label: '敦煌云财',
    description: '矿物蓝、淡金与飞云',
    src: '/wallpapers/fortune-dunhuang-blue.webp',
    position: 'center left',
    swatch: '#8ba7ae',
  },
  {
    id: 'woodblock',
    label: '木刻迎财',
    description: '朱红、靛蓝与手工版画',
    src: '/wallpapers/fortune-woodblock.webp',
    position: 'center right',
    swatch: '#c8493b',
  },
  {
    id: 'snow-plum',
    label: '雪梅送财',
    description: '雪庭、红梅与新春晨光',
    src: '/wallpapers/fortune-snow-plum.webp',
    position: 'center left',
    swatch: '#b85b57',
  },
] as const

export const CUSTOM_APP_WALLPAPER_ID = 'custom' as const

export type AppWallpaperId = (typeof APP_WALLPAPERS)[number]['id'] | typeof CUSTOM_APP_WALLPAPER_ID

export const APP_WALLPAPER_STORAGE_KEY = 'ecommerce-monitor-wallpaper'
export const DEFAULT_APP_WALLPAPER_ID: AppWallpaperId = 'cinnabar'

export function resolveAppWallpaper(id: string | null | undefined) {
  if (id === CUSTOM_APP_WALLPAPER_ID) {
    return {
      id: CUSTOM_APP_WALLPAPER_ID,
      label: '我的壁纸',
      description: '保存在当前电脑',
      src: '',
      position: 'center',
      swatch: '#64748b',
    }
  }
  return APP_WALLPAPERS.find((wallpaper) => wallpaper.id === id)
    ?? APP_WALLPAPERS.find((wallpaper) => wallpaper.id === DEFAULT_APP_WALLPAPER_ID)!
}
