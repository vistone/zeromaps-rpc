/**
 * ZeroMaps RPC 客户端
 * 连接到 RPC 服务器，发起数据请求
 */

import * as net from 'net'
import { EventEmitter } from 'events'
import {
  FrameType,
  DataType,
  HandshakeRequest,
  HandshakeResponse,
  DataRequest,
  DataResponse
} from '../proto/proto/zeromaps-rpc'

interface PendingRequest {
  resolve: (response: DataResponse) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

export class RpcClient extends EventEmitter {
  private socket: net.Socket | null = null
  private clientID: number = 0
  private buffer = Buffer.alloc(0)
  private pendingRequests = new Map<string, PendingRequest>()
  private connected = false

  constructor(
    private host: string,
    private port: number
  ) {
    super()
  }

  /**
   * 连接到服务器
   */
  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(this.port, this.host, () => {
        console.log(`✓ 已连接到 RPC 服务器: ${this.host}:${this.port}`)
        this.performHandshake().then(resolve).catch(reject)
      })
      
      this.socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk])
        this.processBuffer()
      })
      
      this.socket.on('close', () => {
        this.connected = false
        console.log('✗ 与服务器断开连接')
        this.emit('close')
      })
      
      this.socket.on('error', (err) => {
        console.error('Socket 错误:', err)
        reject(err)
      })
    })
  }

  /**
   * 执行握手
   */
  private async performHandshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = HandshakeRequest.encode({
        clientInfo: 'taskcli v1.0.0'
      }).finish()
      
      this.sendFrame(FrameType.HANDSHAKE_REQUEST, Buffer.from(request))
      
      // 监听握手响应
      const timeout = setTimeout(() => {
        reject(new Error('握手超时'))
      }, 5000)
      
      const handler = (response: HandshakeResponse) => {
        clearTimeout(timeout)
        if (response.success) {
          this.clientID = response.clientID
          this.connected = true
          console.log(`✓ 握手成功: clientID=${this.clientID}`)
          resolve()
        } else {
          reject(new Error(`握手失败: ${response.message}`))
        }
      }
      
      this.once('handshake', handler)
    })
  }

  /**
   * 处理接收缓冲区
   */
  private processBuffer(): void {
    while (this.buffer.length >= 5) {
      const payloadLength = this.buffer.readUInt32BE(0)
      const frameType = this.buffer.readUInt8(4)
      
      if (this.buffer.length < 5 + payloadLength) {
        break
      }
      
      const payload = this.buffer.slice(5, 5 + payloadLength)
      this.buffer = this.buffer.slice(5 + payloadLength)
      
      this.handleFrame(frameType, payload)
    }
  }

  /**
   * 处理接收到的帧
   */
  private handleFrame(frameType: number, payload: Buffer): void {
    try {
      switch (frameType) {
        case FrameType.HANDSHAKE_RESPONSE: {
          const response = HandshakeResponse.decode(payload)
          this.emit('handshake', response)
          break
        }
        
        case FrameType.DATA_RESPONSE: {
          const response = DataResponse.decode(payload)
          this.handleDataResponse(response)
          break
        }
        
        default:
          console.warn(`未知帧类型: ${frameType}`)
      }
    } catch (error) {
      console.error('处理帧错误:', error)
    }
  }

  /**
   * 处理数据响应
   */
  private handleDataResponse(response: DataResponse): void {
    // 使用 URI 作为 key 匹配
    const key = response.uri
    
    const pending = this.pendingRequests.get(key)
    if (pending) {
      clearTimeout(pending.timeout)
      this.pendingRequests.delete(key)
      pending.resolve(response)
    } else {
      console.warn(`[Client] 未找到匹配的请求: ${key}`)
    }
  }

  /**
   * 发起数据请求
   * @param uri URI 路径，如 "PlanetoidMetadata" 或 "BulkMetadata/pb=!1m2!1s04!2u2699"
   */
  public async fetchData(uri: string): Promise<DataResponse> {
    if (!this.connected) {
      throw new Error('未连接到服务器')
    }
    
    const request: DataRequest = {
      clientID: this.clientID,
      uri
    }
    
    return new Promise((resolve, reject) => {
      // 使用 URI 作为 key
      const key = uri
      
      console.log(`[Client] 发送请求: ${key.substring(0, 80)}`)
      
      // 设置超时
      const timeout = setTimeout(() => {
        console.warn(`[Client] 请求超时: ${key.substring(0, 80)}`)
        this.pendingRequests.delete(key)
        reject(new Error('请求超时'))
      }, 30000) // 30秒超时（增加到30秒）
      
      this.pendingRequests.set(key, { resolve, reject, timeout })
      
      console.log(`[Client] 待处理请求数: ${this.pendingRequests.size}`)
      
      // 发送请求
      const encoded = DataRequest.encode(request).finish()
      this.sendFrame(FrameType.DATA_REQUEST, Buffer.from(encoded))
    })
  }

  /**
   * 发送帧
   */
  private sendFrame(frameType: number, payload: Buffer): void {
    if (!this.socket || this.socket.destroyed) {
      return
    }
    
    const frameLength = 5 + payload.length
    const frame = Buffer.allocUnsafe(frameLength)
    
    frame.writeUInt32BE(payload.length, 0)
    frame.writeUInt8(frameType, 4)
    payload.copy(frame, 5)
    
    this.socket.write(frame)
  }

  /**
   * 断开连接
   */
  public disconnect(): void {
    if (this.socket) {
      this.socket.end()
      this.socket = null
      this.connected = false
    }
  }

  /**
   * 是否已连接
   */
  public isConnected(): boolean {
    return this.connected
  }

  /**
   * 获取 clientID
   */
  public getClientID(): number {
    return this.clientID
  }
}

