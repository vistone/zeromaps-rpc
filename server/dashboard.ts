/**
 * 统一管理面板启动文件
 * 单独运行，聚合所有VPS节点的监控数据
 */

import { DashboardServer } from './dashboard-server'

const DASHBOARD_PORT = 8080

async function main() {
  console.log('='.repeat(50))
  console.log('ZeroMaps RPC 统一管理面板')
  console.log('='.repeat(50))
  
  const dashboard = new DashboardServer(DASHBOARD_PORT)
  
  try {
    dashboard.start()
    
    console.log('')
    console.log('访问管理面板:')
    console.log(`  http://localhost:${DASHBOARD_PORT}`)
    console.log(`  http://你的IP:${DASHBOARD_PORT}`)
    console.log('')
    console.log('按 Ctrl+C 停止')
    
    // 优雅退出
    process.on('SIGINT', () => {
      console.log('\n正在关闭管理面板...')
      dashboard.stop()
      process.exit(0)
    })
    
    process.on('SIGTERM', () => {
      console.log('\n正在关闭管理面板...')
      dashboard.stop()
      process.exit(0)
    })
    
  } catch (error) {
    console.error('启动失败:', error)
    process.exit(1)
  }
}

main()

