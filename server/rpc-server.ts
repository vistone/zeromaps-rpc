/**
 * ZeroMaps RPC 服务器
 * 处理客户端请求，使用 HTTP/2 或系统 curl + IPv6 池获取数据
 */

import * as net from 'net'
import * as https from 'https'
import * as http from 'http'
import * as os from 'os'
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

/**
 * 自动检测系统 IPv6 隧道前缀
 * 返回：{ supported: boolean, prefix: string, interface: string }
 */
function detectIPv6Tunnel(): { supported: boolean; prefix: string; interfaceName: string } {
  try {
    const interfaces = os.networkInterfaces()

    // 优先查找 he-ipv6, sit1, tun0 等隧道接口
    const tunnelInterfaces = ['he-ipv6', 'sit1', 'sit2', 'tun0', 'tun1']

    for (const tunnelName of tunnelInterfaces) {
      const addrs = interfaces[tunnelName]
      if (!addrs) continue

      for (const addr of addrs) {
        if (addr.family === 'IPv6' && !addr.internal) {
          const ipv6Full = addr.address

          // 过滤掉本地链路地址（fe80::）和其他特殊地址
          if (ipv6Full.startsWith('fe80:') || ipv6Full.startsWith('::1')) {
            continue  // 跳过本地链路地址和 loopback
          }

          // 从完整地址提取前缀（去掉后缀）
          // 例如：2607:8700:5500:2043::2 → 2607:8700:5500:2043
          const prefix = ipv6Full.split('::')[0]  // 取 :: 前面的部分

          logger.info('✅ 检测到 IPv6 隧道', {
            interface: tunnelName,
            prefix: prefix,
            fullAddress: ipv6Full.substring(0, 40)
          })

          return { supported: true, prefix, interfaceName: tunnelName }
        }
      }
    }

    // 查找其他任何非内部的 IPv6 地址
    for (const name in interfaces) {
      const addrs = interfaces[name]
      if (!addrs) continue

      for (const addr of addrs) {
        if (addr.family === 'IPv6' && !addr.internal) {
          const ipv6Full = addr.address

          // 过滤掉本地链路地址（fe80::）和其他特殊地址
          if (ipv6Full.startsWith('fe80:') || ipv6Full.startsWith('::1') || ipv6Full.startsWith('::')) {
            continue  // 跳过本地链路地址、loopback 和未分配地址
          }

          const prefix = ipv6Full.split('::')[0]

          logger.info('✅ 检测到 IPv6 支持', {
            interface: name,
            prefix: prefix,
            fullAddress: ipv6Full.substring(0, 40)
          })

          return { supported: true, prefix, interfaceName: name }
        }
      }
    }

    logger.info('ℹ️  系统不支持 IPv6（未找到全局 IPv6 地址）')
    return { supported: false, prefix: '', interfaceName: '' }
  } catch (error) {
    logger.warn('IPv6 检测失败，假定不支持', error as Error)
    return { supported: false, prefix: '', interfaceName: '' }
  }
}

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
  private utlsHealthStatus: { status: string; message: string; lastCheck: number } = { status: 'unknown', message: '未检测', lastCheck: 0 }
  private fetcherType: 'utls' = 'utls'  // 当前使用的 fetcher 类型（只支持 uTLS）
  private emergencyStop = false  // 紧急停止标志（检测到 403 时触发）
  private emergencyStopReason = ''  // 紧急停止原因
  private dynamicConcurrencyEnabled = true  // 是否启用动态并发调节
  private concurrencyAdjustmentInterval: NodeJS.Timeout | null = null  // 并发调整定时器
  private healthCheckInterval: NodeJS.Timeout | null = null  // 健康检查定时器
  private utlsHealthCheckInterval: NodeJS.Timeout | null = null  // uTLS健康检查定时器
  private lastSystemStats: any = null  // 上次系统统计信息

  constructor(
    private port: number,
    private ipv6BasePrefix: string
  ) {
    super()

    // 增加最大监听器数量限制（防止 WebSocket 连接过多时警告）
    this.setMaxListeners(50)

    // 获取配置实例（延迟初始化，避免模块导入时失败）
    const config = getConfig()

    // 从配置获取 IPv6 池参数
    const ipv6Start = config.get<number>('ipv6.start')
    const ipv6Count = config.get<number>('ipv6.count')

    // 🔍 自动检测系统 IPv6 隧道和前缀
    const ipv6Detection = detectIPv6Tunnel()

    // 决定最终使用的 IPv6 前缀（优先级：手动配置 > 自动检测）
    let finalIPv6Prefix = ipv6BasePrefix  // 手动配置的前缀

    if (!finalIPv6Prefix && ipv6Detection.supported) {
      // 如果没有手动配置，但检测到 IPv6，使用自动检测的前缀
      finalIPv6Prefix = ipv6Detection.prefix
      logger.info('🔍 使用自动检测的 IPv6 前缀', {
        prefix: finalIPv6Prefix,
        interface: ipv6Detection.interfaceName
      })
    }

    // 初始化 IPv6 地址池
    if (finalIPv6Prefix && ipv6Detection.supported) {
      const hc = config.get<any>('ipv6.healthCheck')
      this.ipv6Pool = new IPv6Pool(finalIPv6Prefix, ipv6Start, ipv6Count, {
        maxError403Count: hc.maxError403Count,
        minRequestsBeforeCheck: hc.minRequestsBeforeCheck,
        failureRateThreshold: hc.failureRateThreshold,
        responseTimeThreshold: hc.responseTimeThreshold,
        rateLimitThreshold: hc.rateLimitThreshold
      })
      logger.info('IPv6 地址池已配置', {
        prefix: finalIPv6Prefix,
        range: `::${ipv6Start} ~ ::${ipv6Start + ipv6Count - 1}`,
        count: ipv6Count,
        source: ipv6BasePrefix ? '手动配置' : '自动检测'
      })
    } else {
      // 创建空的 IPv6 池（不使用 IPv6），也保持统一的配置接口
      const hc = config.get<any>('ipv6.healthCheck')
      this.ipv6Pool = new IPv6Pool('', 0, 0, {
        maxError403Count: hc.maxError403Count,
        minRequestsBeforeCheck: hc.minRequestsBeforeCheck,
        failureRateThreshold: hc.failureRateThreshold,
        responseTimeThreshold: hc.responseTimeThreshold,
        rateLimitThreshold: hc.rateLimitThreshold
      })

      if (finalIPv6Prefix && !ipv6Detection.supported) {
        logger.warn('配置了 IPv6 前缀但系统不支持 IPv6，禁用 IPv6 地址池')
      } else if (!finalIPv6Prefix && ipv6Detection.supported) {
        logger.warn('检测到 IPv6 但无可用前缀（可能是动态地址），使用默认网络')
      } else {
        logger.warn('未使用 IPv6 地址池（使用默认网络）')
      }
    }

    // 从配置获取 uTLS 参数
    const proxyPort = config.get<number>('utls.proxyPort')
    const concurrency = config.get<number>('utls.concurrency')
    const enableKeepAlive = config.get<boolean>('utls.enableKeepAlive')
    const enableAdaptiveConcurrency = config.get<boolean>('utls.enableAdaptiveConcurrency')

    logger.info('使用 uTLS 代理', {
      browser: 'Chrome 120',
      proxyPort,
      concurrency,
      keepAlive: enableKeepAlive,
      adaptiveConcurrency: enableAdaptiveConcurrency
    })
    const fetcherInstance = new UTLSFetcher(
      this.ipv6Pool,
      concurrency,
      proxyPort,
      enableKeepAlive,
      enableAdaptiveConcurrency
    )
    // 注入数据验证阈值配置
    try {
      const dv = config.get<any>('dataValidation')
      fetcherInstance.updateValidationConfig({
        minResponseSize: dv.minResponseSize,
        allowedContentTypes: dv.allowedContentTypes
      })
    } catch { }
    this.fetcher = fetcherInstance as IFetcher
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

    // 监听数据验证失败事件（触发紧急检查）
    this.fetcher.on('invalidData', async (data: any) => {
      logger.warn('🚨 检测到无效数据，触发紧急健康检查', {
        statusCode: data.statusCode,
        bodySize: data.bodySize,
        warning: data.warning
      })
      await this.emergencyHealthCheck()
    })

    // 初始化系统监控
    this.systemMonitor = new SystemMonitor()

    // 启动健康检查（从配置获取间隔）
    this.startHealthCheck()
    this.startUTLSHealthCheck()

    // 启动动态并发调节
    this.startDynamicConcurrencyAdjustment()
  }

  /**
   * 启动前健康检查（阻塞式）
   */
  public async performStartupHealthCheck(): Promise<{ google: any, utls: any }> {
    logger.info('开始启动前健康检查...')

    // 检查 Google API
    await this.checkHealth()

    // 检查 uTLS 代理（等待 2 秒让 uTLS 先启动）
    logger.info('等待 uTLS 代理启动...')
    await new Promise(resolve => setTimeout(resolve, 2000))
    await this.checkUTLSHealth()

    return {
      google: this.healthStatus,
      utls: this.utlsHealthStatus
    }
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
   * 紧急健康检查（检测到可疑数据时触发）
   */
  private async emergencyHealthCheck(): Promise<void> {
    logger.error('🚨 紧急健康检查开始（检测到可疑的 200 响应）')

    try {
      // 使用原始 https 请求检查真实状态
      const testUrl = 'https://kh.google.com/rt/earth/PlanetoidMetadata'
      const result = await this.rawHttpsRequest(testUrl, 5000)

      logger.info('紧急健康检查结果', {
        statusCode: result.statusCode,
        bodySize: result.body.length
      })

      if (result.statusCode === 403) {
        // 确认节点被拉黑，进入紧急停止模式
        this.emergencyStop = true
        this.emergencyStopReason = '节点被 Google 拉黑（403）'

        logger.error('🚨🚨🚨 紧急停止：节点已被拉黑！', undefined, {
          statusCode: 403,
          bodySize: result.body.length
        })

        // 更新健康状态
        this.healthStatus = {
          status: 403,
          message: '节点被拉黑（紧急检测）',
          lastCheck: Date.now()
        }

        // 通知所有已连接的客户端
        this.notifyAllClients403()

      } else if (result.statusCode === 200) {
        logger.warn('紧急健康检查通过，可能是临时问题', {
          statusCode: 200,
          bodySize: result.body.length
        })
      } else {
        logger.warn('紧急健康检查异常', {
          statusCode: result.statusCode
        })
      }
    } catch (error) {
      logger.error('紧急健康检查失败', error as Error)
    }
  }

  /**
   * 通知所有客户端 403 错误
   */
  private notifyAllClients403(): void {
    logger.info(`设置紧急停止标志，后续所有请求将返回 403 (当前客户端: ${this.clients.size} 个)`)
    // 紧急停止标志已在 emergencyHealthCheck 中设置
    // 所有后续请求会在 handleDataRequest 中被拦截并返回 403
  }

  /**
   * 处理数据请求
   */
  private async handleDataRequest(socket: net.Socket, payload: Buffer): Promise<void> {
    try {
      const request = DataRequest.decode(payload)

      // 🚨 紧急停止检查
      if (this.emergencyStop) {
        logger.warn('紧急停止模式：拒绝请求', {
          reason: this.emergencyStopReason,
          clientID: request.clientID,
          uri: request.uri.substring(0, 50)
        })

        const errorResponse = DataResponse.encode({
          clientID: request.clientID,
          uri: request.uri,
          statusCode: 403,
          data: Buffer.from(`服务已停止：${this.emergencyStopReason}`)
        }).finish()

        this.sendFrame(socket, FrameType.DATA_RESPONSE, Buffer.from(errorResponse))
        return
      }

      // 验证请求 URI 是否有效（避免向 Google 发送无效请求）
      if (!this.isValidURI(request.uri)) {
        logger.warn('拒绝无效请求', {
          clientID: request.clientID,
          uri: request.uri.substring(0, 80)
        })

        const errorResponse = DataResponse.encode({
          clientID: request.clientID,
          uri: request.uri,
          statusCode: 400,
          data: Buffer.from('无效的请求 URI')
        }).finish()

        this.sendFrame(socket, FrameType.DATA_RESPONSE, Buffer.from(errorResponse))
        return
      }

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
    const fetcherStats = this.fetcher.getStats()

    return {
      totalClients: this.clients.size,
      fetcherType: this.fetcherType,
      fetcherStats: fetcherStats,
      ipv6Stats: this.ipv6Pool.getDetailedStats(),
      system: systemStats,
      health: this.healthStatus,  // 保持原有字段（Google API 健康状态）
      utlsHealth: this.utlsHealthStatus,  // 新增字段（uTLS 代理健康状态）
      emergencyStop: this.emergencyStop,  // 紧急停止标志
      emergencyStopReason: this.emergencyStopReason,  // 紧急停止原因
      dynamicConcurrency: {
        enabled: this.dynamicConcurrencyEnabled,
        currentConcurrency: fetcherStats.currentConcurrency,
        adaptiveConcurrency: fetcherStats.adaptiveConcurrency,
        keepAliveEnabled: fetcherStats.keepAliveEnabled,
        performanceMetrics: fetcherStats.performanceMetrics,
        lastSystemStats: this.lastSystemStats
      }
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
    // 清理所有定时器
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }

    if (this.utlsHealthCheckInterval) {
      clearInterval(this.utlsHealthCheckInterval)
      this.utlsHealthCheckInterval = null
    }

    if (this.concurrencyAdjustmentInterval) {
      clearInterval(this.concurrencyAdjustmentInterval)
      this.concurrencyAdjustmentInterval = null
    }

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

    // 清理旧定时器
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
    }

    // 从配置获取健康检查间隔
    const config = getConfig()
    const interval = config.get<number>('performance.healthCheckInterval')
    this.healthCheckInterval = setInterval(() => {
      this.checkHealth()
    }, interval)
  }

  /**
   * 验证 URI 是否有效（防止向 Google 发送垃圾请求）
   */
  private isValidURI(uri: string): boolean {
    // 拒绝明显无效的请求模式

    // 1. URI 不能为空
    if (!uri || uri.trim().length === 0) {
      return false
    }

    // 2. 拒绝测试用的无效节点 ID
    // 例如：NodeData/pb=!1m2!1s0!2u0（0 是无效的节点 ID）
    if (uri.includes('!1s0!') || uri.includes('!2s0!')) {
      return false
    }

    // 3. 只允许特定的 API 路径
    const validPaths = [
      'PlanetoidMetadata',
      'BulkMetadata',
      'NodeData',
      'ImageryMetadata',
      'Imagery'
    ]

    const hasValidPath = validPaths.some(path => uri.startsWith(path))
    if (!hasValidPath) {
      return false
    }

    // 4. 检查是否包含合法的 protobuf 参数格式
    if (uri.includes('/pb=') && uri.length < 20) {
      // pb 参数太短，可能是无效请求
      return false
    }

    return true
  }

  /**
   * 检查节点健康状态（直接用 https 请求，不经过 uTLS 代理，带重试）
   */
  private async checkHealth(): Promise<void> {
    const testUrl = 'https://kh.google.com/rt/earth/PlanetoidMetadata'
    let lastError: Error | null = null

    // 最多重试3次（总共4次尝试）
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        // 直接用 Node.js https 模块，不经过 uTLS 代理
        // 这样才能真正测试服务器主 IP 是否被拉黑（不使用任何伪装）
        const result = await this.rawHttpsRequest(testUrl, 10000)

        this.healthStatus = {
          status: result.statusCode,
          message: result.statusCode === 200 ? '正常（原始 IPv4）' :
            result.statusCode === 403 ? '节点被拉黑（原始 IPv4）' :
              result.statusCode === 429 ? '限流（原始 IPv4）' :
                `HTTP ${result.statusCode}（原始 IPv4）`,
          lastCheck: Date.now()
        }

        if (result.statusCode === 403) {
          logger.error('健康检查: 节点被拉黑（原始 IPv4，无伪装）', undefined, {
            statusCode: 403,
            bodySize: result.body.length
          })
        } else if (result.statusCode === 200) {
          logger.info('健康检查: 节点正常（原始 IPv4，无伪装）', {
            bodySize: result.body.length,
            attempt: attempt + 1
          })
        } else {
          logger.warn('健康检查异常（原始 IPv4，无伪装）', {
            statusCode: result.statusCode,
            bodySize: result.body.length,
            attempt: attempt + 1
          })
        }

        return // 成功，退出重试循环
      } catch (error) {
        lastError = error as Error
        
        // 如果不是最后一次尝试，等待后重试（指数退避）
        if (attempt < 3) {
          const delay = Math.pow(2, attempt) * 1000 // 1s, 2s, 4s
          logger.warn(`健康检查失败，${delay}ms 后重试 (${attempt + 1}/3)`, {
            error: lastError.message
          })
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }

    // 所有尝试都失败
    if (lastError) {
      this.healthStatus = {
        status: 0,
        message: lastError.message,
        lastCheck: Date.now()
      }
      logger.error('健康检查失败（所有重试均失败）', lastError)
    }
  }

  /**
   * 原始 HTTPS 请求（不经过 uTLS 代理，不使用任何伪装）
   */
  private async rawHttpsRequest(url: string, timeout: number): Promise<{ statusCode: number, body: Buffer }> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url)

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        timeout,
        // 不设置任何特殊 headers，使用 Node.js 默认的
      }

      const req = https.request(options, (res: any) => {
        const chunks: Buffer[] = []

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })

        res.on('end', () => {
          const body = Buffer.concat(chunks)
          resolve({
            statusCode: res.statusCode,
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
   * 启动 uTLS 代理健康检查
   */
  private startUTLSHealthCheck(): void {
    // 立即执行一次
    this.checkUTLSHealth()

    // 清理旧定时器
    if (this.utlsHealthCheckInterval) {
      clearInterval(this.utlsHealthCheckInterval)
    }

    // 从配置获取健康检查间隔
    const config = getConfig()
    const interval = config.get<number>('performance.healthCheckInterval')

    // 定期检查（与 Google API 健康检查间隔相同）
    this.utlsHealthCheckInterval = setInterval(() => {
      this.checkUTLSHealth()
    }, interval)
  }

  /**
   * 检查 uTLS 代理健康状态
   */
  private async checkUTLSHealth(): Promise<void> {
    try {
      const config = getConfig()
      const proxyPort = config.get<number>('utls.proxyPort')
      const healthUrl = `http://localhost:${proxyPort}/health`

      // 请求 uTLS 代理的健康检查端点
      const result = await this.httpGet(healthUrl, 5000)

      if (result.statusCode === 200) {
        try {
          const healthData = JSON.parse(result.body.toString())

          // 检查成功率
          const successRate = parseFloat(healthData.successRate)

          if (healthData.status === 'ok') {
            if (successRate >= 80) {
              this.utlsHealthStatus = {
                status: 'healthy',
                message: `正常 (成功率: ${healthData.successRate}, 请求数: ${healthData.totalRequests})`,
                lastCheck: Date.now()
              }
              logger.info('uTLS 代理健康检查: 正常', {
                successRate: healthData.successRate,
                totalRequests: healthData.totalRequests
              })
            } else {
              this.utlsHealthStatus = {
                status: 'degraded',
                message: `性能下降 (成功率: ${healthData.successRate}, 请求数: ${healthData.totalRequests})`,
                lastCheck: Date.now()
              }
              logger.warn('uTLS 代理健康检查: 性能下降', {
                successRate: healthData.successRate,
                totalRequests: healthData.totalRequests
              })
            }
          } else {
            this.utlsHealthStatus = {
              status: 'unhealthy',
              message: `异常状态: ${healthData.status}`,
              lastCheck: Date.now()
            }
            logger.error('uTLS 代理健康检查: 异常', undefined, {
              status: healthData.status
            })
          }
        } catch (parseError) {
          this.utlsHealthStatus = {
            status: 'error',
            message: '响应格式错误',
            lastCheck: Date.now()
          }
          logger.error('uTLS 代理健康检查: 响应解析失败', parseError as Error)
        }
      } else {
        this.utlsHealthStatus = {
          status: 'error',
          message: `HTTP ${result.statusCode}`,
          lastCheck: Date.now()
        }
        logger.error('uTLS 代理健康检查: HTTP 错误', undefined, {
          statusCode: result.statusCode
        })
      }
    } catch (error) {
      this.utlsHealthStatus = {
        status: 'offline',
        message: '无法连接到 uTLS 代理',
        lastCheck: Date.now()
      }
      logger.error('uTLS 代理健康检查: 连接失败', error as Error)
    }
  }

  /**
   * HTTP GET 请求（用于健康检查）
   */
  private async httpGet(url: string, timeout: number): Promise<{ statusCode: number, body: Buffer }> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url)

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        timeout
      }

      const req = http.request(options, (res: any) => {
        const chunks: Buffer[] = []

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })

        res.on('end', () => {
          const body = Buffer.concat(chunks)
          resolve({
            statusCode: res.statusCode,
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
   * 获取健康状态（保持 API 兼容性）
   */
  public getHealthStatus() {
    return this.healthStatus
  }

  /**
   * 获取 uTLS 代理健康状态
   */
  public getUTLSHealthStatus() {
    return this.utlsHealthStatus
  }

  /**
   * 启动动态并发调节
   */
  private startDynamicConcurrencyAdjustment(): void {
    if (this.concurrencyAdjustmentInterval) {
      clearInterval(this.concurrencyAdjustmentInterval)
    }

    // 每60秒检查一次系统资源并调整并发
    this.concurrencyAdjustmentInterval = setInterval(async () => {
      await this.adjustConcurrencyBasedOnSystemResources()
    }, 60000)

    logger.info('动态并发调节已启动', { interval: '60s' })
  }

  /**
   * 基于系统资源调整并发数
   */
  private async adjustConcurrencyBasedOnSystemResources(): Promise<void> {
    if (!this.dynamicConcurrencyEnabled) {
      return
    }

    try {
      const systemStats = await this.systemMonitor.getStats()
      const fetcherStats = this.fetcher.getStats()

      // 计算系统负载指标
      const cpuUsage = systemStats.cpu.usage
      const memoryUsage = systemStats.memory.usage
      const loadAvg = systemStats.cpu.loadAvg[0]  // 1分钟平均负载
      const cores = systemStats.cpu.cores

      // 计算目标并发数
      let targetConcurrency = this.calculateTargetConcurrency(
        cpuUsage,
        memoryUsage,
        loadAvg,
        cores,
        fetcherStats
      )

      // 限制并发数范围
      const config = getConfig()
      const minConcurrency = config.get<number>('utls.adaptiveConcurrency.minConcurrency') || 5
      const maxConcurrency = config.get<number>('utls.adaptiveConcurrency.maxConcurrency') || 300
      targetConcurrency = Math.max(minConcurrency, Math.min(maxConcurrency, targetConcurrency))

      // 如果目标并发数与当前不同，则更新
      if (targetConcurrency !== fetcherStats.currentConcurrency) {
        (this.fetcher as any).updateConcurrencyConfig({ concurrency: targetConcurrency })

        logger.info('动态并发调整', {
          oldConcurrency: fetcherStats.currentConcurrency,
          newConcurrency: targetConcurrency,
          cpuUsage: `${cpuUsage}%`,
          memoryUsage: `${memoryUsage}%`,
          loadAvg: loadAvg.toFixed(2),
          cores
        })
      }

      this.lastSystemStats = systemStats
    } catch (error) {
      logger.error('动态并发调整失败', error as Error)
    }
  }

  /**
   * 计算目标并发数
   */
  private calculateTargetConcurrency(
    cpuUsage: number,
    memoryUsage: number,
    loadAvg: number,
    cores: number,
    fetcherStats: any
  ): number {
    // 基础并发数（基于CPU核心数）
    let baseConcurrency = cores * 10

    // CPU 使用率调整
    if (cpuUsage > 80) {
      baseConcurrency *= 0.7  // CPU 高负载时减少并发
    } else if (cpuUsage < 30) {
      baseConcurrency *= 1.3  // CPU 低负载时增加并发
    }

    // 内存使用率调整
    if (memoryUsage > 85) {
      baseConcurrency *= 0.6  // 内存不足时大幅减少并发
    } else if (memoryUsage < 50) {
      baseConcurrency *= 1.2  // 内存充足时增加并发
    }

    // 系统负载调整
    if (loadAvg > cores * 2) {
      baseConcurrency *= 0.5  // 系统负载过高时大幅减少并发
    } else if (loadAvg < cores * 0.5) {
      baseConcurrency *= 1.4  // 系统负载较低时增加并发
    }

    // 基于当前性能指标微调
    const avgResponseTime = fetcherStats.performanceMetrics?.avgResponseTime || 0
    const successRate = fetcherStats.performanceMetrics?.successRate || 1.0

    if (avgResponseTime > 3000 && successRate > 0.8) {
      baseConcurrency *= 0.8  // 响应时间过长时减少并发
    } else if (avgResponseTime < 1000 && successRate > 0.9) {
      baseConcurrency *= 1.2  // 响应时间短且成功率高时增加并发
    }

    return Math.round(baseConcurrency)
  }

  /**
   * 更新配置（热更新，带原子性保证）
   */
  public updateConfig(newConfig: any): void {
    logger.info('RpcServer 配置热更新开始', {
      ipv6HealthCheck: newConfig.ipv6?.healthCheck,
      dataValidation: newConfig.dataValidation,
      utlsConcurrency: newConfig.utls
    })

    // 备份当前配置（用于回滚）
    const backup = {
      ipv6HealthCheck: { ...this.ipv6Pool['healthCheckConfig'] },
      currentConcurrency: (this.fetcher as any).currentConcurrency,
      enableKeepAlive: (this.fetcher as any).enableKeepAlive,
      enableAdaptiveConcurrency: (this.fetcher as any).enableAdaptiveConcurrency
    }

    try {
      // 步骤1: 预验证所有配置项
      if (newConfig.ipv6?.healthCheck) {
        const hc = newConfig.ipv6.healthCheck
        if (hc.maxError403Count !== undefined && (hc.maxError403Count < 1 || hc.maxError403Count > 100)) {
          throw new Error(`maxError403Count 无效: ${hc.maxError403Count}`)
        }
        if (hc.failureRateThreshold !== undefined && (hc.failureRateThreshold < 0 || hc.failureRateThreshold > 1)) {
          throw new Error(`failureRateThreshold 无效: ${hc.failureRateThreshold}`)
        }
      }

      if (newConfig.utls?.concurrency !== undefined) {
        if (newConfig.utls.concurrency < 1 || newConfig.utls.concurrency > 1000) {
          throw new Error(`concurrency 无效: ${newConfig.utls.concurrency}`)
        }
      }

      // 步骤2: 原子性更新（全部成功或全部失败）
      const updates: Array<() => void> = []

      if (newConfig.ipv6?.healthCheck) {
        updates.push(() => this.ipv6Pool.updateHealthCheckConfig(newConfig.ipv6.healthCheck))
      }

      if (newConfig.dataValidation) {
        updates.push(() => (this.fetcher as any).updateValidationConfig(newConfig.dataValidation))
      }

      if (newConfig.utls) {
        updates.push(() => (this.fetcher as any).updateConcurrencyConfig({
          concurrency: newConfig.utls.concurrency,
          enableKeepAlive: newConfig.utls.enableKeepAlive,
          enableAdaptiveConcurrency: newConfig.utls.enableAdaptiveConcurrency
        }))
      }

      // 执行所有更新
      for (const update of updates) {
        update()
      }

      logger.info('RpcServer 配置热更新成功')
    } catch (error) {
      // 回滚到备份配置
      logger.error('RpcServer 配置热更新失败，正在回滚', error as Error)

      try {
        this.ipv6Pool.updateHealthCheckConfig(backup.ipv6HealthCheck);
        (this.fetcher as any).updateConcurrencyConfig({
          concurrency: backup.currentConcurrency,
          enableKeepAlive: backup.enableKeepAlive,
          enableAdaptiveConcurrency: backup.enableAdaptiveConcurrency
        })
        logger.info('配置已回滚到更新前状态')
      } catch (rollbackError) {
        logger.error('配置回滚失败（严重错误）', rollbackError as Error)
      }

      throw error
    }
  }
}

