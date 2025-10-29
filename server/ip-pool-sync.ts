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
import { IPHealthChecker, IPHealthStatus, IPTestResult } from './ip-health-checker.js'

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
  private healthChecker: IPHealthChecker
  private readonly syncIntervalMs = 60 * 1000 // 60秒同步一次
  private readonly maxRetries = 3
  private readonly syncTimeout = 10000 // 10秒超时

  constructor() {
    super()
    
    try {
      this.ipPoolFile = path.join(process.cwd(), 'utls-proxy', 'ip-pools.json')
      this.currentNodeId = this.getNodeId()
      this.currentNodeDomain = this.getNodeDomain()
      
      logger.info('IPPoolSyncManager 初始化开始', {
        nodeId: this.currentNodeId,
        domain: this.currentNodeDomain,
        ipPoolFile: this.ipPoolFile
      })
      
      // 初始化健康检查器
      this.healthChecker = new IPHealthChecker({
        testUrl: '/rt/earth/PlanetoidMetadata',
        testHeaders: {
          'Host': 'kh.google.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive'
        },
        timeout: 10000,
        retryCount: 2,
        blacklistThreshold: 3,
        whitelistThreshold: 2,
        testInterval: 5 * 60 * 1000, // 5分钟测试一次
        blacklistTestInterval: 10 * 60 * 1000 // 黑名单IP 10分钟测试一次
      })
      
      // 监听健康检查事件
      this.healthChecker.on('testResult', (event) => {
        this.handleHealthCheckResult(event)
        // 健康检查产生新结果后自动尝试同步（并发保护由 syncInProgress 保证）
        this.performSync().catch(() => {})
      })
      
      this.healthChecker.on('statusChanged', (event) => {
        this.handleIPStatusChange(event)
        // 状态变化后自动尝试同步
        this.performSync().catch(() => {})
      })
      
      this.loadLocalData()
      this.startPeriodicSync()
      // 启动后立即尝试一次同步
      this.performSync().catch(() => {})
      
      logger.info('IP池同步管理器已启动', {
        nodeId: this.currentNodeId,
        domain: this.currentNodeDomain,
        ipPoolFile: this.ipPoolFile
      })
    } catch (error) {
      logger.error('IPPoolSyncManager 初始化失败', error as Error)
      throw error
    }
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
      this.localData.metadata.nodeId = this.currentNodeId
      this.localData.metadata.nodeDomain = this.currentNodeDomain
      
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
  public startPeriodicSync(): void {
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
  public async performSync(): Promise<{
    targets: Array<{ id: string, domain: string }>
    results: Array<{ node: { id: string, domain: string }, ok: boolean, error?: string }>
    summary: { total: number, succeeded: number, failed: number }
  }> {
    if (this.syncInProgress) {
      logger.debug('同步已在进行中，跳过')
      return { targets: [], results: [], summary: { total: 0, succeeded: 0, failed: 0 } }
    }
    
    this.syncInProgress = true
    
    try {
      logger.info('开始IP池同步')
      
      // 1. 从节点管理器获取所有节点
      const nodes = await this.getKnownNodes()
      
      if (nodes.length === 0) {
        logger.debug('没有已知节点，跳过同步')
        return { targets: [], results: [], summary: { total: 0, succeeded: 0, failed: 0 } }
      }
      
      // 2. 并发同步到所有节点
      const syncPromises = nodes.map(async (node) => {
        try {
          await this.syncWithNode(node)
          return { node, ok: true as const }
        } catch (e) {
          return { node, ok: false as const, error: (e as Error).message }
        }
      })
      const results = await Promise.all(syncPromises)
      
      // 3. 统计结果
      const succeeded = results.filter(r => r.ok).length
      const failed = results.filter(r => !r.ok).length
      
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
      return {
        targets: nodes,
        results,
        summary: { total: nodes.length, succeeded, failed }
      }
    } catch (error) {
      logger.error('IP池同步失败', error as Error)
      return { targets: [], results: [], summary: { total: 0, succeeded: 0, failed: 0 } }
    } finally {
      this.syncInProgress = false
    }
  }

  /**
   * 获取已知节点列表
   */
  private async getKnownNodes(): Promise<Array<{ id: string, domain: string }>> {
    const config = getConfig()
    const nodes: Array<{ id: string, domain: string }> = []

    // 来源1：节点列表（如存在）
    const nodesConfig = config.get<any>('nodes') || []
    for (const node of nodesConfig) {
      if (node?.domain) {
        nodes.push({ id: node.name || node.domain, domain: node.domain })
      }
    }

    // 来源2：p2p.nodes 列表（字符串，如 tile12.zeromaps.cn:9528）
    const p2pList = (config.get<string[]>('p2p.nodes') || []).filter(Boolean)
    for (const entry of p2pList) {
      const host = String(entry).split(',')[0].trim()
      const domain = host.includes(':') ? host.split(':')[0] : host
      if (domain) {
        nodes.push({ id: domain, domain })
      }
    }

    // 去重并排除自身
    const unique = new Map<string, { id: string, domain: string }>()
    for (const n of nodes) {
      if (n.domain && n.domain !== this.currentNodeDomain) {
        unique.set(n.domain, n)
      }
    }
    return Array.from(unique.values())
  }

  /**
   * 与单个节点同步 - 双向对比分析，相互优化补缺
   */
  private async syncWithNode(node: { id: string, domain: string }): Promise<void> {
    try {
      logger.debug('开始与节点双向同步', { nodeId: node.id, domain: node.domain })
      
      // 1. 获取远程节点的IP池数据
      const remoteData = await this.fetchRemoteIPPool(node.domain)
      
      if (!remoteData) {
        throw new Error('无法获取远程节点数据')
      }
      
      // 2. 对比分析本地和远程数据
      const comparison = this.compareIPPools(this.localData!, remoteData)
      
      logger.info('IP池对比分析完成', {
        nodeId: node.id,
        domain: node.domain,
        localIPs: comparison.local.totalIPs,
        remoteIPs: comparison.remote.totalIPs,
        commonIPs: comparison.common.length,
        localOnly: comparison.localOnly.length,
        remoteOnly: comparison.remoteOnly.length,
        conflicts: comparison.conflicts.length
      })
      
      // 3. 智能合并策略
      const mergedData = this.intelligentMerge(this.localData!, remoteData, comparison)
      
      // 4. 更新本地数据
      this.localData = mergedData
      this.saveLocalData()
      
      // 5. 推送合并后的数据回远程节点（确保一致性）
      await this.pushMergedData(node.domain, mergedData)
      
      // 6. 更新节点状态
      this.knownNodes.set(node.id, {
        domain: node.domain,
        lastSync: Date.now(),
        successCount: (this.knownNodes.get(node.id)?.successCount || 0) + 1
      })
      
      logger.info('节点双向同步成功', {
        nodeId: node.id,
        domain: node.domain,
        finalIPs: this.getTotalIPCount(),
        addedIPs: comparison.remoteOnly.length,
        improvedIPs: comparison.conflicts.length
      })
      
    } catch (error) {
      logger.warn('节点双向同步失败', {
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
   * 获取远程节点的IP池数据
   */
  private async fetchRemoteIPPool(domain: string): Promise<IPPoolData | null> {
    try {
      const url = `https://${domain}:9528/api/ip-pool/data`
      
      const options: https.RequestOptions = {
        hostname: domain,
        port: 443,
        path: '/api/ip-pool/data',
        method: 'GET',
        headers: {
          'User-Agent': 'ZeroMaps-IPPoolSync/1.0',
          'Accept': 'application/json'
        },
        timeout: this.syncTimeout,
        rejectUnauthorized: false
      }
      
      return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
          let data = ''
          
          res.on('data', (chunk) => {
            data += chunk
          })
          
          res.on('end', () => {
            try {
              if (res.statusCode === 200) {
                const response = JSON.parse(data)
                resolve(response)
              } else {
                reject(new Error(`HTTP ${res.statusCode}`))
              }
            } catch (error) {
              reject(new Error('解析远程数据失败'))
            }
          })
        })
        
        req.on('error', reject)
        req.on('timeout', () => {
          req.destroy()
          reject(new Error('请求超时'))
        })
        
        req.end()
      })
      
    } catch (error) {
      logger.error('获取远程IP池数据失败', error as Error, { domain })
      return null
    }
  }

  /**
   * 对比分析两个IP池
   */
  private compareIPPools(local: IPPoolData, remote: IPPoolData): {
    local: { totalIPs: number, domains: string[] },
    remote: { totalIPs: number, domains: string[] },
    common: Array<{ domain: string, ip: string, type: 'ipv4' | 'ipv6' }>,
    localOnly: Array<{ domain: string, ip: string, type: 'ipv4' | 'ipv6' }>,
    remoteOnly: Array<{ domain: string, ip: string, type: 'ipv4' | 'ipv6' }>,
    conflicts: Array<{ domain: string, ip: string, localHealth: any, remoteHealth: any }>
  } {
    const localIPs = this.extractAllIPs(local)
    const remoteIPs = this.extractAllIPs(remote)
    
    const localSet = new Set(localIPs.map(ip => `${ip.domain}:${ip.ip}`))
    const remoteSet = new Set(remoteIPs.map(ip => `${ip.domain}:${ip.ip}`))
    
    const common: Array<{ domain: string, ip: string, type: 'ipv4' | 'ipv6' }> = []
    const localOnly: Array<{ domain: string, ip: string, type: 'ipv4' | 'ipv6' }> = []
    const remoteOnly: Array<{ domain: string, ip: string, type: 'ipv4' | 'ipv6' }> = []
    const conflicts: Array<{ domain: string, ip: string, localHealth: any, remoteHealth: any }> = []
    
    // 分析共同IP和冲突
    for (const localIP of localIPs) {
      const key = `${localIP.domain}:${localIP.ip}`
      if (remoteSet.has(key)) {
        common.push(localIP)
        
        // 检查健康数据冲突
        const localHealth = local.domains[localIP.domain]?.health?.[localIP.ip]
        const remoteHealth = remote.domains[localIP.domain]?.health?.[localIP.ip]
        
        if (localHealth && remoteHealth && this.hasHealthConflict(localHealth, remoteHealth)) {
          conflicts.push({
            domain: localIP.domain,
            ip: localIP.ip,
            localHealth,
            remoteHealth
          })
        }
      } else {
        localOnly.push(localIP)
      }
    }
    
    // 分析远程独有IP
    for (const remoteIP of remoteIPs) {
      const key = `${remoteIP.domain}:${remoteIP.ip}`
      if (!localSet.has(key)) {
        remoteOnly.push(remoteIP)
      }
    }
    
    return {
      local: { 
        totalIPs: localIPs.length, 
        domains: Object.keys(local.domains) 
      },
      remote: { 
        totalIPs: remoteIPs.length, 
        domains: Object.keys(remote.domains) 
      },
      common,
      localOnly,
      remoteOnly,
      conflicts
    }
  }

  /**
   * 提取所有IP地址
   */
  private extractAllIPs(data: IPPoolData): Array<{ domain: string, ip: string, type: 'ipv4' | 'ipv6' }> {
    const ips: Array<{ domain: string, ip: string, type: 'ipv4' | 'ipv6' }> = []
    
    for (const [domain, domainData] of Object.entries(data.domains)) {
      for (const ip of domainData.ipv4) {
        ips.push({ domain, ip, type: 'ipv4' })
      }
      for (const ip of domainData.ipv6) {
        ips.push({ domain, ip, type: 'ipv6' })
      }
    }
    
    return ips
  }

  /**
   * 检查健康数据是否有冲突
   */
  private hasHealthConflict(local: any, remote: any): boolean {
    // 如果成功率差异超过20%，认为有冲突
    const localSuccessRate = local.totalRequests > 0 ? (local.successCount / local.totalRequests) : 0
    const remoteSuccessRate = remote.totalRequests > 0 ? (remote.successCount / remote.totalRequests) : 0
    
    return Math.abs(localSuccessRate - remoteSuccessRate) > 0.2
  }

  /**
   * 智能合并策略
   */
  private intelligentMerge(local: IPPoolData, remote: IPPoolData, comparison: any): IPPoolData {
    const merged = JSON.parse(JSON.stringify(local)) // 深拷贝本地数据
    
    // 1. 添加远程独有IP
    for (const remoteIP of comparison.remoteOnly) {
      const domain = remoteIP.domain
      if (!merged.domains[domain]) {
        merged.domains[domain] = {
          preferIPv6: remote.domains[domain]?.preferIPv6 || false,
          ipv4: [],
          ipv6: [],
          blacklist: [],
          health: {}
        }
      }
      
      const domainData = merged.domains[domain]
      if (remoteIP.type === 'ipv4' && !domainData.ipv4.includes(remoteIP.ip)) {
        domainData.ipv4.push(remoteIP.ip)
      } else if (remoteIP.type === 'ipv6' && !domainData.ipv6.includes(remoteIP.ip)) {
        domainData.ipv6.push(remoteIP.ip)
      }
      
      // 复制健康数据
      const remoteHealth = remote.domains[domain]?.health?.[remoteIP.ip]
      if (remoteHealth) {
        domainData.health[remoteIP.ip] = { ...remoteHealth, source: 'remote' }
      }
    }
    
    // 2. 解决冲突 - 选择更好的健康数据
    for (const conflict of comparison.conflicts) {
      const domain = conflict.domain
      const ip = conflict.ip
      const localHealth = conflict.localHealth
      const remoteHealth = conflict.remoteHealth
      
      const localSuccessRate = localHealth.totalRequests > 0 ? (localHealth.successCount / localHealth.totalRequests) : 0
      const remoteSuccessRate = remoteHealth.totalRequests > 0 ? (remoteHealth.successCount / remoteHealth.totalRequests) : 0
      
      // 选择成功率更高的数据
      if (remoteSuccessRate > localSuccessRate) {
        merged.domains[domain].health[ip] = { 
          ...remoteHealth, 
          source: 'remote-merged',
          mergedAt: new Date().toISOString()
        }
        logger.debug('采用远程健康数据', { domain, ip, remoteSuccessRate, localSuccessRate })
      } else {
        merged.domains[domain].health[ip].source = 'local-merged'
        merged.domains[domain].health[ip].mergedAt = new Date().toISOString()
        logger.debug('保持本地健康数据', { domain, ip, localSuccessRate, remoteSuccessRate })
      }
    }
    
    // 3. 合并黑名单
    for (const [domain, remoteDomainData] of Object.entries(remote.domains)) {
      if (merged.domains[domain] && remoteDomainData.blacklist) {
        const mergedBlacklist = [...new Set([...merged.domains[domain].blacklist, ...remoteDomainData.blacklist])]
        merged.domains[domain].blacklist = mergedBlacklist
      }
    }
    
    // 4. 更新元数据
    merged.metadata.lastSync = new Date().toISOString()
    merged.metadata.syncCount = (merged.metadata.syncCount || 0) + 1
    
    return merged
  }

  /**
   * 推送合并后的数据到远程节点
   */
  private async pushMergedData(domain: string, mergedData: IPPoolData): Promise<void> {
    try {
      const url = `https://${domain}:9528/api/ip-pool/sync`
      
      const syncRequest: SyncRequest = {
        type: 'full',
        nodeId: this.currentNodeId,
        timestamp: Date.now(),
        data: mergedData
      }
      
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
      
      return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
          let data = ''
          
          res.on('data', (chunk) => {
            data += chunk
          })
          
          res.on('end', () => {
            try {
              const response = JSON.parse(data)
              if (response.success) {
                logger.debug('成功推送合并数据到远程节点', { domain })
                resolve()
              } else {
                reject(new Error(response.message || '推送失败'))
              }
            } catch (error) {
              reject(new Error('解析推送响应失败'))
            }
          })
        })
        
        req.on('error', reject)
        req.on('timeout', () => {
          req.destroy()
          reject(new Error('推送请求超时'))
        })
        
        req.write(JSON.stringify(syncRequest))
        req.end()
      })
      
    } catch (error) {
      logger.warn('推送合并数据失败', { domain, error: (error as Error).message })
      // 不抛出错误，因为本地数据已经更新成功
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
      // 验证请求数据
      if (!request.nodeId) {
        return {
          success: false,
          message: 'Missing nodeId'
        }
      }
      
      if (!request.type || !['full', 'incremental'].includes(request.type)) {
        return {
          success: false,
          message: 'Invalid sync type. Must be "full" or "incremental"'
        }
      }
      
      // 处理时间戳
      let timestamp: Date
      if (request.timestamp) {
        try {
          timestamp = new Date(request.timestamp)
          if (isNaN(timestamp.getTime())) {
            return {
              success: false,
              message: 'Invalid timestamp format'
            }
          }
        } catch (error) {
          return {
            success: false,
            message: 'Invalid timestamp value'
          }
        }
      } else {
        timestamp = new Date()
      }
      
      logger.info('收到IP池同步请求', {
        from: request.nodeId,
        type: request.type,
        timestamp: timestamp.toISOString()
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
  public async triggerSync(): Promise<{
    targets: Array<{ id: string, domain: string }>
    results: Array<{ node: { id: string, domain: string }, ok: boolean, error?: string }>
    summary: { total: number, succeeded: number, failed: number }
  }> {
    return this.performSync()
  }

  /**
   * 处理健康检查结果
   */
  private handleHealthCheckResult(event: any): void {
    const { key, status, result, wasBlacklisted, statusChanged } = event
    // key 由 `${domain}:${ip}` 组成，IPv6 地址包含冒号，必须只在第一个冒号处分割
    const sepIndex = key.indexOf(':')
    const domain = sepIndex >= 0 ? key.slice(0, sepIndex) : key
    const ip = sepIndex >= 0 ? key.slice(sepIndex + 1) : ''
    
    logger.debug('处理健康检查结果', {
      ip,
      domain,
      success: result.success,
      statusCode: result.statusCode,
      responseTime: result.responseTime,
      status,
      statusChanged
    })
    
    // 更新本地数据
    if (this.localData && this.localData.domains[domain]) {
      const domainData = this.localData.domains[domain]
      
      // 更新健康数据
      if (!domainData.health[ip]) {
        domainData.health[ip] = {
          totalRequests: 0,
          successCount: 0,
          failureCount: 0,
          avgResponseTime: 0,
          lastSuccess: '',
          lastFailure: '',
          source: 'local',
          score: 0
        }
      }
      
      const health = domainData.health[ip]
      health.totalRequests++
      
      if (result.success) {
        health.successCount++
        health.lastSuccess = new Date().toISOString()
        health.avgResponseTime = health.avgResponseTime === 0 
          ? result.responseTime 
          : (health.avgResponseTime + result.responseTime) / 2
      } else {
        health.failureCount++
        health.lastFailure = new Date().toISOString()
      }
      
      // 根据状态更新IP列表
      if (statusChanged) {
        if (status === 'active') {
          // 从黑名单移除，添加到活跃列表
          const blacklistIndex = domainData.blacklist.indexOf(ip)
          if (blacklistIndex !== -1) {
            domainData.blacklist.splice(blacklistIndex, 1)
          }
          
          // 添加到对应的IP列表
          if (ip.includes(':')) {
            if (!domainData.ipv6.includes(ip)) {
              domainData.ipv6.push(ip)
            }
          } else {
            if (!domainData.ipv4.includes(ip)) {
              domainData.ipv4.push(ip)
            }
          }
          
        } else if (status === 'blacklisted') {
          // 从活跃列表移除，添加到黑名单
          if (ip.includes(':')) {
            const ipv6Index = domainData.ipv6.indexOf(ip)
            if (ipv6Index !== -1) {
              domainData.ipv6.splice(ipv6Index, 1)
            }
          } else {
            const ipv4Index = domainData.ipv4.indexOf(ip)
            if (ipv4Index !== -1) {
              domainData.ipv4.splice(ipv4Index, 1)
            }
          }
          
          if (!domainData.blacklist.includes(ip)) {
            domainData.blacklist.push(ip)
          }
        }
      }
      
      // 保存数据
      this.saveLocalData()
      
      // 发送事件
      this.emit('ipStatusChanged', {
        ip,
        domain,
        status,
        result,
        wasBlacklisted,
        statusChanged
      })
    }
  }

  /**
   * 处理IP状态变化
   */
  private handleIPStatusChange(event: any): void {
    const { ip, domain, newStatus } = event
    
    logger.info('IP状态变化', { ip, domain, newStatus })
    
    // 发送状态变化事件
    this.emit('ipStatusChanged', {
      ip,
      domain,
      status: newStatus,
      timestamp: Date.now()
    })
  }

  /**
   * 启动健康检查
   */
  public startHealthCheck(): void {
    if (!this.localData) {
      logger.warn('本地数据未加载，无法启动健康检查')
      return
    }
    
    logger.info('启动IP健康检查')
    
    // 为所有IP启动健康检查
    for (const [domain, domainData] of Object.entries(this.localData.domains)) {
      // 添加活跃IP
      this.healthChecker.addIPs(domainData.ipv4, domain, 'active')
      this.healthChecker.addIPs(domainData.ipv6, domain, 'active')
      
      // 添加黑名单IP（也会被测试）
      this.healthChecker.addIPs(domainData.blacklist, domain, 'blacklisted')
    }
    
    // 启动健康检查器
    this.healthChecker.start()
    
    logger.info('IP健康检查已启动', {
      totalIPs: this.healthChecker.getAllIPStatus().length
    })
  }

  /**
   * 停止健康检查
   */
  public stopHealthCheck(): void {
    logger.info('停止IP健康检查')
    this.healthChecker.stop()
  }

  /**
   * 手动测试IP
   */
  public async testIPManually(ip: string, domain: string): Promise<IPTestResult> {
    logger.info('手动测试IP', { ip, domain })
    return await this.healthChecker.testIPManually(ip, domain)
  }

  /**
   * 获取IP健康状态
   */
  public getIPHealthStatus(ip: string, domain: string): IPHealthStatus | undefined {
    return this.healthChecker.getIPStatus(ip, domain)
  }

  /**
   * 获取所有IP健康状态
   */
  public getAllIPHealthStatus(): IPHealthStatus[] {
    return this.healthChecker.getAllIPStatus()
  }

  /**
   * 获取健康检查统计
   */
  public getHealthCheckStats(): any {
    return this.healthChecker.getStats()
  }

  /**
   * 强制更新IP状态
   */
  public updateIPStatus(ip: string, domain: string, status: 'active' | 'blacklisted'): void {
    this.healthChecker.updateIPStatus(ip, domain, status)
  }

  /**
   * 清除IP统计数据
   */
  public clearIPStats(ip: string, domain: string): void {
    this.healthChecker.clearIPStats(ip, domain)
  }

  /**
   * 清理无效健康数据与黑名单（移除被截断的IPv6如“2607”，非法IP字符串等）
   */
  public clearInvalidData(): { removedHealth: number, removedBlacklist: number } {
    if (!this.localData) return { removedHealth: 0, removedBlacklist: 0 }
    const ipv4Re = /^(?:\d{1,3}\.){3}\d{1,3}$/
    const ipv6Re = /:/ // 粗略判断，包含冒号
    let removedHealth = 0
    let removedBlacklist = 0
    
    for (const [domain, domainData] of Object.entries(this.localData.domains)) {
      // 清理 health 中的无效 key
      for (const ip of Object.keys(domainData.health)) {
        const valid = ipv4Re.test(ip) || (ipv6Re.test(ip) && ip.length >= 8)
        if (!valid) {
          delete domainData.health[ip]
          removedHealth++
        }
      }
      // 清理 blacklist 中的无效项
      const before = domainData.blacklist.length
      domainData.blacklist = domainData.blacklist.filter(ip => ipv4Re.test(ip) || (ipv6Re.test(ip) && ip.length >= 8))
      removedBlacklist += before - domainData.blacklist.length
    }
    this.saveLocalData()
    return { removedHealth, removedBlacklist }
  }

  /**
   * 一键清空所有健康统计（不动 ipv4/ipv6 列表，仅清空 health 与重置统计）
   */
  public clearAllHealthData(): { cleared: number } {
    if (!this.localData) return { cleared: 0 }
    let cleared = 0
    for (const [, domainData] of Object.entries(this.localData.domains)) {
      const ips = Object.keys(domainData.health)
      cleared += ips.length
      domainData.health = {}
    }
    this.saveLocalData()
    return { cleared }
  }

  /**
   * 停止同步管理器
   */
  public stop(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval)
      this.syncInterval = null
    }
    
    // 停止健康检查器
    this.healthChecker.stop()
    
    logger.info('IP池同步管理器已停止')
  }
}
