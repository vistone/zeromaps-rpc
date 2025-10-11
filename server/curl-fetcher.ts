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

  /**
   * @param curlPath curl-impersonate 可执行文件路径
   * @param ipv6Pool 可选的 IPv6 地址池
   */
  constructor(curlPath: string = '/usr/local/bin/curl_chrome116', ipv6Pool?: IPv6Pool) {
    this.curlPath = curlPath
    this.ipv6Pool = ipv6Pool || null
  }

  /**
   * 发起 HTTP 请求
   */
  public async fetch(options: FetchOptions): Promise<FetchResult> {
    const startTime = Date.now()
    this.requestCount++

    try {
      // 选择 IPv6 地址
      const ipv6 = options.ipv6 || (this.ipv6Pool ? this.ipv6Pool.getNext() : null)
      
      // 构建 curl 命令
      const curlCmd = this.buildCurlCommand(options, ipv6)
      
      console.log(`[Curl] Request #${this.requestCount}: ${options.url.substring(0, 80)}... ${ipv6 ? `via ${ipv6.substring(0, 30)}...` : ''}`)
      console.log(`[Curl] Command: ${curlCmd.substring(0, 200)}...`)
      
      // 执行 curl
      const { stdout, stderr } = await execAsync(curlCmd, {
        encoding: 'buffer',
        maxBuffer: 50 * 1024 * 1024, // 50MB
        timeout: options.timeout || 10000
      })
      
      const duration = Date.now() - startTime
      
      // 解析响应
      const result = this.parseResponse(stdout as Buffer)
      
      console.log(`[Curl] Response: ${result.statusCode} (${duration}ms, ${result.body.length} bytes) ${ipv6 ? `from ${ipv6.substring(0, 30)}...` : ''}`)
      
      return result
    } catch (error) {
      const duration = Date.now() - startTime
      console.error(`[Curl] Error (${duration}ms):`, (error as Error).message)
      
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
    
    // IPv6 接口
    if (ipv6) {
      parts.push(`--interface "${ipv6}"`)
    }
    
    // IPv6 优先
    parts.push('-6')
    
    // 方法
    if (options.method && options.method !== 'GET') {
      parts.push(`-X ${options.method}`)
    }
    
    // Headers
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        parts.push(`-H "${key}: ${value}"`)
      }
    }
    
    // 默认 Headers（模拟真实浏览器）
    parts.push('-H "Accept: */*"')
    parts.push('-H "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8"')
    parts.push('-H "Origin: https://earth.google.com"')
    parts.push('-H "Referer: https://earth.google.com/"')
    
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
      ipv6PoolStats: this.ipv6Pool ? this.ipv6Pool.getStats() : null
    }
  }
}

