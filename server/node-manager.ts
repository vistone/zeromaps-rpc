/**
 * 节点管理器
 * 提供节点的增删改查、状态监控、配置管理等功能
 */

import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import { EventEmitter } from 'events'
import { createLogger } from './logger.js'
import { getConfig } from './config-manager.js'

const logger = createLogger('NodeManager')

export interface NodeInfo {
  id: string
  name: string
  domain: string
  ipv4: string
  ipv6Prefix?: string
  webhookUrl: string
  status: 'online' | 'offline' | 'unknown'
  lastCheck: number
  enabled: boolean
  location?: string
  description?: string
  config?: {
    rpcPort: number
    monitorPort: number
    webhookPort: number
    utlsPort: number
  }
}

export interface NodeHealth {
  nodeId: string
  timestamp: number
  status: 'healthy' | 'degraded' | 'unhealthy' | 'offline'
  responseTime: number
  services: {
    rpc: boolean
    monitor: boolean
    webhook: boolean
    utls: boolean
  }
  metrics?: {
    cpu?: number
    memory?: number
    requests?: number
    errors?: number
  }
}

export class NodeManager extends EventEmitter {
  private nodes = new Map<string, NodeInfo>()
  private healthChecks = new Map<string, NodeHealth>()
  private healthCheckInterval: NodeJS.Timeout | null = null
  private configPath: string
  private nodesConfigPath: string
  private vpsConfigsPath: string

  constructor() {
    super()
    
    const configDir = path.join(process.cwd(), 'config')
    this.configPath = configDir
    this.nodesConfigPath = path.join(configDir, 'nodes.json')
    this.vpsConfigsPath = path.join(process.cwd(), 'configs')
    
    this.loadNodes()
    this.startHealthCheck()
  }

  /**
   * 加载所有节点配置
   */
  private loadNodes(): void {
    try {
      // 加载 nodes.json（webhook 转发配置）
      if (fs.existsSync(this.nodesConfigPath)) {
        const nodesData = JSON.parse(fs.readFileSync(this.nodesConfigPath, 'utf-8'))
        const nodes = nodesData.nodes || []
        
        for (const node of nodes) {
          const nodeInfo: NodeInfo = {
            id: node.name,
            name: node.name,
            domain: node.domain,
            ipv4: '', // 从 VPS 配置中获取
            webhookUrl: node.webhookUrl,
            status: 'unknown',
            lastCheck: 0,
            enabled: true,
            config: {
              rpcPort: 9527,
              monitorPort: 9528,
              webhookPort: 9530,
              utlsPort: 8765
            }
          }
          
          // 尝试从 VPS 配置中获取更多信息
          this.loadVPSConfig(nodeInfo)
          
          this.nodes.set(nodeInfo.id, nodeInfo)
        }
        
        logger.info('加载节点配置', { count: this.nodes.size })
      }
      
      // 加载 VPS 配置文件（物理配置）
      this.loadVPSConfigs()
      
    } catch (error) {
      logger.error('加载节点配置失败', error as Error)
    }
  }

  /**
   * 加载 VPS 配置文件
   */
  private loadVPSConfigs(): void {
    try {
      if (!fs.existsSync(this.vpsConfigsPath)) {
        return
      }
      
      const files = fs.readdirSync(this.vpsConfigsPath)
        .filter(file => file.startsWith('vps-') && file.endsWith('.conf'))
      
      for (const file of files) {
        const filePath = path.join(this.vpsConfigsPath, file)
        const content = fs.readFileSync(filePath, 'utf-8')
        
        // 解析配置文件
        const config = this.parseVPSConfig(content)
        if (config) {
          // 查找对应的节点
          for (const [nodeId, node] of this.nodes) {
            if (node.name === config.SERVER_NAME) {
              node.ipv4 = config.LOCAL_IP
              node.ipv6Prefix = config.IPV6_PREFIX
              node.location = config.SERVER_LOCATION
              node.config = {
                rpcPort: config.RPC_PORT || 9527,
                monitorPort: config.MONITOR_PORT || 9528,
                webhookPort: 9530,
                utlsPort: 8765
              }
              break
            }
          }
        }
      }
      
    } catch (error) {
      logger.error('加载 VPS 配置失败', error as Error)
    }
  }

  /**
   * 解析 VPS 配置文件
   */
  private parseVPSConfig(content: string): any {
    const config: any = {}
    const lines = content.split('\n')
    
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, value] = trimmed.split('=', 2)
        if (key && value) {
          config[key.trim()] = value.trim().replace(/^["']|["']$/g, '')
        }
      }
    }
    
    return Object.keys(config).length > 0 ? config : null
  }

  /**
   * 为节点加载 VPS 配置
   */
  private loadVPSConfig(nodeInfo: NodeInfo): void {
    try {
      // 尝试从域名解析 IP
      if (!nodeInfo.ipv4) {
        // 这里可以添加 DNS 解析逻辑
        nodeInfo.ipv4 = 'unknown'
      }
    } catch (error) {
      logger.debug('加载 VPS 配置失败', { nodeId: nodeInfo.id, error })
    }
  }

  /**
   * 启动健康检查
   */
  private startHealthCheck(): void {
    // 立即执行一次
    this.performHealthCheck()
    
    // 每30秒检查一次
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck()
    }, 30000)
    
    logger.info('节点健康检查已启动', { interval: '30s' })
  }

  /**
   * 执行健康检查
   */
  private async performHealthCheck(): Promise<void> {
    const promises = Array.from(this.nodes.values()).map(node => 
      this.checkNodeHealth(node)
    )
    
    await Promise.allSettled(promises)
  }

  /**
   * 检查单个节点健康状态
   */
  private async checkNodeHealth(node: NodeInfo): Promise<void> {
    const startTime = Date.now()
    
    try {
      // 检查监控端口
      const healthUrl = `http://${node.domain}:${node.config?.monitorPort || 9528}/api/health`
      const response = await this.httpRequest(healthUrl, 5000)
      
      const responseTime = Date.now() - startTime
      
      if (response.statusCode === 200) {
        const healthData = JSON.parse(response.body.toString())
        
        const health: NodeHealth = {
          nodeId: node.id,
          timestamp: Date.now(),
          status: 'healthy',
          responseTime,
          services: {
            rpc: true,
            monitor: true,
            webhook: true,
            utls: true
          },
          metrics: {
            cpu: healthData.system?.cpu?.usage,
            memory: healthData.system?.memory?.usage,
            requests: healthData.totalRequests,
            errors: healthData.failedRequests
          }
        }
        
        // 更新节点状态
        node.status = 'online'
        node.lastCheck = Date.now()
        
        this.healthChecks.set(node.id, health)
        
        logger.debug('节点健康检查成功', {
          nodeId: node.id,
          responseTime,
          status: health.status
        })
        
      } else {
        throw new Error(`HTTP ${response.statusCode}`)
      }
      
    } catch (error) {
      // 节点离线或异常
      node.status = 'offline'
      node.lastCheck = Date.now()
      
      const health: NodeHealth = {
        nodeId: node.id,
        timestamp: Date.now(),
        status: 'offline',
        responseTime: Date.now() - startTime,
        services: {
          rpc: false,
          monitor: false,
          webhook: false,
          utls: false
        }
      }
      
      this.healthChecks.set(node.id, health)
      
      logger.debug('节点健康检查失败', {
        nodeId: node.id,
        error: (error as Error).message
      })
    }
  }

  /**
   * HTTP 请求工具
   */
  private async httpRequest(url: string, timeout: number): Promise<{ statusCode: number, body: Buffer }> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url)
      const isHttps = parsedUrl.protocol === 'https:'
      const client = isHttps ? https : http
      
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        timeout,
        headers: {
          'User-Agent': 'ZeroMaps-NodeManager/1.0'
        }
      }
      
      const req = client.request(options, (res) => {
        const chunks: Buffer[] = []
        
        res.on('data', (chunk) => {
          chunks.push(chunk)
        })
        
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks)
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
   * 获取所有节点
   */
  public getAllNodes(): NodeInfo[] {
    return Array.from(this.nodes.values())
  }

  /**
   * 获取节点详情
   */
  public getNode(nodeId: string): NodeInfo | null {
    return this.nodes.get(nodeId) || null
  }

  /**
   * 获取节点健康状态
   */
  public getNodeHealth(nodeId: string): NodeHealth | null {
    return this.healthChecks.get(nodeId) || null
  }

  /**
   * 获取所有节点健康状态
   */
  public getAllNodeHealth(): NodeHealth[] {
    return Array.from(this.healthChecks.values())
  }

  /**
   * 添加新节点
   */
  public async addNode(nodeData: Partial<NodeInfo>): Promise<NodeInfo> {
    const nodeId = nodeData.id || nodeData.name || `node-${Date.now()}`
    
    const node: NodeInfo = {
      id: nodeId,
      name: nodeData.name || nodeId,
      domain: nodeData.domain || '',
      ipv4: nodeData.ipv4 || '',
      ipv6Prefix: nodeData.ipv6Prefix,
      webhookUrl: nodeData.webhookUrl || `https://${nodeData.domain}/webhook`,
      status: 'unknown',
      lastCheck: 0,
      enabled: nodeData.enabled !== false,
      location: nodeData.location,
      description: nodeData.description,
      config: nodeData.config || {
        rpcPort: 9527,
        monitorPort: 9528,
        webhookPort: 9530,
        utlsPort: 8765
      }
    }
    
    this.nodes.set(nodeId, node)
    
    // 保存到配置文件
    await this.saveNodesConfig()
    
    logger.info('添加新节点', { nodeId, domain: node.domain })
    
    this.emit('nodeAdded', node)
    
    return node
  }

  /**
   * 更新节点
   */
  public async updateNode(nodeId: string, updates: Partial<NodeInfo>): Promise<NodeInfo | null> {
    const node = this.nodes.get(nodeId)
    if (!node) {
      return null
    }
    
    // 更新节点信息
    Object.assign(node, updates)
    
    // 保存到配置文件
    await this.saveNodesConfig()
    
    logger.info('更新节点', { nodeId, updates })
    
    this.emit('nodeUpdated', node)
    
    return node
  }

  /**
   * 删除节点
   */
  public async removeNode(nodeId: string): Promise<boolean> {
    const node = this.nodes.get(nodeId)
    if (!node) {
      return false
    }
    
    this.nodes.delete(nodeId)
    this.healthChecks.delete(nodeId)
    
    // 保存到配置文件
    await this.saveNodesConfig()
    
    logger.info('删除节点', { nodeId, domain: node.domain })
    
    this.emit('nodeRemoved', node)
    
    return true
  }

  /**
   * 启用/禁用节点
   */
  public async toggleNode(nodeId: string, enabled: boolean): Promise<boolean> {
    const node = this.nodes.get(nodeId)
    if (!node) {
      return false
    }
    
    node.enabled = enabled
    
    // 保存到配置文件
    await this.saveNodesConfig()
    
    logger.info('切换节点状态', { nodeId, enabled })
    
    this.emit('nodeToggled', node)
    
    return true
  }

  /**
   * 保存节点配置到文件
   */
  private async saveNodesConfig(): Promise<void> {
    try {
      const nodesData = {
        nodes: Array.from(this.nodes.values()).map(node => ({
          name: node.name,
          domain: node.domain,
          webhookUrl: node.webhookUrl,
          enabled: node.enabled,
          location: node.location,
          description: node.description
        }))
      }
      
      fs.writeFileSync(this.nodesConfigPath, JSON.stringify(nodesData, null, 2))
      
      logger.debug('节点配置已保存', { path: this.nodesConfigPath })
      
    } catch (error) {
      logger.error('保存节点配置失败', error as Error)
      throw error
    }
  }

  /**
   * 获取统计信息
   */
  public getStats(): any {
    const totalNodes = this.nodes.size
    const onlineNodes = Array.from(this.nodes.values()).filter(n => n.status === 'online').length
    const offlineNodes = Array.from(this.nodes.values()).filter(n => n.status === 'offline').length
    const enabledNodes = Array.from(this.nodes.values()).filter(n => n.enabled).length
    
    return {
      total: totalNodes,
      online: onlineNodes,
      offline: offlineNodes,
      enabled: enabledNodes,
      disabled: totalNodes - enabledNodes,
      lastCheck: Math.max(...Array.from(this.nodes.values()).map(n => n.lastCheck))
    }
  }

  /**
   * 停止节点管理器
   */
  public stop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }
    
    logger.info('节点管理器已停止')
  }
}
