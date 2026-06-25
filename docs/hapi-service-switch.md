# HAPI Service 切换记录：npm 包 ↔ 源码

## 背景

源码改动（讯飞主动压缩、context 估算等）需在本地 runner 生效。
runner 由 systemd 用户服务 `hapi.service` 管理，跑的是 npm 全局包的原生二进制。
切换为用 `bun` 跑源码，验证改动。

## 当前 npm 版本（回退基准）

- 包：`@twsxtd/hapi@0.20.2`
- 二进制：`/home/myron/.nvm/versions/node/v22.22.0/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-linux-x64/bin/hapi`
- service 文件：`~/.config/systemd/user/hapi.service`

## 原始配置（回退用，已备份到 hapi.service.npm-backup）

```ini
[Unit]
Description=HAPI Runner - Claude Code Background Runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.hapi/.env
ExecStart=/home/myron/.nvm/versions/node/v22.22.0/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-linux-x64/bin/hapi runner start-sync --workspace-root /home/myron
ExecStop=/home/myron/.nvm/versions/node/v22.22.0/bin/hapi runner stop
Restart=on-failure
RestartSec=10
Environment=PATH=/home/myron/.local/bin:/home/myron/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=HOME=/home/myron
Environment=HAPI_API_URL=http://111.229.16.156:8922
WorkingDirectory=/home/myron

[Install]
WantedBy=default.target
```

## 操作步骤

### 1. 切换到源码模式（本次执行，已生效）

```bash
# 备份（已执行）
cp ~/.config/systemd/user/hapi.service ~/.config/systemd/user/hapi.service.npm-backup
```

service 文件改动（注意 `--cwd` 必须有，否则 `@/` 路径别名无法解析）：

```ini
ExecStart=/home/myron/.bun/bin/bun --cwd /home/myron/Documents/android/hapi/cli /home/myron/Documents/android/hapi/cli/src/index.ts runner start-sync --workspace-root /home/myron
ExecStop=/home/myron/.bun/bin/bun --cwd /home/myron/Documents/android/hapi/cli /home/myron/Documents/android/hapi/cli/src/index.ts runner stop
Environment=PATH=/home/myron/.bun/bin:/home/myron/.local/bin:/home/myron/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WorkingDirectory=/home/myron/Documents/android/hapi/cli
```

关键点：
- `--cwd <cli目录>` 让 bun 读取 tsconfig.json 的 paths（`@/* → ./src/*`），否则报 `Cannot find module '@/projectPath'`
- PATH 加 `/home/myron/.bun/bin`，让 spawn 的子进程能找到 bun
- `--workspace-root /home/myron` 仍指定 runner 工作目录，与 WorkingDirectory 不冲突

```bash
systemctl --user daemon-reload
systemctl --user restart hapi
```

### 2. 回退到 npm 包（哪天需要时）

**方式 A（推荐，用备份）：**
```bash
cp ~/.config/systemd/user/hapi.service.npm-backup ~/.config/systemd/user/hapi.service
systemctl --user daemon-reload
systemctl --user restart hapi
```

**方式 B（备份丢失时手动改回）：**

把 service 文件的 ExecStart / ExecStop 改回：

```
ExecStart=/home/myron/.nvm/versions/node/v22.22.0/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-linux-x64/bin/hapi runner start-sync --workspace/myron
ExecStop=/home/myron/.nvm/versions/node/v22.22.0/bin/hapi runner stop
```

然后：
```bash
systemctl --user daemon-reload
systemctl --user restart hapi
```

## 注意事项

- 源码模式下，`git pull` 后重启 service 即用最新代码
- 回退最干净的终态：改动发版后 `npm i -g @twsxtd/hapi@latest`，再切回 npm 包
- 改 service 前确认无活跃会话（`ps --ppid <runner_pid>`）
- 重启会短暂断开 Web 连接，刷新即可；会话历史存在 hub SQLite 不丢
