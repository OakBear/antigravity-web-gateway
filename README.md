# Antigravity Headless Backend & WebUI Gateway

在纯原版 Antigravity `language_server --standalone` 基础上构建的**无 VNC / 无 X11 远程 Linux WebUI 网关**，零外部 npm 依赖（仅需 Node.js 原生模块），支持完整的 WebSocket 通信、本地存储桥接、Sidecar 辅助面板（iframe）代理以及 `systemd --user` 守护进程管理。

## 核心特性

- **纯无头启动**：默认直启 `language_server --standalone --enable_sidecars`，无需 Chromium / Electron GUI、无需 X11 / VNC。
- **WebUI + WebSocket 反向代理**：通过 `backend/server.mjs` 自动发现后端端口，注入 `frontend/web_shim.js` 以在普通浏览器中完整兼容 WebSocket、本地持久化（`app_storage.json`）与工作区选择。
- **原生插件 Sidecar 代理**：通过 `/__agy_sidecar/<port>/...` 反向代理并注入 `frontend/sidecar_patch.js`，使侧栏插件（如 [`agy-telemetry-monitor`](https://github.com/OakBear/agy-telemetry-monitor)）在远程浏览器中无跨域/端口阻塞地正常运行。
- **内置运维状态页**：访问 `/__agy_gateway_ui` 可实时查看网关与后端健康状态，访问 `/__agy_gateway_health` 可获取 JSON 探活数据。

## 目录结构

```text
antigravity-web-gateway/
├── config.env.example                     # 配置模板（复制为 config.env 后按需修改）
├── agyctl.sh                              # systemd --user 安装与日常运维脚本
├── backend/
│   ├── start_backend.sh                   # 无头后端启动器（默认 standalone，可选 electron headless）
│   ├── server.mjs                         # WebUI HTTP/WebSocket 反向代理与 Sidecar 代理
│   ├── port_discovery.mjs                 # 固定端口优先 + ss 本机进程 + 日志 + HTTP 探活
│   └── storage.mjs                        # app_storage.json 原子读写
├── frontend/
│   ├── web_shim.js                        # 注入 WebUI 的适配层（WebSocket、nativeStorage、Sidecar iframe）
│   ├── sidecar_patch.js                   # 注入 Sidecar iframe 的 fetch/XHR/SSE 路径前缀补丁
│   └── dashboard.html                     # 内置网关运维控制台 (/__agy_gateway_ui)
└── systemd/
    ├── agy-backend.service.template       # 后端用户级 systemd 单元模板
    └── agy-web-gateway.service.template   # 网关用户级 systemd 单元模板
```

## 快速部署

### 1. 准备配置文件

```bash
cp config.env.example config.env
```

编辑 `config.env`，将以下关键路径修改为本机实际路径（`systemd EnvironmentFile` 不展开 `$HOME`，请填写绝对路径）：

- `AGY_PROFILE_ROOT` / `AGY_LS_LOG_PATH` / `AGY_APP_STORAGE_PATH`
- `AGY_DEFAULT_WORKSPACE`
- `AGY_NODE_BIN`（建议 Node.js >= 20）
- `AGY_APP_ROOT` / `AGY_ELECTRON_BIN` / `AGY_LS_BIN`
- `AGY_PROXY_URL`（可选，如需通过代理访问上游服务）
- `AGY_ALLOWED_HOST`（可选，限制仅在指定主机名上启动；留空表示不限制）

### 2. 安装并启动 `systemd --user` 服务

```bash
bash agyctl.sh install
bash agyctl.sh start
```

> 若服务器未启用 `systemd --user`，也可以直接前台/后台运行：
> ```bash
> bash backend/start_backend.sh &
> node backend/server.mjs
> ```

### 3. 建立本地 SSH 隧道并访问

在本地电脑执行：

```bash
ssh -N -L 12689:127.0.0.1:13081 <user>@<remote-host>
```

随后在本地浏览器打开：

- **Antigravity WebUI**：`http://127.0.0.1:12689/?useWebSocket=true`
- **网关运维状态页**：`http://127.0.0.1:12689/__agy_gateway_ui`
- **JSON 健康检查**：`http://127.0.0.1:12689/__agy_gateway_health`

## 日常运维

```bash
# 后端 + 网关一起重启（通过 PartOf 联动）
agyctl restart

# 仅热重启 WebUI 网关（不中断正在运行的 Agent）
agyctl restart-gateway

# 查看运行状态与端口探活
agyctl status

# 查看最近日志
agyctl logs
```

## 开源协议

本目录采用 **MIT License**，详见 [`LICENSE`](./LICENSE)。
