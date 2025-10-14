/**
 * Node.js 原生 HTTP/HTTPS 请求执行器
 * 使用 Node.js 默认配置，不模拟浏览器指纹
 * 每次请求创建新连接，避免连接复用被检测
 */

import * as http2 from 'http2'
import * as https from 'https'
import * as tls from 'tls'
import * as dns from 'dns'
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

interface HttpTask {
    requestId: number
    options: FetchOptions
    ipv6: string | null
    queuedAt: number
}

/**
 * HTTP/2 连接池
 */
class Http2ConnectionPool {
    private connections = new Map<string, http2.ClientHttp2Session>()
    private connectionUsage = new Map<string, number>()
    private maxConnectionAge = 2 * 60 * 1000 // 2分钟后关闭连接（缩短避免连接过期）
    private connectionTimestamps = new Map<string, number>()
    private connectionErrors = new Map<string, number>() // 记录连接错误次数

    /**
     * 获取或创建 HTTP/2 连接
     */
    public getConnection(url: string, ipv6: string | null, tlsOptions: tls.ConnectionOptions): http2.ClientHttp2Session {
        const key = `${url}-${ipv6}`

        // 检查是否有可用连接
        if (this.connections.has(key)) {
            const conn = this.connections.get(key)!
            const timestamp = this.connectionTimestamps.get(key)!
            const errorCount = this.connectionErrors.get(key) || 0

            // 检查连接是否健康：未关闭、未过期、错误次数少
            const isHealthy = !conn.closed && !conn.destroyed &&
                Date.now() - timestamp < this.maxConnectionAge &&
                errorCount < 3  // 如果错误超过3次，关闭重建

            if (isHealthy) {
                this.connectionUsage.set(key, (this.connectionUsage.get(key) || 0) + 1)
                return conn
            } else {
                // 清理不健康的连接
                console.log(`[HTTP2] 清理不健康连接 (${key}): closed=${conn.closed}, destroyed=${conn.destroyed}, age=${Date.now() - timestamp}ms, errors=${errorCount}`)
                this.closeConnection(key)
            }
        }

        // 创建新连接
        const parsedUrl = new URL(url)
        const options: http2.SecureClientSessionOptions = {
            ...tlsOptions,
            // 强制使用 IPv6
            lookup: (hostname, opts, callback) => {
                if (ipv6) {
                    callback(null, ipv6, 6)
                } else {
                    // 使用默认 DNS 解析
                    dns.lookup(hostname, { family: 6 }, callback)
                }
            }
        }

        const client = http2.connect(`${parsedUrl.protocol}//${parsedUrl.host}`, options)

        this.connections.set(key, client)
        this.connectionUsage.set(key, 1)
        this.connectionTimestamps.set(key, Date.now())
        this.connectionErrors.set(key, 0)

        // 监听错误和关闭事件
        client.on('error', (err) => {
            const errorCount = (this.connectionErrors.get(key) || 0) + 1
            this.connectionErrors.set(key, errorCount)
            console.warn(`[HTTP2] 连接错误 (${key}, 错误次数: ${errorCount}):`, err.message)

            // 如果错误次数过多，立即关闭连接
            if (errorCount >= 3) {
                this.closeConnection(key)
            }
        })

        client.on('close', () => {
            this.closeConnection(key)
        })

        return client
    }

    /**
     * 关闭特定连接
     */
    private closeConnection(key: string): void {
        const conn = this.connections.get(key)
        if (conn && !conn.destroyed) {
            conn.close()
        }
        this.connections.delete(key)
        this.connectionUsage.delete(key)
        this.connectionTimestamps.delete(key)
        this.connectionErrors.delete(key)
    }

    /**
     * 关闭所有连接
     */
    public closeAll(): void {
        for (const [key, conn] of this.connections) {
            if (!conn.destroyed) {
                conn.close()
            }
        }
        this.connections.clear()
        this.connectionUsage.clear()
        this.connectionTimestamps.clear()
    }

    /**
     * 获取连接池统计
     */
    public getStats() {
        return {
            totalConnections: this.connections.size,
            totalUsage: Array.from(this.connectionUsage.values()).reduce((sum, n) => sum + n, 0)
        }
    }
}

/**
 * 简单的 TLS 配置（使用 Node.js 默认值）
 */
const SIMPLE_TLS_CONFIG: tls.ConnectionOptions = {
    // 使用 Node.js 默认配置，不模拟浏览器指纹
    rejectUnauthorized: false  // 允许自签名证书
}

/**
 * 简单的 HTTP Headers（不模拟浏览器）
 */
const SIMPLE_HEADERS = {
    'User-Agent': 'Mozilla/5.0',
    'Accept': '*/*'
}

export class HttpFetcher extends EventEmitter {
    private ipv6Pool: IPv6Pool | null = null
    private requestCount = 0
    private concurrentRequests = 0
    private maxConcurrent = 0
    private queue: queueAsPromised<HttpTask, FetchResult>
    private connectionPool: Http2ConnectionPool  // 保留但不使用
    private useHttp2 = true  // 是否使用 HTTP/2

    constructor(
        ipv6Pool?: IPv6Pool,
        concurrency: number = 25
    ) {
        super()
        this.ipv6Pool = ipv6Pool || null
        this.connectionPool = new Http2ConnectionPool()  // 保留兼容性

        const finalConcurrency = concurrency || parseInt(process.env.HTTP_CONCURRENCY || '25')

        console.log(`🚀 HttpFetcher 初始化: 并发数=${finalConcurrency}, HTTP/2=${this.useHttp2}, 使用 Node.js 原生配置`)

        this.queue = fastq.promise(this.worker.bind(this), finalConcurrency)
    }

    /**
     * 发起 HTTP 请求
     */
    public async fetch(options: FetchOptions): Promise<FetchResult> {
        const requestId = ++this.requestCount
        const queuedAt = Date.now()
        const ipv6 = options.ipv6 || (this.ipv6Pool ? this.ipv6Pool.getHealthyNext() : null)

        console.log(`[HttpReq#${requestId}] 📥 接收请求: ${options.url.substring(0, 80)}`)

        const result = await this.queue.push({ requestId, options, ipv6, queuedAt })

        const totalTime = Date.now() - queuedAt
        console.log(`[HttpReq#${requestId}] ✅ 总耗时: ${totalTime}ms\n`)

        return result
    }

    /**
     * Worker: 实际执行 HTTP 请求
     */
    private async worker(task: HttpTask): Promise<FetchResult> {
        const { requestId, options, ipv6, queuedAt } = task

        const t1 = Date.now()
        const waitTime = t1 - queuedAt

        this.concurrentRequests++
        if (this.concurrentRequests > this.maxConcurrent) {
            this.maxConcurrent = this.concurrentRequests
        }

        if (waitTime > 1000) {
            console.warn(`[HttpReq#${requestId}] ⚠️  队列等待过长: ${waitTime}ms, 当前并发: ${this.concurrentRequests}`)
        } else {
            console.log(`[HttpReq#${requestId}] ⏱️  队列等待: ${waitTime}ms, 当前并发: ${this.concurrentRequests}`)
        }

        try {
            const result = this.useHttp2
                ? await this.fetchHttp2(task)
                : await this.fetchHttps(task)

            const totalDuration = Date.now() - queuedAt
            const success = result.statusCode >= 200 && result.statusCode < 300

            if (ipv6 && this.ipv6Pool) {
                this.ipv6Pool.recordRequest(ipv6, success, totalDuration)
            }

            this.emit('request', {
                requestId,
                url: options.url,
                ipv6: ipv6?.substring(0, 30),
                statusCode: result.statusCode,
                success,
                duration: totalDuration,
                size: result.body.length,
                waitTime,
                timestamp: Date.now()
            })

            this.concurrentRequests--
            return result

        } catch (error) {
            const duration = Date.now() - queuedAt
            console.error(`[HttpReq#${requestId}] ❌ 错误 (${duration}ms):`, (error as Error).message)

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
        } finally {
            // 确保 concurrentRequests 总是被正确减少
            // 在 try 块中已经减少，这里不需要再次减少
        }
    }

    /**
     * 使用 HTTP/2 发起请求（每次创建新连接，避免连接复用被检测）
     */
    private async fetchHttp2(task: HttpTask): Promise<FetchResult> {
        const { requestId, options, ipv6 } = task
        const parsedUrl = new URL(options.url)

        return new Promise((resolve, reject) => {
            const startTime = Date.now()

            try {
                // 使用 Node.js 原生配置，不模拟浏览器指纹
                const tlsOptions: http2.SecureClientSessionOptions = {
                    ...SIMPLE_TLS_CONFIG,
                    // 强制使用 IPv6
                    lookup: (hostname, opts, callback) => {
                        if (ipv6) {
                            callback(null, ipv6, 6)
                        } else {
                            dns.lookup(hostname, { family: 6 }, callback)
                        }
                    }
                }

                const client = http2.connect(`${parsedUrl.protocol}//${parsedUrl.host}`, tlsOptions)

                // 请求完成后立即关闭连接
                const cleanupConnection = () => {
                    if (!client.destroyed) {
                        client.close()
                    }
                }

                // 监听连接错误
                client.on('error', (err) => {
                    console.warn(`[HttpReq#${requestId}] 连接错误:`, err.message)
                    cleanupConnection()
                })

                // 构建请求头
                const headers = {
                    ':method': options.method || 'GET',
                    ':path': parsedUrl.pathname + parsedUrl.search,
                    ':scheme': parsedUrl.protocol.replace(':', ''),
                    ':authority': parsedUrl.host,
                    ...SIMPLE_HEADERS,
                    ...options.headers
                }

                // 发起请求
                const req = client.request(headers)

                // 设置超时
                const timeout = options.timeout || 10000
                const timer = setTimeout(() => {
                    req.destroy(new Error('Request timeout'))
                    cleanupConnection()
                }, timeout)

                const chunks: Buffer[] = []
                let responseHeaders: any = {}

                req.on('response', (headers) => {
                    responseHeaders = headers
                    console.log(`[HttpReq#${requestId}]   ├─ 收到响应头: ${headers[':status']}`)
                })

                req.on('data', (chunk) => {
                    chunks.push(chunk)
                })

                req.on('end', () => {
                    clearTimeout(timer)
                    const requestTime = Date.now() - startTime

                    const body = Buffer.concat(chunks)
                    const statusCode = parseInt(responseHeaders[':status'] as string) || 0

                    console.log(`[HttpReq#${requestId}]   ├─ HTTP/2 请求: ${requestTime}ms, 状态码: ${statusCode}, 数据: ${body.length} bytes`)

                    // 关闭连接
                    cleanupConnection()

                    resolve({
                        statusCode,
                        headers: this.normalizeHeaders(responseHeaders),
                        body
                    })
                })

                req.on('error', (err) => {
                    clearTimeout(timer)
                    cleanupConnection()
                    reject(err)
                })

                req.end()

            } catch (error) {
                reject(error)
            }
        })
    }

    /**
     * 使用 HTTPS 发起请求（HTTP/1.1，备用方案）
     */
    private async fetchHttps(task: HttpTask): Promise<FetchResult> {
        const { requestId, options, ipv6 } = task
        const parsedUrl = new URL(options.url)

        return new Promise((resolve, reject) => {
            const startTime = Date.now()

            const requestOptions: https.RequestOptions = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || 443,
                path: parsedUrl.pathname + parsedUrl.search,
                method: options.method || 'GET',
                headers: {
                    ...SIMPLE_HEADERS,
                    'Host': parsedUrl.host,
                    ...options.headers
                },
                timeout: options.timeout || 10000,
                ...SIMPLE_TLS_CONFIG,
                // 强制使用 IPv6
                family: 6,
                lookup: (hostname, opts, callback) => {
                    if (ipv6) {
                        callback(null, ipv6, 6)
                    } else {
                        dns.lookup(hostname, { family: 6 }, callback)
                    }
                }
            }

            const req = https.request(requestOptions, (res) => {
                const chunks: Buffer[] = []

                res.on('data', (chunk) => {
                    chunks.push(chunk)
                })

                res.on('end', () => {
                    const requestTime = Date.now() - startTime
                    const body = Buffer.concat(chunks)

                    console.log(`[HttpReq#${requestId}]   ├─ HTTPS 请求: ${requestTime}ms, 状态码: ${res.statusCode}, 数据: ${body.length} bytes`)

                    resolve({
                        statusCode: res.statusCode || 0,
                        headers: this.normalizeHeaders(res.headers),
                        body
                    })
                })
            })

            req.on('error', (err) => {
                reject(err)
            })

            req.on('timeout', () => {
                req.destroy()
                reject(new Error('Request timeout'))
            })

            req.end()
        })
    }

    /**
     * 标准化响应头
     */
    private normalizeHeaders(headers: any): Record<string, string> {
        const result: Record<string, string> = {}
        for (const [key, value] of Object.entries(headers)) {
            if (typeof value === 'string') {
                result[key] = value
            } else if (Array.isArray(value)) {
                result[key] = value.join(', ')
            } else if (value !== undefined) {
                result[key] = String(value)
            }
        }
        return result
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
            useHttp2: this.useHttp2,
            connectionPool: this.connectionPool.getStats(),
            ipv6PoolStats: this.ipv6Pool ? this.ipv6Pool.getStats() : null
        }
    }

    /**
     * 清理资源
     */
    public destroy(): void {
        this.connectionPool.closeAll()
    }
}

