# Digital journal（拾光手账）

自托管的实时协同电子手账，全栈 Web 应用。后端 Node.js + Express + Socket.io，前端单页应用（Canvas 2D，无第三方 UI 库），数据存于本地 JSON 文件，无需数据库、零成本运行。

## 功能

- 多账本（房间）管理：新建 / 重命名 / 删除，访问密码，可编辑 / 只读权限
- 实时协同：多人同时编辑，画布操作实时同步，在线成员与光标跟随，元素乐观锁
- 多页手账：增删 / 重命名 / 切换页面，每页独立的图片层与标注层
- 绘图工具：画笔、橡皮擦（仅擦标注）、直线 / 矩形 / 圆形 / 箭头、文字、图片上传与剪贴板粘贴
- 元素效果：阴影 / 描边（强度可调，图片 / 文字 / 笔迹 / 图形通用，支持多选批量应用）
- 缩放：桌面端滚轮缩放，移动端双指缩放 / 平移
- 导出：高清 PNG（透明 / 白底）、PDF（A4 分页，全部页面）
- 容灾：每次操作立即写入 `./data/` JSON 文件，浏览器端另有 IndexedDB 缓存

## 启动

```bash
npm install express socket.io
node server.js
```

浏览器打开 <http://localhost:3000>。Windows 下可直接双击 `start.bat`（可见控制台，关闭即停止；`stop.bat` 可关闭服务）。

对外分享：`ngrok http 3000` 或使用 frp 转发 3000 端口。

## 数据

所有手账数据保存在 `./data/` 目录下的 JSON 文件中，删除该目录即清空全部数据。

## License

MIT License，详见 [LICENSE](LICENSE)。
