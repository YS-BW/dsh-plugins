/**
 * host 半区：本插件是纯客户端 UI，宿主侧没有行为。
 *
 * 这一行仍然必须存在：`cordis.patch.yml` 的 name 指向本包，宿主解析到这一行才会
 * 发现 `dsh.client` 声明、把 `lib/client.js` 作为浏览器半区 serve 出去。宿主侧刻意
 * 保持空实现——模态声明完全走官方 settings 服务（`settings.mutate`），不经过本插件
 * 的任何宿主代码，因此没有需要回收的资源，也不需要跟着引擎版本改。
 *
 * 为什么不做「写后回读校验」：让宿主持有 `ctx.llm` 会引入跨半区状态与生命周期管理，
 * 而结果可以直接从「设置 → 模型」页与贴图行为看到。保持空实现是这个插件最小的可信面。
 */
import type { Context } from '@deepseek-ai/cordis'

/**
 * 挂载 host 半区。
 * @param _ctx - 宿主上下文；本插件不使用。
 */
export function apply(_ctx: Context): void {
  // 纯客户端插件，宿主侧无行为。
}
