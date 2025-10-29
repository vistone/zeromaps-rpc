/**
 * ZeroMaps RPC 主程序入口
 * 启动所有服务
 */

import { createZeroMapsRPC } from './index.js'
import { createLogger } from './utils/logger.js'

const logger = createLogger('Main')

async function main() {
    try {
        logger.info('正在启动ZeroMaps RPC...')

        // 创建服务实例
        const app = createZeroMapsRPC()

        // 监听服务事件
        app.on('started', () => {
            logger.info('ZeroMaps RPC服务启动成功')
        })

        app.on('stopped', () => {
            logger.info('ZeroMaps RPC服务已停止')
        })

        app.on('emergency-stop', (reason) => {
            logger.error('服务紧急停止', new Error(reason), { reason })
        })

        // 启动服务
        await app.start()

        // 保持进程运行
        process.on('SIGINT', async () => {
            logger.info('收到退出信号，正在关闭服务...')
            await app.stop()
            process.exit(0)
        })

    } catch (error) {
        logger.error('启动失败', error as Error)
        process.exit(1)
    }
}

// 启动主程序
main().catch((error) => {
    logger.error('主程序异常', error)
    process.exit(1)
})

export { main }
