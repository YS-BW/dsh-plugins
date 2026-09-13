/**
 * 构建期 CSS 通道的类型声明：与 shared/tsdown.client.ts 的三个通道一一对应。
 * *.module.css 默认导出类名映射；*.css?inline 默认导出 CSS 文本。
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css?inline' {
  const css: string
  export default css
}
