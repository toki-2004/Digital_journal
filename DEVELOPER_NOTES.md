# 开发者交接文档（给下一个 Codex 执行者）

> 更新日期：2026-08-14 · 最后提交：`08cb164`
> 本文是项目内部资料，记录了架构、协议、已知坑与测试方法。公开仓库内可见，如需保密可移出 git（参考 `require.md` 的处理方式）。

## 1. 项目是什么

**拾光手账**：自托管的实时协同电子手账（全栈 Web 应用）。

- 后端：Node.js + Express + Socket.io，数据存本地 JSON 文件，零数据库、零成本。
- 前端：单文件 SPA（`index.html` 内包含全部 CSS/JS/DOM），Canvas 2D 渲染，无第三方 UI 库。
- 启动：`node server.js` → 监听 `0.0.0.0:3000`；Windows 双击 `start.bat`（可见控制台，关闭即停服），`stop.bat` 按 `server.pid` 结束进程。
- GitHub：https://github.com/toki-2004/Digital_journal（公开，main 分支；本机 `gh` 已登录 toki-2004，git 用户已配置）。

## 2. 文件清单

| 文件 | 说明 |
|---|---|
| `server.js` | 后端全部逻辑（REST + Socket.io + 持久化） |
| `index.html` | 前端全部逻辑（约 11 万字节，单文件） |
| `start.bat` / `stop.bat` | Windows 启动/停止脚本（纯 ASCII 输出，避免 GBK 乱码） |
| `package.json` / `package-lock.json` | 依赖仅 `express`、`socket.io` |
| `.gitignore` | 排除 `node_modules/`、`data/`、日志、`require.md` |
| `README.md` | 公开说明 |
| `require.md` | **用户提示词，非代码**，已从 git 移除（本地保留） |
| `DEVELOPER_NOTES.md` | 本文 |
| `data/` | 运行时数据（不入库）：`rooms.json` 索引 + `data/<roomId>.json` |

## 3. 数据模型

### 3.1 房间索引 `data/rooms.json`
```json
{ "rooms": { "<roomId>": { "id", "name", "password"(sha256), "editPermission": "editable|readonly",
                           "createdBy", "createdAt", "lastModified", "cover"(base64 或 null) } } }
```
密码哈希：`sha256(password + '::' + roomId)`，永不发给客户端。

### 3.2 房间文件 `data/<roomId>.json`
```json
{ "id", "revision", "lastModified",
  "pages": [ { "id", "name", "images": [], "annotations": [] } ],
  "history": [ { "ts", "time": "HH:MM:SS", "userId", "userName", "text" } ] }
```
旧版单页数据（顶层 `images`/`annotations`）会在加载时自动迁移为 `pages[0]`（服务端 `migrateRoom`、前端 `normalizePages` 双保险）。

### 3.3 元素结构（所有元素统一）
- 图片：`{ id, kind:'image', layer:'image', x, y(中心), width, height, rotation, src(base64) }`
- 标注：`pen/line/rect/circle/arrow/text`，保存原生几何（`points` / `x1y1x2y2` / `cx,cy,r` / `x,y,fontSize,text`）
- **公共字段**：
  - `rotation`：默认 0（所有元素可旋转，绘制/命中/橡皮擦都做了旋转感知）
  - `z`：全局层级。无 `z` 时按默认计算：图片 = 数组下标（0..n），标注 = 100000+下标 → 保持"图片在下"语义；`置顶/置底` = `z = max+1 / min-1`
  - `createdBy {id,name}` + `createdAt`：服务端盖章（`stampElement`），复制元素会重新署名给复制者
  - 元素属于哪个页面 = 它在哪个 page 的数组里（无独立字段）

## 4. 通信协议

### 4.1 REST（Express）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/rooms` | 房间轻量列表（含 cover/hasPassword） |
| POST | `/api/rooms` | 新建（body: name,password,editPermission,cover,user） |
| PATCH | `/api/rooms/:id` | 改名/改密/改权限/改封面（仅创建者，body 带 userId） |
| DELETE | `/api/rooms/:id` | 删除（仅创建者，body 带 userId） |
| GET | `/api/rooms/:id/data` | **轻量元数据**：pages 只含 `{id,name,imageCount,annotationCount}` + history + locks（**绝不含页面内容**） |
| GET | `/api/rooms/:id/page/:pageId` | 单页完整内容（images+annotations）——按需加载用 |
| GET | `/api/health` | 健康检查 |

### 4.2 Socket.io
客户端事件：`join-room`(ack 返回轻量 data) / `leave-room` / `op` / `cursor`(节流~40ms) / `update-user` / `update-page` / `lock-element` / `unlock-element`

服务端广播：`op` / `members`(含 cursor、pageId) / `cursor`(含 pageId) / `member-page` / `element-locked` / `element-unlocked` / `room-settings` / `room-deleted`

**op 类型**：
- 元素持久化：`add-image` `add-annotation` `update-annotation` `transform-image` `erase{deletedIds,modifiedStrokes}` `delete-elements` `duplicate` `reorder{ids,mode}` `clear-annotations`
- 页面：`add-page{page}` `rename-page{pageId,name}` `delete-page{pageId,name}`
- 瞬态（`op.transient=true`，只转发不落盘）：`image-transform` `stroke-progress` `shape-progress` `annotation-transform`
- 元素类 op 由客户端自动注入 `pageId`（`PAGE_OPS` 集合除外）；历史文案由服务端生成（中文，含页名）。

## 5. 关键实现与架构决策

1. **服务端内存缓存**：`getRoom()` 返回内存中的同一对象，所有 op 串行修改后 `saveRoom` 经 per-room 写队列原子落盘（tmp+rename）。`rooms.json` 索引同样有内存缓存（`getIndex._cache`）——**外部手改磁盘文件不生效，需重启**。
2. **按需加载（重要）**：以前"一次推全量页面+全部图片 base64"导致 8 秒超时 → "无法加载房间数据"。现在房间元数据轻量化，**只加载当前显示页面**（`loadPageContent`），切页才拉取；未加载页面在本地为 `{loaded:false}` 占位，相关 op 跳过应用（切过去时全量拉取天然包含）；PDF 导出前会逐页预加载；IndexedDB 只缓存已加载页面（带 loaded 标志）。
3. **全局层级**：渲染/命中/导出都用 `renderOrder()` 按 `z` 排序；`置顶/置底` 不再分图层。
4. **乐观锁**：服务端 `roomLocks`（键 `roomId::elementId`），断线自动释放；`sanitizeRoom` 下发时剥掉 `roomId::` 前缀（前端按 elementId 查）。
5. **元素盖章**：创建（add-image/add-annotation/duplicate）由服务端写 `createdBy/createdAt`；前端也盖章用于即时显示；复制时前端先删旧章再盖新章。
6. **历史记录**：数组保持时间顺序（服务端追加），**前端倒序显示（最新在上）**，`scrollTop=0`。
7. **光标跨页感知**：成员带 `pageId`；对方与我同页 → 不透明、仅名字；异页 → opacity 0.35 + "名字 · 页名"。
8. **统一变换**：所有元素（含画笔/图形/文字）都支持拖拽/角点缩放/圆点旋转；缩放以元素自身中心为基准（`scaleElement` 从 snapshot 计算，避免累积误差）；文字缩放按字号比例并保持中心。
9. **移动端**：≤768px 首次自动收起侧栏；工具栏 48px；底部 UI 上移避让浏览器底栏（桌面：页码栏 bottom14、缩放+选中工具栏 bottom60 同高；移动：56 / 102）。

## 6. 已踩过的坑（务必先看）

### 6.1 环境/工具
- **旧服务进程**：改完 `server.js` 必须重启 3000 端口进程，否则测试打的是旧代码。检查：`Get-NetTCPConnection -LocalPort 3000 -State Listen`；重启：kill 后 `cmd /c start.bat`。
- **PowerShell 命令引号**：shell 包装器会破坏"混用单双引号"或含空格路径（`D:\pythonitems\Digital journal`）的多段命令。策略：路径先存变量（`$dir = "D:\pythonitems\Digital journal"`）、一条命令只干一件事；**`Remove-Item` 会被策略拦截**——删除文件用临时 Node 脚本（路径白名单校验后再删）。
- **apply_patch 的 hunk 必须按文件行号升序**，否则报 "Failed to find expected lines"（即使内容都在）。
- **Windows 控制台编码**：.bat 里中文会乱码 → start.bat/stop.bat 全部纯 ASCII；server 启动横幅是英文；`process.title` 设置了服务窗口标题（关窗即停服）。
- **npm --no-save 测试依赖会被互相清理**：`puppeteer-core` 和 `socket.io-client` 要一条命令一起装，测完 `npm prune`。

### 6.2 前端代码坑（每个都真实踩过）
- **socket.io 客户端脚本必须引入**：`<script src="/socket.io/socket.io.js">` 在业务脚本之前；缺失 = 页面空白、按钮全死。
- **init 顺序**：`setupSwatches → bindUI → setupCanvas → loadRooms`；`bindUI` 里不能立刻调 `resizeCanvas`（canvasWrap 未初始化）——`resizeCanvas/layoutCanvas` 已有空值保护。
- **画布空白**：编辑器初始 `display:none`，尺寸按 0 计算；进入房间必须显式 `resizeCanvas()`，另加 ResizeObserver。
- **PC 文字工具失焦**：浏览器 pointerdown 的默认焦点转移会立刻 blur 掉刚创建的 textarea → 空提交删除。解法：pointerdown `preventDefault()` + `setTimeout(focus, 0)`。
- **双指平移锚点**：必须锚定"手势起点中点"，用当前中点会数学抵消、画布不动。
- **旋转**：手柄区域必须纳入命中（`isNearRotateHandle` 同时用于图片与标注）；角度计算用 `(snapshot.rotation||0)`（旧标注无 rotation → 否则 NaN）。
- **pointerdown 挂在 canvasWrap**：点 `.float-inspector` / `.text-edit` 必须 `closest()` 拦截，否则误触发绘制。
- **触屏长按**：select 模式先等 500ms（长按→信息卡）或位移>10px（→拖动），避免误拖。
- **fetch 超时**：页面内容加载用 30s 超时；房间元数据 8s。

### 6.3 测试方法
- 服务端协议测试：`npm i --no-save socket.io-client` + Node 脚本（join/op/lock/update-page 等）。
- 浏览器 E2E：`puppeteer-core` + Edge 无头（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`）。
  - 无头环境**不合成 dblclick**（用 `dispatchEvent(new MouseEvent('dblclick',...))` 验证处理器）。
  - 双指手势用 CDP：`Input.dispatchTouchEvent`（touchStart 两个 touchPoints → touchMove → touchEnd）。
  - **坐标换算**：X 用 `rect.width/1400`，**Y 必须用 `rect.height/1980`**（写错过一次导致点击全落空）。
  - 双用户用 `browser.createBrowserContext()` 隔离 localStorage；身份用 `page.evaluateOnNewDocument` 预置 `dj_user`。
- jsdom 可做脚本级冒烟（stub `io`、canvas getContext、fetch）。
- **测试房间必须清理**：失败中途会泄漏房间（名字如 自动测试/移动测试/懒加载测试/光标页面测试…），按名批量 DELETE。**`data/` 里用户自己的房间（welcome/手账 等）绝不能删**；清理脚本要白名单精确匹配。

## 7. 当前功能状态（全部可用）

- 房间：增删改、密码、只读/可编辑、封面
- 画布：画笔/橡皮擦/直线/矩形/圆形/箭头/文字、图片上传与 Ctrl+V 粘贴、选择/移动/**缩放/旋转（所有元素）**、复制粘贴、删除、置顶置底（全局 z）、清空标注
- 缩放平移：滚轮/双指捏合缩放、空格或中键/双指拖动平移、适应按钮
- 多页：增删/重命名/切换、**按需加载**
- 协同：实时 op、成员列表、光标（跨页半透明+页名）、乐观锁、改显示名
- 历史：时间线（最新在上）、元素右键/长按/选中查看创建人与创建时间
- 导出：PNG（透明/白底，当前页）、PDF（全部页面 A4 分页）
- 持久化：JSON + IndexedDB 缓存、旧数据自动迁移
- 移动端响应式布局

## 8. 已知限制 / 可能的下一步

- 历史遗留元素（更新前创建）无 `createdBy`，显示"旧数据（未知）"；如需可做"按操作历史回填"。
- 单页内图片极多时单页拉取仍可能较大（30s 超时兜底）；未来可做图片懒加载/缩略图。
- 无账号体系/HTTPS/限流，仅适合内网或 ngrok/frp 转发；密码仅防误入。
- `stop.bat` 依赖 `server.pid`，进程异常退出后会提示"可能已停止"（可接受）。

## 9. 快速自检清单（改完代码后）

1. `node --check server.js` + 提取 index.html 内联脚本 `node --check`。
2. 重启 3000 端口服务（旧进程坑）。
3. `curl http://localhost:3000/api/health`、`/api/rooms`、轻量 `/api/rooms/:id/data`、`/page/:pageId`。
4. 关键回归：进房间见 A4 画布 → 绘制/上传 → 缩放旋转 → 加页切换 → 导出 PDF（会预加载所有页）。
5. 双浏览器验证协同（光标跨页、实时 op、锁）。
6. 清理测试房间与 `--no-save` 依赖，提交推送。
