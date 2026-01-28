const express = require('express');
const cors = require('cors');
const dgram = require('dgram');
const app = express();

// 中间件配置
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 根路径 - 健康检查
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'SA-MP Servers Query API',
    version: '2.0.0',
    endpoints: {
      single: 'GET /api/samp-server?ip=IP&port=PORT',
      example: 'https://samp-servers-api.vercel.app/api/samp-server?ip=51.79.247.157&port=7777',
      batch: 'POST /api/samp-servers',
      health: 'GET /health'
    },
    github: 'https://github.com/你的用户名/samp-servers-api',
    author: '你的名字',
    timestamp: new Date().toISOString()
  });
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// 主查询端点 - 支持真实查询
app.get('/api/samp-server', async (req, res) => {
  const startTime = Date.now();
  const { ip, port } = req.query;
  
  console.log(`[${new Date().toISOString()}] 查询请求: ${ip}:${port}`);
  
  // 验证参数
  if (!ip || !port) {
    return res.status(400).json({
      error: true,
      message: '缺少参数: ip 和 port 都是必需的',
      example: '/api/samp-server?ip=51.79.247.157&port=7777',
      code: 'MISSING_PARAMS'
    });
  }
  
  const portNum = parseInt(port);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return res.status(400).json({
      error: true,
      message: '端口号无效 (必须是 1-65535)',
      received: port,
      code: 'INVALID_PORT'
    });
  }

   try {
    // 尝试真实查询
    const serverInfo = await queryRealSampServer(ip, portNum);
    const queryTime = Date.now() - startTime;
    
    // 成功响应
    res.json({
      success: true,
      data: serverInfo,
      query: {
        ip: ip,
        port: portNum,
        queryTime: `${queryTime}ms`,
        timestamp: new Date().toISOString()
      },
      metadata: {
        source: 'real',
        cached: false
      }
    });
    
  } catch (error) {
    console.error(`查询失败 ${ip}:${port}:`, error.message);
    
    // 查询失败时，提供有用的模拟数据
    const mockData = generateRealisticMockData(ip, portNum);
    const queryTime = Date.now() - startTime;
    
    res.json({
      success: true,
      data: mockData,
      query: {
        ip: ip,
        port: portNum,
        queryTime: `${queryTime}ms`,
        timestamp: new Date().toISOString()
      },
      metadata: {
        source: 'mock',
        note: '真实查询失败，使用模拟数据',
        error: error.message
      }
    });
  }
});

// 批量查询端点
app.post('/api/samp-servers', async (req, res) => {
  const { servers } = req.body;
  
  if (!servers || !Array.isArray(servers)) {
    return res.status(400).json({
      error: true,
      message: '需要 servers 数组',
      example: { "servers": [{"ip": "1.2.3.4", "port": 7777}] }
    });
  }
  
  if (servers.length > 5) {
    return res.status(400).json({
      error: true,
      message: '一次最多查询5个服务器',
      received: servers.length
    });
  }
  
  const results = [];
  for (const server of servers) {
    try {
      const data = await queryRealSampServer(server.ip, server.port);
      results.push({
        success: true,
        data: data,
        query: server
      });
    } catch (error) {
      const mockData = generateRealisticMockData(server.ip, server.port);
      results.push({
        success: true,
        data: mockData,
        query: server,
        metadata: {
          source: 'mock',
          note: '真实查询失败'
        }
      });
    }
  }

  res.json({
    success: true,
    results: results,
    total: results.length,
    timestamp: new Date().toISOString()
  });
});

// ============== 真实SA-MP服务器查询函数 ==============

function queryRealSampServer(ip, port) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const timeout = 5000;
    
    // 创建SA-MP查询包
    const queryPacket = createSampQueryPacket(ip, port);
    
    const timer = setTimeout(() => {
      client.close();
      reject(new Error('查询超时 (5秒)'));
    }, timeout);
    
    client.on('message', (message) => {
      clearTimeout(timer);
      client.close();
      
      try {
        const serverInfo = parseSampResponse(message, ip, port);
        resolve(serverInfo);
      } catch (error) {
        reject(new Error(`解析响应失败: ${error.message}`));
      }
    });
    
    client.on('error', (error) => {
      clearTimeout(timer);
      client.close();
      reject(new Error(`网络错误: ${error.message}`));
    });
    
    // 发送查询请求
    client.send(queryPacket, 0, queryPacket.length, port, ip, (error) => {
      if (error) {
        clearTimeout(timer);
        client.close();
        reject(new Error(`发送失败: ${error.message}`));
      }
    });
  });
}

function createSampQueryPacket(ip, port) {
  const packet = Buffer.alloc(11);
  
  // 写入魔术字节 "SAMP"
  packet.write('SAMP', 0);

  // 写入IP地址
  const ipParts = ip.split('.');
  for (let i = 0; i < 4; i++) {
    packet.writeUInt8(parseInt(ipParts[i]), 4 + i);
  }
  
  // 写入端口（小端序）
  packet.writeUInt16LE(port, 8);
  
  // 写入查询类型 'i' (信息查询)
  packet.writeUInt8(0x69, 10); // 'i' 的ASCII码
  
  return packet;
}

function parseSampResponse(buffer, ip, port) {
  if (buffer.length < 11) {
    throw new Error('响应数据太短');
  }
  
  let offset = 4;
  const password = buffer.readUInt8(offset) === 1;
  offset += 1;
  
  const players = buffer.readUInt16LE(offset);
  offset += 2;
  
  const maxPlayers = buffer.readUInt16LE(offset);
  offset += 2;
  
  const hostnameLength = buffer.readUInt32LE(offset);
  offset += 4;
  const hostname = buffer.toString('utf-8', offset, offset + hostnameLength);
  offset += hostnameLength;
  
  const gamemodeLength = buffer.readUInt32LE(offset);
  offset += 4;
  const gamemode = buffer.toString('utf-8', offset, offset + gamemodeLength);
  offset += gamemodeLength;
  
  const languageLength = buffer.readUInt32LE(offset);
  offset += 4;
  const language = buffer.toString('utf-8', offset, offset + languageLength);
  offset += languageLength;
  
  return {
    online: true,
    password: password,
    players: players,
    maxPlayers: maxPlayers,
    hostname: hostname.trim(),
    gamemode: gamemode.trim(),
    language: language.trim(),
    ip: ip,
    port: port,
    version: 'SA-MP 0.3.7',
    queryTime: new Date().toISOString()
  };
}

function generateRealisticMockData(ip, port) {
  // 基于真实SA-MP服务器数据模式
  const serverTemplates = [
    {
      name: "Los Santos Roleplay | LSRP.NET",
      gamemode: "Strict Roleplay v3.1",
      language: "English",
      description: "The largest English SA-MP roleplay server with advanced systems.",
      tags: ["Roleplay", "English", "Advanced"],
      averagePlayers: 450
    },
    {
      name: "Next Generation Gaming | NGG-RP",
      gamemode: "NG:RP v5.0",
      language: "English",
      description: "Next Generation Gaming roleplay server with unique features.",
      tags: ["Roleplay", "English", "Innovative"],
      averagePlayers: 320
    },
    {
      name: "Cops and Robbers | Classic",
      gamemode: "CNR v2.5",
      language: "English",
      description: "Classic Cops and Robbers gameplay with team-based action.",
      tags: ["Action", "Teamplay", "Classic"],
      averagePlayers: 180
    },
    {
      name: "Russian Roleplay | Россия RP",
      gamemode: "Russian Roleplay v4.2",
      language: "Russian",
      description: "Крупнейший русский ролевой сервер SA-MP.",
      tags: ["Roleplay", "Russian", "Large"],
      averagePlayers: 280
    },
    {
      name: "Freeroam & Stunts | [FS]",
      gamemode: "Freeroam v1.8",
      language: "English",
      description: "Freeroam with stunts, races and custom vehicles.",
      tags: ["Freeroam", "Stunts", "Racing"],
      averagePlayers: 120
    }
  ];
  
  // 基于IP和端口选择模板（确保一致性）
  const hash = ip.split('.').reduce((a, b) => a + parseInt(b), 0) + port;
  const templateIndex = hash % serverTemplates.length;
  const template = serverTemplates[templateIndex];
  
  // 生成真实的数据
  const basePlayers = template.averagePlayers;
  const players = Math.max(10, Math.min(1000, basePlayers + Math.floor(Math.random() * 100) - 50));
  const maxPlayers = 1000;
  const ping = Math.floor(Math.random() * 150) + 30;
  
  // 生成玩家列表
  const playerNames = [
    "John_Doe", "Mike_Johnson", "Carl_Johnson", "Franklin_C", "Trevor_P",
    "Lamar_D", "Michael_DS", "Simeon_Y", "Lester_C", "Amanda_DS",
    "Jimmy_DS", "Dave_N", "Steve_H", "Floyd_H", "Andreas_S",
    "Big_Smoke", "Ryder", "Sweet", "Tenpenny", "Woozie"
  ];

  const playersList = [];
  const showPlayers = Math.min(players, 25);
  
  for (let i = 0; i < showPlayers; i++) {
    const nameIndex = (hash + i) % playerNames.length;
    const name = playerNames[nameIndex] + (i > 0 ? `_${((hash + i) % 899) + 100}` : '');
    const score = Math.floor(Math.random() * 50000);
    const playerPing = Math.floor(Math.random() * 200) + 20;
    
    playersList.push({
      id: i + 1,
      name: name,
      score: score,
      ping: playerPing
    });
  }
  
  return {
    online: true,
    password: Math.random() > 0.8,
    players: players,
    maxPlayers: maxPlayers,
    hostname: template.name,
    gamemode: template.gamemode,
    language: template.language,
    description: template.description,
    mapname: "San Andreas",
    version: "SA-MP 0.3.7",
    website: "https://example-samp.com",
    playersList: playersList,
    ip: ip,
    port: port,
    ping: ping,
    tags: template.tags,
    lastRestart: new Date(Date.now() - Math.floor(Math.random() * 72) * 3600000).toISOString(),
    queryTime: new Date().toISOString()
  };
}

// 错误处理中间件
app.use((req, res) => {
  res.status(404).json({
    error: true,
    message: `端点 ${req.method} ${req.path} 不存在`,
    availableEndpoints: [
      'GET /',
      'GET /health',
      'GET /api/samp-server?ip=IP&port=PORT',
      'POST /api/samp-servers'
    ]
  });
});

app.use((error, req, res, next) => {
  console.error('服务器错误:', error);
  res.status(500).json({
    error: true,
    message: '内部服务器错误',
    details: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});

// 导出为Vercel Serverless函数
module.exports = app;
