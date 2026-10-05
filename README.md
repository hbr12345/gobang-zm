# 五子棋 · 在线对战版

给你的五子棋桌面版加上了**在线对战**功能，并配套一个对战服务器。
**客户端界面 100% 保持原版**（米黄渐变背景、宋体标题、圆角按钮、原版棋盘与 AI 全部原样），只在原界面基础上新增了「在线对战」模式按钮。

## 文件说明

```
new-chat/
├── 五子棋_在线对战版.exe        ← 客户端(双击即玩, 人机/双人/在线 三种模式, 原版 UI)
├── README.md                     ← 本说明
├── client2/                     客户端 C# 源码(基于原 exe 反编译源码注入, 可用 csc 重新编译)
│   ├── GomokuForm.cs            主窗体: 原版棋盘/AI + 在线对战逻辑
│   ├── NetDialog.cs             在线对战连接对话框(创建房间/快速匹配/加入房间)
│   ├── NetClient.cs             WebSocket 通信封装
│   ├── ScoredPoint.cs           原版 AI 评分辅助类
│   ├── NetTest2.cs / NetTest2.exe  无界面联调测试(27 项断言)
│   └── winenum.cs / winenum.exe    窗口冒烟检查辅助
├── orig/                         原 exe 备份与反编译源码(未改动)
│   ├── gomoku_orig.exe           原始 exe 备份
│   └── src/五子棋_新版/          反编译出的原始 C# 源码
└── server/                       服务器(协议完全一致, 可无缝切换)
    ├── gobang_server.py          Python 版(本地/局域网联机用)
    ├── server_deno.ts            Deno 版(部署到公网 Deno Deploy 用)
    ├── deno.json                 Deno Deploy 部署配置
    ├── test_protocol.py          服务器协议端到端测试(18 项断言)
    └── deno_stub.d.ts            仅用于本地语法检查
```

## 快速开始（本地 / 局域网联机）

1. **启动服务器**（任选一台电脑，需要 Python + websockets）：
   ```
   pip install websockets        # 第一次需要
   python gobang_server.py 8080
   ```
   看到 `服务器已启动` 即成功，默认端口 **8080**。

2. **打开客户端**：双击 `五子棋_在线对战版.exe`。顶部模式条新增第三个按钮 **「在线对战」**（人机/双人/在线），点击后弹出连接对话框。

3. **开局**（需要两台电脑，或同一台电脑开两个窗口）：
   - 一方点 **「创建房间」**，记下 6 位房间号；
   - 另一方在服务器地址填 `ws://<服务器IP>:8080`（本机就填 `ws://127.0.0.1:8080`），输入房间号后点 **「加入房间」**；
   - 也可以双方都点 **「快速匹配」** 随机配对。

4. 在线对局支持：
   - **落子**：轮到你时点棋盘，双方实时同步；
   - **悔棋需对方同意**：点「悔棋」→ 对方弹窗「是否同意悔棋？」→ 同意才撤销，且撤销后轮到请求方；
   - **认输**：点「认输」直接结束；
   - **重开需对方同意**：终局后点「重新开始」→ 对方同意才开新局；
   - **断线提示**：对方掉线会收到提示，服务器清理房间。

> 局域网联机时，服务器地址要填运行服务器那台电脑的局域网 IP，可用 `ipconfig` 查看（如 `192.168.1.100`）。

## 部署到公网（Deno Deploy，推荐）

想和异地朋友对战，把 Deno 版服务器部署到免费托管平台即可：

1. 打开 [Deno Deploy](https://dash.deno.com)，用 GitHub 账号登录；
2. 新建项目 → **从 GitHub 导入仓库**（或直接上传文件）→ 入口选择 `server_deno.ts`（本项目已带 `deno.json`，Deno Deploy 会自动识别其 `main` 字段）；
3. 部署完成后会得到一个域名，例如 `https://xxx.deno.dev`，**WebSocket 地址就是 `wss://xxx.deno.dev`**；
4. 客户端「在线对战」对话框的服务器地址填这个 `wss://...` 地址，双方即可异地联机。

本地验证 Deno 版（需要安装 Deno）：
```
deno run --allow-net server/server_deno.ts
```
或
```
deno task start      # 在 server/ 目录下, 使用 deno.json 里的任务
```

## 在线对战协议（简）

客户端 ↔ 服务器为 **WebSocket + JSON 文本帧**。服务器为权威：负责房间管理、回合校验、胜负判定，每次变更向双方广播**全量棋盘状态** `state`（board/turn/status/winner/history），客户端据此同步，天然支持断线重进。

| 方向 | 消息 | 说明 |
|---|---|---|
| C→S | `{"type":"hello","name":"昵称"}` | 上报昵称 |
| C→S | `{"type":"create_room"}` | 创建房间(6位房间号) |
| C→S | `{"type":"join_room","room":"123456"}` | 加入房间 |
| C→S | `{"type":"quick_match"}` | 快速匹配 |
| C→S | `{"type":"move","r":7,"c":7}` | 落子 |
| C→S | `{"type":"undo_req"}` | 悔棋请求(发给对方, 需对方同意) |
| C→S | `{"type":"undo_ack","accept":true/false}` | 悔棋回应(同意才撤销, 轮到请求方) |
| C→S | `{"type":"restart_req"}` / `{"type":"restart_ack","accept":true}` | 重开请求/回应(终局后) |
| C→S | `{"type":"resign"}` | 认输 |
| S→C | `{"type":"state",...}` | 全量棋盘状态 |
| S→C | `{"type":"joined"}`、`{"type":"opponent_joined"}`、`{"type":"opponent_left"}`、`{"type":"error"}` 等 | 事件通知 |

## 自测结果

| 测试 | 范围 | 结果 |
|---|---|---|
| `server/test_protocol.py` | 建房/加入/落子/五连判定/非法落子/悔棋同意与拒绝/重开/认输/快速匹配/断线 | **18 项断言全部通过** |
| `client2/NetTest2.exe` | C# 客户端真实协议流：落子双向同步、悔棋需对方同意(同意撤销/拒绝不变)、快速匹配配对、认输、重开需同意、断线通知 | **27 项断言全部通过** |
| `五子棋_在线对战版.exe` | 编译 + 启动冒烟 + 窗口创建 | 正常 |

## 重新编译客户端（可选）

```
C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe /nologo /target:winexe /platform:anycpu ^
  /out:五子棋_在线对战版.exe /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll ^
  /r:C:\Windows\Microsoft.NET\Framework\v4.0.30319\System.Web.Extensions.dll ^
  client2\GomokuForm.cs client2\ScoredPoint.cs client2\NetClient.cs client2\NetDialog.cs
```

## 说明

- 客户端源码以原 exe 反编译源码为底稿（`orig/src/`），原版 UI 绘制、棋盘布局、AI 逻辑（简单/中等/困难）未做任何改动，仅新增在线对战模式与连接对话框；
- 人机、双人模式与原版行为完全一致。
