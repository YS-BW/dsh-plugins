import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // client 半区直接操作 DOM，所以测试环境用 jsdom。
    environment: 'jsdom',
    // 面板的渲染用例里有 JSX，必须是 .tsx 才会被转译。
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
  },
})
