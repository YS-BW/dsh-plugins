import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // client 半区直接操作 DOM，所以测试环境用 jsdom。
    environment: 'jsdom',
    include: ['tests/**/*.spec.ts'],
  },
})
