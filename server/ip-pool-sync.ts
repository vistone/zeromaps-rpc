/**
 * 去中心化IP池同步管理器
 * 实现节点间IP池数据的P2P同步和优化
 */

import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import { EventEmitter } from 'events'
import { createLogger } from './logger.js'
import { getConfig } from './config-manager.js'

const logger = createLogger('IPPoolSync')

export interface IPPoolData {
  version: string
  lastUpdate: string
  domains: {
    [domain: string]: {
      preferIPv6: boolean
      ipv4: string[]
      ipv6: string[]
      blacklist: string[]
      health: {
        [ip: string]: {
          totalRequests: number
          successCount: number
          failureCount: number
          avgResponseTime: number
          lastSuccess: string
          lastFailure: string
          source: string
          score: number
        }
      }
    }
  }
  metadata: {
    nodeId: string
    nodeDomain: string
    syncCount: number
    lastSync: string
  }
}

export interface SyncRequest {
  type: 'full' | 'incremental'
  nodeId: string
  timestamp: number
  data?: IPPoolData
  changes?: {
    [domain: string]: {
      added?: string[]
      removed?: string[]
      updated?: { [ip: string]: any }
    }
  }
}

export interface SyncResponse {
  success: boolean
  message?: string
  data?: IPPoolData
  conflicts?: {
    [domain: string]: {
      [ip: string]: {
        local: any
        remote: any
        resolution: 'local' | 'remote' | 'merge'
      }
    }
  }
}

export class IPPoolSyncManager extends EventEmitter {
  private ipPoolFile: string
  private currentNodeId: string
  private currentNodeDomain: string
  private syncInterval: NodeJS.Timeout | null = null
  private knownNodes: Map<string, { domain: string, lastSync: number, successCount: number }> = new Map()
  private localData: IPPoolData | null = null
  private syncInProgress = false
  private readonly syncIntervalMs = 5 * 60 * 1000 // 5分钟同步一次
  private readonly maxRetries = 3
  private readonly syncTimeout = 10000 // 10秒超时

  constructor() {
    super()
    
    this.ipPoolFile = path.join(process.cwd(), 'utls-proxy', 'ip-pools.json')
    this.currentNodeId = this.getNodeId()
    this.currentNodeDomain = this.getNodeDomain()
    
    this.loadLocalData()
    this.startPeriodicSync()
    
    logger.info('IP池同步管理器已启动', {
      nodeId: this.currentNodeId,
      domain: this.currentNodeDomain,
      ipPoolFile: this.ipPoolFile
    })
  }

  /**
   * 获取当前节点ID
   */
  private getNodeId(): string {
    const config = getConfig()
    return config.get<string>('server.nodeId') || process.env.NODE_ID || 'unknown'
  }

  /**
   * 获取当前节点域名
   */
  private getNodeDomain(): string {
    const config = getConfig()
    return config.get<string>('server.domain') || process.env.SERVER_DOMAIN || 'localhost'
  }

  /**
   * 加载本地IP池数据
   */
  private loadLocalData(): void {
    try {
      if (fs.existsSync(this.ipPoolFile)) {
        const content = fs.readFileSync(this.ipPoolFile, 'utf-8')
        const data = JSON.parse(content)
        
        // 确保数据结构完整
        this.localData = this.normalizeData(data)
        
        logger.info('本地IP池数据已加载', {
          domains: Object.keys(this.localData.domains).length,
          totalIPs: this.getTotalIPCount()
        })
      } else {
        // 创建初始数据结构
        this.localData = this.createInitialData()
        this.saveLocalData()
        
        logger.info('创建初始IP池数据')
      }
    } catch (error) {
      logger.error('加载本地IP池数据失败', error as Error)
      this.localData = this.createInitialData()
    }
  }

  /**
   * 标准化数据结构
   */
  private normalizeData(data: any): IPPoolData {
    return {
      version: data.version || '1.0.0',
      lastUpdate: data.lastUpdate || new Date().toISOString(),
      domains: data.domains || {},
      metadata: {
        nodeId: this.currentNodeId,
        nodeDomain: this.currentNodeDomain,
        syncCount: data.metadata?.syncCount || 0,
        lastSync: data.metadata?.lastSync || new Date().toISOString()
      }
    }
  }

  /**
   * 创建初始数据结构
   */
  private createInitialData(): IPPoolData {
    return {
      version: '1.0.0',
      lastUpdate: new Date().toISOString(),
      domains: {
        'kh.google.com': {
          preferIPv6: true,
          ipv4: [],
          ipv6: [],
          blacklist: [],
          health: {}
        },
        'earth.google.com': {
          preferIPv6: false,
          ipv4: [],
          ipv6: [],
          blacklist: [],
          health: {}
        }
      },
      metadata: {
        nodeId: this.currentNodeId,
        nodeDomain: this.currentNodeDomain,
        syncCount: 0,
        lastSync: new Date().toISOString()
      }
    }
  }

  /**
   * 保存本地数据
   */
  private saveLocalData(): void {
    try {
      if (!this.localData) return
      
      // 更新元数据
      this.localData.lastUpdate = new Date().toISOString()
      this.localData.metadata.lastSync = new Date().toISOString()
      
      // 确保目录存在
      const dir = path.dirname(this.ipPoolFile)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      
      fs.writeFileSync(this.ipPoolFile, JSON.stringify(this.localData, null, 2))
      
      logger.debug('本地IP池数据已保存', {
        domains: Object.keys(this.localData.domains).length,
        totalIPs: this.getTotalIPCount()
      })
      
      this.emit('dataUpdated', this.localData)
      
    } catch (error) {
      logger.error('保存本地IP池数据失败', error as Error)
    }
  }

  /**
   * 获取总IP数量
   */
  private getTotalIPCount(): number {
    if (!this.localData) return 0
    
    let total = 0
    for (const domain of Object.values(this.localData.domains)) {
      total += domain.ipv4.length + domain.ipv6.length
    }
    return total
  }

  /**
   * 启动定期同步
   */
  private startPeriodicSync(): void {
    this.syncInterval = setInterval(() => {
      this.performSync().catch(err => {
        logger.error('定期同步失败', err)
      })
    }, this.syncIntervalMs)
    
    logger.info('定期同步已启动', { interval: this.syncIntervalMs / 1000 + 's' })
  }

  /**
   * 执行同步
   */
  public async performSync(): Promise<void> {
    if (this.syncInProgress) {
      logger.debug('同步已在进行中，跳过')
      return
    }
    
    this.syncInProgress = true
    
    try {
      logger.info('开始IP池同步')
      
      // 1. 从节点管理器获取所有节点
      const nodes = await this.getKnownNodes()
      
      if (nodes.length === 0) {
        logger.debug('没有已知节点，跳过同步')
        return
      }
      
      // 2. 并发同步到所有节点
      const syncPromises = nodes.map(node => this.syncWithNode(node))
      const results = await Promise.allSettled(syncPromises)
      
      // 3. 统计结果
      const succeeded = results.filter(r => r.status === 'fulfilled').length
      const failed = results.filter(r => r.status === 'rejected').length
      
      logger.info('IP池同步完成', {
        total: nodes.length,
        succeeded,
        failed
      })
      
      // 4. 更新同步计数
      if (this.localData) {
        this.localData.metadata.syncCount++
        this.saveLocalData()
      }
      
    } catch (error) {
      logger.error('IP池同步失败', error as Error)
    } finally {
      this.syncInProgress = false
    }
  }

  /**
   * 获取已知节点列表
   */
  private async getKnownNodes(): Promise<Array<{ id: string, domain: string }>> {
    // 这里可以从节点管理器获取，暂时使用硬编码的节点列表
    const config = getConfig()
    const nodesConfig = config.get<any>('nodes') || []
    
    return nodesConfig.map((node: any) => ({
      id: node.name,
      domain: node.domain
    })).filter((node: any) => node.domain !== this.currentNodeDomain)
  }

  /**
   * 与单个节点同步
   */
  private async syncWithNode(node: { id: string, domain: string }): Promise<void> {
    try {
      logger.debug('开始与节点同步', { nodeId: node.id, domain: node.domain })
      
      // 1. 发送同步请求
      const syncRequest: SyncRequest = {
        type: 'full',
        nodeId: this.currentNodeId,
        timestamp: Date.now(),
        data: this.localData || undefined
      }
      
      const response = await this.sendSyncRequest(node.domain, syncRequest)
      
      if (response.success && response.data) {
        // 2. 合并数据
        const mergedData = this.mergeData(this.localData!, response.data)
        
        // 3. 解决冲突
        if (response.conflicts) {
          this.resolveConflicts(mergedData, response.conflicts)
        }
        
        // 4. 更新本地数据
        this.localData = mergedData
        this.saveLocalData()
        
        // 5. 更新节点状态
        this.knownNodes.set(node.id, {
          domain: node.domain,
          lastSync: Date.now(),
          successCount: (this.knownNodes.get(node.id)?.successCount || 0) + 1
        })
        
        logger.info('节点同步成功', {
          nodeId: node.id,
          domain: node.domain,
          mergedIPs: this.getTotalIPCount()
        })
        
      } else {
        throw new Error(response.message || '同步失败')
      }
      
    } catch (error) {
      logger.warn('节点同步失败', {
        nodeId: node.id,
        domain: node.domain,
        error: (error as Error).message
      })
      
      // 更新失败计数
      const nodeInfo = this.knownNodes.get(node.id)
      if (nodeInfo) {
        nodeInfo.successCount = Math.max(0, nodeInfo.successCount - 1)
      }
    }
  }

  /**
   * 发送同步请求
   */
  private async sendSyncRequest(domain: string, request: SyncRequest): Promise<SyncResponse> {
    return new Promise((resolve, reject) => {
      const url = `https://${domain}:9528/api/ip-pool/sync`
      
      const options: https.RequestOptions = {
        hostname: domain,
        port: 443,
        path: '/api/ip-pool/sync',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'ZeroMaps-IPPoolSync/1.0'
        },
        timeout: this.syncTimeout,
        rejectUnauthorized: false
      }
      
      const req = https.request(options, (res) => {
        let data = ''
        
        res.on('data', (chunk) => {
          data += chunk
        })
        
        res.on('end', () => {
          try {
            const response = JSON.parse(data)
            resolve(response)
          } catch (error) {
            reject(new Error('解析响应失败'))
          }
        })
      })
      
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('请求超时'))
      })
      
      req.write(JSON.stringify(request))
      req.end()
    })
  }

  /**
   * 合并IP池数据
   */
  private mergeData(local: IPPoolData, remote: IPPoolData): IPPoolData {
    const merged = JSON.parse(JSON.stringify(local)) // 深拷贝
    
    for (const [domain, remoteDomainData] of Object.entries(remote.domains)) {
      if (!merged.domains[domain]) {
        merged.domains[domain] = {
          preferIPv6: remoteDomainData.preferIPv6,
          ipv4: [],
          ipv6: [],
          blacklist: [],
          health: {}
        }
      }
      
      const localDomainData = merged.domains[domain]
      
      // 合并IPv4
      const mergedIPv4 = this.mergeIPList(localDomainData.ipv4, remoteDomainData.ipv4, localDomainData.health, remoteDomainData.health)
      
      // 合并IPv6
      const mergedIPv6 = this.mergeIPList(localDomainData.ipv6, remoteDomainData.ipv6, localDomainData.health, remoteDomainData.health)
      
      // 合并黑名单
      const mergedBlacklist = [...new Set([...localDomainData.blacklist, ...remoteDomainData.blacklist])]
      
      // 合并健康数据
      const mergedHealth = this.mergeHealthData(localDomainData.health, remoteDomainData.health)
      
      merged.domains[domain] = {
        preferIPv6: remoteDomainData.preferIPv6, // 使用远程偏好设置
        ipv4: mergedIPv4,
        ipv6: mergedIPv6,
        blacklist: mergedBlacklist,
        health: mergedHealth
      }
    }
    
    return merged
  }

  /**
   * 合并IP列表
   */
  private mergeIPList(local: string[], remote: string[], localHealth: any, remoteHealth: any): string[] {
    const allIPs = [...new Set([...local, ...remote])]
    
    // 按健康分数排序
    return allIPs.sort((a, b) => {
      const scoreA = this.calculateIPScore(a, localHealth[a], remoteHealth[a])
      const scoreB = this.calculateIPScore(b, localHealth[b], remoteHealth[b])
      return scoreB - scoreA // 降序排列
    })
  }

  /**
   * 计算IP健康分数
   */
  private calculateIPScore(ip: string, localHealth?: any, remoteHealth?: any): number {
    let totalRequests = 0
    let successCount = 0
    let avgResponseTime = 1000
    
    if (localHealth) {
      totalRequests += localHealth.totalRequests || 0
      successCount += localHealth.successCount || 0
      avgResponseTime = Math.min(avgResponseTime, localHealth.avgResponseTime || 1000)
    }
    
    if (remoteHealth) {
      totalRequests += remoteHealth.totalRequests || 0
      successCount += remoteHealth.successCount || 0
      avgResponseTime = Math.min(avgResponseTime, remoteHealth.avgResponseTime || 1000)
    }
    
    if (totalRequests === 0) return 0
    
    const successRate = successCount / totalRequests
    const responseScore = Math.max(0, 1 - (avgResponseTime / 2000)) // 2秒为基准
    
    return successRate * 0.7 + responseScore * 0.3
  }

  /**
   * 合并健康数据
   */
  private mergeHealthData(local: any, remote: any): any {
    const merged: any = {}
    
    // 合并所有IP的健康数据
    const allIPs = [...new Set([...Object.keys(local), ...Object.keys(remote)])]
    
    for (const ip of allIPs) {
      const localHealth = local[ip]
      const remoteHealth = remote[ip]
      
      if (localHealth && remoteHealth) {
        // 合并数据
        merged[ip] = {
          totalRequests: (localHealth.totalRequests || 0) + (remoteHealth.totalRequests || 0),
          successCount: (localHealth.successCount || 0) + (remoteHealth.successCount || 0),
          failureCount: (localHealth.failureCount || 0) + (remoteHealth.failureCount || 0),
          avgResponseTime: Math.min(localHealth.avgResponseTime || 1000, remoteHealth.avgResponseTime || 1000),
          lastSuccess: this.getLatestTime(localHealth.lastSuccess, remoteHealth.lastSuccess),
          lastFailure: this.getLatestTime(localHealth.lastFailure, remoteHealth.lastFailure),
          source: 'merged',
          score: this.calculateIPScore(ip, localHealth, remoteHealth)
        }
      } else if (localHealth) {
        merged[ip] = { ...localHealth }
      } else if (remoteHealth) {
        merged[ip] = { ...remoteHealth }
      }
    }
    
    return merged
  }

  /**
   * 获取最新时间
   */
  private getLatestTime(time1?: string, time2?: string): string {
    if (!time1) return time2 || new Date().toISOString()
    if (!time2) return time1
    return new Date(time1) > new Date(time2) ? time1 : time2
  }

  /**
   * 解决冲突
   */
  private resolveConflicts(data: IPPoolData, conflicts: any): void {
    // 简单的冲突解决策略：选择成功率更高的数据
    for (const [domain, domainConflicts] of Object.entries(conflicts)) {
      for (const [ip, conflict] of Object.entries(domainConflicts as any)) {
        const conflictData = conflict as any
        const localScore = this.calculateIPScore(ip, conflictData.local)
        const remoteScore = this.calculateIPScore(ip, conflictData.remote)
        
        if (remoteScore > localScore) {
          // 使用远程数据
          if (data.domains[domain]) {
            data.domains[domain].health[ip] = conflictData.remote
          }
        }
      }
    }
  }

  /**
   * 处理同步请求（API端点）
   */
  public async handleSyncRequest(request: SyncRequest): Promise<SyncResponse> {
    try {
      logger.info('收到IP池同步请求', {
        from: request.nodeId,
        type: request.type,
        timestamp: new Date(request.timestamp).toISOString()
      })
      
      if (request.type === 'full' && request.data) {
        // 全量同步
        const mergedData = this.mergeData(this.localData!, request.data)
        this.localData = mergedData
        this.saveLocalData()
        
        return {
          success: true,
          message: '同步成功',
          data: this.localData
        }
      }
      
        return {
          success: true,
          message: '同步请求已处理',
          data: this.localData || undefined
        }
      
    } catch (error) {
      logger.error('处理同步请求失败', error as Error)
      return {
        success: false,
        message: (error as Error).message
      }
    }
  }

  /**
   * 获取当前IP池数据
   */
  public getCurrentData(): IPPoolData | undefined {
    return this.localData || undefined
  }

  /**
   * 获取同步统计
   */
  public getSyncStats(): any {
    return {
      nodeId: this.currentNodeId,
      domain: this.currentNodeDomain,
      totalIPs: this.getTotalIPCount(),
      knownNodes: this.knownNodes.size,
      lastSync: this.localData?.metadata.lastSync,
      syncCount: this.localData?.metadata.syncCount || 0,
      syncInProgress: this.syncInProgress
    }
  }

  /**
   * 手动触发同步
   */
  public async triggerSync(): Promise<void> {
    await this.performSync()
  }

  /**
   * 停止同步管理器
   */
  public stop(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval)
      this.syncInterval = null
    }
    
    logger.info('IP池同步管理器已停止')
  }
}
