// ========================================
// ROI 矩形选区交互 — 荧光检测平台
// 同时支持触摸事件（手机）和鼠标事件（桌面调试）
// 支持三种操作：框外拖拽新建选区、框内拖拽平移、拖拽边角手柄缩放
// ========================================

var _roi = null;          // {x, y, width, height} in canvas coordinates
var _isDragging = false;
var _startX = 0;
var _startY = 0;
var _onROIChange = null;
var _overlayCanvas = null;
var _roiCanvas = null;    // 当前绑定的 overlay canvas 引用

// ---- 手柄常量 ----
var HANDLE_DRAW = 10;     // 手柄绘制边长（CSS 像素）
var HANDLE_TOUCH = 18;    // 手柄触摸判定半径（CSS 像素）

// ---- 拖拽模式状态 ----
var _dragMode = null;     // 'new' | 'move' | 'resize'
var _activeHandle = null; // 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
var _roiSnapshot = null;  // 拖拽开始时的 ROI 副本（作为位移/缩放的基准）

// ---- 初始化 ROI 选区 ----
// imageCanvas: 显示照片的 Canvas
// overlayCanvas: 用于绘制选区的透明 Canvas（叠加在图片上方）
// onROIChange(roi | null): 选区变化回调
function initROISelection(imageCanvas, overlayCanvas, onROIChange) {
  _onROIChange = onROIChange || null;
  _overlayCanvas = overlayCanvas;
  _roiCanvas = overlayCanvas;

  // 覆盖层尺寸与图片层一致
  overlayCanvas.width = imageCanvas.width;
  overlayCanvas.height = imageCanvas.height;

  // 清除旧选区
  clearROI();

  // 移除旧监听器（避免重复绑定）
  // 触摸事件
  overlayCanvas.removeEventListener('touchstart', _handleDragStart);
  overlayCanvas.removeEventListener('touchmove', _handleDragMove);
  overlayCanvas.removeEventListener('touchend', _handleDragEnd);
  overlayCanvas.removeEventListener('touchcancel', _handleDragEnd);
  // 鼠标事件
  overlayCanvas.removeEventListener('mousedown', _handleDragStart);
  window.removeEventListener('mousemove', _handleDragMove);
  window.removeEventListener('mouseup', _handleDragEnd);

  // 绑定触摸事件
  overlayCanvas.addEventListener('touchstart', _handleDragStart, { passive: false });
  overlayCanvas.addEventListener('touchmove', _handleDragMove, { passive: false });
  overlayCanvas.addEventListener('touchend', _handleDragEnd);
  overlayCanvas.addEventListener('touchcancel', _handleDragEnd);

  // 绑定鼠标事件（桌面浏览器）
  // 拖动过程绑定在 window 上，避免鼠标移出画布时丢失事件
  overlayCanvas.addEventListener('mousedown', _handleDragStart);
  window.addEventListener('mousemove', _handleDragMove);
  window.addEventListener('mouseup', _handleDragEnd);
}

// ---- 从事件中提取 clientX/clientY（兼容触摸和鼠标） ----
function _getClientPos(e) {
  if (e.touches) {
    // 触摸事件
    if (e.touches.length === 0) return null;
    return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
  }
  // 鼠标事件
  return { clientX: e.clientX, clientY: e.clientY };
}

// ---- 将 CSS 坐标转换为 Canvas 内部坐标 ----
function _cssToCanvas(canvas, clientX, clientY) {
  var rect = canvas.getBoundingClientRect();
  var scaleX = canvas.width / rect.width;
  var scaleY = canvas.height / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY
  };
}

// ---- 计算 Canvas 像素 → CSS 像素的缩放比 ----
// 图片可能被 CSS 缩小显示，绘制手柄和判定命中都需要这个比例
function _canvasScale(canvas) {
  var rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return { sx: 1, sy: 1 };
  return {
    sx: canvas.width / rect.width,
    sy: canvas.height / rect.height
  };
}

// ---- 计算 8 个手柄在 Canvas 坐标中的位置 ----
// 顺序：四角 + 四边中点
function _getHandlePoints(roi) {
  var x0 = roi.x;
  var y0 = roi.y;
  var x1 = roi.x + roi.width;
  var y1 = roi.y + roi.height;
  var mx = roi.x + roi.width / 2;
  var my = roi.y + roi.height / 2;

  return [
    { name: 'nw', x: x0, y: y0 },
    { name: 'n',  x: mx, y: y0 },
    { name: 'ne', x: x1, y: y0 },
    { name: 'e',  x: x1, y: my },
    { name: 'se', x: x1, y: y1 },
    { name: 's',  x: mx, y: y1 },
    { name: 'sw', x: x0, y: y1 },
    { name: 'w',  x: x0, y: my }
  ];
}

// ---- 手柄命中判定 ----
// 在 CSS 坐标空间判定，保证触摸目标大小不随图片缩放变化
// 返回手柄名称，未命中返回 null
function _hitTestHandle(canvas, roi, clientX, clientY) {
  var rect = canvas.getBoundingClientRect();
  var scale = _canvasScale(canvas);
  var pts = _getHandlePoints(roi);

  for (var i = 0; i < pts.length; i++) {
    var hx = rect.left + pts[i].x / scale.sx;
    var hy = rect.top + pts[i].y / scale.sy;
    if (Math.abs(clientX - hx) <= HANDLE_TOUCH && Math.abs(clientY - hy) <= HANDLE_TOUCH) {
      return pts[i].name;
    }
  }
  return null;
}

// ---- 是否点在矩形内部 ----
function _isInsideROI(canvas, roi, clientX, clientY) {
  var p = _cssToCanvas(canvas, clientX, clientY);
  return p.x >= roi.x && p.x <= roi.x + roi.width &&
         p.y >= roi.y && p.y <= roi.y + roi.height;
}

// ---- 将矩形限制在画布范围内 ----
function _clampROI(roi, maxW, maxH) {
  if (roi.width > maxW) roi.width = maxW;
  if (roi.height > maxH) roi.height = maxH;
  if (roi.x < 0) roi.x = 0;
  if (roi.y < 0) roi.y = 0;
  if (roi.x + roi.width > maxW) roi.x = maxW - roi.width;
  if (roi.y + roi.height > maxH) roi.y = maxH - roi.height;
  return roi;
}

// ---- 按手柄调整矩形大小，保持对边固定 ----
// snapshot: 拖拽开始时的矩形；dx/dy: 相对拖拽起点的位移（Canvas 坐标）
function _resizeROI(snapshot, handle, dx, dy, maxW, maxH) {
  var minS = CONFIG.ROI_MIN_SIZE;
  var left = snapshot.x;
  var top = snapshot.y;
  var right = snapshot.x + snapshot.width;
  var bottom = snapshot.y + snapshot.height;

  // 横向：西侧（左边界）或东侧（右边界）
  if (handle === 'nw' || handle === 'w' || handle === 'sw') {
    left = Math.max(0, Math.min(snapshot.x + dx, right - minS));
  } else if (handle === 'ne' || handle === 'e' || handle === 'se') {
    right = Math.min(maxW, Math.max(snapshot.x + snapshot.width + dx, left + minS));
  }

  // 纵向：北侧（上边界）或南侧（下边界）
  if (handle === 'nw' || handle === 'n' || handle === 'ne') {
    top = Math.max(0, Math.min(snapshot.y + dy, bottom - minS));
  } else if (handle === 'sw' || handle === 's' || handle === 'se') {
    bottom = Math.min(maxH, Math.max(snapshot.y + snapshot.height + dy, top + minS));
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}

// ---- 统一的 drag 开始 ----
function _handleDragStart(e) {
  e.preventDefault();

  var pos = _getClientPos(e);
  if (!pos) return;

  var canvasPos = _cssToCanvas(_roiCanvas, pos.clientX, pos.clientY);
  _startX = canvasPos.x;
  _startY = canvasPos.y;

  _activeHandle = null;
  _roiSnapshot = null;

  // 判定优先级：手柄 → 矩形内部 → 空白区域
  if (_roi) {
    var handle = _hitTestHandle(_roiCanvas, _roi, pos.clientX, pos.clientY);
    if (handle) {
      // 拖动边角/边中点：调整大小
      _dragMode = 'resize';
      _activeHandle = handle;
      _roiSnapshot = { x: _roi.x, y: _roi.y, width: _roi.width, height: _roi.height };
      _isDragging = true;
      return;
    }

    if (_isInsideROI(_roiCanvas, _roi, pos.clientX, pos.clientY)) {
      // 拖动矩形内部：整体平移
      _dragMode = 'move';
      _roiSnapshot = { x: _roi.x, y: _roi.y, width: _roi.width, height: _roi.height };
      _isDragging = true;
      return;
    }
  }

  // 空白区域：清除旧选区，重新画框
  _dragMode = 'new';
  _isDragging = true;
  clearROI();
}

// ---- 统一的 drag 移动 ----
function _handleDragMove(e) {
  if (!_isDragging) return;
  e.preventDefault();

  var pos = _getClientPos(e);
  if (!pos) return;

  var canvasPos = _cssToCanvas(_roiCanvas, pos.clientX, pos.clientY);
  var maxW = _roiCanvas.width;
  var maxH = _roiCanvas.height;

  // 模式 1：整体平移，尺寸不变
  if (_dragMode === 'move') {
    _roi = _clampROI({
      x: _roiSnapshot.x + (canvasPos.x - _startX),
      y: _roiSnapshot.y + (canvasPos.y - _startY),
      width: _roiSnapshot.width,
      height: _roiSnapshot.height
    }, maxW, maxH);
    _drawROI(_roiCanvas);
    return;
  }

  // 模式 2：拖动边角调整大小，对边固定
  if (_dragMode === 'resize') {
    _roi = _resizeROI(_roiSnapshot, _activeHandle,
      canvasPos.x - _startX, canvasPos.y - _startY, maxW, maxH);
    _drawROI(_roiCanvas);
    return;
  }

  // 模式 3：拖拽新建选区（原有逻辑）
  var x = Math.min(_startX, canvasPos.x);
  var y = Math.min(_startY, canvasPos.y);
  var w = Math.abs(canvasPos.x - _startX);
  var h = Math.abs(canvasPos.y - _startY);

  // 钳制到 Canvas 边界内
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.min(w, maxW - x);
  h = Math.min(h, maxH - y);

  _roi = { x: x, y: y, width: w, height: h };
  _drawROI(_roiCanvas);
}

// ---- 统一的 drag 结束 ----
function _handleDragEnd(e) {
  if (!_isDragging) return;
  _isDragging = false;
  _dragMode = null;
  _activeHandle = null;
  _roiSnapshot = null;

  // 验证最小尺寸
  if (_roi && _roi.width >= CONFIG.ROI_MIN_SIZE && _roi.height >= CONFIG.ROI_MIN_SIZE) {
    if (_onROIChange) _onROIChange(_roi);
  } else {
    // 太小，清除
    _roi = null;
    if (_overlayCanvas) _clearOverlay();
    if (_onROIChange) _onROIChange(null);
  }
}

// ---- 绘制选区矩形 ----
function _drawROI(canvas) {
  _clearOverlay();
  if (!_roi) return;

  var ctx = canvas.getContext('2d');
  var r = _roi;

  // 按缩放反算绘制尺寸，保证屏幕上看到的粗细/手柄大小恒定
  var scale = _canvasScale(canvas);
  var s = Math.min(scale.sx, scale.sy);
  if (!s || !isFinite(s) || s <= 0) s = 1;

  var lineW = 3 / s;
  var handleSize = HANDLE_DRAW / s;
  var handleHalf = handleSize / 2;

  // 白色半透明填充
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.fillRect(r.x, r.y, r.width, r.height);

  // 蓝色虚线边框
  ctx.strokeStyle = THEME.blueMid;   // #42A5F5
  ctx.lineWidth = lineW;
  ctx.setLineDash([8 / s, 4 / s]);
  ctx.strokeRect(r.x + lineW / 2, r.y + lineW / 2,
                 Math.max(0, r.width - lineW), Math.max(0, r.height - lineW));

  // 恢复实线
  ctx.setLineDash([]);

  // 8 个缩放手柄：白色实心方块 + 蓝色描边
  var pts = _getHandlePoints(r);
  ctx.strokeStyle = THEME.blueMid;
  ctx.lineWidth = 1.5 / s;

  for (var i = 0; i < pts.length; i++) {
    ctx.fillStyle = THEME.white;
    ctx.fillRect(pts[i].x - handleHalf, pts[i].y - handleHalf, handleSize, handleSize);
    ctx.strokeRect(pts[i].x - handleHalf, pts[i].y - handleHalf, handleSize, handleSize);
  }
}

// ---- 清除覆盖层 ----
function _clearOverlay() {
  if (!_overlayCanvas) return;
  var ctx = _overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, _overlayCanvas.width, _overlayCanvas.height);
}

// ---- 获取当前 ROI 坐标 ----
function getROI() {
  return _roi ? { x: _roi.x, y: _roi.y, width: _roi.width, height: _roi.height } : null;
}

// ---- 清除选区 ----
function clearROI() {
  _roi = null;
  _clearOverlay();
}
