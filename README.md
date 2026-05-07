# Forgejo OpenCode OAuth2 Proxy

使用 Forgejo OAuth2 授权替代 OpenCode 原有的 HTTP Basic Auth，防止暴力破解。

## 为什么需要这个？

OpenCode 的 `serve` 模式通过 `OPENCODE_SERVER_PASSWORD` 环境变量启用 HTTP Basic Auth。Basic Auth 存在以下安全问题：

- **暴力破解风险**：密码通过 HTTP 头明文传输（Base64 编码），攻击者可无限尝试
- **无速率限制**：OpenCode 自身未内置登录失败限制
- **无审计日志**：不知道谁在什么时间访问了服务
- **凭证泄露**：密码长期固定，一旦泄露无法快速吊销

本插件通过 Forgejo OAuth2 代理解决上述问题：所有请求先经过 OAuth2 认证，验证通过后才转发到 OpenCode 后端。

## 架构

```
                         Forgejo OAuth2
                        ┌──────────────┐
                        │  /authorize  │
                        │  /token      │
                        │  /api/v1/user│
                        └──────┬───────┘
                               │
  用户浏览器                    │
      │                        │
      ▼                        ▼
┌──────────┐  JWT Cookie  ┌──────────┐  X-Auth-User  ┌──────────┐
│  Proxy   │◄────────────►│  Proxy   │──────────────►│ OpenCode │
│  :3000   │              │  Auth MW │               │  :4096   │
└──────────┘              └──────────┘               └──────────┘
      │                        │
      │  无有效 Session         │
      └── 302 → Forgejo Login ─┘
```

## 快速开始

### 前置条件

- [Bun](https://bun.sh) >= 1.0
- 一个 Forgejo 实例（可以是自托管或 [Codeberg](https://codeberg.org)）
- 在该 Forgejo 实例上有账号

### 1. 克隆项目

```bash
git clone https://forgejo.draw.live/jerry/forgejo-opencode.git
cd forgejo-opencode
```

### 2. 在 Forgejo 上创建 OAuth2 应用

1. 登录你的 Forgejo 实例
2. 进入 **设置 → 应用**
3. 点击 **创建新的 OAuth2 应用程序**
4. 填写：
   - **应用名称**：`OpenCode Proxy`（或任意名称）
   - **重定向 URI**：`http://localhost:3000/auth/callback`（需与代理端口一致）

创建后会得到 `Client ID` 和 `Client Secret`。

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入必要配置：

```ini
# 代理监听端口
OAUTH2_PROXY_PORT=3000

# OpenCode 服务地址
OPENCODE_BACKEND_URL=http://localhost:4096

# Forgejo 实例地址
FORGEJO_URL=https://codeberg.org

# 上一步获取的凭证
FORGEJO_CLIENT_ID=your-client-id
FORGEJO_CLIENT_SECRET=your-client-secret

# JWT 签名密钥（生成命令：openssl rand -hex 32）
JWT_SECRET=your-random-secret-at-least-32-chars
```

### 4. 安装依赖并启动

```bash
bun install
bun run start
```

### 5. 启动 OpenCode（不设置 Basic Auth）

```bash
# 注意：不设置 OPENCODE_SERVER_PASSWORD
opencode serve --port 4096
```

### 6. 访问

浏览器打开 `http://localhost:3000`，将自动跳转到 Forgejo 登录页面。

## 配置参考

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `OAUTH2_PROXY_PORT` | `3000` | 代理监听端口 |
| `OAUTH2_PROXY_HOST` | `0.0.0.0` | 代理绑定地址 |
| `OPENCODE_BACKEND_URL` | `http://localhost:4096` | OpenCode 后端地址 |
| `FORGEJO_URL` | `https://codeberg.org` | Forgejo 实例 URL |
| `FORGEJO_CLIENT_ID` | — | OAuth2 Client ID（必填） |
| `FORGEJO_CLIENT_SECRET` | — | OAuth2 Client Secret（必填） |
| `JWT_SECRET` | — | JWT 签名密钥，至少 32 字符（必填） |
| `SESSION_MAX_AGE` | `86400` | 会话有效期（秒），默认 24 小时 |
| `OAUTH2_REDIRECT_URI` | `http://localhost:3000/auth/callback` | OAuth2 回调地址 |
| `FORGEJO_ALLOWED_USERS` | — | 允许访问的用户名列表，逗号分隔 |
| `FORGEJO_ALLOWED_ORGS` | — | 允许访问的组织列表，逗号分隔 |
| `COOKIE_DOMAIN` | — | Cookie 域名（跨子域时设置） |
| `BEHIND_PROXY` | `false` | 是否在 HTTPS 反向代理后 |

## 端点

| 路径 | 说明 |
|---|---|
| `GET /auth/login` | 发起 OAuth2 登录流程 |
| `GET /auth/callback` | OAuth2 回调处理（Forgejo 重定向到此） |
| `GET /auth/logout` | 清除会话并登出 |
| `GET /auth/status` | 返回当前认证状态（JSON） |
| `*` | 所有其他请求，认证后代理到 OpenCode |

## OpenCode 插件

项目包含一个 OpenCode 伴侣插件，在 OpenCode 内部提供 `forgejo_oauth_status` 工具。

**加载方式**：将 `plugin/forgejo-oauth.ts` 放入项目或全局的 `.opencode/plugins/` 目录，或添加到 `opencode.json` 的 `plugin` 列表中。

## 安全考虑

- **PKCE**：使用 SHA-256 的 Proof Key for Code Exchange，防止授权码拦截
- **CSRF 防护**：OAuth2 state 参数防止跨站请求伪造
- **HttpOnly Cookie**：JWT 存储在 HttpOnly Cookie 中，JavaScript 无法访问
- **SameSite=Lax**：防止跨站请求携带 Cookie
- **无密码存储**：不持久化任何用户密码或 Forgejo access token
- **访问控制**：通过 `FORGEJO_ALLOWED_USERS` 实现细粒度用户白名单
- **暴力破解无效**：没有密码输入环节，认证完全委托给 Forgejo

## 与 Basic Auth 对比

| | Basic Auth | OAuth2 Proxy |
|---|---|---|
| 认证方式 | 用户名/密码 | Forgejo OAuth2 |
| 暴力破解风险 | 高 | 无（无密码输入） |
| 多因素认证 | 不支持 | 取决于 Forgejo 配置 |
| 用户管理 | 无 | Forgejo 用户/组织体系 |
| 会话管理 | 无（每次请求） | JWT + Cookie，可配置过期 |
| 访问控制 | 无 | 用户名/组织白名单 |
| 审计 | 无 | 可通过 Forgejo 审计日志追踪 |

## 部署方式

支持两种部署方式：**本地运行**（开发/测试）和 **Docker 部署**（生产/云端）。

### 方式一：本地运行

```bash
cp .env.example .env
# 编辑 .env 填入配置
bun install
bun run start           # 启动 OAuth2 代理
opencode serve --port 4096  # 另开终端启动 OpenCode
```

### 方式二：Docker 一键部署（推荐）

Docker 镜像包含完整技术栈：**OpenCode + oh-my-openagent + Forgejo OAuth2 代理**，开箱即用。

```bash
# 1. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 Forgejo OAuth2 凭证和 JWT_SECRET

# 2. 创建 workspace 目录
mkdir -p workspace

# 3. 构建并启动
docker compose up -d

# 4. 访问
open http://localhost:3000
```

容器内运行两个进程：
- OpenCode Server（:4096，内部） + oh-my-openagent 插件
- OAuth2 Proxy（:3000，外部）— 所有外部请求经此认证

#### Docker Compose 配置说明

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `FORGEJO_CLIENT_ID` | ✅ | Forgejo OAuth2 Client ID |
| `FORGEJO_CLIENT_SECRET` | ✅ | Forgejo OAuth2 Client Secret |
| `JWT_SECRET` | ✅ | JWT 签名密钥（≥32 字符） |
| `FORGEJO_URL` | — | Forgejo 实例地址（默认 codeberg.org） |
| `OAUTH2_REDIRECT_URI` | — | 回调地址（默认 localhost:3000） |
| `FORGEJO_ALLOWED_USERS` | — | 用户白名单 |
| `WORKSPACE_DIR` | — | 挂载的工作目录（默认 ./workspace） |

#### 版本锁定（防止自动更新）

镜像默认锁定 OpenCode 和 oh-my-openagent 的版本，**不会自动更新**：

```ini
# .env 中可覆盖版本
OPENCODE_VERSION=1.14.31   # 默认
OMO_VERSION=3.17.5         # 默认
```

自动更新已从以下层面禁止：

| 层面 | 措施 |
|---|---|
| **Docker 构建** | `npm install -g @opencode-ai/cli@${VERSION}` 锁定版本 |
| **oh-my-openagent** | `oh-my-opencode.json` 中禁用 `auto-update-checker` hook |
| **OpenCode** | 容器内二进制只读，无法被 `opencode upgrade` 覆盖 |
| **系统级别** | 每次重建镜像时版本固定，运行时不主动联网更新 |

如需升级到新版本：

```bash
# 修改 .env 中的版本号，重建镜像
OPENCODE_VERSION=1.15.0 OMO_VERSION=3.18.0 docker compose build --no-cache
docker compose up -d
```

#### 持久化数据

| Docker Volume | 容器路径 | 用途 |
|---|---|---|
| `opencode-config` | `/home/opencode/.config/opencode` | 插件配置、模型设置 |
| `opencode-data` | `/home/opencode/.local/share/opencode` | 认证令牌、会话数据 |
| `./workspace` | `/workspace` | 项目代码 |

#### 在云端部署

**1. 配合 Nginx 反代（生产环境）**

```nginx
server {
    listen 443 ssl;
    server_name opencode.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`.env` 配置：

```ini
OAUTH2_REDIRECT_URI=https://opencode.example.com/auth/callback
BEHIND_PROXY=true
```

**2. 直接推送到云服务器**

```bash
# 在云服务器上
git clone <this-repo> && cd forgejo-opencode
cp .env.example .env   # 填入实际配置
docker compose up -d
```

#### 配置 LLM Provider

容器启动后，需要配置 AI 模型提供商。有两种方式：

**方式 A：挂载已有认证文件**

```yaml
# docker-compose.yml 中添加
volumes:
  - ~/.local/share/opencode/auth.json:/home/opencode/.local/share/opencode/auth.json:ro
```

**方式 B：进入容器交互式配置**

```bash
docker compose exec opencode bash
opencode auth login   # 按提示选择 provider 并认证
```

#### 镜像结构

```
┌─────────────────────────────────────────┐
│              Docker Container            │
│                                         │
│  ┌─────────────┐    ┌────────────────┐  │
│  │ OAuth2 Proxy │───▶│  OpenCode      │  │
│  │   (:3000)    │    │  Server (:4096)│  │
│  │              │    │                │  │
│  │  Forgejo     │    │  oh-my-        │  │
│  │  OAuth2 +    │    │  openagent     │  │
│  │  PKCE + JWT  │    │  plugin        │  │
│  └─────────────┘    └────────────────┘  │
│         ▲                               │
│         │ 外部访问                       │
│    用户浏览器                            │
└─────────────────────────────────────────┘
```

### Systemd 服务（不使用 Docker 时）

```ini
# /etc/systemd/system/forgejo-opencode-oauth2.service
[Unit]
Description=Forgejo OpenCode OAuth2 Proxy
After=network.target

[Service]
Type=simple
User=opencode
WorkingDirectory=/opt/forgejo-opencode
EnvironmentFile=/opt/forgejo-opencode/.env
ExecStart=/usr/local/bin/bun run src/server.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## 许可

MIT
