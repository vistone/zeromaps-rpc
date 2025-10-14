/**
 * 系统 curl 请求执行器
 * 使用系统自带的 curl 命令
 * 使用 fastq 队列管理请求
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import * as os from 'os'
import * as fastq from 'fastq'
import type { queueAsPromised } from 'fastq'
import { EventEmitter } from 'events'
import { IPv6Pool } from './ipv6-pool.js'

const execAsync = promisify(exec)

export interface FetchOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  timeout?: number
  ipv6?: string // 指定使用的 IPv6 地址
}

export interface FetchResult {
  statusCode: number
  headers: Record<string, string>
  body: Buffer
  error?: string
}

interface CurlTask {
  requestId: number
  options: FetchOptions
  ipv6: string | null
  queuedAt: number
}

export class CurlFetcher extends EventEmitter {
  private ipv6Pool: IPv6Pool | null = null
  private requestCount = 0
  private concurrentRequests = 0  // 当前并发请求数
  private maxConcurrent = 0       // 最大并发请求数（用于统计）
  private queue: queueAsPromised<CurlTask, FetchResult>

  /**
   * @param ipv6Pool 可选的 IPv6 地址池
   * @param concurrency 并发数（默认通过环境变量或自动计算）
   */
  constructor(
    ipv6Pool?: IPv6Pool,
    concurrency?: number
  ) {
    super()
    this.ipv6Pool = ipv6Pool || null

    // 并发数优先级：参数 > 环境变量 > 自动计算（默认1-2）
    const finalConcurrency = concurrency
      || parseInt(process.env.CURL_CONCURRENCY || '0')
      || this.calculateOptimalConcurrency()

    console.log(`🚀 CurlFetcher 初始化: 并发数=${finalConcurrency}, 使用系统 curl, 随机延迟=100-500ms`)

    // fastq 队列，管理请求分发
    this.queue = fastq.promise(this.worker.bind(this), finalConcurrency)
  }

  /**
   * 根据可用内存计算最佳并发数
   */
  private calculateOptimalConcurrency(): number {
    try {
      const totalMem = os.totalmem() / 1024 / 1024 // MB
      const freeMem = os.freemem() / 1024 / 1024   // MB

      // 系统 curl 占用约 10-20MB
      // 保留 300MB 给系统和 Node.js
      const reservedMem = 300
      const perProcessMem = 15  // 系统 curl 更轻量
      const optimal = Math.floor((totalMem - reservedMem) / perProcessMem)

      // 范围：1-2（极低并发避免被 Google 封禁）
      const concurrency = Math.max(1, Math.min(2, optimal))

      console.log(`📊 内存情况: 总内存=${totalMem.toFixed(0)}MB, 空闲=${freeMem.toFixed(0)}MB`)
      console.log(`📊 计算得出最佳并发数: ${concurrency}（极低并发避免被封）`)

      return concurrency
    } catch (error) {
      console.warn('⚠️ 无法计算最佳并发数，使用默认值 1')
      return 1
    }
  }

  /**
   * 发起 HTTP 请求（加入 fastq 队列）
   */
  public async fetch(options: FetchOptions): Promise<FetchResult> {
    const requestId = ++this.requestCount
    const queuedAt = Date.now()
    // 使用智能IPv6选择（优先选择健康的IP）
    const ipv6 = options.ipv6 || (this.ipv6Pool ? this.ipv6Pool.getHealthyNext() : null)

    console.log(`[Req#${requestId}] 📥 接收请求: ${options.url.substring(0, 80)}`)

    const result = await this.queue.push({ requestId, options, ipv6, queuedAt })

    const totalTime = Date.now() - queuedAt
    console.log(`[Req#${requestId}] ✅ 总耗时: ${totalTime}ms\n`)

    return result
  }

  /**
   * Worker：实际执行 curl（使用系统 curl）
   */
  private async worker(task: CurlTask): Promise<FetchResult> {
    const { requestId, options, ipv6, queuedAt } = task

    const t1 = Date.now()
    const waitTime = t1 - queuedAt

    this.concurrentRequests++
    if (this.concurrentRequests > this.maxConcurrent) {
      this.maxConcurrent = this.concurrentRequests
    }

    // 队列等待告警
    if (waitTime > 1000) {
      console.warn(`[Req#${requestId}] ⚠️  队列等待过长: ${waitTime}ms, 当前并发: ${this.concurrentRequests}, 队列长度: ${this.queue.length()}`)
    } else {
      console.log(`[Req#${requestId}] ⏱️  队列等待: ${waitTime}ms, 当前并发: ${this.concurrentRequests}`)
    }

    try {
      // 1. 随机延迟 (100-500ms)，避免请求模式太规律
      const randomDelay = Math.floor(Math.random() * 400) + 100
      await new Promise(resolve => setTimeout(resolve, randomDelay))
      console.log(`[Req#${requestId}]   ├─ 随机延迟: ${randomDelay}ms`)

      // 2. 构建系统 curl 命令
      const curlCmd = this.buildCurlCommand(options, ipv6)

      // 3. 执行 curl
      const t3 = Date.now()
      console.log(`[Req#${requestId}]   ├─ 开始执行 curl via ${ipv6?.substring(0, 30)}...`)

      const result = await execAsync(curlCmd, {
        encoding: 'buffer',
        maxBuffer: 10 * 1024 * 1024,  // 10MB
        timeout: options.timeout || 10000
      })
      const stdout = result.stdout as Buffer

      const curlTime = Date.now() - t3
      console.log(`[Req#${requestId}]   ├─ curl 执行: ${curlTime}ms`)

      // 4. 解析响应
      const parsedResult = this.parseResponse(stdout)
      console.log(`[Req#${requestId}]   ├─ 状态码: ${parsedResult.statusCode}, 数据: ${parsedResult.body.length} bytes`)

      // 5. 记录统计
      const totalDuration = Date.now() - queuedAt
      const success = parsedResult.statusCode >= 200 && parsedResult.statusCode < 300
      if (ipv6 && this.ipv6Pool) {
        this.ipv6Pool.recordRequest(ipv6, success, totalDuration)
      }

      // 发出请求完成事件
      try {
        this.emit('request', {
          requestId,
          url: options.url,
          ipv6: ipv6?.substring(0, 30),
          statusCode: parsedResult.statusCode,
          success,
          duration: totalDuration,
          size: parsedResult.body.length,
          waitTime,
          curlTime,
          timestamp: Date.now()
        })
      } catch (emitError) {
        console.error(`[Req#${requestId}] ⚠️  事件发送失败:`, emitError)
      }

      this.concurrentRequests--
      return parsedResult

    } catch (error) {
      const duration = Date.now() - queuedAt
      console.error(`[Req#${requestId}] ❌ 错误 (${duration}ms):`, (error as Error).message)

      if (ipv6 && this.ipv6Pool) {
        this.ipv6Pool.recordRequest(ipv6, false, duration)
      }

      // 发出请求错误事件
      try {
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
      } catch (emitError) {
        console.error(`[Req#${requestId}] ⚠️  事件发送失败:`, emitError)
      }

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
   * 构建系统 curl 命令
   */
  private buildCurlCommand(options: FetchOptions, ipv6: string | null): string {
    const parts = ['curl']

    // IPv6 接口
    if (ipv6) {
      parts.push(`--interface "${ipv6}"`)
    }
    parts.push('-6')

    // 基本参数
    parts.push('--http2')
    parts.push('--compressed')

    // 方法
    if (options.method && options.method !== 'GET') {
      parts.push(`-X ${options.method}`)
    }

    // 模拟 Google Earth Web 客户端的完整 Headers
    parts.push(`-H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'`)
    parts.push(`-H 'Accept: */*'`)
    parts.push(`-H 'Accept-Encoding: gzip, deflate, br'`)
    parts.push(`-H 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8'`)
    parts.push(`-H 'Referer: https://earth.google.com/'`)
    parts.push(`-H 'Origin: https://earth.google.com'`)
    parts.push(`-H 'Sec-Fetch-Dest: empty'`)
    parts.push(`-H 'Sec-Fetch-Mode: cors'`)
    parts.push(`-H 'Sec-Fetch-Site: same-site'`)

    // 自定义 Headers
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        parts.push(`-H "${key}: ${value}"`)
      }
    }

    // 超时
    parts.push(`--max-time ${Math.floor((options.timeout || 10000) / 1000)}`)

    // 包含响应头
    parts.push('-i')

    // 禁用进度条
    parts.push('-s')

    // URL
    parts.push(`"${options.url}"`)

    return parts.join(' ')
  }

  /**
   * 解析 curl 响应（包含 headers）
   */
  private parseResponse(buffer: Buffer): FetchResult {
    // 查找 headers 和 body 的分隔符
    const separator = Buffer.from('\r\n\r\n')
    const separatorIndex = buffer.indexOf(separator)

    if (separatorIndex === -1) {
      // 没找到分隔符，可能是错误响应
      return {
        statusCode: 0,
        headers: {},
        body: buffer,
        error: 'Invalid response format'
      }
    }

    // 分离 headers 和 body
    const headersBuffer = buffer.slice(0, separatorIndex)
    const body = buffer.slice(separatorIndex + 4)

    // 解析 headers
    const headersText = headersBuffer.toString('utf-8')
    const lines = headersText.split('\r\n')

    // 第一行是状态行: HTTP/2 200 OK
    const statusLine = lines[0]
    const statusMatch = statusLine.match(/HTTP\/[\d.]+\s+(\d+)/)
    const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0

    // 解析 header 字段
    const headers: Record<string, string> = {}
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      const colonIndex = line.indexOf(':')
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim().toLowerCase()
        const value = line.substring(colonIndex + 1).trim()
        headers[key] = value
      }
    }

    return {
      statusCode,
      headers,
      body
    }
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

