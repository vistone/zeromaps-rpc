/**
 * GitHub Webhook 服务器
 * 监听 GitHub push 事件，自动触发更新
 */

import * as http from 'http'
import * as crypto from 'crypto'

export class WebhookServer {
  private server: http.Server | null = null
  private secret: string
  private updateScript: string
  private updating = false

  constructor(
    private port: number,
    secret?: string,
    updateScript: string = '/opt/zeromaps-rpc/auto-update.sh'
  ) {
    // GitHub Webhook Secret（用于验证请求来自 GitHub）
    this.secret = secret || process.env.WEBHOOK_SECRET || ''
    this.updateScript = updateScript
  }

  /**
   * 启动 Webhook 服务器
   */
  public start(): void {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res)
    })

    this.server.listen(this.port, '0.0.0.0', () => {
      console.log(`🎣 Webhook 服务器启动: http://0.0.0.0:${this.port}/webhook`)
      if (this.secret) {
        console.log(`   🔐 Secret 已配置，启用签名验证`)
      } else {
        console.warn(`   ⚠️  未配置 Secret，跳过签名验证（不安全）`)
      }
    })
  }

  /**
   * 处理 HTTP 请求
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/'

    // 健康检查
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', updating: this.updating }))
      return
    }

    // Webhook 端点
    if (url === '/webhook' && req.method === 'POST') {
      await this.handleWebhook(req, res)
      return
    }

    res.writeHead(404)
    res.end('Not Found')
  }

  /**
   * 处理 GitHub Webhook
   */
  private async handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      // 读取请求体
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(chunk as Buffer)
      }
      const body = Buffer.concat(chunks)
      const payload = body.toString()

      // 验证签名（如果配置了 secret）
      if (this.secret) {
        const signature = req.headers['x-hub-signature-256'] as string
        if (!signature) {
          console.warn('❌ Webhook 请求缺少签名')
          res.writeHead(401)
          res.end('Missing signature')
          return
        }

        const expectedSignature = 'sha256=' + crypto
          .createHmac('sha256', this.secret)
          .update(body)
          .digest('hex')

        if (signature !== expectedSignature) {
          console.warn('❌ Webhook 签名验证失败')
          res.writeHead(401)
          res.end('Invalid signature')
          return
        }
      }

      // 解析 payload
      const data = JSON.parse(payload)
      const event = req.headers['x-github-event'] as string

      console.log(`🎣 收到 GitHub Webhook: ${event}`)

      // 只处理 push 事件
      if (event !== 'push') {
        console.log(`ℹ️  忽略事件类型: ${event}`)
        res.writeHead(200)
        res.end('OK')
        return
      }

      // 检查是否是 master 分支
      const ref = data.ref
      if (ref !== 'refs/heads/master') {
        console.log(`ℹ️  忽略非 master 分支: ${ref}`)
        res.writeHead(200)
        res.end('OK')
        return
      }

      // 获取推送信息
      const commits = data.commits || []
      const pusher = data.pusher?.name || 'unknown'
      
      console.log(`📦 检测到 master 分支推送`)
      console.log(`   推送者: ${pusher}`)
      console.log(`   提交数: ${commits.length}`)
      
      if (commits.length > 0) {
        const lastCommit = commits[commits.length - 1]
        console.log(`   最新提交: ${lastCommit.message}`)
      }

      // 触发更新（异步执行，立即返回响应）
      res.writeHead(200)
      res.end('Update triggered')

      // 在后台执行更新（不要 await，立即返回）
      console.log(`🚀 准备触发自动更新...`)
      this.triggerUpdate().catch(err => {
        console.error('❌ 触发更新异常:', err)
      })

    } catch (error) {
      console.error('❌ 处理 Webhook 失败:', error)
      res.writeHead(500)
      res.end('Internal Error')
    }
  }

  /**
   * 触发更新脚本
   */
  private async triggerUpdate(): Promise<void> {
    if (this.updating) {
      console.log('⚠️  更新已在进行中，跳过')
      return
    }

    this.updating = true
    console.log('🚀 触发自动更新...')
    console.log(`   执行: ${this.updateScript}`)

    try {
      // 异步执行更新脚本（使用 spawn 实现实时日志）
      const { spawn } = await import('child_process')
      
      const child = spawn('bash', [this.updateScript])
      
      child.stdout.on('data', (data) => {
        console.log(`[更新] ${data.toString().trim()}`)
      })
      
      child.stderr.on('data', (data) => {
        console.error(`[更新错误] ${data.toString().trim()}`)
      })
      
      child.on('close', (code) => {
        if (code === 0) {
          console.log('✅ 自动更新完成')
        } else {
          console.error(`❌ 自动更新失败，退出码: ${code}`)
        }
        this.updating = false
      })
      
      child.on('error', (error) => {
        console.error('❌ 自动更新执行失败:', error)
        this.updating = false
      })

    } catch (error) {
      console.error('❌ 自动更新启动失败:', error)
      this.updating = false
    }
  }

  /**
   * 停止服务器
   */
  public stop(): void {
    if (this.server) {
      this.server.close()
      console.log('✓ Webhook 服务器已停止')
    }
  }
}

