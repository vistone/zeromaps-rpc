/**
 * GitHub Webhook 服务器
 * 监听 GitHub push 事件，自动触发更新
 */

import * as http from 'http'
import * as crypto from 'crypto'
import { createLogger } from './logger.js'

const logger = createLogger('WebhookServer')

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
      logger.info('Webhook 服务器启动', {
        url: `http://0.0.0.0:${this.port}/webhook`,
        secretConfigured: !!this.secret
      })

      if (!this.secret) {
        logger.warn('未配置 Secret，跳过签名验证（不安全）')
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
          logger.warn('Webhook 请求缺少签名')
          res.writeHead(401)
          res.end('Missing signature')
          return
        }

        const expectedSignature = 'sha256=' + crypto
          .createHmac('sha256', this.secret)
          .update(body)
          .digest('hex')

        if (signature !== expectedSignature) {
          logger.warn('Webhook 签名验证失败')
          res.writeHead(401)
          res.end('Invalid signature')
          return
        }
      }

      // 解析 payload
      const data = JSON.parse(payload)
      const event = req.headers['x-github-event'] as string

      logger.info('收到 GitHub Webhook', { event })

      // 只处理 push 事件
      if (event !== 'push') {
        logger.debug('忽略非 push 事件', { event })
        res.writeHead(200)
        res.end('OK')
        return
      }

      // 检查是否是 master 分支
      const ref = data.ref
      if (ref !== 'refs/heads/master') {
        logger.debug('忽略非 master 分支', { ref })
        res.writeHead(200)
        res.end('OK')
        return
      }

      // 获取推送信息
      const commits = data.commits || []
      const pusher = data.pusher?.name || 'unknown'

      logger.info('检测到 master 分支推送', {
        pusher,
        commitCount: commits.length,
        lastCommit: commits.length > 0 ? commits[commits.length - 1].message : null
      })

      // 触发更新（异步执行，立即返回响应）
      res.writeHead(200)
      res.end('Update triggered')

      // 在后台执行更新（不要 await，立即返回）
      logger.info('准备触发自动更新')
      this.triggerUpdate().catch(err => {
        logger.error('触发更新异常', err)
      })

    } catch (error) {
      logger.error('处理 Webhook 失败', error as Error)
      res.writeHead(500)
      res.end('Internal Error')
    }
  }

  /**
   * 触发更新脚本
   */
  private async triggerUpdate(): Promise<void> {
    if (this.updating) {
      logger.warn('更新已在进行中，跳过')
      return
    }

    this.updating = true
    logger.info('触发自动更新', { script: this.updateScript })

    try {
      const { spawn } = await import('child_process')

      const child = spawn('bash', [this.updateScript])

      child.stdout.on('data', (data) => {
        logger.info('[更新输出]', { output: data.toString().trim() })
      })

      child.stderr.on('data', (data) => {
        logger.warn('[更新错误输出]', { output: data.toString().trim() })
      })

      child.on('close', (code) => {
        if (code === 0) {
          logger.info('自动更新完成')
        } else {
          logger.error('自动更新失败', undefined, { exitCode: code })
        }
        this.updating = false
      })

      child.on('error', (error) => {
        logger.error('自动更新执行失败', error)
        this.updating = false
      })

    } catch (error) {
      logger.error('自动更新启动失败', error as Error)
      this.updating = false
    }
  }

  /**
   * 停止服务器
   */
  public stop(): void {
    if (this.server) {
      this.server.close()
      logger.info('Webhook 服务器已停止')
    }
  }
}

