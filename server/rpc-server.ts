/**
 * ZeroMaps RPC 服务器
 * 处理客户端请求，使用 curl-impersonate + IPv6 池获取数据
 */

import * as net from 'net'
import { EventEmitter } from 'events'
import { IPv6Pool } from './ipv6-pool'
import { CurlFetcher } from './curl-fetcher'
import {
  FrameType,
  DataType,
  HandshakeRequest,
  HandshakeResponse,
  DataRequest,
  DataResponse
} from '../proto/proto/zeromaps-rpc'

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
  private curlFetcher: CurlFetcher

  constructor(
    private port: number,
    private ipv6BasePrefix: string,
    private curlPath: string = '/usr/local/bin/curl_chrome116'
  ) {
    super()

    // 初始化 IPv6 地址池（100个地址）
    this.ipv6Pool = new IPv6Pool(ipv6BasePrefix, 1001, 100)

    // 初始化 curl 执行器
    this.curlFetcher = new CurlFetcher(curlPath, this.ipv6Pool)
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
        console.log(`   curl: ${this.curlPath}`)
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

      // 使用 curl-impersonate 获取数据
      const result = await this.curlFetcher.fetch({
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
   * 停止服务器
   */
  public async stop(): Promise<void> {
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
   * 获取服务器统计
   */
  public getStats() {
    return {
      totalClients: this.clients.size,
      curlStats: this.curlFetcher.getStats(),
      ipv6Stats: this.ipv6Pool.getDetailedStats()
    }
  }

  /**
   * 获取IPv6池对象（用于监控工具）
   */
  public getIPv6Pool(): IPv6Pool {
    return this.ipv6Pool
  }
}

