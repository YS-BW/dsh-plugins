/**
 * tsdown 配置：两个半区都由构建预设生成。
 *
 * 预设用的是包内的 build/tsdown.client.ts（由 scripts/sync-preset.mjs 从
 * shared/tsdown.client.ts 生成），所以本包可以被单独复制出去构建，
 * 不需要仓库根那个「启动文件夹」。
 */
import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('@lixklv/dsh-model-vision', ['src/index.ts'])
