/**
 * ZeroMaps RPC 服务器启动文件
 */

import { RpcServer } from './rpc-server'

// 配置
const PORT = 9527
const IPV6_PREFIX = '2607:8700:5500:2043' // 根据服务器实际配置修改
const CURL_PATH = '/usr/local/bin/curl_chrome124'

// 创建并启动服务器
async function main() {
  console.log('='.repeat(50))
  console.log('ZeroMaps RPC 服务器')
  console.log('='.repeat(50))
  
  const server = new RpcServer(PORT, IPV6_PREFIX, CURL_PATH)
  
  try {
    await server.start()
    
    // 定期打印统计信息
    setInterval(() => {
      const stats = server.getStats()
      console.log('\n--- 服务器统计 ---')
      console.log(`在线客户端: ${stats.totalClients}`)
      console.log(`总请求数: ${stats.curlStats.totalRequests}`)
      
      if (stats.ipv6Stats) {
        console.log(`IPv6 池统计:`)
        console.log(`  总地址: ${stats.ipv6Stats.totalAddresses}`)
        console.log(`  总请求: ${stats.ipv6Stats.totalRequests}`)
        console.log(`  平均每IP: ${stats.ipv6Stats.averagePerIP}`)
        console.log(`  最大使用: ${stats.ipv6Stats.maxUsage}`)
        console.log(`  最小使用: ${stats.ipv6Stats.minUsage}`)
        console.log(`  平衡度: ${stats.ipv6Stats.balance}`)
      }
      console.log('-'.repeat(30))
    }, 60000) // 每分钟打印一次
    
    // 优雅退出
    process.on('SIGINT', async () => {
      console.log('\n收到退出信号，正在关闭服务器...')
      await server.stop()
      process.exit(0)
    })
    
    process.on('SIGTERM', async () => {
      console.log('\n收到退出信号，正在关闭服务器...')
      await server.stop()
      process.exit(0)
    })
    
  } catch (error) {
    console.error('服务器启动失败:', error)
    process.exit(1)
  }
}

main()

