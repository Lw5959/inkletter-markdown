// 只把文档开头成对的分隔符识别为 YAML，正文中的水平线继续按 Markdown 处理。
export function frontMatter(source: string) {
  return /^---[ \t]*\n(?:([\s\S]*?)\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(source)
}
