require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// ========================================
// 配置与初始化
// ========================================

const app = express();

// 必须使用 Railway 提供的 PORT 环境变量
const PORT = process.env.PORT || 3002;

// 上传目录配置
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer 存储配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname) || '.png';
    cb(null, 'card-' + uniqueSuffix + ext);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ========================================
// 中间件
// ========================================

// CORS 配置 - 允许所有来源（生产环境可收紧）
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '2mb' }));

// 静态文件服务
app.use('/uploads', express.static(uploadDir));

// ========================================
// 健康检查端点（必须放在 API 路由之前）
// ========================================

// 根路径健康检查 - Railway 默认检查
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    service: 'TexHub AI Proxy',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// 详细健康检查
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// ========================================
// 环境变量检查
// ========================================

const MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

console.log('🔧 环境变量检查:');
console.log('  - MOONSHOT_API_KEY:', MOONSHOT_API_KEY ? '✅ 已配置' : '⚠️ 未配置');
console.log('  - SUPABASE_URL:', SUPABASE_URL ? '✅ 已配置' : '⚠️ 未配置');
console.log('  - PORT:', PORT);

// 初始化 Supabase
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    console.log('✅ Supabase 客户端已初始化');
  } catch (err) {
    console.error('❌ Supabase 初始化失败:', err.message);
  }
} else {
  console.warn('⚠️ Supabase 配置缺失，部分功能不可用');
}

// ========================================
// 工具函数
// ========================================

function extractJSON(content) {
  if (!content) return null;
  if (typeof content === 'object') return content;
  
  const s = String(content);
  
  try { return JSON.parse(s.trim()); } catch (e) {}
  
  const codeBlock = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch (e) {}
  }
  
  const objMatch = s.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch (e) {}
  }
  
  return null;
}

function normalizeGrade(raw) {
  if (!raw) return 'C';
  const t = String(raw).toLowerCase();
  if (t.includes('platinum') || t.includes('a级') || t.includes('战略')) return 'A';
  if (t.includes('gold') || t.includes('b级') || t.includes('黄金')) return 'A';
  if (t.includes('silver') || t.includes('c级') || t.includes('白银')) return 'B';
  return 'C';
}

async function callMoonshot(payload, retries = 1) {
  if (!MOONSHOT_API_KEY) {
    throw new Error('MOONSHOT_API_KEY not configured');
  }
  
  const url = 'https://api.moonshot.cn/v1/chat/completions';
  const headers = { 
    Authorization: `Bearer ${MOONSHOT_API_KEY}`, 
    'Content-Type': 'application/json' 
  };
  
  try {
    const resp = await axios.post(url, payload, { headers, timeout: 60000 });
    return resp.data;
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 500));
      return callMoonshot(payload, retries - 1);
    }
    throw err;
  }
}

// ========================================
// API 路由
// ========================================

// 名片识别
app.post('/parse-card', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!MOONSHOT_API_KEY) {
      return res.status(503).json({ error: 'MOONSHOT_API_KEY not configured' });
    }

    const backendUrl = process.env.BACKEND_URL || `http://localhost:${PORT}`;
    const imageUrl = `${backendUrl}/uploads/${file.filename}`;

    const mime = file.mimetype || 'image/jpeg';
    const b64 = fs.readFileSync(file.path, { encoding: 'base64' });
    const dataUrl = `data:${mime};base64,${b64}`;

    const systemPrompt = `你是一位资深外贸业务助理。请从名片图片中提取信息并分析。返回JSON格式：{"name":"姓名","company":"公司","position":"职位","phone":"电话","email":"邮箱","country":"国家","country_code":"国家代码","background_summary":"公司背景","customer_grade":"A/B/C/D","business_model":"retailer/distributor/manufacturer","grade_reason":"分级原因"}`;

    const payload = {
      model: 'moonshot-v1-8k-vision-preview',
      messages: [
        { role: 'system', content: systemPrompt },
        { 
          role: 'user', 
          content: [
            { type: 'text', text: '请解析这张名片图片。' },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ],
      max_tokens: 1000,
      temperature: 0.1
    };

    const aiResp = await callMoonshot(payload, 1);
    const rawContent = aiResp?.choices?.[0]?.message?.content;

    if (!rawContent) {
      return res.status(502).json({ error: 'No content from AI' });
    }

    const parsed = extractJSON(rawContent);
    
    if (!parsed) {
      return res.status(502).json({ error: 'JSON parse failed', raw: rawContent });
    }

    const grade = normalizeGrade(parsed.customer_grade);

    const result = {
      name: parsed.name || '',
      company: parsed.company || '',
      position: parsed.position || '',
      phone: parsed.phone || '',
      email: parsed.email || '',
      country: parsed.country || '',
      country_code: parsed.country_code || '',
      background_summary: parsed.background_summary || '',
      customer_grade: grade,
      business_model: parsed.business_model || 'retailer',
      grade_reason: parsed.grade_reason || '',
      image_url: imageUrl,
      imageUrl: imageUrl
    };

    return res.json(result);

  } catch (err) {
    console.error('Parse error:', err);
    return res.status(500).json({ 
      error: 'Parse failed', 
      detail: err?.message || String(err) 
    });
  }
});

// 公司调研
app.post('/research-company', async (req, res) => {
  try {
    const { companyName } = req.body;
    if (!companyName) {
      return res.status(400).json({ error: 'companyName is required' });
    }

    if (!MOONSHOT_API_KEY) {
      return res.status(503).json({ error: 'MOONSHOT_API_KEY not configured' });
    }

    const systemPrompt = `你是一位专业的外贸业务研究员。请研究公司并返回JSON：{"background_summary":"背景简介","customer_grade":"A/B/C/D","grade_reason":"分级原因","business_model":"retailer/distributor/manufacturer"}`;

    const payload = {
      model: 'moonshot-v1-8k',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `研究公司：${companyName}` }
      ],
      temperature: 0.2,
      max_tokens: 600
    };

    const aiResp = await callMoonshot(payload, 1);
    const rawContent = aiResp?.choices?.[0]?.message?.content;

    if (!rawContent) {
      return res.status(502).json({ error: 'No content from AI' });
    }

    const parsed = extractJSON(rawContent);
    if (!parsed) {
      return res.status(502).json({ error: 'JSON parse failed', raw: rawContent });
    }

    const grade = normalizeGrade(parsed.customer_grade);

    return res.json({
      background_summary: parsed.background_summary || '',
      customer_grade: grade,
      grade_reason: parsed.grade_reason || '',
      business_model: parsed.business_model || 'retailer',
      backgroundSummary: parsed.background_summary || '',
      customerGrade: grade,
      gradeReason: parsed.grade_reason || '',
      businessModel: parsed.business_model || 'retailer'
    });

  } catch (err) {
    console.error('Research error:', err);
    return res.status(500).json({ 
      error: 'Research failed', 
      detail: err?.message || String(err) 
    });
  }
});

// 客户状态分析
app.post('/analyze-status', async (req, res) => {
  try {
    const { companyName, backgroundSummary, interactionHistory } = req.body;

    if (!MOONSHOT_API_KEY) {
      return res.status(503).json({ 
        error: 'MOONSHOT_API_KEY not configured',
        status: 'warm',
        reason: 'AI服务未配置',
        suggestion: '请稍后重试'
      });
    }

    const systemPrompt = `分析客户状态，返回JSON：{"status":"cold/warm/hot/inquiry/quoted/negotiating/closed","reason":"原因","suggestion":"建议"}`;

    const userContent = `分析客户状态：\n公司：${companyName || '未知'}\n背景：${backgroundSummary || '暂无'}\n交互：${JSON.stringify(interactionHistory || [])}`;

    const payload = {
      model: 'moonshot-v1-8k',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      max_tokens: 500,
      temperature: 0.3
    };

    const aiResp = await callMoonshot(payload, 1);
    const content = aiResp?.choices?.[0]?.message?.content;

    if (!content) {
      return res.json({ status: 'warm', reason: 'AI无响应', suggestion: '请手动判断' });
    }

    const parsed = extractJSON(content);
    if (parsed && parsed.status) {
      return res.json(parsed);
    }

    return res.json({ 
      status: 'warm', 
      reason: content.substring(0, 200), 
      suggestion: '建议根据分析结果调整跟进策略' 
    });

  } catch (err) {
    console.error('Analysis error:', err);
    return res.json({ 
      status: 'warm',
      reason: '分析服务暂时不可用',
      suggestion: '请稍后重试或手动判断'
    });
  }
});

// AI任务生成
app.post('/generate-ai-tasks', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    // 获取需要跟进的客户
    const { data: customersNeedFollowUp, error: customerError } = await supabase
      .from('customers')
      .select('id, name, company, country, contact_person, email, phone, last_order_date, total_orders, total_value')
      .eq('status', 'active')
      .or(`last_order_date.lt.${thirtyDaysAgo.toISOString()},last_order_date.is.null`)
      .limit(10);

    if (customerError) {
      console.error('Customer fetch error:', customerError);
    }

    // 获取未结清订单
    const { data: pendingOrders, error: orderError } = await supabase
      .from('orders')
      .select('id, order_id, customer_id, total_value, payment_status, balance_due_date')
      .in('payment_status', ['balance_pending', 'balance_overdue'])
      .order('balance_due_date', { ascending: true })
      .limit(10);

    if (orderError) {
      console.error('Order fetch error:', orderError);
    }

    const fixedTasks = [
      {
        customerId: null,
        customerName: '通用',
        title: '✅ 检查并回复所有新询盘/邮件',
        description: '1. 检查邮箱新邮件\n2. 回复询盘（2小时内）\n3. 标记重要邮件跟进',
        priority: 'high',
        category: 'daily_routine',
        reason: '每日基础工作'
      },
      {
        customerId: null,
        customerName: '通用',
        title: '✅ 每日社交媒体/平台产品引流推广',
        description: '1. 发布LinkedIn动态\n2. 更新产品到B2B平台\n3. 回复社交平台消息',
        priority: 'medium',
        category: 'daily_routine',
        reason: '每日基础工作'
      },
      {
        customerId: null,
        customerName: '通用',
        title: '✅ 更新并分析今日汇率风险',
        description: '1. 查看主要货币汇率\n2. 评估未结订单汇率风险',
        priority: 'medium',
        category: 'daily_routine',
        reason: '每日基础工作'
      }
    ];

    let aiTasks = [];

    if (MOONSHOT_API_KEY && customersNeedFollowUp && customersNeedFollowUp.length > 0) {
      try {
        const systemPrompt = `你是外贸业务总监，根据CRM数据生成3-5个高优先级任务。返回JSON：{"tasks":[{"customerId":"id","customerName":"名称","title":"标题","description":"描述","priority":"high/medium/low","category":"follow_up/payment/opportunity","reason":"原因"}]}`;

        const payload = {
          model: 'moonshot-v1-8k',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `待跟进客户：${JSON.stringify(customersNeedFollowUp.slice(0, 5))}\n未结订单：${JSON.stringify(pendingOrders?.slice(0, 5) || [])}` }
          ],
          temperature: 0.3,
          max_tokens: 1500
        };

        const aiResp = await callMoonshot(payload, 1);
        const rawContent = aiResp?.choices?.[0]?.message?.content;

        if (rawContent) {
          const parsed = extractJSON(rawContent);
          if (parsed && parsed.tasks) {
            aiTasks = parsed.tasks;
          }
        }
      } catch (aiErr) {
        console.error('AI task generation error:', aiErr);
      }
    }

    const allTasks = [...fixedTasks, ...aiTasks];

    return res.json({
      tasks: allTasks,
      stats: {
        fixedTasks: fixedTasks.length,
        aiTasks: aiTasks.length,
        customersNeedFollowUp: customersNeedFollowUp?.length || 0,
        pendingOrders: pendingOrders?.length || 0
      }
    });

  } catch (err) {
    console.error('Task generation error:', err);
    return res.status(500).json({ 
      error: 'Task generation failed', 
      detail: err?.message || String(err)
    });
  }
});

// 地址解析
app.post('/geocode-address', async (req, res) => {
  try {
    const { address, customerId } = req.body;
    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    if (!MOONSHOT_API_KEY) {
      return res.status(503).json({ error: 'MOONSHOT_API_KEY not configured' });
    }

    const systemPrompt = `你是地理编码专家。解析地址返回JSON：{"country":"国家","city":"城市","latitude":纬度,"longitude":经度,"formatted_address":"格式化地址"}`;

    const payload = {
      model: 'moonshot-v1-8k',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `解析地址：${address}` }
      ],
      temperature: 0.1,
      max_tokens: 500
    };

    const aiResp = await callMoonshot(payload, 1);
    const rawContent = aiResp?.choices?.[0]?.message?.content;

    if (!rawContent) {
      return res.status(502).json({ error: 'No content from AI' });
    }

    const parsed = extractJSON(rawContent);
    if (!parsed || !parsed.latitude || !parsed.longitude) {
      return res.status(502).json({ error: 'Geocoding failed', raw: rawContent });
    }

    const result = {
      country: parsed.country || '',
      city: parsed.city || '',
      latitude: parseFloat(parsed.latitude),
      longitude: parseFloat(parsed.longitude),
      formatted_address: parsed.formatted_address || address
    };

    // 更新数据库
    if (customerId && supabase) {
      await supabase
        .from('customers')
        .update({
          latitude: result.latitude,
          longitude: result.longitude,
          city: result.city,
          country: result.country
        })
        .eq('id', customerId);
    }

    return res.json(result);

  } catch (err) {
    console.error('Geocode error:', err);
    return res.status(500).json({ 
      error: 'Geocoding failed', 
      detail: err?.message || String(err) 
    });
  }
});

// 路线规划
app.post('/plan-route', async (req, res) => {
  try {
    const { customerIds } = req.body;
    if (!customerIds || !Array.isArray(customerIds) || customerIds.length < 2) {
      return res.status(400).json({ error: 'At least 2 customer IDs required' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { data: customers, error } = await supabase
      .from('customers')
      .select('id, name, company, address, city, country, lat, lng')
      .in('id', customerIds)
      .not('lat', 'is', null)
      .not('lng', 'is', null);

    if (error) {
      throw error;
    }

    if (!customers || customers.length < 2) {
      return res.status(400).json({ 
        error: 'Insufficient location data',
        message: '选中的客户缺少地理位置信息'
      });
    }

    // 最近邻算法
    const calculateDistance = (lat1, lng1, lat2, lng2) => {
      const R = 6371;
      const dLat = ((lat2 - lat1) * Math.PI) / 180;
      const dLng = ((lng2 - lng1) * Math.PI) / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng/2) * Math.sin(dLng/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      return R * c;
    };

    const visited = new Set();
    const orderedCustomers = [];
    let current = customers[0];
    visited.add(current.id);
    orderedCustomers.push(current);

    while (visited.size < customers.length) {
      let nearest = null;
      let minDistance = Infinity;

      for (const customer of customers) {
        if (!visited.has(customer.id)) {
          const distance = calculateDistance(
            parseFloat(current.lat), parseFloat(current.lng),
            parseFloat(customer.lat), parseFloat(customer.lng)
          );
          if (distance < minDistance) {
            minDistance = distance;
            nearest = customer;
          }
        }
      }

      if (nearest) {
        visited.add(nearest.id);
        orderedCustomers.push(nearest);
        current = nearest;
      }
    }

    let totalDistance = 0;
    for (let i = 0; i < orderedCustomers.length - 1; i++) {
      totalDistance += calculateDistance(
        parseFloat(orderedCustomers[i].lat), parseFloat(orderedCustomers[i].lng),
        parseFloat(orderedCustomers[i+1].lat), parseFloat(orderedCustomers[i+1].lng)
      );
    }

    return res.json({
      route: orderedCustomers.map((c, index) => ({
        order: index + 1,
        customerId: c.id,
        name: c.name || c.company,
        address: c.formatted_address || c.address,
        city: c.city,
        country: c.country,
        coordinates: {
          latitude: parseFloat(c.lat),
          longitude: parseFloat(c.lng)
        }
      })),
      totalDistance: Math.round(totalDistance * 10) / 10,
      estimatedDuration: Math.round(totalDistance / 60),
      totalCustomers: orderedCustomers.length
    });

  } catch (err) {
    console.error('Route planning error:', err);
    return res.status(500).json({ 
      error: 'Route planning failed', 
      detail: err?.message || String(err) 
    });
  }
});

// 获取有位置的客户
app.get('/customers-with-location', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { country, city } = req.query;
    
    let query = supabase
      .from('customers')
      .select('id, name, company, country, city, address, lat, lng, contact_person, phone, email')
      .not('lat', 'is', null)
      .not('lng', 'is', null);

    if (country) {
      query = query.ilike('country', `%${country}%`);
    }
    if (city) {
      query = query.ilike('city', `%${city}%`);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return res.json({ customers: data || [] });

  } catch (err) {
    console.error('Fetch customers error:', err);
    return res.status(500).json({ 
      error: 'Failed to fetch customers', 
      detail: err?.message || String(err) 
    });
  }
});

// ========================================
// 错误处理
// ========================================

// 404 处理
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large', limit: '50MB' });
  }
  res.status(500).json({ error: 'Server error', detail: err.message || String(err) });
});

// ========================================
// 启动服务
// ========================================

app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log('🚀 TexHub AI Proxy 服务已启动');
  console.log('='.repeat(60));
  console.log(`📡 服务地址: http://0.0.0.0:${PORT}`);
  console.log(`🔧 端口: ${PORT}`);
  console.log(`🌍 环境: ${process.env.NODE_ENV || 'development'}`);
  console.log('');
  console.log('✅ 健康检查:');
  console.log(`   GET http://0.0.0.0:${PORT}/`);
  console.log(`   GET http://0.0.0.0:${PORT}/health`);
  console.log('');
  console.log('📋 API 端点:');
  console.log('   POST /parse-card         - 名片识别');
  console.log('   POST /research-company   - 公司调研');
  console.log('   POST /analyze-status     - 状态分析');
  console.log('   POST /generate-ai-tasks  - AI任务生成');
  console.log('   POST /geocode-address    - 地址解析');
  console.log('   POST /plan-route         - 路线规划');
  console.log('   GET  /customers-with-location');
  console.log('='.repeat(60));
});
