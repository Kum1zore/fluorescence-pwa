// ========================================
// ROI 矩形选区交互 — 荧光检测平台
// 同时支持触摸事件（手机）和鼠标事件（桌面调试）
// ========================================

var _roi = null;          // {x, y, width, height} in canvas coordinates
var _isDragging = false;
var _startX = 0;
var _startY = 0;
var _onROIChange = null;
var _overlayCanvas = null;
var _roiCanvas = null;    // 当前绑定的 overlay canvas 引用

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
  overlayCanvas.removeEventListener('mousemove', _handleDragMove);
  overlayCanvas.removeEventListener('mouseup', _handleDragEnd);
  overlayCanvas.removeEventListener('mouseleave', _handleDragEnd);

  // 绑定触摸事件
  overlayCanvas.addEventListener('touchstart', _handleDragStart, { passive: false });
  overlayCanvas.addEventListener('touchmove', _handleDragMove, { passive: false });
  overlayCanvas.addEventListener('touchend', _handleDragEnd);
  overlayCanvas.addEventListener('touchcancel', _handleDragEnd);

  // 绑定鼠标事件（桌面浏览器）
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

// ---- 统一的 drag 开始 ----
function _handleDragStart(e) {
  e.preventDefault();

  var pos = _getClientPos(e);
  if (!pos) return;

  var canvasPos = _cssToCanvas(_roiCanvas, pos.clientX, pos.clientY);

  _startX = canvasPos.x;
  _startY = canvasPos.y;
  _isDragging = true;

  // 清除旧选区
  clearROI();
}

// ---- 统一的 drag 移动 ----
function _handleDragMove(e) {
  if (!_isDragging) return;
  e.preventDefault();

  var pos = _getClientPos(e);
  if (!pos) return;

  var canvasPos = _cssToCanvas(_roiCanvas, pos.clientX, pos.clientY);

  // 计算矩形（支持反向拖动）
  var x = Math.min(_startX, canvasPos.x);
  var y = Math.min(_startY, canvasPos.y);
  var w = Math.abs(canvasPos.x - _startX);
  var h = Math.abs(canvasPos.y - _startY);

  // 钳制到 Canvas 边界内
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.min(w, _roiCanvas.width - x);
  h = Math.min(h, _roiCanvas.height - y);

  _roi = { x: x, y: y, width: w, height: h };
  _drawROI(_roiCanvas);
}

// ---- 统一的 drag 结束 ----
function _handleDragEnd(e) {
  if (!_isDragging) return;
  _isDragging = false;

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

  // 白色半透明填充
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.fillRect(r.x, r.y, r.width, r.height);

  // 蓝色虚线边框
  ctx.strokeStyle = THEME.blueMid;   // #42A5F5
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 4]);
  ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.width - 3, r.height - 3);

  // 恢复实线
  ctx.setLineDash([]);
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
