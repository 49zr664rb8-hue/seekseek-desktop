# seekseek desktop

第三方 DeepSeek 桌面客户端。界面用官方开源的 chat-demo 前端，后端接**任意 OpenAI 兼容服务商**——本地 Ollama、局域网机器、或者云端 API 都行。

> 宣传视频：https://www.bilibili.com/video/BV1wzsU6MEsH/

## 特性

- **官方界面**：完整复用 DeepSeek chat-demo 的界面，markdown、代码块、会话历史都在
- **任意服务商**：填地址、模型名、API Key 即可，不绑定任何一家
- **流式输出**：逐字显示，支持思考过程（R1 系列的 `reasoning_content`）
- **联网搜索**：代理自己抓 Bing 结果并注入上下文，任何模型都能用，不依赖模型本身的工具调用能力
- **朗读**：调用 Windows 系统语音（SAPI），可选任意已安装的中文音色
- **桌宠**：可选的桌面挂件，安装时可跳过
- **数据独立**：配置和历史存在 `%APPDATA%\DeepSeekPublic`，不干扰官方客户端

## 下载

到 [Releases](../../releases) 下载 `seekseek-Setup-x.x.x.exe`，双击安装即可。

不需要装 Node.js，不需要执行任何命令，桌宠和全部功能都已打包在安装程序里。

首次启动会让你填服务商：

| 字段 | 示例 |
|---|---|
| 服务商地址 | `http://127.0.0.1:11434/v1`（Ollama）或 `https://api.deepseek.com/v1` |
| 模型 | `deepseek-r1:8b`，留空则自动选第一个 |
| API Key | 本地服务随便填，云端填真 Key |

## 从源码构建

> 只有想自己改代码、自己打包的人才需要看这一节。普通用户请直接用上面的安装包。

需要 Node.js 18+。

```bash
npm install
npm install --prefix vendor/dsh-pet   # 桌宠的依赖（体积大，没进 git）
npm start                             # 开发运行
npm run dist                          # 打包成安装程序，产物在 dist/
```

## 项目结构

```
src/main/main.js     主进程：窗口、托盘、设置、朗读、桌宠
src/main/proxy.js    本地代理：Anthropic 协议 → OpenAI 协议，含联网搜索
renderer/            官方 chat-demo 前端产物（MIT，见 renderer/LICENSE）
assets/              图标与托盘图
build/               打包配置（NSIS 脚本、安装图标）
```

前端和代理之间走 `127.0.0.1:8788`，网页和 API 同源，不涉及跨域。

## 说明

- 本项目是**第三方客户端**，与 DeepSeek 官方无关，不代表官方立场
- `renderer/` 内的前端产物来自官方开源的 chat-demo，遵循其 MIT 许可证，版权归 DeepSeek 所有
- 桌宠（`vendor/dsh-pet`，MIT）的 `node_modules` 没进 git，构建前需要 `npm install --prefix vendor/dsh-pet`

## 许可证

MIT，见 [LICENSE](LICENSE)。
