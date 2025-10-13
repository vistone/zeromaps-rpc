/**
 * curl-impersonate 请求执行器
 * 使用 curl-impersonate 模拟真实浏览器请求
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
  private curlPath: string
  private ipv6Pool: IPv6Pool | null = null
  private requestCount = 0
  private concurrentRequests = 0  // 当前并发请求数
  private maxConcurrent = 0       // 最大并发请求数（用于统计）
  private queue: queueAsPromised<CurlTask, FetchResult>
  private useFallbackCurl = true  // 临时使用普通 curl 测试
  private cookieFiles = new Map<string, string>()  // 域名 -> Cookie 文件路径

  /**
   * @param curlPath curl-impersonate 可执行文件路径
   * @param ipv6Pool 可选的 IPv6 地址池
   * @param concurrency 并发数（默认通过环境变量或自动计算）
   */
  constructor(
    curlPath: string = '/usr/local/bin/curl-impersonate-chrome',
    ipv6Pool?: IPv6Pool,
    concurrency?: number
  ) {
    super()
    this.curlPath = curlPath
    this.ipv6Pool = ipv6Pool || null

    // 并发数优先级：参数 > 环境变量 > 默认值
    const finalConcurrency = concurrency
      || parseInt(process.env.CURL_CONCURRENCY || '0')
      || this.calculateOptimalConcurrency()

    console.log(`🚀 CurlFetcher 初始化: 并发数=${finalConcurrency}`)

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

      // 保守策略：
      // - 每个 curl-impersonate 占用约 100MB
      // - 保留 300MB 给系统和 Node.js
      const reservedMem = 300
      const perProcessMem = 100
      const optimal = Math.floor((totalMem - reservedMem) / perProcessMem)

      // 限制范围：1-20
      const concurrency = Math.max(1, Math.min(20, optimal))

      console.log(`📊 内存情况: 总内存=${totalMem.toFixed(0)}MB, 空闲=${freeMem.toFixed(0)}MB`)
      console.log(`📊 计算得出最佳并发数: ${concurrency}`)

      return concurrency
    } catch (error) {
      console.warn('⚠️ 无法计算最佳并发数，使用默认值 5')
      return 5  // 默认值
    }
  }

  /**
   * 发起 HTTP 请求（加入 fastq 队列）
   */
  public async fetch(options: FetchOptions): Promise<FetchResult> {
    const requestId = ++this.requestCount
    const queuedAt = Date.now()
    const ipv6 = options.ipv6 || (this.ipv6Pool ? this.ipv6Pool.getNext() : null)

    console.log(`[Req#${requestId}] 📥 接收请求: ${options.url.substring(0, 80)}`)

    const result = await this.queue.push({ requestId, options, ipv6, queuedAt })

    const totalTime = Date.now() - queuedAt
    console.log(`[Req#${requestId}] ✅ 总耗时: ${totalTime}ms\n`)

    return result
  }

  /**
   * Worker：实际执行 curl（添加详细性能日志）
   */
  private async worker(task: CurlTask): Promise<FetchResult> {
    const { requestId, options, ipv6, queuedAt } = task

    const t1 = Date.now()
    const waitTime = t1 - queuedAt
    let buildTime = 0
    let curlTime = 0

    this.concurrentRequests++
    if (this.concurrentRequests > this.maxConcurrent) {
      this.maxConcurrent = this.concurrentRequests
    }

    console.log(`[Req#${requestId}] ⏱️  队列等待: ${waitTime}ms, 当前并发: ${this.concurrentRequests}`)

    try {
      // 1. 构建命令
      const t2 = Date.now()
      const curlCmd = this.useFallbackCurl
        ? this.buildFallbackCurlCommand(options, ipv6)
        : this.buildCurlCommand(options, ipv6)
      buildTime = Date.now() - t2
      console.log(`[Req#${requestId}]   ├─ 构建命令: ${buildTime}ms (${this.useFallbackCurl ? 'fallback curl' : 'curl-impersonate'})`)

      // 2. 执行 curl
      const t3 = Date.now()
      console.log(`[Req#${requestId}]   ├─ 开始执行 curl via ${ipv6?.substring(0, 30)}...`)

      let stdout: Buffer
      try {
        const result = await execAsync(curlCmd, {
          encoding: 'buffer',
          maxBuffer: 50 * 1024 * 1024,
          timeout: options.timeout || 10000
        })
        stdout = result.stdout as Buffer
      } catch (curlError) {
        // 如果是 Killed 错误且还没使用回退，尝试普通 curl
        const errorMsg = (curlError as Error).message
        if (!this.useFallbackCurl && errorMsg.includes('Killed')) {
          console.warn(`[Req#${requestId}]   ⚠️  curl-impersonate 被杀死，切换到普通 curl`)
          this.useFallbackCurl = true
          const fallbackCmd = this.buildFallbackCurlCommand(options, ipv6)
          const fallbackResult = await execAsync(fallbackCmd, {
            encoding: 'buffer',
            maxBuffer: 50 * 1024 * 1024,
            timeout: options.timeout || 10000
          })
          stdout = fallbackResult.stdout as Buffer
        } else {
          throw curlError
        }
      }

      curlTime = Date.now() - t3
      console.log(`[Req#${requestId}]   ├─ curl 执行: ${curlTime}ms ⭐`)

      // 3. 解析响应
      const t4 = Date.now()
      const result = this.parseResponse(stdout as Buffer)
      const parseTime = Date.now() - t4
      console.log(`[Req#${requestId}]   ├─ 解析响应: ${parseTime}ms, 状态码: ${result.statusCode}, 数据: ${result.body.length} bytes`)

      // 4. 记录统计
      const totalDuration = Date.now() - queuedAt
      const success = result.statusCode >= 200 && result.statusCode < 300
      if (ipv6 && this.ipv6Pool) {
        this.ipv6Pool.recordRequest(ipv6, success, totalDuration)
      }

      console.log(`[Req#${requestId}]   └─ 分解: 等待${waitTime}ms + 构建${buildTime}ms + curl${curlTime}ms + 解析${parseTime}ms = ${totalDuration}ms`)

      // 发出请求完成事件（捕获事件监听器中的错误）
      try {
        this.emit('request', {
          requestId,
          url: options.url,
          ipv6: ipv6?.substring(0, 30),
          statusCode: result.statusCode,
          success,
          duration: totalDuration,
          size: result.body.length,
          waitTime,
          curlTime,
          timestamp: Date.now()
        })
      } catch (emitError) {
        console.error(`[Req#${requestId}] ⚠️  事件发送失败:`, emitError)
      }

      this.concurrentRequests--
      return result

    } catch (error) {
      const duration = Date.now() - queuedAt
      console.error(`[Req#${requestId}] ❌ 错误 (${duration}ms):`, (error as Error).message)

      if (ipv6 && this.ipv6Pool) {
        this.ipv6Pool.recordRequest(ipv6, false, duration)
      }

      // 发出请求错误事件（捕获事件监听器中的错误）
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
          curlTime,
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
   * 构建普通 curl 命令（回退方案）
   */
  private buildFallbackCurlCommand(options: FetchOptions, ipv6: string | null): string {
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

    // 基本 Headers
    parts.push(`-H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'`)
    parts.push(`-H 'Accept: */*'`)
    parts.push(`-H 'Accept-Encoding: gzip, deflate, br'`)
    parts.push(`-H 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8'`)

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
   * 获取域名对应的 Cookie 文件路径
   */
  private getCookieFile(url: string): string {
    try {
      const domain = new URL(url).hostname
      if (!this.cookieFiles.has(domain)) {
        const cookieFile = `/tmp/curl-cookies-${domain}.txt`
        this.cookieFiles.set(domain, cookieFile)
      }
      return this.cookieFiles.get(domain)!
    } catch {
      return '/tmp/curl-cookies-default.txt'
    }
  }

  /**
   * 构建 curl-impersonate 命令（简化版，只保留必要参数）
   */
  private buildCurlCommand(options: FetchOptions, ipv6: string | null): string {
    const parts = [this.curlPath]

    // IPv6 接口
    if (ipv6) {
      parts.push(`--interface "${ipv6}"`)
    }
    parts.push('-6')

    // 基本参数
    parts.push('--http2')
    parts.push('--compressed')

    // 超时
    parts.push(`--max-time ${Math.floor((options.timeout || 10000) / 1000)}`)

    // 包含响应头
    parts.push('-i')

    // 禁用进度条
    parts.push('-s')

    // 自定义 Headers
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        parts.push(`-H "${key}: ${value}"`)
      }
    }

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
      ipv6PoolStats: this.ipv6Pool ? this.ipv6Pool.getStats() : null
    }
  }
}

