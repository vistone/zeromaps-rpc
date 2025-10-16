/**
 * GitHub Webhook 服务器
 * 监听 GitHub push 事件，自动触发更新
 */

import * as http from 'http'
import * as https from 'https'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from './logger.js'
import { getConfig } from './config-manager.js'

const logger = createLogger('WebhookServer')

interface NodeInfo {
  name: string
  domain: string
  webhookUrl: string
}

export class WebhookServer {
  private server: http.Server | null = null
  private secret: string
  private updateScript: string
  private updating = false
  private allNodes: NodeInfo[] = []

  constructor(
    private port: number,
    secret?: string,
    updateScript?: string
  ) {
    // 获取配置实例（延迟初始化）
    const config = getConfig()

    // 从配置获取 Webhook 参数
    this.secret = secret || config.get<string>('server.webhook.secret')
    this.updateScript = updateScript || config.get<string>('server.webhook.updateScript')

    // 加载所有节点列表（用于转发）
    this.loadNodes()
  }

  /**
   * 加载所有节点列表
   */
  private loadNodes(): void {
    try {
      const nodesPath = path.join(process.cwd(), 'config', 'nodes.json')
      if (fs.existsSync(nodesPath)) {
        const nodesData = JSON.parse(fs.readFileSync(nodesPath, 'utf-8'))
        this.allNodes = nodesData.nodes || []
        logger.info('加载节点列表', { count: this.allNodes.length })
      } else {
        logger.warn('节点列表文件不存在，不会转发到其他节点', { path: nodesPath })
      }
    } catch (error) {
      logger.error('加载节点列表失败', error as Error)
    }
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
      // 检查是否是转发的请求（防止无限循环）
      const isForwarded = req.headers['user-agent'] === 'ZeroMaps-Webhook-Forwarder'
      await this.handleWebhook(req, res, isForwarded)
      return
    }

    res.writeHead(404)
    res.end('Not Found')
  }

  /**
   * 处理 GitHub Webhook
   * @param isForwarded 是否是从其他节点转发来的（防止循环）
   */
  private async handleWebhook(req: http.IncomingMessage, res: http.ServerResponse, isForwarded: boolean = false): Promise<void> {
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

      // 关键：转发到其他所有节点（异步并发）
      // 防止循环：只有直接从 GitHub 来的请求才转发
      if (!isForwarded && this.allNodes.length > 0) {
        logger.info('转发 webhook 到其他节点', { count: this.allNodes.length })
        this.forwardToOtherNodes(body, req.headers).catch(err => {
          logger.error('转发 webhook 失败', err)
        })
      } else if (isForwarded) {
        logger.debug('收到转发的 webhook，不再继续转发（防止循环）')
      }

    } catch (error) {
      logger.error('处理 Webhook 失败', error as Error)
      res.writeHead(500)
      res.end('Internal Error')
    }
  }

  /**
   * 转发 webhook 到其他所有节点
   */
  private async forwardToOtherNodes(body: Buffer, headers: http.IncomingHttpHeaders): Promise<void> {
    // 获取当前节点域名（优先从配置，其次环境变量）
    const config = getConfig()
    const currentDomain = config.get<string>('server.domain') || process.env.SERVER_DOMAIN || ''

    // 过滤出其他节点（排除当前节点）
    const otherNodes = this.allNodes.filter(node =>
      node.domain !== currentDomain && node.webhookUrl
    )

    if (otherNodes.length === 0) {
      logger.debug('没有其他节点需要转发')
      return
    }

    logger.info('开始转发到其他节点', {
      currentNode: currentDomain,
      targetCount: otherNodes.length
    })

    // 并发转发到所有节点
    const forwardPromises = otherNodes.map(node =>
      this.forwardToNode(node, body, headers)
    )

    const results = await Promise.allSettled(forwardPromises)

    // 统计结果
    const succeeded = results.filter(r => r.status === 'fulfilled').length
    const failed = results.filter(r => r.status === 'rejected').length

    logger.info('转发完成', {
      total: otherNodes.length,
      succeeded,
      failed
    })

    // 记录失败的节点
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.warn('转发失败', {
          node: otherNodes[index].name,
          url: otherNodes[index].webhookUrl,
          error: result.reason
        })
      }
    })
  }

  /**
   * 转发到单个节点
   */
  private async forwardToNode(node: NodeInfo, body: Buffer, headers: http.IncomingHttpHeaders): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(node.webhookUrl)

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'X-GitHub-Event': headers['x-github-event'] || 'push',
          'X-Hub-Signature-256': headers['x-hub-signature-256'] || '',
          'User-Agent': 'ZeroMaps-Webhook-Forwarder'
        },
        timeout: 10000,
        rejectUnauthorized: false  // 允许自签名证书
      }

      const req = https.request(options, (res) => {
        let responseData = ''
        res.on('data', (chunk) => {
          responseData += chunk
        })
        res.on('end', () => {
          if (res.statusCode === 200) {
            logger.debug('转发成功', {
              node: node.name,
              statusCode: res.statusCode
            })
            resolve()
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${responseData}`))
          }
        })
      })

      req.on('error', (error) => {
        reject(error)
      })

      req.on('timeout', () => {
        req.destroy()
        reject(new Error('转发超时'))
      })

      req.write(body)
      req.end()
    })
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

