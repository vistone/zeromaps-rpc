/**
 * uTLS 数据获取服务
 * 负责与Go uTLS代理通信，获取Google Earth数据
 */

import * as http from 'http'
import { EventEmitter } from 'events'
import { FetchOptions, FetchResult, DataValidationConfig } from '../types/index.js'
import { createLogger } from '../utils/logger.js'
import { PerformanceCalculator } from '../utils/metrics.js'

const logger = createLogger('UTLSFetcher')

export class UTLSFetcher extends EventEmitter {
    private currentConcurrency: number
    private httpAgent: http.Agent | null = null
    private adaptiveConcurrency: boolean
    private concurrencyAdjustmentInterval: NodeJS.Timeout | null = null
    private performanceMetrics: PerformanceCalculator
    private dataValidationConfig: DataValidationConfig

    constructor(
        private proxyPort: number,
        concurrency: number,
        private enableKeepAlive: boolean,
        enableAdaptiveConcurrency: boolean,
        dataValidationConfig: DataValidationConfig
    ) {
        super()
        this.currentConcurrency = concurrency
        this.adaptiveConcurrency = enableAdaptiveConcurrency
        this.dataValidationConfig = dataValidationConfig
        this.performanceMetrics = new PerformanceCalculator()

        // 初始化HTTP Agent
        if (this.enableKeepAlive) {
            this.httpAgent = new http.Agent({
                keepAlive: true,
                maxSockets: this.currentConcurrency * 2,
                maxFreeSockets: this.currentConcurrency,
                timeout: 60000
            })
        }

        // 启动自适应并发调整
        if (this.adaptiveConcurrency) {
            this.startAdaptiveConcurrencyAdjustment()
        }

        logger.info('UTLSFetcher初始化完成', {
            concurrency: this.currentConcurrency,
            keepAlive: this.enableKeepAlive,
            adaptiveConcurrency: this.adaptiveConcurrency
        })
    }

    /**
     * 获取数据
     */
    public async fetch(options: FetchOptions): Promise<FetchResult> {
        const startTime = Date.now()
        let success = false

        try {
            const result = await this.httpRequest(options)
            const duration = Date.now() - startTime

            // 验证响应数据
            if (this.validateResponse(result)) {
                success = true
                this.performanceMetrics.recordRequest(duration, true)
                logger.debug('数据获取成功', {
                    url: options.url.substring(0, 100),
                    statusCode: result.statusCode,
                    duration,
                    size: result.body.length
                })
            } else {
                this.performanceMetrics.recordRequest(duration, false)
                logger.warn('响应数据验证失败', {
                    url: options.url.substring(0, 100),
                    statusCode: result.statusCode,
                    size: result.body.length
                })
            }

            return result
        } catch (error) {
            const duration = Date.now() - startTime
            this.performanceMetrics.recordRequest(duration, false)

            logger.error('数据获取失败', error as Error, {
                url: options.url.substring(0, 100),
                duration
            })

            return {
                statusCode: 0,
                headers: {},
                body: Buffer.alloc(0),
                error: (error as Error).message
            }
        }
    }

    /**
     * HTTP请求
     */
    private async httpRequest(options: FetchOptions): Promise<FetchResult> {
        return new Promise((resolve, reject) => {
            const url = new URL(options.url)
            const requestOptions: http.RequestOptions = {
                hostname: '127.0.0.1',
                port: this.proxyPort,
                path: `/fetch?uri=${encodeURIComponent(options.url)}`,
                method: options.method || 'GET',
                timeout: options.timeout || 30000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    ...options.headers
                }
            }

            // 添加IPv6地址（如果有）
            if (options.ipv6) {
                (requestOptions.headers as any)['X-IPv6-Address'] = options.ipv6
            }

            // 使用Keep-Alive Agent（如果启用）
            if (this.httpAgent) {
                requestOptions.agent = this.httpAgent
            }

            const req = http.request(requestOptions, (res) => {
                const chunks: Buffer[] = []

                res.on('data', (chunk) => {
                    chunks.push(chunk)
                })

                res.on('end', () => {
                    const body = Buffer.concat(chunks)
                    resolve({
                        statusCode: res.statusCode || 0,
                        headers: res.headers as Record<string, string>,
                        body
                    })
                })
            })

            req.on('error', (error) => {
                reject(error)
            })

            req.on('timeout', () => {
                req.destroy()
                reject(new Error('Request timeout'))
            })

            req.end()
        })
    }

    /**
     * 验证响应数据
     */
    private validateResponse(result: FetchResult): boolean {
        // 检查状态码
        if (result.statusCode !== 200) {
            return false
        }

        // 检查数据大小
        if (result.body.length < this.dataValidationConfig.minResponseSize) {
            logger.warn('响应数据过小', {
                expected: this.dataValidationConfig.minResponseSize,
                actual: result.body.length
            })
            return false
        }

        // 检查内容类型
        const contentType = result.headers['content-type'] || ''
        const allowed = this.dataValidationConfig.allowedContentTypes
        if (allowed && allowed.length > 0) {
            const ok = allowed.some(t => contentType.includes(t))
            if (!ok) {
                logger.warn('响应内容类型不在允许列表', { contentType, allowed })
                return false
            }
        } else {
            // 默认策略：放宽校验，仅在明显非二进制/图片时告警
            const defaultOk = contentType.includes('image') || contentType.includes('application/octet-stream')
            if (!defaultOk) {
                logger.warn('响应内容类型可能异常', { contentType })
            }
        }

        return true
    }

    /**
     * 启动自适应并发调整
     */
    private startAdaptiveConcurrencyAdjustment(): void {
        this.concurrencyAdjustmentInterval = setInterval(() => {
            this.adjustConcurrency()
        }, 30000) // 每30秒调整一次

        logger.info('自适应并发调整已启动')
    }

    /**
     * 调整并发数
     */
    private adjustConcurrency(): void {
        const metrics = this.performanceMetrics.getMetrics()

        // 基于响应时间和成功率调整
        if (metrics.avgResponseTime > 2000 && metrics.successRate > 0.8) {
            // 响应时间过长但成功率高，可以增加并发
            this.setConcurrency(Math.min(this.currentConcurrency + 5, 300))
        } else if (metrics.successRate < 0.7) {
            // 成功率低，减少并发
            this.setConcurrency(Math.max(this.currentConcurrency - 5, 5))
        }

        this.performanceMetrics.recordAdjustment()
    }

    /**
     * 设置并发数
     */
    public setConcurrency(concurrency: number): void {
        const oldConcurrency = this.currentConcurrency
        this.currentConcurrency = Math.max(1, Math.min(concurrency, 300))

        if (oldConcurrency !== this.currentConcurrency) {
            logger.info('并发数已调整', {
                old: oldConcurrency,
                new: this.currentConcurrency
            })

            // 更新HTTP Agent
            if (this.httpAgent) {
                this.httpAgent.maxSockets = this.currentConcurrency * 2
                this.httpAgent.maxFreeSockets = this.currentConcurrency
            }

            this.emit('concurrency-changed', this.currentConcurrency)
        }
    }

    /**
     * 更新配置
     */
    public updateConfig(config: {
        concurrency?: number
        enableKeepAlive?: boolean
        enableAdaptiveConcurrency?: boolean
        dataValidation?: Partial<DataValidationConfig>
    }): void {
        if (config.concurrency !== undefined) {
            this.setConcurrency(config.concurrency)
        }

        if (config.enableKeepAlive !== undefined) {
            this.enableKeepAlive = config.enableKeepAlive
            if (this.enableKeepAlive && !this.httpAgent) {
                this.httpAgent = new http.Agent({
                    keepAlive: true,
                    maxSockets: this.currentConcurrency * 2,
                    maxFreeSockets: this.currentConcurrency,
                    timeout: 60000
                })
            } else if (!this.enableKeepAlive && this.httpAgent) {
                this.httpAgent.destroy()
                this.httpAgent = null
            }
        }

        if (config.enableAdaptiveConcurrency !== undefined) {
            this.adaptiveConcurrency = config.enableAdaptiveConcurrency
            if (this.adaptiveConcurrency && !this.concurrencyAdjustmentInterval) {
                this.startAdaptiveConcurrencyAdjustment()
            } else if (!this.adaptiveConcurrency && this.concurrencyAdjustmentInterval) {
                clearInterval(this.concurrencyAdjustmentInterval)
                this.concurrencyAdjustmentInterval = null
            }
        }

        if (config.dataValidation) {
            this.dataValidationConfig = { ...this.dataValidationConfig, ...config.dataValidation }
        }

        logger.info('UTLSFetcher配置已更新', config)
    }

    /**
     * 获取统计信息
     */
    public getStats(): any {
        const metrics = this.performanceMetrics.getMetrics()

        return {
            concurrency: this.currentConcurrency,
            adaptiveConcurrency: this.adaptiveConcurrency,
            keepAliveEnabled: this.enableKeepAlive,
            performance: metrics,
            proxyPort: this.proxyPort
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

        logger.info('UTLSFetcher已销毁')
    }
}
