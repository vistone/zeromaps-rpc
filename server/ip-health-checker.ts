/**
 * IP健康检查器
 * 通过实际HTTP请求测试IP的有效性，管理白名单/黑名单状态
 */

import * as https from 'https'
import * as http from 'http'
import { EventEmitter } from 'events'
import { createLogger } from './logger.js'

const logger = createLogger('IPHealthChecker')

export interface IPTestResult {
  ip: string
  success: boolean
  statusCode?: number
  responseTime: number
  error?: string
  timestamp: number
  domain: string
}

export interface IPHealthStatus {
  ip: string
  domain: string
  status: 'active' | 'blacklisted' | 'testing'
  lastTest: number
  consecutiveFailures: number
  consecutiveSuccesses: number
  totalTests: number
  successRate: number
  avgResponseTime: number
  lastSuccess?: number
  lastFailure?: number
  error?: string
}

export interface HealthCheckConfig {
  testUrl: string
  testHeaders: Record<string, string>
  timeout: number
  retryCount: number
  blacklistThreshold: number // 连续失败多少次进入黑名单
  whitelistThreshold: number // 连续成功多少次从黑名单移除
  testInterval: number // 测试间隔（毫秒）
  blacklistTestInterval: number // 黑名单IP测试间隔（毫秒）
}

export class IPHealthChecker extends EventEmitter {
  private healthStatus = new Map<string, IPHealthStatus>()
  private testIntervals = new Map<string, NodeJS.Timeout>()
  private isRunning = false
  private config: HealthCheckConfig

  constructor(config: Partial<HealthCheckConfig> = {}) {
    super()
    
    this.config = {
      testUrl: '/rt/earth/PlanetoidMetadata',
      testHeaders: {
        'Host': 'kh.google.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
      },
      timeout: 10000, // 10秒超时
      retryCount: 2,
      blacklistThreshold: 3, // 连续失败3次进入黑名单
      whitelistThreshold: 2, // 连续成功2次从黑名单移除
      testInterval: 5 * 60 * 1000, // 5分钟测试一次
      blacklistTestInterval: 10 * 60 * 1000, // 黑名单IP 10分钟测试一次
      ...config
    }
    
    logger.info('IP健康检查器已初始化', {
      testUrl: this.config.testUrl,
      timeout: this.config.timeout,
      blacklistThreshold: this.config.blacklistThreshold,
      whitelistThreshold: this.config.whitelistThreshold
    })
  }

  /**
   * 添加IP到监控列表
   */
  public addIP(ip: string, domain: string, initialStatus: 'active' | 'blacklisted' = 'active'): void {
    const key = `${domain}:${ip}`
    
    if (!this.healthStatus.has(key)) {
      this.healthStatus.set(key, {
        ip,
        domain,
        status: initialStatus,
        lastTest: 0,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        totalTests: 0,
        successRate: 0,
        avgResponseTime: 0
      })
      
      logger.info('添加IP到监控', { ip, domain, status: initialStatus })
      
      // 立即开始测试
      this.scheduleTest(key)
    }
  }

  /**
   * 移除IP监控
   */
  public removeIP(ip: string, domain: string): void {
    const key = `${domain}:${ip}`
    
    if (this.healthStatus.has(key)) {
      this.healthStatus.delete(key)
      
      // 清除定时器
      const interval = this.testIntervals.get(key)
      if (interval) {
        clearInterval(interval)
        this.testIntervals.delete(key)
      }
      
      logger.info('移除IP监控', { ip, domain })
    }
  }

  /**
   * 批量添加IP
   */
  public addIPs(ips: string[], domain: string, initialStatus: 'active' | 'blacklisted' = 'active'): void {
    ips.forEach(ip => this.addIP(ip, domain, initialStatus))
  }

  /**
   * 启动健康检查器
   */
  public start(): void {
    if (this.isRunning) {
      logger.warn('健康检查器已在运行')
      return
    }
    
    this.isRunning = true
    logger.info('IP健康检查器已启动')
    
    // 为所有已添加的IP安排测试
    for (const key of this.healthStatus.keys()) {
      this.scheduleTest(key)
    }
  }

  /**
   * 停止健康检查器
   */
  public stop(): void {
    if (!this.isRunning) {
      return
    }
    
    this.isRunning = false
    
    // 清除所有定时器
    for (const interval of this.testIntervals.values()) {
      clearInterval(interval)
    }
    this.testIntervals.clear()
    
    logger.info('IP健康检查器已停止')
  }

  /**
   * 安排IP测试
   */
  private scheduleTest(key: string): void {
    const status = this.healthStatus.get(key)
    if (!status) return
    
    // 清除现有定时器
    const existingInterval = this.testIntervals.get(key)
    if (existingInterval) {
      clearInterval(existingInterval)
    }
    
    // 根据状态设置不同的测试间隔
    const interval = status.status === 'blacklisted' 
      ? this.config.blacklistTestInterval 
      : this.config.testInterval
    
    const timeoutId = setInterval(() => {
      this.testIP(key)
    }, interval)
    
    this.testIntervals.set(key, timeoutId)
    
    // 立即执行一次测试
    setTimeout(() => this.testIP(key), 1000)
  }

  /**
   * 测试单个IP
   */
  private async testIP(key: string): Promise<void> {
    const status = this.healthStatus.get(key)
    if (!status) return
    
    logger.debug('开始测试IP', { ip: status.ip, domain: status.domain, status: status.status })
    
    try {
      const result = await this.performHTTPTest(status.ip, status.domain)
      this.handleTestResult(key, result)
      
    } catch (error) {
      const result: IPTestResult = {
        ip: status.ip,
        domain: status.domain,
        success: false,
        responseTime: 0,
        error: (error as Error).message,
        timestamp: Date.now()
      }
      
      this.handleTestResult(key, result)
    }
  }

  /**
   * 执行HTTP测试
   */
  private async performHTTPTest(ip: string, domain: string): Promise<IPTestResult> {
    const startTime = Date.now()
    
    return new Promise((resolve, reject) => {
      const isIPv6 = ip.includes(':')
      const port = 443
      
      const options: https.RequestOptions = {
        hostname: ip,
        port: port,
        path: this.config.testUrl,
        method: 'GET',
        headers: {
          ...this.config.testHeaders,
          'Host': domain
        },
        timeout: this.config.timeout,
        rejectUnauthorized: false, // 忽略SSL证书验证
        family: isIPv6 ? 6 : 4 // 强制使用IPv4或IPv6
      }
      
      const req = https.request(options, (res) => {
        const responseTime = Date.now() - startTime
        
        const result: IPTestResult = {
          ip,
          domain,
          success: res.statusCode === 200,
          statusCode: res.statusCode,
          responseTime,
          timestamp: Date.now()
        }
        
        resolve(result)
      })
      
      req.on('error', (error) => {
        const responseTime = Date.now() - startTime
        
        const result: IPTestResult = {
          ip,
          domain,
          success: false,
          responseTime,
          error: error.message,
          timestamp: Date.now()
        }
        
        resolve(result)
      })
      
      req.on('timeout', () => {
        req.destroy()
        const responseTime = Date.now() - startTime
        
        const result: IPTestResult = {
          ip,
          domain,
          success: false,
          responseTime,
          error: 'Request timeout',
          timestamp: Date.now()
        }
        
        resolve(result)
      })
      
      req.end()
    })
  }

  /**
   * 处理测试结果
   */
  private handleTestResult(key: string, result: IPTestResult): void {
    const status = this.healthStatus.get(key)
    if (!status) return
    
    const wasBlacklisted = status.status === 'blacklisted'
    
    // 更新统计数据
    status.lastTest = result.timestamp
    status.totalTests++
    
    if (result.success) {
      status.consecutiveSuccesses++
      status.consecutiveFailures = 0
      status.lastSuccess = result.timestamp
      status.error = undefined
      
      // 更新平均响应时间
      if (status.avgResponseTime === 0) {
        status.avgResponseTime = result.responseTime
      } else {
        status.avgResponseTime = (status.avgResponseTime + result.responseTime) / 2
      }
      
    } else {
      status.consecutiveFailures++
      status.consecutiveSuccesses = 0
      status.lastFailure = result.timestamp
      status.error = result.error
    }
    
    // 更新成功率
    status.successRate = status.totalTests > 0 
      ? ((status.totalTests - status.consecutiveFailures) / status.totalTests) * 100 
      : 0
    
    // 状态转换逻辑
    let statusChanged = false
    
    if (result.success) {
      // 成功测试
      if (status.status === 'blacklisted' && status.consecutiveSuccesses >= this.config.whitelistThreshold) {
        // 从黑名单移除
        status.status = 'active'
        statusChanged = true
        logger.info('IP从黑名单移除', { 
          ip: status.ip, 
          domain: status.domain,
          consecutiveSuccesses: status.consecutiveSuccesses 
        })
      }
    } else {
      // 失败测试
      if (status.status === 'active' && status.consecutiveFailures >= this.config.blacklistThreshold) {
        // 加入黑名单
        status.status = 'blacklisted'
        statusChanged = true
        logger.info('IP加入黑名单', { 
          ip: status.ip, 
          domain: status.domain,
          consecutiveFailures: status.consecutiveFailures,
          error: result.error
        })
      }
    }
    
    // 重新安排测试间隔
    if (statusChanged) {
      this.scheduleTest(key)
    }
    
    // 发送事件
    this.emit('testResult', {
      key,
      status: status.status,
      result,
      wasBlacklisted,
      statusChanged
    })
    
    logger.debug('IP测试完成', {
      ip: status.ip,
      domain: status.domain,
      success: result.success,
      statusCode: result.statusCode,
      responseTime: result.responseTime,
      status: status.status,
      consecutiveFailures: status.consecutiveFailures,
      consecutiveSuccesses: status.consecutiveSuccesses
    })
  }

  /**
   * 手动测试IP
   */
  public async testIPManually(ip: string, domain: string): Promise<IPTestResult> {
    logger.info('手动测试IP', { ip, domain })
    
    try {
      const result = await this.performHTTPTest(ip, domain)
      
      // 更新状态（但不改变黑名单状态）
      const key = `${domain}:${ip}`
      const status = this.healthStatus.get(key)
      if (status) {
        status.lastTest = result.timestamp
        status.totalTests++
        
        if (result.success) {
          status.consecutiveSuccesses++
          status.consecutiveFailures = 0
          status.lastSuccess = result.timestamp
        } else {
          status.consecutiveFailures++
          status.consecutiveSuccesses = 0
          status.lastFailure = result.timestamp
          status.error = result.error
        }
        
        status.successRate = status.totalTests > 0 
          ? ((status.totalTests - status.consecutiveFailures) / status.totalTests) * 100 
          : 0
      }
      
      return result
      
    } catch (error) {
      const result: IPTestResult = {
        ip,
        domain,
        success: false,
        responseTime: 0,
        error: (error as Error).message,
        timestamp: Date.now()
      }
      
      return result
    }
  }

  /**
   * 获取IP健康状态
   */
  public getIPStatus(ip: string, domain: string): IPHealthStatus | undefined {
    const key = `${domain}:${ip}`
    return this.healthStatus.get(key)
  }

  /**
   * 获取所有IP状态
   */
  public getAllIPStatus(): IPHealthStatus[] {
    return Array.from(this.healthStatus.values())
  }

  /**
   * 获取活跃IP列表
   */
  public getActiveIPs(domain?: string): string[] {
    const activeIPs: string[] = []
    
    for (const status of this.healthStatus.values()) {
      if (status.status === 'active' && (!domain || status.domain === domain)) {
        activeIPs.push(status.ip)
      }
    }
    
    return activeIPs
  }

  /**
   * 获取黑名单IP列表
   */
  public getBlacklistedIPs(domain?: string): string[] {
    const blacklistedIPs: string[] = []
    
    for (const status of this.healthStatus.values()) {
      if (status.status === 'blacklisted' && (!domain || status.domain === domain)) {
        blacklistedIPs.push(status.ip)
      }
    }
    
    return blacklistedIPs
  }

  /**
   * 获取统计信息
   */
  public getStats(): any {
    const totalIPs = this.healthStatus.size
    let activeCount = 0
    let blacklistedCount = 0
    let totalTests = 0
    let totalSuccesses = 0
    
    for (const status of this.healthStatus.values()) {
      if (status.status === 'active') activeCount++
      if (status.status === 'blacklisted') blacklistedCount++
      totalTests += status.totalTests
      totalSuccesses += status.totalTests - status.consecutiveFailures
    }
    
    return {
      totalIPs,
      activeCount,
      blacklistedCount,
      totalTests,
      totalSuccesses,
      overallSuccessRate: totalTests > 0 ? (totalSuccesses / totalTests) * 100 : 0,
      isRunning: this.isRunning
    }
  }

  /**
   * 强制更新IP状态
   */
  public updateIPStatus(ip: string, domain: string, newStatus: 'active' | 'blacklisted'): void {
    const key = `${domain}:${ip}`
    const status = this.healthStatus.get(key)
    
    if (status && status.status !== newStatus) {
      status.status = newStatus
      logger.info('强制更新IP状态', { ip, domain, newStatus })
      
      // 重新安排测试
      this.scheduleTest(key)
      
      this.emit('statusChanged', { ip, domain, newStatus })
    }
  }

  /**
   * 清除IP统计数据
   */
  public clearIPStats(ip: string, domain: string): void {
    const key = `${domain}:${ip}`
    const status = this.healthStatus.get(key)
    
    if (status) {
      status.consecutiveFailures = 0
      status.consecutiveSuccesses = 0
      status.totalTests = 0
      status.successRate = 0
      status.avgResponseTime = 0
      status.lastSuccess = undefined
      status.lastFailure = undefined
      status.error = undefined
      
      logger.info('清除IP统计数据', { ip, domain })
    }
  }
}
