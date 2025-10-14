/**
 * IPv6 地址池管理器
 * 管理和轮换 IPv6 地址，避免单个地址请求过多
 */

interface IPv6Stats {
  totalRequests: number      // 总请求次数
  successCount: number        // 成功次数
  failureCount: number        // 失败次数
  totalResponseTime: number   // 总响应时间(ms)
  minResponseTime: number     // 最小响应时间(ms)
  maxResponseTime: number     // 最大响应时间(ms)
  lastUsedAt: number         // 最后使用时间戳
}

export class IPv6Pool {
  private addresses: string[] = []
  private currentIndex = 0
  private usageStats = new Map<string, number>() // 统计每个IP的使用次数
  private detailedStats = new Map<string, IPv6Stats>() // 详细统计信息
  private poolStartTime = Date.now() // 池启动时间

  /**
   * 初始化 IPv6 地址池
   * @param basePrefix IPv6 前缀，如 "2607:8700:5500:2043"
   * @param start 起始编号，如 1001
   * @param count 地址数量，如 100
   */
  constructor(basePrefix: string, start: number, count: number) {
    for (let i = 0; i < count; i++) {
      const addr = `${basePrefix}::${start + i}`
      this.addresses.push(addr)
      this.usageStats.set(addr, 0)
      this.detailedStats.set(addr, {
        totalRequests: 0,
        successCount: 0,
        failureCount: 0,
        totalResponseTime: 0,
        minResponseTime: Infinity,
        maxResponseTime: 0,
        lastUsedAt: 0
      })
    }
    
    if (count > 0 && this.addresses.length > 0) {
      console.log(`✓ IPv6 池初始化完成: ${this.addresses.length} 个地址`)
      console.log(`  范围: ${this.addresses[0]} ~ ${this.addresses[this.addresses.length - 1]}`)
    }
  }

  /**
   * 获取下一个 IPv6 地址（轮询）
   */
  public getNext(): string | null {
    if (this.addresses.length === 0) {
      return null  // 没有 IPv6 地址池
    }
    
    const addr = this.addresses[this.currentIndex]
    this.currentIndex = (this.currentIndex + 1) % this.addresses.length
    
    // 更新使用统计
    this.usageStats.set(addr, (this.usageStats.get(addr) || 0) + 1)
    
    return addr
  }

  /**
   * 获取健康的 IPv6 地址（智能选择，排除失败率高的IP）
   */
  public getHealthyNext(): string | null {
    if (this.addresses.length === 0) {
      return null  // 没有 IPv6 地址池
    }
    
    // 过滤出健康的IP（失败率<30%）
    const healthyAddresses = this.addresses.filter(addr => {
      const stats = this.detailedStats.get(addr)!
      if (stats.totalRequests < 20) return true  // 新IP给机会（增加到20次）
      
      const failRate = stats.failureCount / stats.totalRequests
      const avgRT = stats.totalResponseTime / stats.totalRequests
      
      // 条件：失败率<30% 且 平均响应时间<3000ms
      return failRate < 0.3 && avgRT < 3000
    })
    
    // 如果没有健康IP，降级到普通轮询
    if (healthyAddresses.length === 0) {
      console.warn('⚠️  没有健康的IPv6地址，使用普通轮询')
      return this.getNext()
    }
    
    // 从健康IP中选择使用最少的
    let minUsage = Infinity
    let selectedAddr = healthyAddresses[0]
    
    for (const addr of healthyAddresses) {
      const usage = this.usageStats.get(addr) || 0
      if (usage < minUsage) {
        minUsage = usage
        selectedAddr = addr
      }
    }
    
    // 更新使用统计
    this.usageStats.set(selectedAddr, (this.usageStats.get(selectedAddr) || 0) + 1)
    
    return selectedAddr
  }

  /**
   * 随机获取一个 IPv6 地址
   */
  public getRandom(): string {
    const index = Math.floor(Math.random() * this.addresses.length)
    const addr = this.addresses[index]
    
    this.usageStats.set(addr, (this.usageStats.get(addr) || 0) + 1)
    
    return addr
  }

  /**
   * 获取使用最少的 IPv6 地址（负载均衡）
   */
  public getLeastUsed(): string {
    let minUsage = Infinity
    let leastUsedAddr = this.addresses[0]
    
    for (const [addr, usage] of this.usageStats) {
      if (usage < minUsage) {
        minUsage = usage
        leastUsedAddr = addr
      }
    }
    
    this.usageStats.set(leastUsedAddr, minUsage + 1)
    
    return leastUsedAddr
  }

  /**
   * 获取统计信息
   */
  public getStats() {
    const total = this.addresses.length
    const totalRequests = Array.from(this.usageStats.values()).reduce((sum, count) => sum + count, 0)
    const avgPerIP = Math.round(totalRequests / total)
    
    // 找出使用最多和最少的IP
    let maxUsage = 0
    let minUsage = Infinity
    
    for (const usage of this.usageStats.values()) {
      if (usage > maxUsage) maxUsage = usage
      if (usage < minUsage) minUsage = usage
    }
    
    return {
      totalAddresses: total,
      totalRequests,
      averagePerIP: avgPerIP,
      maxUsage,
      minUsage,
      balance: maxUsage - minUsage // 平衡度：差值越小越均衡
    }
  }

  /**
   * 重置统计
   */
  public resetStats() {
    this.usageStats.forEach((_, addr) => {
      this.usageStats.set(addr, 0)
    })
  }

  /**
   * 获取所有地址
   */
  public getAllAddresses(): string[] {
    return [...this.addresses]
  }

  /**
   * 记录请求结果
   * @param ipv6 IPv6地址
   * @param success 是否成功
   * @param responseTime 响应时间(ms)
   */
  public recordRequest(ipv6: string, success: boolean, responseTime: number): void {
    const stats = this.detailedStats.get(ipv6)
    if (!stats) return

    stats.totalRequests++
    stats.lastUsedAt = Date.now()
    
    if (success) {
      stats.successCount++
    } else {
      stats.failureCount++
    }
    
    stats.totalResponseTime += responseTime
    stats.minResponseTime = Math.min(stats.minResponseTime, responseTime)
    stats.maxResponseTime = Math.max(stats.maxResponseTime, responseTime)
  }

  /**
   * 获取详细统计信息
   */
  public getDetailedStats() {
    const total = this.addresses.length
    const totalRequests = Array.from(this.usageStats.values()).reduce((sum, count) => sum + count, 0)
    const avgPerIP = Math.round(totalRequests / total)
    
    // 计算总的成功/失败次数
    let totalSuccess = 0
    let totalFailure = 0
    let totalResponseTime = 0
    
    for (const stats of this.detailedStats.values()) {
      totalSuccess += stats.successCount
      totalFailure += stats.failureCount
      totalResponseTime += stats.totalResponseTime
    }
    
    const successRate = totalRequests > 0 ? (totalSuccess / totalRequests * 100).toFixed(2) : '0.00'
    const avgResponseTime = totalRequests > 0 ? Math.round(totalResponseTime / totalRequests) : 0
    
    // 找出使用最多和最少的IP
    let maxUsage = 0
    let minUsage = Infinity
    
    for (const usage of this.usageStats.values()) {
      if (usage > maxUsage) maxUsage = usage
      if (usage < minUsage) minUsage = usage
    }
    
    // 运行时间
    const uptime = Math.floor((Date.now() - this.poolStartTime) / 1000)
    const requestsPerSecond = uptime > 0 ? (totalRequests / uptime).toFixed(2) : '0.00'
    
    return {
      totalAddresses: total,
      totalRequests,
      averagePerIP: avgPerIP,
      maxUsage,
      minUsage,
      balance: maxUsage - minUsage,
      successRate,
      totalSuccess,
      totalFailure,
      avgResponseTime,
      uptime,
      requestsPerSecond
    }
  }

  /**
   * 获取每个IPv6的详细信息
   */
  public getPerIPStats() {
    const result: Array<{
      address: string
      totalRequests: number
      successCount: number
      failureCount: number
      successRate: string
      avgResponseTime: number
      minResponseTime: number
      maxResponseTime: number
      lastUsedAt: number
      lastUsedAgo: string
    }> = []
    
    for (const addr of this.addresses) {
      const stats = this.detailedStats.get(addr)!
      const totalReq = stats.totalRequests
      const successRate = totalReq > 0 ? (stats.successCount / totalReq * 100).toFixed(2) : '0.00'
      const avgResponseTime = totalReq > 0 ? Math.round(stats.totalResponseTime / totalReq) : 0
      
      const lastUsedAgo = stats.lastUsedAt > 0 
        ? this.formatDuration(Date.now() - stats.lastUsedAt)
        : '从未使用'
      
      result.push({
        address: addr,
        totalRequests: stats.totalRequests,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        successRate,
        avgResponseTime,
        minResponseTime: stats.minResponseTime === Infinity ? 0 : stats.minResponseTime,
        maxResponseTime: stats.maxResponseTime,
        lastUsedAt: stats.lastUsedAt,
        lastUsedAgo
      })
    }
    
    return result
  }

  /**
   * 格式化时间间隔
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000)
    
    if (seconds < 60) return `${seconds}秒前`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时前`
    return `${Math.floor(seconds / 86400)}天前`
  }

  /**
   * 导出统计数据为JSON
   */
  public exportJSON() {
    return {
      summary: this.getDetailedStats(),
      perIP: this.getPerIPStats(),
      exportTime: new Date().toISOString()
    }
  }

  /**
   * 导出统计数据为CSV格式
   */
  public exportCSV(): string {
    const perIPStats = this.getPerIPStats()
    const header = 'IPv6地址,总请求数,成功次数,失败次数,成功率(%),平均响应时间(ms),最小响应时间(ms),最大响应时间(ms),最后使用时间\n'
    
    const rows = perIPStats.map(stat => {
      const lastUsed = stat.lastUsedAt > 0 ? new Date(stat.lastUsedAt).toISOString() : '从未使用'
      return `${stat.address},${stat.totalRequests},${stat.successCount},${stat.failureCount},${stat.successRate},${stat.avgResponseTime},${stat.minResponseTime},${stat.maxResponseTime},${lastUsed}`
    })
    
    return header + rows.join('\n')
  }
}

