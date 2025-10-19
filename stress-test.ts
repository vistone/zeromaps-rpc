#!/usr/bin/env tsx
/**
 * CPU 压力测试工具
 * 持续发送请求直到 CPU 达到 100%
 */

import { RpcClient } from './client/rpc-client.js'

const HOST = 'localhost'
const PORT = 9527
const CONCURRENT_CLIENTS = 50  // 并发客户端数量
const REQUESTS_PER_CLIENT = 1000000  // 每个客户端发送请求数

// 测试路径
const TEST_PATHS = [
    'BulkMetadata/pb=!1m2!1s04!2u2699',
    'BulkMetadata/pb=!1m2!1s04!2u2700',
    'BulkMetadata/pb=!1m2!1s04!2u2701',
    'BulkMetadata/pb=!1m2!1s04!2u2702',
    'BulkMetadata/pb=!1m2!1s04!2u2703',
]

async function stressTest(clientId: number) {
    const client = new RpcClient(HOST, PORT)

    try {
        await client.connect()
        console.log(`[客户端 ${clientId}] 已连接`)

        let successCount = 0
        let errorCount = 0

        for (let i = 0; i < REQUESTS_PER_CLIENT; i++) {
            try {
                const path = TEST_PATHS[i % TEST_PATHS.length]
                const result = await client.fetchData(path)

                if (result.statusCode === 200) {
                    successCount++
                } else {
                    errorCount++
                }

                if ((i + 1) % 100 === 0) {
                    console.log(`[客户端 ${clientId}] 已发送: ${i + 1}, 成功: ${successCount}, 失败: ${errorCount}`)
                }
            } catch (error) {
                errorCount++
            }
        }

        console.log(`[客户端 ${clientId}] 完成! 总成功: ${successCount}, 总失败: ${errorCount}`)

    } catch (error) {
        console.error(`[客户端 ${clientId}] 错误:`, error)
    } finally {
        client.disconnect()
    }
}

async function main() {
    console.log(`🚀 启动压力测试`)
    console.log(`   并发客户端: ${CONCURRENT_CLIENTS}`)
    console.log(`   每客户端请求数: ${REQUESTS_PER_CLIENT}`)
    console.log(`   总请求数: ${CONCURRENT_CLIENTS * REQUESTS_PER_CLIENT}`)
    console.log('')

    const startTime = Date.now()

    // 启动多个并发客户端
    const promises = []
    for (let i = 0; i < CONCURRENT_CLIENTS; i++) {
        promises.push(stressTest(i + 1))
        await new Promise(resolve => setTimeout(resolve, 100))
    }

    await Promise.all(promises)

    const duration = (Date.now() - startTime) / 1000
    console.log(`\n✅ 压力测试完成！`)
    console.log(`   总耗时: ${duration.toFixed(2)} 秒`)
    console.log(`   QPS: ${((CONCURRENT_CLIENTS * REQUESTS_PER_CLIENT) / duration).toFixed(2)}`)
}

main().catch(console.error)



