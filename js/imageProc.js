// ========================================
// 图像处理核心 — 荧光检测平台
// ========================================

// ---- 步骤 1：加权灰度转换（ITU-R BT.601） ----
function grayscale(imageData) {
  var data = imageData.data;
  for (var i = 0; i < data.length; i += 4) {
    var r = data[i], g = data[i + 1], b = data[i + 2];
    // NaN 防护
    if (!isFinite(r)) r = 0;
    if (!isFinite(g)) g = 0;
    if (!isFinite(b)) b = 0;
    var gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    if (gray < 0) gray = 0;
    if (gray > 255) gray = 255;
    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
  }
  return imageData;
}

// ---- 步骤 2：3×3 中值滤波 ----
function medianFilter(imageData, kernelSize) {
  kernelSize = kernelSize || CONFIG.MEDIAN_KERNEL; // 默认 3
  var src = imageData.data;
  var w = imageData.width;
  var h = imageData.height;
  var output = new Uint8ClampedArray(src.length);
  var half = Math.floor(kernelSize / 2);

  // 复制 alpha 通道
  for (var i = 0; i < src.length; i += 4) {
    output[i + 3] = src[i + 3];
  }

  // 边界像素（half 宽度）直接复制
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      if (x < half || x >= w - half || y < half || y >= h - half) {
        var idx = (y * w + x) * 4;
        output[idx] = src[idx];
        output[idx + 1] = src[idx + 1];
        output[idx + 2] = src[idx + 2];
      }
    }
  }

  // 3×3 中值滤波
  var neighbors = new Array(kernelSize * kernelSize);
  for (var y = half; y < h - half; y++) {
    for (var x = half; x < w - half; x++) {
      var k = 0;
      for (var dy = -half; dy <= half; dy++) {
        for (var dx = -half; dx <= half; dx++) {
          var nIdx = ((y + dy) * w + (x + dx)) * 4;
          neighbors[k] = src[nIdx]; // 灰度值（R=G=B 取任意通道即可）
          k++;
        }
      }
      // 排序取中位数
      neighbors.sort(function(a, b) { return a - b; });
      var median = neighbors[Math.floor(neighbors.length / 2)];

      var idx = (y * w + x) * 4;
      output[idx] = median;
      output[idx + 1] = median;
      output[idx + 2] = median;
    }
  }

  return new ImageData(output, w, h);
}

// ---- 步骤 3：直方图拉伸（对比度增强） ----
function histogramStretch(imageData, clipPercent) {
  clipPercent = (clipPercent !== undefined) ? clipPercent : CONFIG.CONTRAST_CLIP_PERCENT;
  var data = imageData.data;
  var totalPixels = data.length / 4;

  // 建直方图，跳过 NaN
  var hist = new Array(256);
  for (var b = 0; b < 256; b++) { hist[b] = 0; }
  for (var i = 0; i < data.length; i += 4) {
    var pv = data[i];
    if (!isFinite(pv)) { data[i] = data[i+1] = data[i+2] = 0; pv = 0; }
    if (pv < 0) pv = 0;
    if (pv > 255) pv = 255;
    hist[Math.round(pv)]++;
  }

  // 从暗端裁剪
  var clipCount = Math.floor(totalPixels * clipPercent / 100);
  var minVal = 0;
  var sum = 0;
  while (sum < clipCount && minVal < 255) {
    sum += hist[minVal];
    minVal++;
  }

  // 从亮端裁剪
  var maxVal = 255;
  sum = 0;
  while (sum < clipCount && maxVal > 0) {
    sum += hist[maxVal];
    maxVal--;
  }

  // 线性拉伸
  var range = maxVal - minVal;
  if (range <= 0) {
    // 图像完全均匀
    for (var i = 0; i < data.length; i += 4) {
      data[i] = 128;
      data[i + 1] = 128;
      data[i + 2] = 128;
    }
  } else {
    var scale = 255 / range;
    for (var i = 0; i < data.length; i += 4) {
      var stretched = Math.round((data[i] - minVal) * scale);
      var clamped = stretched < 0 ? 0 : (stretched > 255 ? 255 : stretched);
      data[i] = clamped;
      data[i + 1] = clamped;
      data[i + 2] = clamped;
    }
  }

  return imageData;
}

// ---- 步骤 4：边缘背景扣除 ----
function subtractBackground(imageData, borderFraction) {
  borderFraction = (borderFraction !== undefined) ? borderFraction : CONFIG.BORDER_FRACTION;
  var data = imageData.data;
  var w = imageData.width;
  var h = imageData.height;
  var border = Math.floor(Math.min(w, h) * borderFraction);
  if (border < 1) border = 1;

  // 收集边缘像素均值
  var bgSum = 0;
  var bgCount = 0;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      if (x < border || x >= w - border || y < border || y >= h - border) {
        var idx = (y * w + x) * 4;
        bgSum += data[idx];
        bgCount++;
      }
    }
  }

  if (bgCount === 0) return imageData;
  var bgMean = bgSum / bgCount;

  // 减去背景
  for (var i = 0; i < data.length; i += 4) {
    if (!isFinite(data[i])) { data[i] = data[i+1] = data[i+2] = 0; continue; }
    var newVal = Math.round(data[i] - bgMean);
    if (newVal < 0) newVal = 0;
    if (newVal > 255) newVal = 255;
    data[i] = newVal;
    data[i + 1] = newVal;
    data[i + 2] = newVal;
  }

  return imageData;
}

// ---- ROI 统计计算 ----
function calculateStats(imageData, roi) {
  var data = imageData.data;
  var w = imageData.width;
  var h = imageData.height;

  // 整数化 ROI 坐标，防止浮点精度导致越界
  var rx = Math.round(roi.x);
  var ry = Math.round(roi.y);
  var rw = Math.round(roi.width);
  var rh = Math.round(roi.height);

  // 钳制到图像边界内
  if (rx < 0) { rw += rx; rx = 0; }
  if (ry < 0) { rh += ry; ry = 0; }
  if (rx + rw > w) rw = w - rx;
  if (ry + rh > h) rh = h - ry;
  if (rw <= 0 || rh <= 0) return { meanIntensity: 0, integratedDensity: 0 };

  var sum = 0;
  var count = 0;

  for (var y = ry; y < ry + rh; y++) {
    for (var x = rx; x < rx + rw; x++) {
      var idx = (y * w + x) * 4;
      var val = data[idx];
      // 跳过 NaN / Infinity（异常数据）
      if (!isFinite(val)) continue;
      sum += val;
      count++;
    }
  }

  return {
    meanIntensity: count > 0 ? sum / count : 0,
    integratedDensity: sum
  };
}

// ---- 完整处理流水线 ----
// 返回 { processedData: ImageData, stats: { meanIntensity, integratedDensity } }
function processPipeline(imageData, roi) {
  // 复制输入数据（流水线会原地修改，保留原始数据）
  var w = imageData.width;
  var h = imageData.height;
  var copy = new ImageData(new Uint8ClampedArray(imageData.data), w, h);

  // 输入数据验证：扫描并清除 NaN/Infinity
  var cdata = copy.data;
  for (var i = 0; i < cdata.length; i++) {
    if (!isFinite(cdata[i])) { cdata[i] = 0; }
  }

  // 1. 灰度转换
  grayscale(copy);

  // 2. 中值滤波
  copy = medianFilter(copy);

  // 3. 直方图拉伸
  histogramStretch(copy);

  // 4. 背景扣除
  subtractBackground(copy);

  // 5. 统计计算
  var roiRect = roi || { x: 0, y: 0, width: w, height: h };
  var stats = calculateStats(copy, roiRect);

  return {
    processedData: copy,
    stats: stats
  };
}

// ---- 仅处理 ROI 子区域 ----
// 从完整图像中裁剪 ROI 区域，返回该区域的处理结果
function processROI(imageData, roi) {
  return processPipeline(imageData, roi);
}
