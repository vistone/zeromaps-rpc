package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
)

// 使用 uTLS 创建 HTTP 客户端，模拟 Chrome 120（支持 HTTP/2）
func createUTLSClient(ipv6 string) *http.Client {
	// 创建 HTTP/2 Transport，使用 uTLS 自定义 TLS 连接
	transport := &http2.Transport{
		DialTLS: func(network, addr string, cfg *tls.Config) (net.Conn, error) {
			// 如果指定了 IPv6，强制使用该地址
			var dialer *net.Dialer
			if ipv6 != "" {
				localAddr, err := net.ResolveIPAddr("ip6", ipv6)
				if err != nil {
					return nil, fmt.Errorf("invalid ipv6 address: %v", err)
				}
				dialer = &net.Dialer{
					Timeout:   10 * time.Second,
					LocalAddr: &net.TCPAddr{IP: localAddr.IP},
				}
			} else {
				dialer = &net.Dialer{Timeout: 10 * time.Second}
			}

			// 建立 TCP 连接
			rawConn, err := dialer.Dial("tcp6", addr)
			if err != nil {
				return nil, err
			}

			// 使用 uTLS 模拟 Chrome 120 的 TLS 指纹（完整支持 h2）
			tlsConfig := &utls.Config{
				ServerName:         getHostFromAddr(addr),
				InsecureSkipVerify: true,
			}

			tlsConn := utls.UClient(rawConn, tlsConfig, utls.HelloChrome_120)

			// 执行 TLS 握手
			err = tlsConn.Handshake()
			if err != nil {
				rawConn.Close()
				return nil, err
			}

			return tlsConn, nil
		},
		AllowHTTP: false,
	}

	return &http.Client{
		Timeout:   30 * time.Second,
		Transport: transport,
	}
}

// 从 addr (host:port) 提取 host
func getHostFromAddr(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return host
}

// 解压 gzip 响应
func decompressGzip(data []byte) ([]byte, error) {
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	return io.ReadAll(reader)
}

// HTTP 代理处理器
func proxyHandler(w http.ResponseWriter, r *http.Request) {
	startTime := time.Now()

	// 获取参数
	targetURL := r.URL.Query().Get("url")
	ipv6 := r.URL.Query().Get("ipv6")

	if targetURL == "" {
		http.Error(w, "Missing 'url' parameter", http.StatusBadRequest)
		return
	}

	// 创建 uTLS 客户端
	client := createUTLSClient(ipv6)

	// 创建请求
	req, err := http.NewRequest("GET", targetURL, nil)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to create request: %v", err), http.StatusInternalServerError)
		return
	}

	// 设置 Chrome 浏览器的 Headers
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Accept-Encoding", "gzip, deflate, br")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	req.Header.Set("Referer", "https://earth.google.com/")
	req.Header.Set("Origin", "https://earth.google.com")
	req.Header.Set("Sec-Fetch-Dest", "empty")
	req.Header.Set("Sec-Fetch-Mode", "cors")
	req.Header.Set("Sec-Fetch-Site", "same-site")
	req.Header.Set("Sec-Ch-Ua", `"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"`)
	req.Header.Set("Sec-Ch-Ua-Mobile", "?0")
	req.Header.Set("Sec-Ch-Ua-Platform", `"Windows"`)

	// 发送请求
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("❌ Request failed: %v", err)
		http.Error(w, fmt.Sprintf("Request failed: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// 读取响应体
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read response: %v", err), http.StatusInternalServerError)
		return
	}

	// 如果是 gzip 编码，解压
	if resp.Header.Get("Content-Encoding") == "gzip" {
		body, err = decompressGzip(body)
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to decompress response: %v", err), http.StatusInternalServerError)
			return
		}
	}

	duration := time.Since(startTime)
	log.Printf("✅ [%s] %d - %s (%dms, %d bytes)", 
		ipv6[:20], resp.StatusCode, targetURL[:60], duration.Milliseconds(), len(body))

	// 返回响应
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Status-Code", strconv.Itoa(resp.StatusCode))
	w.Header().Set("X-Duration-Ms", strconv.FormatInt(duration.Milliseconds(), 10))
	
	// 复制原始响应头
	for key, values := range resp.Header {
		for _, value := range values {
			w.Header().Add("X-Origin-"+key, value)
		}
	}

	w.WriteHeader(http.StatusOK)
	w.Write(body)
}

func main() {
	port := os.Getenv("UTLS_PROXY_PORT")
	if port == "" {
		port = "8765"
	}

	http.HandleFunc("/proxy", proxyHandler)

	log.Printf("🚀 uTLS Proxy Server starting on :%s", port)
	log.Printf("📋 模拟浏览器: Chrome 120")
	log.Printf("🌐 使用方法: http://localhost:%s/proxy?url=<URL>&ipv6=<IPv6>", port)
	
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("❌ Server failed: %v", err)
	}
}

