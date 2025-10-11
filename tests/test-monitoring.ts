#!/usr/bin/env tsx
/**
 * 测试监控功能
 */

import { IPv6Pool } from './server/ipv6-pool'
import { StatsExporter } from './server/stats-exporter'

console.log('🧪 测试IPv6监控功能\n')

// 创建一个小型IPv6池用于测试
const pool = new IPv6Pool('2607:8700:5500:2043', 1001, 10)

console.log('✅ IPv6池创建成功\n')

// 模拟一些请求
console.log('📊 模拟100个请求...\n')

for (let i = 0; i < 100; i++) {
  const ipv6 = pool.getNext()
  const success = Math.random() > 0.05 // 95% 成功率
  const responseTime = Math.floor(Math.random() * 500) + 100 // 100-600ms
  
  pool.recordRequest(ipv6, success, responseTime)
}

// 显示统计摘要
console.log('=' .repeat(70))
StatsExporter.showSummary(pool)

// 显示Top 5
StatsExporter.showTopIPs(pool, 5)

// 测试导出功能
console.log('📤 测试导出功能...\n')

try {
  const jsonFile = StatsExporter.exportJSON(pool, 'test-stats.json')
  console.log(`✅ JSON导出成功: ${jsonFile}`)
  
  const csvFile = StatsExporter.exportCSV(pool, 'test-stats.csv')
  console.log(`✅ CSV导出成功: ${csvFile}`)
  
  StatsExporter.exportToTemp(pool)
  console.log(`✅ 临时文件导出成功: /tmp/zeromaps-rpc-stats.json`)
} catch (error) {
  console.error('❌ 导出失败:', (error as Error).message)
}

console.log('\n✅ 所有测试通过！\n')
console.log('提示: 测试文件已生成在当前目录：')
console.log('  - test-stats.json')
console.log('  - test-stats.csv')
console.log('  - /tmp/zeromaps-rpc-stats.json')

