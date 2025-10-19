package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"math/rand"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// DNS IP 池管理器（支持多域名）
type DNSIPPool struct {
	domain string

	// 活跃 IP 池（当前可用）
	activeIPv4 []string
	activeIPv6 []string

	// 候选 IP 池（等待验证）
	candidateIPv4 []string
	candidateIPv6 []string

	// 黑名单（IP → 加入黑名单的时间）
	blacklist map[string]time.Time

	// IP 健康状态
	health map[string]*IPHealth

	// 请求计数器（用于混合策略）
	requestCounter atomic.Int64
	ipPoolUsageRate float64 // 默认 0.95（95% 用 IP 池）

	// 配置
	preferIPv6     bool
	probeInterval  time.Duration
	minPoolSize    int
	blacklistTime  time.Duration

	lastProbe time.Time
	mu        sync.RWMutex
}

// IP 健康状态
type IPHealth struct {
	ip               string
	totalRequests    int64
	successCount     int64
	failureCount     int64
	consecutiveFails int       // 连续失败次数
	lastSuccess      time.Time
	lastFailure      time.Time
	lastUsed         time.Time
	avgResponseTime  float64
	source           string // "static", "dns", "probe", "p2p"
	mu               sync.Mutex
}

// 创建新的 DNS IP 池
func NewDNSIPPool(domain string, defaultIPv4, defaultIPv6 []string, preferIPv6 bool) *DNSIPPool {
	pool := &DNSIPPool{
		domain:          domain,
		activeIPv4:      make([]string, 0),
		activeIPv6:      make([]string, 0),
		candidateIPv4:   make([]string, 0),
		candidateIPv6:   make([]string, 0),
		blacklist:       make(map[string]time.Time),
		health:          make(map[string]*IPHealth),
		ipPoolUsageRate: 0.95, // 95% 用 IP 池
		preferIPv6:      preferIPv6,
		probeInterval:   5 * time.Minute,
		minPoolSize:     2,
		blacklistTime:   10 * time.Minute,
	}

	// 初始化默认 IP
	for _, ip := range defaultIPv4 {
		pool.health[ip] = &IPHealth{
			ip:     ip,
			source: "static",
		}
	}
	for _, ip := range defaultIPv6 {
		pool.health[ip] = &IPHealth{
			ip:     ip,
			source: "static",
		}
	}

	log.Printf("📦 [DNS-Pool] 创建 %s 的 IP 池", domain)

	return pool
}

// 启动时初始化（刺探所有 IP）
func (p *DNSIPPool) InitializeOnStartup() error {
	log.Printf("🔍 [DNS-Pool] 开始刺探 %s 的可用 IP...", p.domain)

	// 1. 从健康状态中提取预设 IP
	defaultIPv4 := []string{}
	defaultIPv6 := []string{}

	for ip := range p.health {
		if strings.Contains(ip, ":") {
			defaultIPv6 = append(defaultIPv6, ip)
		} else {
			defaultIPv4 = append(defaultIPv4, ip)
		}
	}

	// 2. DNS 解析获取更多候选 IP
	dnsIPv4, dnsIPv6, err := p.resolveDNS()
	if err != nil {
		log.Printf("⚠️  [DNS-Pool] DNS 解析失败，使用预设 IP: %v", err)
	} else {
		log.Printf("📋 [DNS-Pool] DNS 解析结果: %d 个 IPv4, %d 个 IPv6",
			len(dnsIPv4), len(dnsIPv6))

		// 合并到候选池（去重）
		defaultIPv4 = mergeUnique(defaultIPv4, dnsIPv4)
		defaultIPv6 = mergeUnique(defaultIPv6, dnsIPv6)

		// 标记 DNS 解析的 IP
		for _, ip := range dnsIPv4 {
			if _, exists := p.health[ip]; !exists {
				p.health[ip] = &IPHealth{ip: ip, source: "dns"}
			}
		}
		for _, ip := range dnsIPv6 {
			if _, exists := p.health[ip]; !exists {
				p.health[ip] = &IPHealth{ip: ip, source: "dns"}
			}
		}
	}

	log.Printf("🧪 [DNS-Pool] 开始测试 %d 个候选 IP...", len(defaultIPv4)+len(defaultIPv6))

	// 3. 并发测试所有候选 IP
	validIPv4 := p.probeIPs(defaultIPv4, false)
	validIPv6 := p.probeIPs(defaultIPv6, true)

	// 4. 初始化活跃池
	p.mu.Lock()
	p.activeIPv4 = validIPv4
	p.activeIPv6 = validIPv6
	p.mu.Unlock()

	log.Printf("✅ [DNS-Pool] IP 池初始化完成: %d 个可用 IPv4, %d 个可用 IPv6",
		len(validIPv4), len(validIPv6))

	if len(validIPv4)+len(validIPv6) == 0 {
		log.Printf("⚠️  [DNS-Pool] 警告：没有可用的 IP，将降级到域名请求")
	}

	return nil
}

// DNS 解析
func (p *DNSIPPool) resolveDNS() ([]string, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// 解析 IPv4
	ipv4List := []string{}
	addrs, err := net.DefaultResolver.LookupIP(ctx, "ip4", p.domain)
	if err == nil {
		for _, addr := range addrs {
			ipv4List = append(ipv4List, addr.String())
		}
	}

	// 解析 IPv6
	ipv6List := []string{}
	addrs, err = net.DefaultResolver.LookupIP(ctx, "ip6", p.domain)
	if err == nil {
		for _, addr := range addrs {
			ipv6List = append(ipv6List, addr.String())
		}
	}

	if len(ipv4List) == 0 && len(ipv6List) == 0 {
		return nil, nil, fmt.Errorf("DNS 解析无结果")
	}

	return ipv4List, ipv6List, nil
}

// 并发测试 IP 列表
func (p *DNSIPPool) probeIPs(ips []string, isIPv6 bool) []string {
	validIPs := []string{}
	var mu sync.Mutex
	var wg sync.WaitGroup

	// 并发测试（最多 10 个并发）
	sem := make(chan struct{}, 10)

	for _, ip := range ips {
		wg.Add(1)
		sem <- struct{}{}

		go func(testIP string) {
			defer wg.Done()
			defer func() { <-sem }()

			// 测试这个 IP
			if p.testIPConnectivity(testIP, isIPv6) {
				mu.Lock()
				validIPs = append(validIPs, testIP)
				mu.Unlock()
				log.Printf("  ✅ [DNS-Pool] %s 可用", testIP)
			} else {
				log.Printf("  ❌ [DNS-Pool] %s 不可用", testIP)
				// 加入黑名单
				p.mu.Lock()
				p.blacklist[testIP] = time.Now()
				p.mu.Unlock()
			}
		}(ip)
	}

	wg.Wait()
	return validIPs
}

// 测试单个 IP 的连通性
func (p *DNSIPPool) testIPConnectivity(ip string, isIPv6 bool) bool {
	var testURL string
	if isIPv6 {
		testURL = fmt.Sprintf("https://[%s]:443/rt/earth/PlanetoidMetadata", ip)
	} else {
		testURL = fmt.Sprintf("https://%s:443/rt/earth/PlanetoidMetadata", ip)
	}

	// 创建测试请求
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", testURL, nil)
	if err != nil {
		return false
	}

	req.Host = p.domain // 关键：设置 Host 头

	// 使用简单的客户端测试
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: true, // 测试时跳过证书验证
			},
		},
	}

	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	// 200 或 404 都算可用（404 只是数据不存在，IP 是通的）
	return resp.StatusCode == 200 || resp.StatusCode == 404
}

// 应该使用 IP 池还是域名？（混合策略）
func (p *DNSIPPool) ShouldUseIPPool() bool {
	count := p.requestCounter.Add(1)

	// 每 20 个请求中，1 个用域名（5%）
	// 这个请求会帮我们发现新的 IP
	return count%20 != 0
}

// 获取随机 IP（从健康的 IP 中选择）
func (p *DNSIPPool) GetRandomIP(preferIPv6 bool) string {
	p.mu.RLock()
	defer p.mu.RUnlock()

	var candidates []string

	if preferIPv6 && len(p.activeIPv6) > 0 {
		candidates = p.activeIPv6
	} else if len(p.activeIPv4) > 0 {
		candidates = p.activeIPv4
	} else if len(p.activeIPv6) > 0 {
		candidates = p.activeIPv6
	}

	if len(candidates) == 0 {
		return "" // 池子空了
	}

	// 过滤健康的 IP（成功率 > 50% 且连续失败 < 3）
	healthyIPs := []string{}
	for _, ip := range candidates {
		health := p.health[ip]
		if health == nil {
			healthyIPs = append(healthyIPs, ip)
			continue
		}

		health.mu.Lock()
		isHealthy := health.consecutiveFails < 3 &&
			(health.totalRequests < 10 || float64(health.successCount)/float64(health.totalRequests) > 0.5)
		health.mu.Unlock()

		if isHealthy {
			healthyIPs = append(healthyIPs, ip)
		}
	}

	// 如果没有健康的 IP，降级到所有 IP
	if len(healthyIPs) == 0 {
		log.Printf("⚠️  [DNS-Pool] 没有健康的 IP，使用全部候选")
		healthyIPs = candidates
	}

	// 随机选择
	selectedIP := healthyIPs[rand.Intn(len(healthyIPs))]

	// 更新最后使用时间
	if health := p.health[selectedIP]; health != nil {
		health.mu.Lock()
		health.lastUsed = time.Now()
		health.mu.Unlock()
	}

	return selectedIP
}

// 记录 IP 请求结果
func (p *DNSIPPool) RecordResult(ip string, statusCode int, responseTime time.Duration) {
	if ip == "" {
		return
	}

	health := p.health[ip]
	if health == nil {
		// 创建新的健康记录
		health = &IPHealth{
			ip:     ip,
			source: "runtime",
		}
		p.health[ip] = health
	}

	health.mu.Lock()
	defer health.mu.Unlock()

	health.totalRequests++

	// 判断是否成功（200 才算成功）
	success := statusCode == 200

	if success {
		health.successCount++
		health.consecutiveFails = 0
		health.lastSuccess = time.Now()

		// 更新平均响应时间
		if health.avgResponseTime == 0 {
			health.avgResponseTime = float64(responseTime.Milliseconds())
		} else {
			health.avgResponseTime = health.avgResponseTime*0.9 + float64(responseTime.Milliseconds())*0.1
		}
	} else {
		health.failureCount++
		health.consecutiveFails++
		health.lastFailure = time.Now()

		// 连续失败 3 次，从池中移除
		if health.consecutiveFails >= 3 {
			log.Printf("⚠️  [DNS-Pool] IP %s 连续失败 %d 次，移除出池", ip, health.consecutiveFails)
			p.removeFromActivePool(ip)
		}
	}
}

// 从活跃池中移除 IP
func (p *DNSIPPool) removeFromActivePool(ip string) {
	p.mu.Lock()
	defer p.mu.Unlock()

	// 从 IPv4 池移除
	newIPv4 := []string{}
	for _, activeIP := range p.activeIPv4 {
		if activeIP != ip {
			newIPv4 = append(newIPv4, activeIP)
		}
	}
	p.activeIPv4 = newIPv4

	// 从 IPv6 池移除
	newIPv6 := []string{}
	for _, activeIP := range p.activeIPv6 {
		if activeIP != ip {
			newIPv6 = append(newIPv6, activeIP)
		}
	}
	p.activeIPv6 = newIPv6

	// 加入黑名单
	p.blacklist[ip] = time.Now()
}

// 添加候选 IP（从刺探中发现）
func (p *DNSIPPool) AddCandidateIP(ip string, source string) {
	p.mu.Lock()
	defer p.mu.Unlock()

	// 检查是否已存在
	isIPv6 := strings.Contains(ip, ":")

	if isIPv6 {
		for _, existing := range p.activeIPv6 {
			if existing == ip {
				return // 已存在
			}
		}
		for _, existing := range p.candidateIPv6 {
			if existing == ip {
				return // 已在候选池
			}
		}
		p.candidateIPv6 = append(p.candidateIPv6, ip)
	} else {
		for _, existing := range p.activeIPv4 {
			if existing == ip {
				return
			}
		}
		for _, existing := range p.candidateIPv4 {
			if existing == ip {
				return
			}
		}
		p.candidateIPv4 = append(p.candidateIPv4, ip)
	}

	// 创建健康记录
	if _, exists := p.health[ip]; !exists {
		p.health[ip] = &IPHealth{
			ip:     ip,
			source: source,
		}
	}

	log.Printf("🆕 [DNS-Pool] 发现新 IP: %s (来源: %s)", ip, source)
}

// 启动后台任务
func (p *DNSIPPool) StartBackgroundTasks() {
	// 定期刺探任务
	go p.startPeriodicProbe()

	// 候选 IP 验证任务
	go p.startCandidateValidation()

	// 黑名单重试任务
	go p.startBlacklistRetry()
}

// 定期刺探任务（5 分钟）
func (p *DNSIPPool) startPeriodicProbe() {
	ticker := time.NewTicker(p.probeInterval)
	defer ticker.Stop()

	for range ticker.C {
		log.Printf("🔄 [DNS-Pool] 开始定期刺探 %s...", p.domain)

		// 1. 重新解析 DNS
		newIPv4, newIPv6, err := p.resolveDNS()
		if err != nil {
			log.Printf("⚠️  [DNS-Pool] DNS 解析失败: %v", err)
			continue
		}

		// 2. 找出新增的 IP
		p.mu.RLock()
		candidatesIPv4 := findNewIPs(newIPv4, p.activeIPv4)
		candidatesIPv6 := findNewIPs(newIPv6, p.activeIPv6)
		p.mu.RUnlock()

		if len(candidatesIPv4) > 0 || len(candidatesIPv6) > 0 {
			log.Printf("  🆕 发现新 IP: %d 个 IPv4, %d 个 IPv6",
				len(candidatesIPv4), len(candidatesIPv6))

			// 添加到候选池
			for _, ip := range candidatesIPv4 {
				p.AddCandidateIP(ip, "dns")
			}
			for _, ip := range candidatesIPv6 {
				p.AddCandidateIP(ip, "dns")
			}
		}

		// 3. 清理失败的 IP
		p.cleanupFailedIPs()
	}
}

// 候选 IP 验证任务（每 30 秒验证候选池）
func (p *DNSIPPool) startCandidateValidation() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		p.mu.Lock()
		ipv4ToTest := p.candidateIPv4
		ipv6ToTest := p.candidateIPv6
		p.candidateIPv4 = []string{}
		p.candidateIPv6 = []string{}
		p.mu.Unlock()

		if len(ipv4ToTest) == 0 && len(ipv6ToTest) == 0 {
			continue
		}

		log.Printf("🧪 [DNS-Pool] 验证候选 IP: %d 个 IPv4, %d 个 IPv6",
			len(ipv4ToTest), len(ipv6ToTest))

		// 测试候选 IP
		validIPv4 := p.probeIPs(ipv4ToTest, false)
		validIPv6 := p.probeIPs(ipv6ToTest, true)

		// 加入活跃池
		if len(validIPv4) > 0 || len(validIPv6) > 0 {
			p.mu.Lock()
			p.activeIPv4 = append(p.activeIPv4, validIPv4...)
			p.activeIPv6 = append(p.activeIPv6, validIPv6...)
			p.mu.Unlock()

			log.Printf("  ✅ 新增 %d 个可用 IP", len(validIPv4)+len(validIPv6))
		}
	}
}

// 黑名单重试任务（每 10 分钟）
func (p *DNSIPPool) startBlacklistRetry() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		p.mu.Lock()
		retryIPs := []string{}
		now := time.Now()

		for ip, blacklistedAt := range p.blacklist {
			if now.Sub(blacklistedAt) > p.blacklistTime {
				retryIPs = append(retryIPs, ip)
			}
		}
		p.mu.Unlock()

		if len(retryIPs) == 0 {
			continue
		}

		log.Printf("🔄 [DNS-Pool] 重试黑名单 IP: %d 个", len(retryIPs))

		for _, ip := range retryIPs {
			isIPv6 := strings.Contains(ip, ":")
			if p.testIPConnectivity(ip, isIPv6) {
				// 测试通过，恢复到池子
				p.mu.Lock()
				if isIPv6 {
					p.activeIPv6 = append(p.activeIPv6, ip)
				} else {
					p.activeIPv4 = append(p.activeIPv4, ip)
				}
				delete(p.blacklist, ip)
				p.mu.Unlock()

				// 重置健康状态
				if health := p.health[ip]; health != nil {
					health.mu.Lock()
					health.consecutiveFails = 0
					health.mu.Unlock()
				}

				log.Printf("  ✅ IP 已恢复: %s", ip)
			} else {
				// 测试失败，重新计时
				p.mu.Lock()
				p.blacklist[ip] = now
				p.mu.Unlock()
			}
		}
	}
}

// 清理失败的 IP
func (p *DNSIPPool) cleanupFailedIPs() {
	p.mu.Lock()
	defer p.mu.Unlock()

	// 清理 IPv4
	cleanIPv4 := []string{}
	for _, ip := range p.activeIPv4 {
		health := p.health[ip]
		if health == nil || health.consecutiveFails < 5 {
			cleanIPv4 = append(cleanIPv4, ip)
		} else {
			log.Printf("  🗑️  [DNS-Pool] 移除失败 IP: %s (连续失败 %d 次)",
				ip, health.consecutiveFails)
			p.blacklist[ip] = time.Now()
		}
	}
	p.activeIPv4 = cleanIPv4

	// 清理 IPv6
	cleanIPv6 := []string{}
	for _, ip := range p.activeIPv6 {
		health := p.health[ip]
		if health == nil || health.consecutiveFails < 5 {
			cleanIPv6 = append(cleanIPv6, ip)
		} else {
			log.Printf("  🗑️  [DNS-Pool] 移除失败 IP: %s (连续失败 %d 次)",
				ip, health.consecutiveFails)
			p.blacklist[ip] = time.Now()
		}
	}
	p.activeIPv6 = cleanIPv6
}

// 获取统计信息
func (p *DNSIPPool) GetStats() map[string]interface{} {
	p.mu.RLock()
	defer p.mu.RUnlock()

	healthStats := make(map[string]map[string]interface{})
	for ip, health := range p.health {
		health.mu.Lock()
		healthStats[ip] = map[string]interface{}{
			"total":            health.totalRequests,
			"success":          health.successCount,
			"failure":          health.failureCount,
			"consecutiveFails": health.consecutiveFails,
			"avgRT":            health.avgResponseTime,
			"source":           health.source,
		}
		health.mu.Unlock()
	}

	return map[string]interface{}{
		"domain":        p.domain,
		"activeIPv4":    p.activeIPv4,
		"activeIPv6":    p.activeIPv6,
		"candidateIPv4": p.candidateIPv4,
		"candidateIPv6": p.candidateIPv6,
		"blacklistSize": len(p.blacklist),
		"health":        healthStats,
		"totalRequests": p.requestCounter.Load(),
	}
}

// 工具函数：找出新增的 IP
func findNewIPs(newIPs, existingIPs []string) []string {
	result := []string{}
	existingMap := make(map[string]bool)

	for _, ip := range existingIPs {
		existingMap[ip] = true
	}

	for _, ip := range newIPs {
		if !existingMap[ip] {
			result = append(result, ip)
		}
	}

	return result
}

// 工具函数：合并去重
func mergeUnique(list1, list2 []string) []string {
	seen := make(map[string]bool)
	result := []string{}

	for _, ip := range list1 {
		if !seen[ip] {
			result = append(result, ip)
			seen[ip] = true
		}
	}

	for _, ip := range list2 {
		if !seen[ip] {
			result = append(result, ip)
			seen[ip] = true
		}
	}

	return result
}

