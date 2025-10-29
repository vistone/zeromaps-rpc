/**
 * 兼容层 - 保持与现有代码的兼容性
 * 重新导出新的模块化代码
 */

// 重新导出主要功能
export { createZeroMapsRPC, ZeroMapsRPC } from '../src/index.js'
export { createLogger } from '../src/utils/logger.js'
export { ConfigManager } from '../src/config/manager.js'
export { RpcServer } from '../src/core/rpc-server.js'
export { MonitorServer } from '../src/monitoring/monitor-server.js'
export { IPv6Pool } from '../src/services/ipv6-pool.js'
export { UTLSFetcher } from '../src/services/utls-fetcher.js'
export { SystemMonitor } from '../src/monitoring/system-monitor.js'

// 导出类型
export * from '../src/types/index.js'

// 保持原有的启动逻辑
import { createZeroMapsRPC } from '../src/index.js'
import { createLogger } from '../src/utils/logger.js'

const logger = createLogger('Server')

async function startServer() {
  try {
    const app = createZeroMapsRPC()
    await app.start()

    logger.info('服务器启动完成')
  } catch (error) {
    logger.error('服务器启动失败', error as Error)
    process.exit(1)
  }
}

// 如果直接运行此文件，启动服务器
// 注意：在 ES 模块中不能使用 require.main，改用文件路径判断
import { fileURLToPath } from 'url'
if (import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer()
}