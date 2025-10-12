/**
 * 统计数据导出工具
 * 服务器端使用，导出IPv6统计数据
 */

import * as fs from 'fs'
import * as path from 'path'
import { IPv6Pool } from './ipv6-pool'

/**
 * 导出统计数据类
 */
export class StatsExporter {
  /**
   * 导出为JSON格式
   */
  public static exportJSON(ipv6Pool: IPv6Pool, outputPath?: string): string {
    const filename = outputPath || `ipv6-stats-${Date.now()}.json`
    const data = ipv6Pool.exportJSON()
    const content = JSON.stringify(data, null, 2)

    fs.writeFileSync(filename, content, 'utf-8')
    console.log(`✅ 统计数据已导出到: ${filename}`)

    return filename
  }

  /**
   * 导出为CSV格式
   */
  public static exportCSV(ipv6Pool: IPv6Pool, outputPath?: string): string {
    const filename = outputPath || `ipv6-stats-${Date.now()}.csv`
    const content = ipv6Pool.exportCSV()

    fs.writeFileSync(filename, content, 'utf-8')
    console.log(`✅ CSV数据已导出到: ${filename}`)

    return filename
  }

  /**
   * 导出到临时文件（用于实时监控）
   */
  public static exportToTemp(ipv6Pool: IPv6Pool): void {
    try {
      const data = ipv6Pool.exportJSON()
      const tmpFile = path.join('/tmp', 'zeromaps-rpc-stats.json')
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8')
    } catch (error) {
      // 静默失败，不影响主服务
    }
  }

  /**
   * 显示统计摘要
   */
  public static showSummary(ipv6Pool: IPv6Pool): void {
    const stats = ipv6Pool.getDetailedStats()

    console.log('\n' + '='.repeat(70))
    console.log('📊 IPv6 统计数据摘要')
    console.log('='.repeat(70))
    console.log(`总地址数: ${stats.totalAddresses}`)
    console.log(`总请求数: ${stats.totalRequests}`)
    console.log(`成功请求: ${stats.totalSuccess} (${stats.successRate}%)`)
    console.log(`失败请求: ${stats.totalFailure}`)
    console.log(`平均每IP: ${stats.averagePerIP} 次`)
    console.log(`平衡度: ${stats.balance} (最大最小差值)`)
    console.log(`平均响应时间: ${stats.avgResponseTime}ms`)
    console.log(`运行时间: ${this.formatUptime(stats.uptime)}`)
    console.log(`请求速率: ${stats.requestsPerSecond} req/s`)
    console.log('='.repeat(70) + '\n')
  }

  /**
   * 显示Top N IPv6地址
   */
  public static showTopIPs(ipv6Pool: IPv6Pool, limit: number = 20): void {
    const perIPStats = ipv6Pool.getPerIPStats()

    // 按请求数排序
    const sorted = perIPStats.sort((a, b) => b.totalRequests - a.totalRequests)
    const top = sorted.slice(0, limit)

    console.log('\n' + '='.repeat(120))
    console.log(`📊 使用最多的 Top ${limit} IPv6 地址`)
    console.log('='.repeat(120))

    // 表头
    console.log(
      this.padRight('IPv6地址', 40) + ' | ' +
      this.padLeft('请求数', 8) + ' | ' +
      this.padLeft('成功数', 8) + ' | ' +
      this.padLeft('失败数', 8) + ' | ' +
      this.padLeft('成功率', 8) + ' | ' +
      this.padLeft('平均RT', 8) + ' | ' +
      this.padLeft('最后使用', 12)
    )
    console.log('-'.repeat(120))

    // 数据行
    for (const stat of top) {
      console.log(
        this.padRight(stat.address, 40) + ' | ' +
        this.padLeft(stat.totalRequests.toString(), 8) + ' | ' +
        this.padLeft(stat.successCount.toString(), 8) + ' | ' +
        this.padLeft(stat.failureCount.toString(), 8) + ' | ' +
        this.padLeft(stat.successRate + '%', 8) + ' | ' +
        this.padLeft(stat.avgResponseTime + 'ms', 8) + ' | ' +
        this.padLeft(stat.lastUsedAgo, 12)
      )
    }

    console.log('='.repeat(120) + '\n')
  }

  /**
   * 显示详细的每个IP统计
   */
  public static showDetailedStats(ipv6Pool: IPv6Pool): void {
    const perIPStats = ipv6Pool.getPerIPStats()

    console.log('\n' + '='.repeat(120))
    console.log('📊 所有 IPv6 地址详细统计')
    console.log('='.repeat(120))

    // 表头
    console.log(
      this.padRight('IPv6地址', 40) + ' | ' +
      this.padLeft('请求', 6) + ' | ' +
      this.padLeft('成功', 6) + ' | ' +
      this.padLeft('失败', 6) + ' | ' +
      this.padLeft('成功率', 7) + ' | ' +
      this.padLeft('平均RT', 7) + ' | ' +
      this.padLeft('最小RT', 7) + ' | ' +
      this.padLeft('最大RT', 7) + ' | ' +
      this.padLeft('最后使用', 12)
    )
    console.log('-'.repeat(120))

    // 数据行
    for (const stat of perIPStats) {
      console.log(
        this.padRight(stat.address, 40) + ' | ' +
        this.padLeft(stat.totalRequests.toString(), 6) + ' | ' +
        this.padLeft(stat.successCount.toString(), 6) + ' | ' +
        this.padLeft(stat.failureCount.toString(), 6) + ' | ' +
        this.padLeft(stat.successRate + '%', 7) + ' | ' +
        this.padLeft(stat.avgResponseTime + 'ms', 7) + ' | ' +
        this.padLeft(stat.minResponseTime + 'ms', 7) + ' | ' +
        this.padLeft(stat.maxResponseTime + 'ms', 7) + ' | ' +
        this.padLeft(stat.lastUsedAgo, 12)
      )
    }

    console.log('='.repeat(120) + '\n')
  }

  /**
   * 格式化运行时间
   */
  private static formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60

    if (days > 0) return `${days}天${hours}小时${mins}分钟`
    if (hours > 0) return `${hours}小时${mins}分钟${secs}秒`
    if (mins > 0) return `${mins}分钟${secs}秒`
    return `${secs}秒`
  }

  /**
   * 左对齐填充
   */
  private static padRight(text: string, width: number): string {
    return text.padEnd(width, ' ')
  }

  /**
   * 右对齐填充
   */
  private static padLeft(text: string, width: number): string {
    return text.padStart(width, ' ')
  }
}

