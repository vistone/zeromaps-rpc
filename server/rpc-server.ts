/**
 * ZeroMaps RPC 服务器
 * 处理客户端请求，使用 HTTP/2 或系统 curl + IPv6 池获取数据
 */

import * as net from 'net'
import { exec } from 'child_process'
import { EventEmitter } from 'events'
import { IPv6Pool } from './ipv6-pool.js'
import { CurlFetcher } from './curl-fetcher.js'
import { HttpFetcher } from './http-fetcher.js'
import { SystemMonitor } from './system-monitor.js'
import {
  FrameType,
  DataType,
  HandshakeRequest,
  HandshakeResponse,
  DataRequest,
  DataResponse
} from '../proto/proto/zeromaps-rpc.js'

// 通用 Fetcher 接口
interface IFetcher {
  fetch(options: any): Promise<any>
  getStats(): any
  on(event: string, handler: (...args: any[]) => void): void
  destroy?(): void
}

interface ClientSession {
  id: number
  socket: net.Socket
  ip: string
  connectedAt: number
  requestCount: number
  lastActiveAt: number
}

export class RpcServer extends EventEmitter {
  private server: net.Server | null = null
  private clients = new Map<number, ClientSession>()
  private nextClientID = 1
  private ipv6Pool: IPv6Pool
  private fetcher: IFetcher  // 通用 fetcher 接口
  private systemMonitor: SystemMonitor
  private requestLogs: any[] = []  // 最近的请求日志
  private maxLogs = 100  // 保留最近100条
  private healthStatus: { status: number; message: string; lastCheck: number } = { status: 0, message: '未检测', lastCheck: 0 }
  private fetcherType: 'curl' | 'http' = 'http'  // 当前使用的 fetcher 类型

  constructor(
    private port: number,
    private ipv6BasePrefix: string
  ) {
    super()

    // 初始化 IPv6 地址池（100个地址）
    this.ipv6Pool = new IPv6Pool(ipv6BasePrefix, 1001, 100)

    // 根据环境变量选择 fetcher 类型（默认使用 curl）
    const fetcherType = (process.env.FETCHER_TYPE || 'curl').toLowerCase()

    if (fetcherType === 'curl') {
      // 使用系统 curl（默认，因为 Node.js HTTP/2 无法通过 Google TLS 检测）
      console.log('🔧 使用系统 curl 请求')
      this.fetcher = new CurlFetcher(this.ipv6Pool) as IFetcher
      this.fetcherType = 'curl'
    } else {
      // 使用 Node.js 原生 HTTP/2（备用，可能被 Google 拒绝）
      console.log('🔧 使用 Node.js 原生 HTTP/2 请求（可能无法访问 Google）')
      this.fetcher = new HttpFetcher(this.ipv6Pool) as IFetcher
      this.fetcherType = 'http'
    }

    // 监听请求事件
    this.fetcher.on('request', (log) => {
      this.requestLogs.unshift(log)  // 添加到开头
      if (this.requestLogs.length > this.maxLogs) {
        this.requestLogs.pop()  // 移除最旧的
      }
      // 转发事件
      this.emit('requestLog', log)
    })

    // 初始化系统监控
    this.systemMonitor = new SystemMonitor()

    // 启动健康检查（每5分钟检查一次）
    this.startHealthCheck()
  }

  /**
   * 启动服务器
   */
  public async start(): Promise<void> {
    this.server = net.createServer((socket) => this.handleConnection(socket))

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, () => {
        console.log(`🚀 ZeroMaps RPC 服务器启动: 端口 ${this.port}`)
        console.log(`   IPv6 池: ${this.ipv6Pool.getAllAddresses().length} 个地址`)
        console.log(`   Fetcher: ${this.fetcherType}`)
        resolve()
      })

      this.server!.on('error', reject)
    })
  }

  /**
   * 处理客户端连接
   */
  private handleConnection(socket: net.Socket): void {
    const clientIP = socket.remoteAddress || 'unknown'
    console.log(`[Server] 新连接: ${clientIP}`)

    let buffer = Buffer.alloc(0)

    socket.on('data', async (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const remaining = await this.processBuffer(socket, buffer)
      buffer = Buffer.from(remaining)
    })

    socket.on('close', () => {
      // 清理客户端会话
      for (const [clientID, session] of this.clients) {
        if (session.socket === socket) {
          this.clients.delete(clientID)
          console.log(`[Server] 客户端 ${clientID} 断开连接 (共处理 ${session.requestCount} 个请求)`)
          break
        }
      }
    })

    socket.on('error', (err) => {
      console.error(`[Server] Socket 错误:`, err.message)
    })
  }

  /**
   * 处理接收缓冲区（非阻塞优化）
   */
  private async processBuffer(socket: net.Socket, buffer: Buffer): Promise<Buffer> {
    while (buffer.length >= 5) {
      // 读取帧头：[payload长度(4字节)][帧类型(1字节)]
      const payloadLength = buffer.readUInt32BE(0)
      const frameType = buffer.readUInt8(4)

      // 检查是否接收到完整帧
      if (buffer.length < 5 + payloadLength) {
        break // 等待更多数据
      }

      // 提取 payload
      const payload = buffer.slice(5, 5 + payloadLength)
      buffer = buffer.slice(5 + payloadLength)

      // 异步处理帧，不阻塞后续帧的读取（关键优化：避免堵塞）
      this.handleFrame(socket, frameType, payload).catch(error => {
        console.error(`[Server] 处理帧错误:`, error)
      })
    }

    return buffer
  }

  /**
   * 处理单个帧
   */
  private async handleFrame(socket: net.Socket, frameType: number, payload: Buffer): Promise<void> {
    try {
      switch (frameType) {
        case FrameType.HANDSHAKE_REQUEST:
          await this.handleHandshake(socket, payload)
          break

        case FrameType.DATA_REQUEST:
          await this.handleDataRequest(socket, payload)
          break

        default:
          console.warn(`[Server] 未知帧类型: ${frameType}`)
      }
    } catch (error) {
      console.error(`[Server] 处理帧错误:`, error)
    }
  }

  /**
   * 处理握手请求
   */
  private async handleHandshake(socket: net.Socket, payload: Buffer): Promise<void> {
    try {
      const request = HandshakeRequest.decode(payload)

      // 分配 clientID
      const clientID = this.nextClientID++
      const clientIP = socket.remoteAddress || 'unknown'

      const session: ClientSession = {
        id: clientID,
        socket,
        ip: clientIP,
        connectedAt: Date.now(),
        requestCount: 0,
        lastActiveAt: Date.now()
      }

      this.clients.set(clientID, session)

      console.log(`[Server] 客户端握手成功: ID=${clientID}, IP=${clientIP}, Info=${request.clientInfo}`)

      // 发送握手响应
      const response = HandshakeResponse.encode({
        clientID,
        success: true,
        message: 'Welcome to ZeroMaps RPC Server'
      }).finish()

      this.sendFrame(socket, FrameType.HANDSHAKE_RESPONSE, Buffer.from(response))
    } catch (error) {
      console.error(`[Server] 握手失败:`, error)
    }
  }

  /**
   * 处理数据请求
   */
  private async handleDataRequest(socket: net.Socket, payload: Buffer): Promise<void> {
    try {
      const request = DataRequest.decode(payload)

      // 更新客户端会话
      const session = this.clients.get(request.clientID)
      if (session) {
        session.requestCount++
        session.lastActiveAt = Date.now()
      }

      console.log(`[Server] 数据请求: clientID=${request.clientID}, uri=${request.uri}`)

      // 构建完整 URL
      const url = `https://kh.google.com/rt/earth/${request.uri}`

      // 使用 fetcher 获取数据（curl 或 native http）
      const result = await this.fetcher.fetch({
        url,
        timeout: 10000
      })

      // 构建响应
      const response = DataResponse.encode({
        clientID: request.clientID,
        uri: request.uri,
        data: result.body,
        statusCode: result.statusCode
      }).finish()

      this.sendFrame(socket, FrameType.DATA_RESPONSE, Buffer.from(response))
    } catch (error) {
      console.error(`[Server] 处理数据请求错误:`, error)

      // 发送错误响应
      const request = DataRequest.decode(payload)
      const errorResponse = DataResponse.encode({
        clientID: request.clientID,
        uri: request.uri,
        data: Buffer.alloc(0),
        statusCode: 500
      }).finish()

      this.sendFrame(socket, FrameType.DATA_RESPONSE, Buffer.from(errorResponse))
    }
  }

  /**
   * 发送帧
   */
  private sendFrame(socket: net.Socket, frameType: number, payload: Buffer): void {
    if (socket.destroyed) {
      return
    }

    const frameLength = 5 + payload.length
    const frame = Buffer.allocUnsafe(frameLength)

    frame.writeUInt32BE(payload.length, 0)
    frame.writeUInt8(frameType, 4)
    payload.copy(frame, 5)

    socket.write(frame)
  }

  /**
   * 获取服务器统计
   */
  public async getStats() {
    const systemStats = await this.systemMonitor.getStats()

    return {
      totalClients: this.clients.size,
      fetcherType: this.fetcherType,
      fetcherStats: this.fetcher.getStats(),
      ipv6Stats: this.ipv6Pool.getDetailedStats(),
      system: systemStats,
      health: this.healthStatus
    }
  }

  /**
   * 获取IPv6池对象（用于监控工具）
   */
  public getIPv6Pool(): IPv6Pool {
    return this.ipv6Pool
  }

  /**
   * 获取 Fetcher 对象（用于 HTTP API）
   */
  public getFetcher() {
    return this.fetcher
  }

  /**
   * 获取 Fetcher 类型
   */
  public getFetcherType(): string {
    return this.fetcherType
  }

  /**
   * 停止服务器
   */
  public async stop(): Promise<void> {
    // 清理 fetcher 资源
    if (this.fetcher.destroy) {
      this.fetcher.destroy()
    }

    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          console.log('✓ RPC 服务器已停止')
          resolve()
        })
      })
    }
  }

  /**
   * 获取请求日志
   */
  public getRequestLogs(): any[] {
    return this.requestLogs
  }

  /**
   * 启动健康检查
   */
  private startHealthCheck(): void {
    // 立即执行一次
    this.checkHealth()

    // 每5分钟检查一次
    setInterval(() => {
      this.checkHealth()
    }, 5 * 60 * 1000)
  }

  /**
   * 检查节点健康状态（使用简单的 curl 命令）
   */
  private async checkHealth(): Promise<void> {
    try {
      const testUrl = 'https://kh.google.com/rt/earth/PlanetoidMetadata'

      // 使用随机 IPv6 地址
      const ipv6 = this.ipv6Pool.getRandom()

      // 使用系统 curl 命令（简单、稳定）
      const result = await this.simpleCurlCheck(testUrl, ipv6)

      this.healthStatus = {
        status: result.statusCode,
        message: result.statusCode === 200 ? '正常' :
          result.statusCode === 403 ? '节点被拉黑' :
            result.error || `HTTP ${result.statusCode}`,
        lastCheck: Date.now()
      }

      if (result.statusCode === 403) {
        console.warn('⚠️  健康检查: 节点被 Google 拉黑 (403)')
      } else if (result.statusCode === 200) {
        console.log('✓ 健康检查: 节点正常')
      } else {
        console.warn(`⚠️  健康检查: ${this.healthStatus.message}`)
      }
    } catch (error) {
      this.healthStatus = {
        status: 0,
        message: (error as Error).message,
        lastCheck: Date.now()
      }
      console.error('❌ 健康检查失败:', error)
    }
  }

  /**
   * 使用 curl 命令检查健康状态
   */
  private async simpleCurlCheck(url: string, ipv6: string): Promise<{ statusCode: number; error?: string }> {
    return new Promise((resolve) => {
      // 使用系统 curl，-i 包含 header（GET 请求），超时 5 秒
      const cmd = `curl -i -s --max-time 5 --interface "${ipv6}" -6 "${url}"`

      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          resolve({ statusCode: 0, error: error.message })
          return
        }

        // 解析状态码：HTTP/2 200 或 HTTP/1.1 200
        const match = stdout.match(/HTTP\/[\d.]+\s+(\d+)/)
        const statusCode = match ? parseInt(match[1]) : 0

        resolve({ statusCode })
      })
    })
  }

  /**
   * 获取健康状态
   */
  public getHealthStatus() {
    return this.healthStatus
  }
}

