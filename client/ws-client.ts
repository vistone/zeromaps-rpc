/**
 * ZeroMaps WebSocket 客户端
 * 浏览器端使用，通过 WebSocket 连接到服务器
 */

export interface WsClientOptions {
  url: string  // wss://tile4.zeromaps.cn/ws
  onConnected?: () => void
  onDisconnected?: () => void
  onError?: (error: Error) => void
}

export interface FetchResult {
  statusCode: number
  data: Uint8Array
  headers: Record<string, string>
}

export class WsClient {
  private ws: WebSocket | null = null
  private connected = false
  private pendingRequests = new Map<string, {
    resolve: (result: FetchResult) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }>()
  private messageId = 0
  private options: WsClientOptions

  constructor(options: WsClientOptions) {
    this.options = options
  }

  /**
   * 连接到服务器
   */
  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.options.url)

        this.ws.onopen = () => {
          this.connected = true
          console.log(`✓ WebSocket 连接成功: ${this.options.url}`)
          this.options.onConnected?.()
          resolve()
        }

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data)
        }

        this.ws.onclose = () => {
          this.connected = false
          console.log(`🔌 WebSocket 断开连接`)
          this.options.onDisconnected?.()
        }

        this.ws.onerror = (event) => {
          const error = new Error('WebSocket 错误')
          console.error('❌ WebSocket 错误:', event)
          this.options.onError?.(error)
          reject(error)
        }

        // 连接超时
        setTimeout(() => {
          if (!this.connected) {
            reject(new Error('WebSocket 连接超时'))
          }
        }, 10000)

      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * 发送数据请求
   */
  public async fetchData(uri: string, timeout: number = 10000): Promise<FetchResult> {
    if (!this.connected || !this.ws) {
      throw new Error('WebSocket 未连接')
    }

    return new Promise((resolve, reject) => {
      const id = `req-${++this.messageId}`

      // 设置超时
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`请求超时: ${uri}`))
      }, timeout)

      // 保存 pending request
      this.pendingRequests.set(id, { resolve, reject, timeout: timeoutHandle })

      // 发送请求
      const message = {
        type: 'fetch',
        id,
        uri
      }

      this.ws!.send(JSON.stringify(message))
    })
  }

  /**
   * 处理服务器消息
   */
  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data)

      if (msg.type === 'response' && msg.id) {
        const pending = this.pendingRequests.get(msg.id)
        if (pending) {
          clearTimeout(pending.timeout)
          this.pendingRequests.delete(msg.id)

          pending.resolve({
            statusCode: msg.data.statusCode,
            data: new Uint8Array(msg.data.data),
            headers: msg.data.headers
          })
        }
      } else if (msg.type === 'error' && msg.id) {
        const pending = this.pendingRequests.get(msg.id)
        if (pending) {
          clearTimeout(pending.timeout)
          this.pendingRequests.delete(msg.id)

          pending.reject(new Error(msg.error || '未知错误'))
        }
      } else if (msg.type === 'pong') {
        // Pong 响应
      } else if (msg.type === 'stats') {
        // 实时统计推送
        console.log('📊 收到统计:', msg.data)
      }
    } catch (error) {
      console.error('处理消息失败:', error)
    }
  }

  /**
   * 发送心跳
   */
  public ping(): void {
    if (this.connected && this.ws) {
      this.ws.send(JSON.stringify({ type: 'ping' }))
    }
  }

  /**
   * 断开连接
   */
  public disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
      this.connected = false
    }
  }

  /**
   * 是否已连接
   */
  public isConnected(): boolean {
    return this.connected
  }
}

