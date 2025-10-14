/**
 * uTLS Proxy Fetcher
 * 通过本地 Go uTLS 代理发送请求，完美模拟 Chrome TLS 指纹
 */

import * as http from 'http'
import { EventEmitter } from 'events'
import { IPv6Pool } from './ipv6-pool.js'
import * as fastq from 'fastq'
import type { queueAsPromised } from 'fastq'

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

  constructor(
    ipv6Pool?: IPv6Pool,
    concurrency: number = 10,
    proxyPort: number = 8765
  ) {
    super()
    this.ipv6Pool = ipv6Pool || null
    this.proxyUrl = `http://localhost:${proxyPort}/proxy`

    const finalConcurrency = concurrency || parseInt(process.env.UTLS_CONCURRENCY || '10')

    console.log(`🚀 UTLSFetcher 初始化: 并发数=${finalConcurrency}, 代理端口=${proxyPort}`)

    this.queue = fastq.promise(this.worker.bind(this), finalConcurrency)
  }

  /**
   * 发起 HTTP 请求
   */
  public async fetch(options: FetchOptions): Promise<FetchResult> {
    const requestId = ++this.requestCount
    const queuedAt = Date.now()
    const ipv6 = options.ipv6 || (this.ipv6Pool ? this.ipv6Pool.getHealthyNext() : null)

    console.log(`[UTLSReq#${requestId}] 📥 接收请求: ${options.url.substring(0, 80)}`)

    const result = await this.queue.push({ requestId, options, ipv6, queuedAt })

    const totalTime = Date.now() - queuedAt
    console.log(`[UTLSReq#${requestId}] ✅ 总耗时: ${totalTime}ms\n`)

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

    console.log(`[UTLSReq#${requestId}] ⏱️  队列等待: ${waitTime}ms, 当前并发: ${this.concurrentRequests}`)

    try {
      // 构建代理 URL
      const proxyURL = new URL(this.proxyUrl)
      proxyURL.searchParams.set('url', options.url)
      if (ipv6) {
        proxyURL.searchParams.set('ipv6', ipv6)
      }

      const t3 = Date.now()
      console.log(`[UTLSReq#${requestId}]   ├─ 通过 uTLS 代理请求 via ${ipv6?.substring(0, 30)}...`)

      // 发送请求到 Go 代理
      const result = await this.httpRequest(proxyURL.toString(), options.timeout || 10000)

      const requestTime = Date.now() - t3
      console.log(`[UTLSReq#${requestId}]   ├─ uTLS 代理响应: ${requestTime}ms`)

      // 从响应头获取状态码
      const statusCode = parseInt(result.headers['x-status-code'] || '200')
      console.log(`[UTLSReq#${requestId}]   ├─ 状态码: ${statusCode}, 数据: ${result.body.length} bytes`)

      // 记录统计
      const totalDuration = Date.now() - queuedAt
      const success = statusCode >= 200 && statusCode < 300
      if (ipv6 && this.ipv6Pool) {
        this.ipv6Pool.recordRequest(ipv6, success, totalDuration)
      }

      this.emit('request', {
        requestId,
        url: options.url,
        ipv6: ipv6?.substring(0, 30),
        statusCode,
        success,
        duration: totalDuration,
        size: result.body.length,
        waitTime,
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
      console.error(`[UTLSReq#${requestId}] ❌ 错误 (${duration}ms):`, (error as Error).message)

      if (ipv6 && this.ipv6Pool) {
        this.ipv6Pool.recordRequest(ipv6, false, duration)
      }

      this.emit('request', {
        requestId,
        url: options.url,
        ipv6: ipv6?.substring(0, 30),
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
      
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        timeout
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
      queueLength: this.queue.length(),
      ipv6PoolStats: this.ipv6Pool ? this.ipv6Pool.getStats() : null
    }
  }
}

