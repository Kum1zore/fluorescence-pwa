// ========================================
// 结果展示 — 荧光检测平台
// ========================================

// ---- 显示检测结果 ----
function displayResults(record) {
  // 荧光数据
  document.getElementById('stat-mean').textContent = formatNumber(record.stats.meanIntensity);
  document.getElementById('stat-integrated').textContent = formatNumber(record.stats.integratedDensity);

  // 相对荧光强度 I_rel = (ROI - 背景) / 背景 —— 跨设备可比的核心指标
  // 内部按比值存储（0.35 表示比背景亮 35%），展示时换算成百分比
  var relEl = document.getElementById('stat-relative');
  var rel = record.relativeIntensity;
  if (typeof rel === 'number' && isFinite(rel)) {
    relEl.textContent = formatNumber(rel * 100);
  } else {
    relEl.textContent = '--';   // 旧记录 / 校准未生效
  }

  // 曝光质量提示
  var warnEl = document.getElementById('quality-warning');
  var exp = record.exposure;
  if (exp && exp.status && exp.status !== 'ok' && exp.message) {
    warnEl.textContent = '⚠ ' + exp.message;
    warnEl.style.display = 'block';
  } else {
    warnEl.textContent = '';
    warnEl.style.display = 'none';
  }

  // ROI 尺寸、时间、校准状态
  document.getElementById('results-roi-size').textContent =
    'ROI: ' + record.roi.width + '×' + record.roi.height + ' px';
  document.getElementById('results-time').textContent =
    '时间: ' + formatDate(record.timestamp);
  document.getElementById('results-calibration').textContent =
    describeCalibration(record.calibration);

  // 重置标签为"原图"
  document.getElementById('tab-original').classList.add('active');
  document.getElementById('tab-pseudocolor').classList.remove('active');

  // 默认显示原图
  drawResultImage(record.originalCrop);
}

// ---- 将 ImageData 绘制到结果页 Canvas ----
function drawResultImage(imageData) {
  var canvas = document.getElementById('results-image-canvas');
  if (!canvas || !imageData) {
    console.warn('[Results] drawResultImage — canvas 或 imageData 为空', !!canvas, !!imageData);
    return;
  }

  var srcW = imageData.width;
  var srcH = imageData.height;
  if (!srcW || !srcH) {
    console.warn('[Results] drawResultImage — 尺寸为零', srcW, srcH);
    return;
  }

  // 调试：检查前10个像素值
  var samplePixels = [];
  for (var si = 0; si < Math.min(40, imageData.data.length); si++) {
    samplePixels.push(imageData.data[si]);
  }
  console.log('[Results] drawResultImage — ImageData:', srcW + '×' + srcH,
    'data.length=' + imageData.data.length,
    '前40字节:', samplePixels.join(','));

  // 计算缩放以适配显示区域
  var container = canvas.parentElement;
  var containerW = container ? container.clientWidth : 0;
  console.log('[Results] drawResultImage — container.clientWidth=' + containerW,
    'window.innerWidth=' + window.innerWidth);
  // 容器可能尚未显示，取 window 宽度作为回退
  if (!containerW || containerW < 10) {
    containerW = window.innerWidth - 32;
  }
  var maxW = Math.max(100, containerW - 32);
  var maxH = 300;

  var scale = Math.min(maxW / srcW, maxH / srcH, 1);
  // 保护：确保 scale 不为负数或 NaN
  if (scale <= 0 || !isFinite(scale)) scale = 1;

  var dstW = Math.max(1, Math.round(srcW * scale));
  var dstH = Math.max(1, Math.round(srcH * scale));

  console.log('[Results] drawResultImage — maxW=' + maxW, 'maxH=' + maxH,
    'scale=' + scale, 'dstW=' + dstW, 'dstH=' + dstH);

  canvas.width = dstW;
  canvas.height = dstH;

  // 先绘制到临时 Canvas
  var temp = document.createElement('canvas');
  temp.width = srcW;
  temp.height = srcH;
  try {
    temp.getContext('2d').putImageData(imageData, 0, 0);
  } catch (e) {
    console.error('[Results] putImageData 失败:', e.message);
    return;
  }

  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, dstW, dstH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(temp, 0, 0, dstW, dstH);

  console.log('[Results] drawResultImage — 绘制完成, canvas尺寸=' + canvas.width + '×' + canvas.height);
}
