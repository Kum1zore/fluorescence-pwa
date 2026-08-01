# 技术规范 — 荧光检测平台

## 技术栈

| 层面 | 技术 |
|------|------|
| 页面结构 | HTML5 单页应用（多个 `<section>` 切换） |
| 样式 | CSS3（CSS 自定义属性做主题变量） |
| 逻辑 | 原生 JavaScript（ES6+），无框架 |
| 相机 | `MediaDevices.getUserMedia()` API |
| 图像处理 | Canvas 2D API（`getImageData` / `putImageData`） |
| 本地存储 | IndexedDB |
| 离线缓存 | Service Worker（Cache API） |
| 应用安装 | Web App Manifest（PWA） |

## 为什么不用框架？

- 项目功能集中在 Canvas 图像处理，不涉及复杂的 UI 状态管理
- 零依赖，不需要 npm/webpack 等构建工具
- 减少文件体积，加快加载速度
- 用户作为初学者，后续维护修改门槛低

## 脚本加载顺序

```
constants.js  →  ui.js  →  storage.js  →  camera.js
                                        →  roi.js
                                        →  imageProc.js  →  pseudocolor.js
                                        →  results.js
→  app.js  (最后加载，依赖以上所有)
```

不使用 ES modules（`import`/`export`），避免 Service Worker 缓存场景下的 MIME 类型问题。所有函数通过全局作用域共享。

## 模块职责

### `constants.js`
全局常量：主题色板、图像处理参数、数据库名称/版本。

```js
const THEME = {
  bgLight:      '#E3F2FD',
  blueLight:    '#90CAF9',
  blueMid:      '#42A5F5',
  blueDark:     '#1E88E5',
  textDark:     '#0D47A1',
  white:        '#FFFFFF',
  errorRed:     '#E53935',
  successGreen: '#43A047',
  borderGray:   '#BDBDBD'
};

const CONFIG = {
  MAX_DIMENSION: 1024,         // 图像处理前缩放到此最大尺寸
  MEDIAN_KERNEL: 3,            // 中值滤波核大小
  BORDER_FRACTION: 0.05,       // 背景估计使用的边缘比例
  CONTRAST_CLIP_PERCENT: 0.5,  // 直方图拉伸时裁剪的极端值比例
  ROI_MIN_SIZE: 20,            // 最小选区尺寸(px)
  THUMB_WIDTH: 300             // 缩略图宽度
};

const DB_NAME = 'fluorescenceDB';
const DB_VERSION = 1;
const STORE_NAME = 'records';
```

### `ui.js`
- `showPage(pageId)` — 隐藏所有 `.page`，显示指定页面
- `showToast(message, duration)` — 底部弹出提示，自动消失
- `showLoading(show)` — 全屏加载遮罩
- `formatDate(isoStr)` — ISO 时间戳转中文日期格式
- `formatNumber(n)` — 数字千分位格式化

### `camera.js`
- `initCamera(videoEl)` → `Promise<MediaStream>` — 请求后置摄像头
  - 优先 `facingMode: { exact: 'environment' }`
  - 失败则降级为任意摄像头
  - 失败则提示用户并返回开始页
- `stopCamera(stream)` — 释放摄像头
- `capturePhoto(videoEl, canvas)` — 将视频帧绘制到 Canvas，返回该 Canvas

### `roi.js`
- `initROISelection(imageCanvas, overlayCanvas, onROIChange)` — 绑定触摸事件
  - `touchstart`：记录起点
  - `touchmove`：实时绘制矩形
  - `touchend`：确定选区，回调 onROIChange
- `getROI()` → `{x, y, width, height}` — 获取当前选区坐标
- `clearROI()` — 清除选区
- 选框样式：`#42A5F5` 虚线，3px 宽，白色半透明填充

### `imageProc.js`
全部为纯函数，接受 `ImageData`，返回 `ImageData` 或统计结果：

- `grayscale(imageData)` → `ImageData`
- `medianFilter(imageData, kernelSize)` → `ImageData`
- `histogramStretch(imageData, clipPercent)` → `ImageData`
- `subtractBackground(imageData, borderFraction)` → `ImageData`
- `processPipeline(imageData)` → `{ processedData, stats: { mean, integrated } }`
  — 串联上述四步 + 统计计算
- `processROI(imageData, roi)` → `{ ... }` — 仅处理 ROI 子区域

### `pseudocolor.js`
- `createThermalLUT()` → `Array<[R,G,B]>` — 生成 256 条目热力图查找表
- `applyPseudocolor(grayImageData, lut)` → `ImageData` — 应用伪彩色

### `storage.js`
- `initDB()` → `Promise<IDBDatabase>`
- `saveRecord({ timestamp, originalThumb, processedThumb, roi, meanIntensity, integratedDensity })` → `Promise<id>`
- `getAllRecords()` → `Promise<Array>`
- `getRecord(id)` → `Promise<Object>`
- `deleteRecord(id)` → `Promise`
- `clearAll()` → `Promise`

### `results.js`
- `displayResults(record)` — 渲染结果页
- `setupAnalyzeButton()` — 绑定"开始分析"按钮的完整流程

### `app.js`
- `DOMContentLoaded` 后执行：
  1. 注册 Service Worker
  2. 初始化 IndexedDB
  3. 绑定导航按钮事件
  4. 显示开始页

## Service Worker 策略

- **Install**：预缓存所有静态资源（HTML、CSS、JS、图标）
- **Activate**：清理旧版本缓存
- **Fetch**：缓存优先（Cache First），缓存未命中时请求网络并缓存

## 数据存储

### IndexedDB: `fluorescenceDB` v1

Object Store: `records`，keyPath: `id`（自增）

```
{
  id: number,
  timestamp: string (ISO 8601),
  dateLabel: string (中文格式),
  originalThumb: string (base64 JPEG, max 300px wide),
  processedThumb: string (base64 JPEG, max 300px wide),
  roi: { x: number, y: number, width: number, height: number },
  meanIntensity: number,
  integratedDensity: number
}
```

索引：`timestamp`（用于按时间排序）

## PWA Manifest 关键配置

```json
{
  "name": "荧光检测平台",
  "short_name": "荧光检测",
  "start_url": "./index.html",
  "display": "standalone",
  "theme_color": "#1E88E5",
  "background_color": "#E3F2FD",
  "orientation": "portrait"
}
```

## 错误处理策略

| 场景 | 处理 |
|------|------|
| 摄像头权限被拒 | Toast 提示 + 返回开始页 |
| 摄像头不可用 | Toast 提示 + 返回开始页 |
| IndexedDB 打开失败 | Toast 警告，历史记录功能不可用，检测功能正常 |
| 图像处理异常 | Toast 提示"处理失败，请重试" |
| 存储空间不足 | Toast 提示"存储空间不足，请清理历史记录" |
| Service Worker 注册失败 | 静默失败，在线功能不受影响 |
