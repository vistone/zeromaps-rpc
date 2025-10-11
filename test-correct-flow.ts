import { RpcClient } from './client/rpc-client'

async function test() {
  const client = new RpcClient('tile12.zeromaps.cn', 9527)
  
  try {
    await client.connect()
    console.log('✓ 已连接\n')
    
    // 1. 获取 PlanetoidMetadata
    console.log('1. 获取 PlanetoidMetadata...')
    const planetoid = await client.fetchData('PlanetoidMetadata')
    console.log(`   状态码: ${planetoid.statusCode}`)
    console.log(`   数据: ${planetoid.data.toString('hex')}\n`)
    
    // 2. 测试根节点（tilekey为空，epoch用1001测试）
    console.log('2. 测试根节点 BulkMetadata...')
    const root = await client.fetchData('BulkMetadata/pb=!1m2!1s!2u1001')
    console.log(`   状态码: ${root.statusCode}`)
    console.log(`   数据大小: ${root.data.length} bytes`)
    
    client.disconnect()
  } catch (error) {
    console.error('错误:', error)
  }
}
test()
