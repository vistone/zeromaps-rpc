/**
 * ZeroMaps RPC 服务器
 * 处理客户端请求，使用 HTTP/2 或系统 curl + IPv6 池获取数据
 */

import * as net from 'net'
import { exec } from 'child_process'
import { EventEmitter } from 'events'
import { IPv6Pool } from './ipv6-pool.js'
import { UTLSFetcher } from './utls-fetcher.js'
import { SystemMonitor } from './system-monitor.js'
import { createLogger } from './logger.js'
import { getConfig } from './config-manager.js'
import {
  FrameType,
  DataType,
  HandshakeRequest,
  HandshakeResponse,
  DataRequest,
  DataResponse
} from '../proto/proto/zeromaps-rpc.js'

const logger = createLogger('RpcServer')

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
  private errorLogs: any[] = []    // 错误日志（单独存储）
  private maxLogs: number  // 保留最近N条（从配置读取）
  private maxErrorLogs = 50 // 错误日志最多保留50条
  private healthStatus: { status: number; message: string; lastCheck: number } = { status: 0, message: '未检测', lastCheck: 0 }
  private fetcherType: 'utls' = 'utls'  // 当前使用的 fetcher 类型（只支持 uTLS）

  constructor(
    private port: number,
    private ipv6BasePrefix: string
  ) {
    super()

    // 获取配置实例（延迟初始化，避免模块导入时失败）
    const config = getConfig()

    // 从配置获取 IPv6 池参数
    const ipv6Start = config.get<number>('ipv6.start')
    const ipv6Count = config.get<number>('ipv6.count')

    // 初始化 IPv6 地址池（如果提供了前缀）
    if (ipv6BasePrefix) {
      this.ipv6Pool = new IPv6Pool(ipv6BasePrefix, ipv6Start, ipv6Count)
      logger.info('IPv6 地址池已配置', {
        prefix: ipv6BasePrefix,
        range: `::${ipv6Start} ~ ::${ipv6Start + ipv6Count - 1}`,
        count: ipv6Count
      })
    } else {
      // 创建空的 IPv6 池（不使用 IPv6）
      this.ipv6Pool = new IPv6Pool('', 0, 0)
      logger.warn('未使用 IPv6 地址池（使用默认网络）')
    }

    // 从配置获取 uTLS 参数
    const proxyPort = config.get<number>('utls.proxyPort')
    const concurrency = config.get<number>('utls.concurrency')

    logger.info('使用 uTLS 代理', {
      browser: 'Chrome 120',
      proxyPort,
      concurrency
    })
    this.fetcher = new UTLSFetcher(this.ipv6Pool, concurrency, proxyPort) as IFetcher
    this.fetcherType = 'utls'

    // 从配置获取性能参数
    this.maxLogs = config.get<number>('performance.maxRequestLogs')

    // 监听请求事件
    this.fetcher.on('request', (log) => {
      this.requestLogs.unshift(log)  // 添加到开头
      if (this.requestLogs.length > this.maxLogs) {
        this.requestLogs.pop()  // 移除最旧的
      }
      
      // 如果是错误请求（statusCode 非 200 或有 error），也添加到错误日志
      if (log.statusCode !== 200 || log.error) {
        this.errorLogs.unshift(log)
        if (this.errorLogs.length > this.maxErrorLogs) {
          this.errorLogs.pop()
        }
        // 发送错误日志事件
        this.emit('errorLog', log)
      }
      
      // 转发事件
      this.emit('requestLog', log)
    })

    // 初始化系统监控
    this.systemMonitor = new SystemMonitor()

    // 启动健康检查（从配置获取间隔）
    this.startHealthCheck()
  }

  /**
   * 启动服务器
   */
  public async start(): Promise<void> {
    this.server = net.createServer((socket) => this.handleConnection(socket))

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, () => {
        logger.info('RPC 服务器启动', {
          port: this.port,
          ipv6PoolSize: this.ipv6Pool.getAllAddresses().length,
          fetcherType: this.fetcherType
        })
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
    logger.info('新客户端连接', { clientIP })

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
          logger.info('客户端断开连接', {
            clientID,
            requestCount: session.requestCount
          })
          break
        }
      }
    })

    socket.on('error', (err) => {
      logger.error('Socket 错误', err)
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
        logger.error('处理帧错误', error)
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
          logger.warn('未知帧类型', { frameType })
      }
    } catch (error) {
      logger.error('处理帧错误', error as Error)
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

      logger.info('客户端握手成功', {
        clientID,
        clientIP,
        clientInfo: request.clientInfo
      })

      // 发送握手响应
      const response = HandshakeResponse.encode({
        clientID,
        success: true,
        message: 'Welcome to ZeroMaps RPC Server'
      }).finish()

      this.sendFrame(socket, FrameType.HANDSHAKE_RESPONSE, Buffer.from(response))
    } catch (error) {
      logger.error('握手失败', error as Error)
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

      logger.debug('数据请求', {
        clientID: request.clientID,
        uri: request.uri.substring(0, 80)
      })

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
      logger.error('处理数据请求错误', error as Error)

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
          logger.info('RPC 服务器已停止')
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
   * 获取错误日志（单独的错误日志列表）
   */
  public getErrorLogs(): any[] {
    return this.errorLogs
  }

  /**
   * 启动健康检查
   */
  private startHealthCheck(): void {
    // 立即执行一次
    this.checkHealth()

    // 从配置获取健康检查间隔
    const config = getConfig()
    const interval = config.get<number>('performance.healthCheckInterval')
    setInterval(() => {
      this.checkHealth()
    }, interval)
  }

  /**
   * 检查节点健康状态（使用 uTLS Fetcher）
   */
  private async checkHealth(): Promise<void> {
    try {
      const testUrl = 'https://kh.google.com/rt/earth/PlanetoidMetadata'

      // 使用 Fetcher 进行健康检查（与实际请求保持一致）
      const result = await this.fetcher.fetch({ url: testUrl, timeout: 10000 })

      this.healthStatus = {
        status: result.statusCode,
        message: result.statusCode === 200 ? '正常' :
          result.statusCode === 403 ? '节点被拉黑' :
            `HTTP ${result.statusCode}`,
        lastCheck: Date.now()
      }

      if (result.statusCode === 403) {
        logger.warn('健康检查: 节点被 Google 拉黑', { statusCode: 403 })
      } else if (result.statusCode === 200) {
        logger.info('健康检查: 节点正常')
      } else {
        logger.warn('健康检查异常', {
          statusCode: result.statusCode,
          message: this.healthStatus.message
        })
      }
    } catch (error) {
      this.healthStatus = {
        status: 0,
        message: (error as Error).message,
        lastCheck: Date.now()
      }
      logger.error('健康检查失败', error as Error)
    }
  }

  /**
   * 获取健康状态
   */
  public getHealthStatus() {
    return this.healthStatus
  }
}

