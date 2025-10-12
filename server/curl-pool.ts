/**
 * Curl 进程池
 * 复用 curl-impersonate 进程，避免频繁启动进程
 */

import { spawn, ChildProcess } from 'child_process'
import { IPv6Pool } from './ipv6-pool'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

interface CurlWorker {
    id: number
    ipv6: string
    process: ChildProcess | null
    busy: boolean
    requestCount: number
    errorCount: number
    createdAt: number
}

interface PendingRequest {
    url: string
    resolve: (result: any) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
}

export class CurlPool {
    private workers: CurlWorker[] = []
    private curlPath: string
    private ipv6Pool: IPv6Pool
    private poolSize: number
    private pendingRequests: PendingRequest[] = []
    private totalRequests = 0

    /**
     * @param curlPath curl-impersonate 路径
     * @param ipv6Pool IPv6 池
     * @param poolSize 进程池大小（默认 10 个进程）
     */
    constructor(curlPath: string, ipv6Pool: IPv6Pool, poolSize: number = 10) {
        this.curlPath = curlPath
        this.ipv6Pool = ipv6Pool
        this.poolSize = poolSize
        this.initializePool()
    }

    /**
     * 初始化进程池
     */
    private initializePool(): void {
        console.log(`🔧 初始化 Curl 进程池: ${this.poolSize} 个 worker`)

        for (let i = 0; i < this.poolSize; i++) {
            const ipv6 = this.ipv6Pool.getNext()
            const worker: CurlWorker = {
                id: i + 1,
                ipv6,
                process: null,
                busy: false,
                requestCount: 0,
                errorCount: 0,
                createdAt: Date.now()
            }
            this.workers.push(worker)
            console.log(`  Worker ${worker.id}: ${ipv6}`)
        }

        console.log(`✓ Curl 进程池初始化完成`)
    }

    /**
     * 执行请求
     */
    public async fetch(url: string, timeout: number = 10000): Promise<Buffer> {
        this.totalRequests++

        return new Promise<Buffer>((resolve, reject) => {
            const timeoutTimer = setTimeout(() => {
                reject(new Error('请求超时'))
            }, timeout)

            this.pendingRequests.push({
                url,
                resolve: (result) => {
                    clearTimeout(timeoutTimer)
                    resolve(result)
                },
                reject: (error) => {
                    clearTimeout(timeoutTimer)
                    reject(error)
                },
                timeout: timeoutTimer
            })

            // 尝试分配 worker
            this.assignWork()
        })
    }

    /**
     * 分配任务给空闲的 worker
     */
    private assignWork(): void {
        if (this.pendingRequests.length === 0) return

        // 找到空闲的 worker
        const idleWorker = this.workers.find(w => !w.busy)
        if (!idleWorker) return

        const request = this.pendingRequests.shift()
        if (!request) return

        // 执行请求
        this.executeOnWorker(idleWorker, request)
    }

    /**
     * 在指定 worker 上执行请求
     */
    private async executeOnWorker(worker: CurlWorker, request: PendingRequest): Promise<void> {
        worker.busy = true
        worker.requestCount++
        const startTime = Date.now()

        try {
            // 构建 curl 命令
            const args = this.buildCurlArgs(request.url, worker.ipv6)

            // 执行 curl
            const result = await this.executeCurl(args)
            const duration = Date.now() - startTime

            // 记录统计
            this.ipv6Pool.recordRequest(worker.ipv6, true, duration)

            request.resolve(result)

        } catch (error) {
            const duration = Date.now() - startTime
            worker.errorCount++
            this.ipv6Pool.recordRequest(worker.ipv6, false, duration)
            request.reject(error as Error)

        } finally {
            worker.busy = false
            // 继续处理下一个请求
            this.assignWork()
        }
    }

    /**
     * 执行 curl 命令
     */
    private async executeCurl(args: string[]): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const curl = spawn(this.curlPath, args)

            let stdout = Buffer.alloc(0)
            let stderr = Buffer.alloc(0)

            curl.stdout.on('data', (data: Buffer) => {
                stdout = Buffer.concat([stdout, data])
            })

            curl.stderr.on('data', (data: Buffer) => {
                stderr = Buffer.concat([stderr, data])
            })

            curl.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout)
                } else {
                    reject(new Error(`Curl 退出码: ${code}, ${stderr.toString()}`))
                }
            })

            curl.on('error', (error) => {
                reject(error)
            })
        })
    }

    /**
     * 构建 curl 参数
     */
    private buildCurlArgs(url: string, ipv6: string): string[] {
        return [
            '--ciphers', 'TLS_AES_128_GCM_SHA256,TLS_AES_256_GCM_SHA384,TLS_CHACHA20_POLY1305_SHA256,ECDHE-ECDSA-AES128-GCM-SHA256,ECDHE-RSA-AES128-GCM-SHA256,ECDHE-ECDSA-AES256-GCM-SHA384,ECDHE-RSA-AES256-GCM-SHA384,ECDHE-ECDSA-CHACHA20-POLY1305,ECDHE-RSA-CHACHA20-POLY1305,ECDHE-RSA-AES128-SHA,ECDHE-RSA-AES256-SHA,AES128-GCM-SHA256,AES256-GCM-SHA384,AES128-SHA,AES256-SHA',
            '--http2',
            '--http2-no-server-push',
            '--compressed',
            '--tlsv1.2',
            '--alps',
            '--tls-permute-extensions',
            '--cert-compression', 'brotli',
            '--interface', ipv6,
            '-6',
            '-H', 'sec-ch-ua: "Chromium";v="116", "Not)A;Brand";v="24", "Google Chrome";v="116"',
            '-H', 'sec-ch-ua-mobile: ?0',
            '-H', 'sec-ch-ua-platform: "Windows"',
            '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
            '-H', 'Accept: */*',
            '-H', 'Sec-Fetch-Site: cross-site',
            '-H', 'Sec-Fetch-Mode: cors',
            '-H', 'Sec-Fetch-Dest: empty',
            '-H', 'Accept-Encoding: gzip, deflate, br',
            '-H', 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
            '--max-time', '10',
            '-i',
            '-s',
            url
        ]
    }

    /**
     * 获取统计信息
     */
    public getStats() {
        return {
            poolSize: this.poolSize,
            totalRequests: this.totalRequests,
            pendingRequests: this.pendingRequests.length,
            workers: this.workers.map(w => ({
                id: w.id,
                ipv6: w.ipv6,
                busy: w.busy,
                requestCount: w.requestCount,
                errorCount: w.errorCount
            }))
        }
    }
}

