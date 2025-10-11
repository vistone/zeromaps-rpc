/**
 * IPv6 地址池管理器
 * 管理和轮换 IPv6 地址，避免单个地址请求过多
 */

export class IPv6Pool {
  private addresses: string[] = []
  private currentIndex = 0
  private usageStats = new Map<string, number>() // 统计每个IP的使用次数

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
    }
    
    console.log(`✓ IPv6 池初始化完成: ${this.addresses.length} 个地址`)
    console.log(`  范围: ${this.addresses[0]} ~ ${this.addresses[this.addresses.length - 1]}`)
  }

  /**
   * 获取下一个 IPv6 地址（轮询）
   */
  public getNext(): string {
    const addr = this.addresses[this.currentIndex]
    this.currentIndex = (this.currentIndex + 1) % this.addresses.length
    
    // 更新使用统计
    this.usageStats.set(addr, (this.usageStats.get(addr) || 0) + 1)
    
    return addr
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
}

