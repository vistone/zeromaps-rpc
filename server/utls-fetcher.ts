/**
 * uTLS Proxy Fetcher
 * 通过本地 Go uTLS 代理发送请求，完美模拟 Chrome TLS 指纹
 */

import * as http from 'http'
import { EventEmitter } from 'events'
import { IPv6Pool } from './ipv6-pool.js'
import * as fastq from 'fastq'
import type { queueAsPromised } from 'fastq'
import { createLogger } from './logger.js'

const logger = createLogger('UTLSFetcher')

export interface FetchOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  timeout?: number
  ipv6?: string
}

export interface FetchResult {
  statusCode: number
  headers: Record<string, string>
  body: Buffer
  error?: string
}

interface UTLSTask {
  requestId: number
  options: FetchOptions
  ipv6: string | null
  queuedAt: number
}

export class UTLSFetcher extends EventEmitter {
  private ipv6Pool: IPv6Pool | null = null
  private requestCount = 0
  private concurrentRequests = 0
  private maxConcurrent = 0
  private queue: queueAsPromised<UTLSTask, FetchResult>
  private proxyUrl: string
  private minResponseSizeBytes: number = 50  // 数据验证阈值，默认 50B，可通过配置热更新
  private allowedContentTypes: string[] | null = null
  private currentConcurrency: number = 100   // 当前并发数
  private httpAgent: http.Agent | null = null  // HTTP Keep-Alive 连接池
  private adaptiveConcurrency = true  // 是否启用自适应并发调整
  private concurrencyAdjustmentInterval: NodeJS.Timeout | null = null
  private performanceMetrics = {
    avgResponseTime: 0,
    successRate: 1.0,
    lastAdjustment: Date.now(),
    adjustmentCount: 0
  }

  constructor(
    ipv6Pool?: IPv6Pool,
    concurrency: number = 100,
    proxyPort: number = 8765,
    enableKeepAlive: boolean = true,
    enableAdaptiveConcurrency: boolean = true
  ) {
    super()
    this.ipv6Pool = ipv6Pool || null
    this.proxyUrl = `http://localhost:${proxyPort}/proxy`
    this.currentConcurrency = concurrency
    this.adaptiveConcurrency = enableAdaptiveConcurrency

    // 初始化 HTTP Keep-Alive 连接池
    if (enableKeepAlive) {
      this.httpAgent = new http.Agent({
        keepAlive: true,
        maxSockets: concurrency * 2,  // 允许更多连接以支持并发
        maxFreeSockets: concurrency,
        timeout: 60000,  // 60秒空闲超时
        keepAliveMsecs: 30000  // 30秒保活间隔
      })
    }

    logger.info('UTLSFetcher 初始化', {
      concurrency,
      proxyPort,
      keepAlive: enableKeepAlive,
      adaptiveConcurrency: enableAdaptiveConcurrency
    })

    this.queue = fastq.promise(this.worker.bind(this), concurrency)

    // 启动自适应并发调整
    if (this.adaptiveConcurrency) {
      this.startAdaptiveConcurrencyAdjustment()
    }
  }

  /**
   * 更新数据验证配置（热更新）
   */
  public updateValidationConfig(config: { minResponseSize?: number, allowedContentTypes?: string[] }): void {
    if (config.minResponseSize !== undefined && Number.isFinite(config.minResponseSize)) {
      this.minResponseSizeBytes = Math.max(0, Math.floor(config.minResponseSize))
      logger.info('UTLSFetcher 数据验证阈值已更新', { minResponseSizeBytes: this.minResponseSizeBytes })
    }
    if (config.allowedContentTypes && Array.isArray(config.allowedContentTypes)) {
      this.allowedContentTypes = config.allowedContentTypes.filter(t => typeof t === 'string')
      logger.info('UTLSFetcher 允许的 Content-Type 已更新', { allowedContentTypes: this.allowedContentTypes })
    }
  }

  /**
   * 更新并发配置（热更新）
   */
  public updateConcurrencyConfig(config: {
    concurrency?: number,
    enableKeepAlive?: boolean,
    enableAdaptiveConcurrency?: boolean
  }): void {
    if (config.concurrency !== undefined && config.concurrency > 0) {
      this.currentConcurrency = config.concurrency
      this.queue.concurrency = config.concurrency
      logger.info('UTLSFetcher 并发数已更新', { concurrency: this.currentConcurrency })
    }

    if (config.enableKeepAlive !== undefined) {
      if (config.enableKeepAlive && !this.httpAgent) {
        this.httpAgent = new http.Agent({
          keepAlive: true,
          maxSockets: this.currentConcurrency * 2,
          maxFreeSockets: this.currentConcurrency,
          timeout: 60000,
          keepAliveMsecs: 30000
        })
        logger.info('UTLSFetcher Keep-Alive 已启用')
      } else if (!config.enableKeepAlive && this.httpAgent) {
        this.httpAgent.destroy()
        this.httpAgent = null
        logger.info('UTLSFetcher Keep-Alive 已禁用')
      }
    }

    if (config.enableAdaptiveConcurrency !== undefined) {
      this.adaptiveConcurrency = config.enableAdaptiveConcurrency
      if (this.adaptiveConcurrency && !this.concurrencyAdjustmentInterval) {
        this.startAdaptiveConcurrencyAdjustment()
        logger.info('UTLSFetcher 自适应并发已启用')
      } else if (!this.adaptiveConcurrency && this.concurrencyAdjustmentInterval) {
        clearInterval(this.concurrencyAdjustmentInterval)
        this.concurrencyAdjustmentInterval = null
        logger.info('UTLSFetcher 自适应并发已禁用')
      }
    }
  }

  /**
   * 启动自适应并发调整
   * 注意：如果外部（RpcServer）启用了动态并发调整，此方法不会启动，避免冲突
   */
  private startAdaptiveConcurrencyAdjustment(): void {
    // 检查是否由外部统一管理并发（RpcServer 的动态并发调整）
    // 如果禁用，则不启动内部调整，避免与 RpcServer 冲突
    if (!this.adaptiveConcurrency) {
      logger.info('UTLSFetcher 自适应并发调整已禁用（由外部统一管理）')
      return
    }

    if (this.concurrencyAdjustmentInterval) {
      clearInterval(this.concurrencyAdjustmentInterval)
    }

    // 每30秒调整一次并发数
    this.concurrencyAdjustmentInterval = setInterval(() => {
      this.adjustConcurrency()
    }, 30000)

    logger.info('UTLSFetcher 自适应并发调整已启动（独立模式）')
  }

  /**
   * 调整并发数（基于性能指标）
   */
  private adjustConcurrency(): void {
    const now = Date.now()
    const timeSinceLastAdjustment = now - this.performanceMetrics.lastAdjustment

    // 至少需要运行1分钟才进行调整
    if (timeSinceLastAdjustment < 60000) {
      return
    }

    const { avgResponseTime, successRate } = this.performanceMetrics
    const oldConcurrency = this.currentConcurrency
    let newConcurrency = this.currentConcurrency

    // 基于响应时间和成功率调整并发数
    if (avgResponseTime > 2000 && successRate > 0.8) {
      // 响应时间过长但成功率高，可以增加并发
      newConcurrency = Math.min(this.currentConcurrency + 5, 200)
    } else if (avgResponseTime < 500 && successRate > 0.9) {
      // 响应时间短且成功率高，可以进一步增加并发
      newConcurrency = Math.min(this.currentConcurrency + 10, 300)
    } else if (successRate < 0.7 || avgResponseTime > 5000) {
      // 成功率低或响应时间过长，减少并发
      newConcurrency = Math.max(this.currentConcurrency - 10, 10)
    } else if (successRate < 0.5) {
      // 成功率很低，大幅减少并发
      newConcurrency = Math.max(this.currentConcurrency - 20, 5)
    }

    if (newConcurrency !== oldConcurrency) {
      this.currentConcurrency = newConcurrency
      this.queue.concurrency = newConcurrency
      this.performanceMetrics.lastAdjustment = now
      this.performanceMetrics.adjustmentCount++

      logger.info('UTLSFetcher 自适应并发调整', {
        oldConcurrency,
        newConcurrency,
        avgResponseTime: Math.round(avgResponseTime),
        successRate: Math.round(successRate * 100) / 100,
        adjustmentCount: this.performanceMetrics.adjustmentCount
      })

      // 更新 HTTP Agent 的连接池大小
      if (this.httpAgent) {
        this.httpAgent.maxSockets = newConcurrency * 2
        this.httpAgent.maxFreeSockets = newConcurrency
      }
    }
  }

  /**
   * 更新性能指标
   */
  private updatePerformanceMetrics(responseTime: number, success: boolean): void {
    // 使用指数移动平均更新响应时间
    const alpha = 0.1  // 平滑因子
    this.performanceMetrics.avgResponseTime =
      this.performanceMetrics.avgResponseTime === 0
        ? responseTime
        : alpha * responseTime + (1 - alpha) * this.performanceMetrics.avgResponseTime

    // 使用指数移动平均更新成功率
    const successValue = success ? 1 : 0
    this.performanceMetrics.successRate =
      alpha * successValue + (1 - alpha) * this.performanceMetrics.successRate
  }

  /**
   * 发起 HTTP 请求
   */
  public async fetch(options: FetchOptions): Promise<FetchResult> {
    const requestId = ++this.requestCount
    const queuedAt = Date.now()

    // 修复：明确检查 undefined，空字符串 '' 表示不使用 IPv6
    const ipv6 = options.ipv6 !== undefined
      ? options.ipv6
      : (this.ipv6Pool ? this.ipv6Pool.getHealthyNext() : null)

    logger.debug('接收请求', {
      requestId,
      url: options.url.substring(0, 80),
      useIPv6: ipv6 ? ipv6.substring(0, 30) : '默认网络'
    })

    const result = await this.queue.push({ requestId, options, ipv6, queuedAt })

    const totalTime = Date.now() - queuedAt
    logger.debug('请求完成', { requestId, totalTime })

    return result
  }

  /**
   * Worker: 通过 Go uTLS 代理发送请求
   */
  private async worker(task: UTLSTask): Promise<FetchResult> {
    const { requestId, options, ipv6, queuedAt } = task

    const t1 = Date.now()
    const waitTime = t1 - queuedAt

    this.concurrentRequests++
    if (this.concurrentRequests > this.maxConcurrent) {
      this.maxConcurrent = this.concurrentRequests
    }

    logger.debug('开始处理', {
      requestId,
      waitTime,
      concurrent: this.concurrentRequests
    })

    try {
      // 构建代理 URL
      const proxyURL = new URL(this.proxyUrl)
      proxyURL.searchParams.set('url', options.url)
      // 只有非空字符串才设置 IPv6 参数
      if (ipv6 && ipv6.length > 0) {
        proxyURL.searchParams.set('ipv6', ipv6)
      }

      const t3 = Date.now()
      logger.debug('通过 uTLS 代理请求', {
        requestId,
        network: ipv6 && ipv6.length > 0 ? ipv6.substring(0, 30) : 'IPv4 默认网络'
      })

      // 发送请求到 Go 代理
      const result = await this.httpRequest(proxyURL.toString(), options.timeout || 10000)

      const requestTime = Date.now() - t3

      // 从响应头获取状态码和请求模式信息
      const statusCode = parseInt(result.headers['x-status-code'] || '200')
      const requestMode = result.headers['x-request-mode'] || 'unknown'
      const usedIP = result.headers['x-used-ip'] || 'unknown'
      const actualBodySize = result.body.length

      // 调试：检查响应体实际内容并验证数据有效性
      let isValidData = true
      let dataWarning = ''

      if (actualBodySize < 100) {
        const preview = result.body.toString('utf-8').substring(0, 50)

        // 检测是否是 HTML/JSON 错误页面或数据过小
        if (preview.includes('<html') || preview.includes('<!DOCTYPE')) {
          isValidData = false
          dataWarning = '返回了 HTML 页面，不是 protobuf 数据'
        } else if (preview.includes('{') && preview.includes('"error"')) {
          isValidData = false
          dataWarning = '返回了 JSON 错误消息'
        } else if (actualBodySize < this.minResponseSizeBytes) {
          // 使用可配置阈值：小于 minResponseSizeBytes 认为无效
          isValidData = false
          dataWarning = `数据过小（${actualBodySize}B），疑似错误页面`
        }

        logger.warn('uTLS 代理响应（小文件，需检查）', {
          requestId,
          requestTime,
          statusCode,
          bodySize: actualBodySize,
          bodyPreview: preview,
          isValidData,
          warning: dataWarning
        })
      } else {
        // 可选的 Content-Type 允许列表告警（不拦截）
        const contentType = (result.headers['content-type'] || '').toString()
        if (this.allowedContentTypes && this.allowedContentTypes.length > 0) {
          const ok = this.allowedContentTypes.some(t => contentType.includes(t))
          if (!ok) {
            logger.warn('Content-Type 不在允许列表（仅告警，不拦截）', {
              requestId,
              contentType,
              allowed: this.allowedContentTypes
            })
          }
        }
        logger.debug('uTLS 代理响应', {
          requestId,
          requestTime,
          statusCode,
          size: actualBodySize
        })
      }

      // 如果数据无效，触发紧急检查
      if (!isValidData && statusCode === 200) {
        logger.error('🚨 数据验证失败：状态码 200 但返回无效数据，触发紧急检查', undefined, {
          requestId,
          bodySize: actualBodySize,
          warning: dataWarning,
          url: options.url.substring(0, 80)
        })

        // 触发紧急健康检查事件
        this.emit('invalidData', {
          requestId,
          statusCode,
          bodySize: actualBodySize,
          warning: dataWarning,
          url: options.url
        })
      }

      // 记录统计
      const totalDuration = Date.now() - queuedAt
      const success = statusCode === 200  // 只有 200 状态码才算成功

      // 更新性能指标（用于自适应并发调整）
      this.updatePerformanceMetrics(totalDuration, success)

      // 只有使用 IPv6 时才记录到 IPv6 池统计
      if (ipv6 && ipv6.length > 0 && this.ipv6Pool) {
        this.ipv6Pool.recordRequest(ipv6, statusCode, totalDuration)
      }

      this.emit('request', {
        requestId,
        url: options.url,
        ipv6: ipv6 && ipv6.length > 0 ? ipv6.substring(0, 30) : 'IPv4',
        statusCode,
        success,
        duration: totalDuration,
        size: result.body.length,
        waitTime,
        requestMode,  // 'ip-pool' 或 'domain'
        usedIP,       // 实际使用的 IP 地址
        timestamp: Date.now()
      })

      this.concurrentRequests--
      return {
        statusCode,
        headers: result.headers,
        body: result.body
      }

    } catch (error) {
      const duration = Date.now() - queuedAt
      logger.error('请求失败', error as Error, {
        requestId,
        duration
      })

      // 只有使用 IPv6 时才记录到 IPv6 池统计
      if (ipv6 && ipv6.length > 0 && this.ipv6Pool) {
        this.ipv6Pool.recordRequest(ipv6, 0, duration)  // 0 表示网络异常
      }

      this.emit('request', {
        requestId,
        url: options.url,
        ipv6: ipv6 && ipv6.length > 0 ? ipv6.substring(0, 30) : 'IPv4',
        statusCode: 0,
        success: false,
        duration,
        size: 0,
        waitTime,
        error: (error as Error).message,
        timestamp: Date.now()
      })

      this.concurrentRequests--
      return {
        statusCode: 0,
        headers: {},
        body: Buffer.alloc(0),
        error: (error as Error).message
      }
    }
  }

  /**
   * 发送 HTTP 请求到本地代理
   */
  private async httpRequest(url: string, timeout: number): Promise<{ headers: Record<string, string>, body: Buffer }> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url)

      const options: any = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        timeout
      }

      // 只有在启用 Keep-Alive 时才设置 agent
      if (this.httpAgent) {
        options.agent = this.httpAgent
      }

      const req = http.request(options, (res) => {
        const chunks: Buffer[] = []

        res.on('data', (chunk) => {
          chunks.push(chunk)
        })

        res.on('end', () => {
          const body = Buffer.concat(chunks)
          resolve({
            headers: res.headers as Record<string, string>,
            body
          })
        })
      })

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Request timeout'))
      })

      req.end()
    })
  }

  /**
   * 获取统计信息
   */
  public getStats() {
    return {
      totalRequests: this.requestCount,
      concurrentRequests: this.concurrentRequests,
      maxConcurrent: this.maxConcurrent,
      currentConcurrency: this.currentConcurrency,
      queueLength: this.queue.length(),
      adaptiveConcurrency: this.adaptiveConcurrency,
      keepAliveEnabled: this.httpAgent !== null,
      performanceMetrics: {
        avgResponseTime: Math.round(this.performanceMetrics.avgResponseTime),
        successRate: Math.round(this.performanceMetrics.successRate * 100) / 100,
        adjustmentCount: this.performanceMetrics.adjustmentCount,
        lastAdjustment: this.performanceMetrics.lastAdjustment
      },
      ipv6PoolStats: this.ipv6Pool ? this.ipv6Pool.getStats() : null
    }
  }

  /**
   * 销毁资源
   */
  public destroy(): void {
    if (this.concurrencyAdjustmentInterval) {
      clearInterval(this.concurrencyAdjustmentInterval)
      this.concurrencyAdjustmentInterval = null
    }

    if (this.httpAgent) {
      this.httpAgent.destroy()
      this.httpAgent = null
    }
  }
}

