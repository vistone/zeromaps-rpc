package main

import (
	"fmt"
	"log"
	"sync"
	"time"
)

// P2P 同步管理器（暂时禁用，待实现 WebSocket 客户端）
type P2PSync struct {
	nodeName      string
	peerNodes     []string                        // 其他节点地址列表
	connections   map[string]interface{}          // 占位符（待实现）
	ipPools       map[string]*DNSIPPool           // domain → pool
	syncInterval  time.Duration
	reconnectDelay time.Duration
	enabled       bool                            // 是否启用 P2P
	mu            sync.RWMutex
}

// P2P 消息
type P2PMessage struct {
	Type      string                 `json:"type"`
	Node      string                 `json:"node"`
	Timestamp int64                  `json:"timestamp"`
	Data      map[string]interface{} `json:"data"`
}

// 消息类型常量
const (
	MsgTypeIPPoolUpdate = "ip_pool_update"
	MsgTypeHealthReport = "health_report"
	MsgTypeRequestPool  = "request_pool"
	MsgTypeIPDiscovered = "ip_discovered"
	MsgTypePong         = "pong"
)

// 创建 P2P 同步管理器
func NewP2PSync(nodeName string, peerNodes []string, ipPools map[string]*DNSIPPool) *P2PSync {
	return &P2PSync{
		nodeName:       nodeName,
		peerNodes:      peerNodes,
		connections:    make(map[string]interface{}),
		ipPools:        ipPools,
		syncInterval:   60 * time.Second,
		reconnectDelay: 5 * time.Second,
		enabled:        false, // 暂时禁用 P2P（待实现 WebSocket）
	}
}

// 启动 P2P 同步
func (p *P2PSync) Start() {
	if !p.enabled {
		log.Printf("🌐 [P2P] P2P 同步已禁用（待实现 WebSocket 客户端）")
		return
	}
	
	log.Printf("🌐 [P2P] 启动 P2P IP 池同步服务")
	log.Printf("🌐 [P2P] 节点名称: %s", p.nodeName)
	log.Printf("🌐 [P2P] 对等节点: %d 个", len(p.peerNodes))

	// TODO: 连接到所有对等节点（需要实现 WebSocket 客户端）
	// go p.connectToPeers()

	// TODO: 定期广播 IP 池
	// go p.startIPPoolBroadcast()

	// TODO: 定期广播健康报告
	// go p.startHealthReportBroadcast()
}

// 连接到对等节点（待实现）
func (p *P2PSync) connectToPeers() {
	// TODO: 实现 WebSocket 客户端连接
	log.Printf("⚠️  [P2P] WebSocket 客户端待实现")
}

// 连接并维护与单个节点的连接（待实现）
func (p *P2PSync) connectAndMaintain(peer string) {
	// TODO: 实现 WebSocket 客户端连接和维护
}

// 处理 WebSocket 连接（待实现）
func (p *P2PSync) handleConnection(conn interface{}, peer string) {
	// TODO: 实现 WebSocket 消息处理
}

// 处理收到的消息
func (p *P2PSync) handleMessage(msg P2PMessage, peer string) {
	switch msg.Type {
	case MsgTypeIPPoolUpdate:
		p.handleIPPoolUpdate(msg)

	case MsgTypeHealthReport:
		p.handleHealthReport(msg)

	case MsgTypeIPDiscovered:
		p.handleIPDiscovered(msg)

	case MsgTypeRequestPool:
		// 对方请求我们的 IP 池，立即发送
		p.broadcastIPPool()

	default:
		log.Printf("⚠️  [P2P] 未知消息类型: %s", msg.Type)
	}
}

// 处理 IP 池更新
func (p *P2PSync) handleIPPoolUpdate(msg P2PMessage) {
	log.Printf("📡 [P2P] 接收到 %s 的 IP 池更新", msg.Node)

	for domain, poolData := range msg.Data {
		pool := p.ipPools[domain]
		if pool == nil {
			continue
		}

		// 提取 IPv4 和 IPv6
		if ipv4Data, ok := poolData.(map[string]interface{})["ipv4"]; ok {
			if ipv4List, ok := ipv4Data.([]interface{}); ok {
				for _, ipInterface := range ipv4List {
					if ip, ok := ipInterface.(string); ok {
						pool.AddCandidateIP(ip, "p2p:"+msg.Node)
					}
				}
			}
		}

		if ipv6Data, ok := poolData.(map[string]interface{})["ipv6"]; ok {
			if ipv6List, ok := ipv6Data.([]interface{}); ok {
				for _, ipInterface := range ipv6List {
					if ip, ok := ipInterface.(string); ok {
						pool.AddCandidateIP(ip, "p2p:"+msg.Node)
					}
				}
			}
		}
	}
}

// 处理健康报告
func (p *P2PSync) handleHealthReport(msg P2PMessage) {
	log.Printf("📊 [P2P] 接收到 %s 的健康报告", msg.Node)
	// TODO: 可以根据其他节点的健康报告调整本地 IP 优先级
}

// 处理新 IP 发现
func (p *P2PSync) handleIPDiscovered(msg P2PMessage) {
	ip, _ := msg.Data["ip"].(string)
	domain, _ := msg.Data["domain"].(string)

	log.Printf("🆕 [P2P] %s 发现新 IP: %s (域名: %s)", msg.Node, ip, domain)

	pool := p.ipPools[domain]
	if pool != nil {
		pool.AddCandidateIP(ip, "p2p:"+msg.Node)
	}
}

// 定期广播 IP 池
func (p *P2PSync) startIPPoolBroadcast() {
	ticker := time.NewTicker(p.syncInterval)
	defer ticker.Stop()

	for range ticker.C {
		p.broadcastIPPool()
	}
}

// 广播 IP 池
func (p *P2PSync) broadcastIPPool() {
	poolData := make(map[string]interface{})

	for domain, pool := range p.ipPools {
		stats := pool.GetStats()
		poolData[domain] = map[string]interface{}{
			"ipv4": stats["activeIPv4"],
			"ipv6": stats["activeIPv6"],
		}
	}

	msg := P2PMessage{
		Type:      MsgTypeIPPoolUpdate,
		Node:      p.nodeName,
		Timestamp: time.Now().Unix(),
		Data:      poolData,
	}

	p.broadcast(msg)
}

// 定期广播健康报告
func (p *P2PSync) startHealthReportBroadcast() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		p.broadcastHealthReport()
	}
}

// 广播健康报告
func (p *P2PSync) broadcastHealthReport() {
	healthData := make(map[string]interface{})

	for _, pool := range p.ipPools {
		stats := pool.GetStats()
		if healthMap, ok := stats["health"].(map[string]map[string]interface{}); ok {
			for ip, health := range healthMap {
				healthData[ip] = health
			}
		}
	}

	if len(healthData) == 0 {
		return
	}

	msg := P2PMessage{
		Type:      MsgTypeHealthReport,
		Node:      p.nodeName,
		Timestamp: time.Now().Unix(),
		Data:      healthData,
	}

	p.broadcast(msg)
}

// 广播新发现的 IP
func (p *P2PSync) BroadcastIPDiscovered(domain, ip string) {
	msg := P2PMessage{
		Type:      MsgTypeIPDiscovered,
		Node:      p.nodeName,
		Timestamp: time.Now().Unix(),
		Data: map[string]interface{}{
			"domain": domain,
			"ip":     ip,
			"tested": true,
		},
	}

	p.broadcast(msg)
}

// 发送消息到所有节点
func (p *P2PSync) broadcast(msg P2PMessage) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	for peer, conn := range p.connections {
		if err := p.sendMessage(conn, msg); err != nil {
			log.Printf("⚠️  [P2P] 发送消息到 %s 失败: %v", peer, err)
		}
	}
}

// 发送消息（待实现）
func (p *P2PSync) sendMessage(conn interface{}, msg P2PMessage) error {
	// TODO: 实现 WebSocket 消息发送
	return fmt.Errorf("未实现")
}

// 获取 P2P 状态
func (p *P2PSync) GetStatus() map[string]interface{} {
	p.mu.RLock()
	defer p.mu.RUnlock()

	peers := make(map[string]string)
	for peer := range p.connections {
		peers[peer] = "connected"
	}

	for _, peer := range p.peerNodes {
		if _, connected := p.connections[peer]; !connected {
			peers[peer] = "disconnected"
		}
	}

	return map[string]interface{}{
		"nodeName":       p.nodeName,
		"totalPeers":     len(p.peerNodes),
		"connectedPeers": len(p.connections),
		"peers":          peers,
	}
}

