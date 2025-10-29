/**
 * WebSocket处理器
 * 负责WebSocket连接管理和消息处理
 */

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import WebSocket, { WebSocketServer } from 'ws'
import { RpcServer } from './rpc-server.js'
import { NodeManager } from './node-manager.js'
import { IPPoolSyncManager } from './ip-pool-sync.js'
import { createLogger } from './logger.js'

const logger = createLogger('WebSocketHandler')

export interface WsMessage {
  type: 'fetch' | 'ping' | 'request_ip_pool' | 'update_ip_pool'
  id?: string
  uri?: string
  data?: any
}

export interface WsResponse {
  type: 'response' | 'error' | 'pong' | 'stats' | 'ip_pool_data' | 'ip_pool_updated'
  id?: string
  data?: any
  error?: string
}

export class WebSocketHandler {
  private wss: WebSocketServer | null = null
  private activeWSConnections = new Set<WebSocket>()
  private readonly maxWSConnections = 100
  private statsIntervals = new Map<WebSocket, NodeJS.Timeout>()
  private requestLogHandlers = new Map<WebSocket, (log: any) => void>()

  constructor(
    private rpcServer: RpcServer,
    private nodeManager: NodeManager,
    private ipPoolSyncManager: IPPoolSyncManager,
    private getVersion: () => string
  ) {}

  /**
   * 启动WebSocket服务器
   */
  public start(server: http.Server): void {
    this.wss = new WebSocketServer({ server })

    this.wss.on('connection', (ws: WebSocket, req) => {
      this.handleConnection(ws, req)
    })

    logger.info('WebSocket服务器已启动')
  }

  /**
   * 停止WebSocket服务器
   */
  public stop(): void {
    if (this.wss) {
      // 关闭所有连接
      for (const ws of this.activeWSConnections) {
        ws.close()
      }
      this.activeWSConnections.clear()
      
      // 清除所有定时器
      for (const interval of this.statsIntervals.values()) {
        clearInterval(interval)
      }
      this.statsIntervals.clear()

      this.wss.close()
      this.wss = null
      logger.info('WebSocket服务器已停止')
    }
  }

  /**
   * 处理WebSocket连接
   */
  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const clientIP = req.socket.remoteAddress

    // 检查连接数限制
    if (this.activeWSConnections.size >= this.maxWSConnections) {
      logger.warn('WebSocket 连接数已达上限，拒绝新连接', {
        current: this.activeWSConnections.size,
        max: this.maxWSConnections,
        clientIP
      })
      ws.close(1008, 'Too many connections')
      return
    }

    // 添加到活跃连接集合
    this.activeWSConnections.add(ws)
    logger.info('WebSocket 客户端连接', {
      clientIP,
      activeConnections: this.activeWSConnections.size
    })

    // 设置统计数据推送
    this.setupStatsPushing(ws)

    // 设置请求日志监听
    this.setupRequestLogListening(ws)

    // 处理消息
    ws.on('message', async (data: Buffer) => {
      await this.handleMessage(ws, data, clientIP || 'unknown')
    })

    // 处理连接关闭
    ws.on('close', () => {
      this.handleDisconnection(ws, clientIP || 'unknown')
    })

    // 处理错误
    ws.on('error', (error) => {
      logger.error('WebSocket 错误', error)
    })
  }

  /**
   * 设置统计数据推送
   */
  private setupStatsPushing(ws: WebSocket): void {
    const statsInterval = setInterval(async () => {
      if (ws.readyState === WebSocket.OPEN) {
        const stats = await this.rpcServer.getStats()
        const ipv6Pool = this.rpcServer.getIPv6Pool()
        const detailedStats = ipv6Pool.getDetailedStats()

        const statsResponse: WsResponse = {
          type: 'stats',
          data: {
            version: this.getVersion(),
            timestamp: Date.now(),
            clients: stats.totalClients,
            fetcherType: stats.fetcherType,
            requests: {
              total: stats.fetcherStats.totalRequests,
              concurrent: stats.fetcherStats.concurrentRequests,
              maxConcurrent: stats.fetcherStats.maxConcurrent,
              currentConcurrency: stats.fetcherStats.currentConcurrency,
              queueLength: stats.fetcherStats.queueLength || 0
            },
            concurrency: {
              enabled: stats.dynamicConcurrency?.enabled || false,
              current: stats.dynamicConcurrency?.currentConcurrency || 0,
              adaptive: stats.dynamicConcurrency?.adaptiveConcurrency || false,
              keepAlive: stats.dynamicConcurrency?.keepAliveEnabled || false,
              performance: stats.dynamicConcurrency?.performanceMetrics || null
            },
            ipv6: {
              total: detailedStats.totalAddresses,
              totalRequests: detailedStats.totalRequests,
              avgPerIP: detailedStats.averagePerIP,
              balance: detailedStats.balance,
              successRate: parseFloat(detailedStats.successRate),
              totalSuccess: detailedStats.totalSuccess,
              totalFailure: detailedStats.totalFailure,
              avgResponseTime: detailedStats.avgResponseTime,
              uptime: detailedStats.uptime,
              qps: parseFloat(detailedStats.requestsPerSecond),
              hasIPv6: detailedStats.hasIPv6
            },
            system: stats.system,
            health: stats.health,
            utlsHealth: stats.utlsHealth,
            emergencyStop: stats.emergencyStop,
            emergencyStopReason: stats.emergencyStopReason
          }
        }
        ws.send(JSON.stringify(statsResponse))
      }
    }, 1000)

    this.statsIntervals.set(ws, statsInterval)
  }

  /**
   * 设置请求日志监听
   */
  private setupRequestLogListening(ws: WebSocket): void {
    const requestLogHandler = (log: any) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'requestLog',
          data: log
        }))
      }
    }

    this.rpcServer.on('requestLog', requestLogHandler)
    this.requestLogHandlers.set(ws, requestLogHandler)
  }

  /**
   * 处理WebSocket消息
   */
  private async handleMessage(ws: WebSocket, data: Buffer, clientIP: string): Promise<void> {
    try {
      const msg: WsMessage = JSON.parse(data.toString())

      // Ping-Pong 心跳
      if (msg.type === 'ping') {
        const response: WsResponse = { type: 'pong' }
        ws.send(JSON.stringify(response))
        return
      }

      // IP 池同步：请求 IP 池
      if (msg.type === 'request_ip_pool') {
        await this.handleIPPoolRequest(ws, clientIP)
        return
      }

      // IP 池同步：接收 IP 池更新
      if (msg.type === 'update_ip_pool' && msg.data) {
        await this.handleIPPoolUpdate(ws, msg.data, clientIP)
        return
      }

      // 数据请求
      if (msg.type === 'fetch' && msg.uri && msg.id) {
        await this.handleFetchRequest(ws, msg, clientIP)
        return
      }

    } catch (error) {
      logger.error('处理 WebSocket 消息失败', error as Error)
    }
  }

  /**
   * 处理IP池请求
   */
  private async handleIPPoolRequest(ws: WebSocket, clientIP: string): Promise<void> {
    const ipPoolPath = '/opt/zeromaps-rpc/utls-proxy/ip-pools.json'
    try {
      const ipPoolData = await fs.promises.readFile(ipPoolPath, 'utf-8')
      const response: WsResponse = {
        type: 'ip_pool_data',
        data: JSON.parse(ipPoolData)
      }
      ws.send(JSON.stringify(response))
      logger.info('发送 IP 池数据到节点', { clientIP })
    } catch (error) {
      logger.error('读取 IP 池文件失败', error as Error)
    }
  }

  /**
   * 处理IP池更新
   */
  private async handleIPPoolUpdate(ws: WebSocket, data: any, clientIP: string): Promise<void> {
    const ipPoolPath = '/opt/zeromaps-rpc/utls-proxy/ip-pools.json'
    try {
      await fs.promises.writeFile(ipPoolPath, JSON.stringify(data, null, 2), 'utf-8')
      logger.info('收到 IP 池更新并已保存', { clientIP })

      const response: WsResponse = { type: 'ip_pool_updated' }
      ws.send(JSON.stringify(response))
    } catch (error) {
      logger.error('保存 IP 池文件失败', error as Error)
    }
  }

  /**
   * 处理数据获取请求
   */
  private async handleFetchRequest(ws: WebSocket, msg: WsMessage, clientIP: string): Promise<void> {
    logger.debug('[WS] 收到请求', {
      uri: msg.uri!.substring(0, 80),
      id: msg.id
    })

    try {
      const t1 = Date.now()

      // 构建完整 URL
      const url = `https://kh.google.com/rt/earth/${msg.uri}`

      // 通过 Fetcher 获取数据
      const fetcher = this.rpcServer.getFetcher()
      const result = await fetcher.fetch({ url, timeout: 10000 })

      const duration = Date.now() - t1
      logger.debug('[WS] 请求完成', {
        duration,
        statusCode: result.statusCode,
        size: result.body.length
      })

      const response: WsResponse = {
        type: 'response',
        id: msg.id,
        data: {
          statusCode: result.statusCode,
          data: Array.from(result.body),
          headers: result.headers
        }
      }

      ws.send(JSON.stringify(response))
    } catch (error) {
      logger.error('[WS] 请求失败', error as Error)

      const response: WsResponse = {
        type: 'error',
        id: msg.id,
        error: (error as Error).message
      }
      ws.send(JSON.stringify(response))
    }
  }

  /**
   * 处理连接断开
   */
  private handleDisconnection(ws: WebSocket, clientIP: string): void {
    // 从活跃连接集合中移除
    this.activeWSConnections.delete(ws)

    // 清除统计数据推送定时器
    const statsInterval = this.statsIntervals.get(ws)
    if (statsInterval) {
      clearInterval(statsInterval)
      this.statsIntervals.delete(ws)
    }

    // 移除请求日志监听器
    const requestLogHandler = this.requestLogHandlers.get(ws)
    if (requestLogHandler) {
      this.rpcServer.removeListener('requestLog', requestLogHandler)
      this.requestLogHandlers.delete(ws)
    }

    logger.info('WebSocket 客户端断开', {
      clientIP,
      activeConnections: this.activeWSConnections.size
    })
  }

  /**
   * 获取活跃连接数
   */
  public getActiveConnectionsCount(): number {
    return this.activeWSConnections.size
  }

  /**
   * 广播消息到所有连接的客户端
   */
  public broadcast(message: WsResponse): void {
    const messageStr = JSON.stringify(message)
    for (const ws of this.activeWSConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(messageStr)
      }
    }
  }
}
