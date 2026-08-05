import { defineConfig } from 'playwright/test'

/**
 * Material Map E2E（Playwright + Electron）
 *
 * 前置条件：先执行 `npm run build` 生成 out/main/index.js。
 * 运行：`npx playwright test`
 *
 * 所有用例在构建产物缺失或 Electron 无法启动的环境中自动 skip，
 * 不会阻塞 CI 中的单元测试（npm test 不包含本目录）。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Electron 应用实例之间共享用户数据目录，必须串行
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
})
