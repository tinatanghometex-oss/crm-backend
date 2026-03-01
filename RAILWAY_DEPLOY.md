# Railway 部署指南

## 修复内容

本次修复针对 Railway 健康检查失败问题：

1. ✅ **健康检查路由** - 在根路径 `/` 和 `/health` 添加了简单的 JSON 响应
2. ✅ **端口绑定** - 使用 `app.listen(PORT, '0.0.0.0', callback)` 绑定到所有接口
3. ✅ **环境变量检查** - 启动时打印环境变量状态，方便调试
4. ✅ **错误处理** - 添加了全局错误处理和 404 处理
5. ✅ **CORS 配置** - 简化为允许所有来源（可根据需要收紧）

## 部署步骤

### 1. 推送到 GitHub

```bash
cd backend-deploy
git init
git add .
git commit -m "Fix Railway healthcheck: add root route and 0.0.0.0 binding"
git remote add origin https://github.com/你的用户名/crm-backend.git
git push -u origin main -f
```

### 2. Railway 配置

1. 登录 https://railway.app
2. 创建新项目 → Deploy from GitHub repo
3. 选择你的仓库
4. 在 Variables 中添加：
   ```
   MOONSHOT_API_KEY=sk-你的Moonshot密钥
   ```
5. 点击 Deploy

### 3. 验证部署

部署完成后，访问：
```
https://你的域名.up.railway.app/
https://你的域名.up.railway.app/health
```

应该返回：
```json
{"status":"ok","service":"TexHub AI Proxy","version":"1.0.0","timestamp":"..."}
```

### 4. 配置前端

在 Vercel 环境变量中添加：
```
VITE_AI_PROXY_URL=https://你的域名.up.railway.app
```

## 常见问题

### 健康检查失败
- 确保 `railway.json` 中的 `healthcheckPath` 是 `/health`
- 确保 `healthcheckTimeout` 足够长（至少 30 秒）
- 检查 Railway 日志看具体错误

### 端口绑定错误
- 必须使用 `process.env.PORT`
- 必须绑定到 `'0.0.0.0'`
- 不能省略第二个参数

### CORS 错误
- 后端已配置允许所有来源
- 检查前端 `VITE_AI_PROXY_URL` 是否正确
