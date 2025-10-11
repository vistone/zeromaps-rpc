/**
 * curl-impersonate 请求执行器
 * 使用 curl-impersonate 模拟真实浏览器请求
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { IPv6Pool } from './ipv6-pool'

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

export class CurlFetcher {
  private curlPath: string
  private ipv6Pool: IPv6Pool | null = null
  private requestCount = 0
  private concurrentRequests = 0  // 当前并发请求数
  private maxConcurrent = 0       // 最大并发请求数（用于统计）

  /**
   * @param curlPath curl-impersonate 可执行文件路径
   * @param ipv6Pool 可选的 IPv6 地址池
   */
  constructor(curlPath: string = '/usr/local/bin/curl-impersonate-chrome', ipv6Pool?: IPv6Pool) {
    this.curlPath = curlPath
    this.ipv6Pool = ipv6Pool || null
  }

  /**
   * 发起 HTTP 请求
   */
  public async fetch(options: FetchOptions): Promise<FetchResult> {
    const startTime = Date.now()
    this.requestCount++
    this.concurrentRequests++
    
    // 记录最大并发数
    if (this.concurrentRequests > this.maxConcurrent) {
      this.maxConcurrent = this.concurrentRequests
    }

    // 选择 IPv6 地址
    const ipv6 = options.ipv6 || (this.ipv6Pool ? this.ipv6Pool.getNext() : null)

    try {
      // 构建 curl 命令
      const curlCmd = this.buildCurlCommand(options, ipv6)
      
      console.log(`[Curl] #${this.requestCount}: ${options.url.substring(0, 60)}... ${ipv6 ? `via ${ipv6.substring(20, 30)}...` : ''}`)
      
      // 执行 curl
      const { stdout, stderr } = await execAsync(curlCmd, {
        encoding: 'buffer',
        maxBuffer: 50 * 1024 * 1024, // 50MB
        timeout: options.timeout || 10000
      })
      
      const duration = Date.now() - startTime
      
      // 解析响应
      const result = this.parseResponse(stdout as Buffer)
      
      // 记录到IPv6池统计
      if (ipv6 && this.ipv6Pool) {
        const success = result.statusCode >= 200 && result.statusCode < 300
        this.ipv6Pool.recordRequest(ipv6, success, duration)
      }
      
      // 只在非200时记录日志
      if (result.statusCode !== 200) {
        console.log(`[Curl] ${result.statusCode} (${duration}ms)`)
      }
      
      this.concurrentRequests--
      return result
    } catch (error) {
      const duration = Date.now() - startTime
      console.error(`[Curl] Error (${duration}ms):`, (error as Error).message)
      
      // 记录失败到IPv6池统计
      if (ipv6 && this.ipv6Pool) {
        this.ipv6Pool.recordRequest(ipv6, false, duration)
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
   * 构建 curl 命令
   */
  private buildCurlCommand(options: FetchOptions, ipv6: string | null): string {
    const parts = [this.curlPath]
    
    // Chrome 116 TLS 参数
    parts.push('--ciphers TLS_AES_128_GCM_SHA256,TLS_AES_256_GCM_SHA384,TLS_CHACHA20_POLY1305_SHA256,ECDHE-ECDSA-AES128-GCM-SHA256,ECDHE-RSA-AES128-GCM-SHA256,ECDHE-ECDSA-AES256-GCM-SHA384,ECDHE-RSA-AES256-GCM-SHA384,ECDHE-ECDSA-CHACHA20-POLY1305,ECDHE-RSA-CHACHA20-POLY1305,ECDHE-RSA-AES128-SHA,ECDHE-RSA-AES256-SHA,AES128-GCM-SHA256,AES256-GCM-SHA384,AES128-SHA,AES256-SHA')
    parts.push('--http2')
    parts.push('--http2-no-server-push')
    parts.push('--compressed')
    parts.push('--tlsv1.2')
    parts.push('--alps')
    parts.push('--tls-permute-extensions')
    parts.push('--cert-compression brotli')
    
    // IPv6 接口
    if (ipv6) {
      parts.push(`--interface "${ipv6}"`)
    }
    parts.push('-6')
    
    // 方法
    if (options.method && options.method !== 'GET') {
      parts.push(`-X ${options.method}`)
    }
    
    // Chrome 116 Headers（模拟 fetch 请求）
    parts.push(`-H 'sec-ch-ua: "Chromium";v="116", "Not)A;Brand";v="24", "Google Chrome";v="116"'`)
    parts.push(`-H 'sec-ch-ua-mobile: ?0'`)
    parts.push(`-H 'sec-ch-ua-platform: "Windows"'`)
    parts.push(`-H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'`)
    parts.push(`-H 'Accept: */*'`)
    parts.push(`-H 'Sec-Fetch-Site: cross-site'`)
    parts.push(`-H 'Sec-Fetch-Mode: cors'`)
    parts.push(`-H 'Sec-Fetch-Dest: empty'`)
    parts.push(`-H 'Accept-Encoding: gzip, deflate, br'`)
    parts.push(`-H 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8'`)
    
    // 自定义 Headers（可以覆盖默认值）
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
      ipv6PoolStats: this.ipv6Pool ? this.ipv6Pool.getStats() : null
    }
  }
}

