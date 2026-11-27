export const officialPluginMarket = 'https://lw5959.github.io/inkletter-plugin-market/index.json'

export function resolvePluginMarketSource(value?: string): string {
  const source = value?.trim()
  // 旧版可能把官方目录存为显式设置，自建市场地址继续沿用。
  return !source || source === 'https://lw5959.github.io/yeyu-plugin-market/index.json' ? officialPluginMarket : source
}
