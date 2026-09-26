// ========================================
// 自动校准 — 荧光检测平台
// ========================================
// 目标：让不同手机拍出的荧光颜色/强度尽可能一致，减小检测误差
//
// 全自动、零操作。核心思路是「用图像自身的空白基底做参考」：
// 芯片的基底在所有手机上都是同一个物理对象，把它归一到固定值，
// 各设备就被拉齐到同一基准。而且基底与样品在同一帧内，
// 光照、曝光完全一致 —— 这是手动拍白板做不到的。
//
// 三个措施：
//   A2 自动白平衡  — 边缘空白区的各通道均值归一到 TARGET_BG_LEVEL
//   A5 平场校正    — 分块估计并补偿镜头暗角
//   A3 比值归一化  — I_rel = (ROI - 背景) / 背景，对曝光/光源波动免疫
//
// 关键前提：所有增益运算都必须在线性光空间进行。
// sRGB 是显示编码（近似 γ=2.2），直接在 sRGB 值上做除法是错的。
//
// 参考：
//   Microsystems & Nanoengineering (2019) 校正荧光强度 = 测量区均值 - 背景区均值
//   CVAC review, ACA 2015 — ODR = (I_b - I_s) / I_b
//     "minimizes measurement error due to fluctuations in the light source
//      intensity or camera performance"

// ---- sRGB → 线性光 查找表（256 项，惰性构建） ----
var _srgbToLinear = null;

function _buildSRGBLUT() {
  if (_srgbToLinear) return _srgbToLinear;
  var lut = new Float32Array(256);
  for (var i = 0; i < 256; i++) {
    var v = i / 255;
    // sRGB EOTF（反伽马）
    lut[i] = (v <= 0.04045) ? (v / 12.92) : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  _srgbToLinear = lut;
  return lut;
}

// ---- 线性光 → sRGB 值（0~255） ----
function _linearToSRGB(l) {
  if (!(l > 0)) return 0;
  if (l >= 1) return 255;
  var v = (l <= 0.0031308) ? (l * 12.92) : (1.055 * Math.pow(l, 1 / 2.4) - 0.055);
  var out = Math.round(v * 255);
  return out < 0 ? 0 : (out > 255 ? 255 : out);
}

// ---- 线性光 → sRGB 查找表 ----
// 逐像素调用 Math.pow 太慢（1024×768 要 236 万次，占整个校准一半以上时间）。
// 用 4096 级查找表代替：在 [0,1] 上均匀分 4096 格，
// 每格宽度 1/4096 = 0.000244，而 sRGB 编码在最陡处的斜率约 3300/单位，
// 即每格最多跨 0.8 个码值 —— 取整后与直接计算完全一致。
var _linToSRGBLUT = null;

function _buildLinToSRGBLUT() {
  if (_linToSRGBLUT) return _linToSRGBLUT;
  var lut = new Uint8Array(4097);
  for (var i = 0; i <= 4096; i++) {
    lut[i] = _linearToSRGB(i / 4096);
  }
  _linToSRGBLUT = lut;
  return lut;
}

// ---- 线性光亮度（权重与灰度转换保持一致） ----
function _linearLuma(lr, lg, lb) {
  return 0.299 * lr + 0.587 * lg + 0.114 * lb;
}

// ---- 归一化半径平方：画面中心为 0，四角为 1 ----
function _normR2(x, y, w, h) {
  var cx = (w - 1) / 2;
  var cy = (h - 1) / 2;
  var maxR2 = cx * cx + cy * cy;
  if (!(maxR2 > 0)) return 0;
  var dx = x - cx, dy = y - cy;
  return (dx * dx + dy * dy) / maxR2;
}

// ---- 某像素处的平场校正系数 ----
// 必须用「混合后」的系数，才能和真正应用到图像上的校正保持一致。
function _flatFieldFactor(ff, x, y, w, h) {
  var raw = (ff.a + ff.b * _normR2(x, y, w, h)) / ff.mean;
  return 1 + CALIB.FLAT_FIELD_BLEND * (raw - 1);
}

// ---- 从直方图取「裁剪线性均值」（精确值，无分箱量化误差） ----
// 从最暗端开始累加，只取前 (1-trim) 比例的像素求线性光均值。
// 荧光信号是线性光空间里的极亮离群值，裁剪掉最亮的部分即可排除它们。
//
// 按 sRGB 值（0~255）分箱，但箱内累加的是真实的线性光值之和 ——
// 同一箱内所有像素的 sRGB 值相同，线性光值也就完全相同，
// 所以 sum/count 是精确值，不会因为分箱而引入偏差。
// （若直接用箱索引 b/255 当线性值，暗背景会被系统性低估约 2%，
//   这个偏差会 1:1 传导到白平衡增益和 I_rel 上。）
function _trimmedLinearMean(hist, linSum, count, trim) {
  if (count <= 0) return 0;
  var keep = Math.max(1, Math.floor(count * (1 - trim)));
  var sum = 0;
  var n = 0;
  for (var b = 0; b < 256 && n < keep; b++) {
    var c = hist[b];
    if (c === 0) continue;
    var take = Math.min(c, keep - n);
    sum += (linSum[b] / c) * take;
    n += take;
  }
  return n > 0 ? sum / n : 0;
}

// ============================================================
// A2 背景参考估计 + 自动白平衡增益
// ============================================================

// ---- 估计边缘背景区的每通道线性光水平 ----
// ff 不为空时先补偿平场再统计 —— 这一步很关键：
// 镜头暗角会让边缘比中心暗，不补偿的话背景会被系统性低估，
// 白平衡增益就会把整幅图错误地提亮（实测能偏差 40%）。
// 返回 { r, g, b, lum, count }，单位为线性光（0~1）
function estimateBackgroundRef(imageData, borderFraction, ff) {
  var lut = _buildSRGBLUT();
  var data = imageData.data;
  var w = imageData.width;
  var h = imageData.height;
  var border = Math.max(1, Math.floor(Math.min(w, h) * borderFraction));

  var hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
  var sr = new Float64Array(256), sg = new Float64Array(256), sb = new Float64Array(256);
  var count = 0;

  for (var y = 0; y < h; y++) {
    var isTopBottom = (y < border || y >= h - border);
    for (var x = 0; x < w; x++) {
      // 四边条带：上下整行，左右只取边列
      if (!isTopBottom && x >= border && x < w - border) continue;

      var idx = (y * w + x) * 4;
      var lr = lut[data[idx]];
      var lg = lut[data[idx + 1]];
      var lb = lut[data[idx + 2]];
      if (!isFinite(lr) || !isFinite(lg) || !isFinite(lb)) continue;

      if (ff) {
        // 除以响应系数：暗角处记录值偏低，要补回来
        var f = _flatFieldFactor(ff, x, y, w, h);
        lr /= f; lg /= f; lb /= f;
      }

      var br = Math.min(255, Math.round(lr * 255));
      var bg = Math.min(255, Math.round(lg * 255));
      var bb = Math.min(255, Math.round(lb * 255));
      hr[br]++; sr[br] += lr;
      hg[bg]++; sg[bg] += lg;
      hb[bb]++; sb[bb] += lb;
      count++;
    }
  }

  if (count === 0) return null;

  var trim = CALIB.BG_TRIM;
  var r = _trimmedLinearMean(hr, sr, count, trim);
  var g = _trimmedLinearMean(hg, sg, count, trim);
  var b = _trimmedLinearMean(hb, sb, count, trim);

  return {
    r: r,
    g: g,
    b: b,
    lum: _linearLuma(r, g, b),
    count: count
  };
}

// ---- 计算白平衡增益 ----
// 把每个通道的背景水平都归一到 TARGET_BG_LEVEL。
// 这样无论基底真实颜色、无论手机白平衡如何，各设备输出都趋于同一基准。
function computeWhiteBalanceGains(bgRef) {
  var fallback = { r: 1, g: 1, b: 1, applied: false, note: '' };

  if (!bgRef) {
    fallback.note = '未取到背景参考区';
    return fallback;
  }
  if (bgRef.lum < CALIB.MIN_BG_LEVEL) {
    // 背景太暗（几乎全黑），增益会被放大到不可靠，放弃归一化
    fallback.note = '背景过暗，未做归一化';
    return fallback;
  }

  var target = CALIB.TARGET_BG_LEVEL;
  function clampGain(v) {
    if (!isFinite(v) || v <= 0) return 1;
    return Math.min(CALIB.MAX_GAIN, Math.max(CALIB.MIN_GAIN, v));
  }

  return {
    r: clampGain(target / Math.max(bgRef.r, 1e-6)),
    g: clampGain(target / Math.max(bgRef.g, 1e-6)),
    b: clampGain(target / Math.max(bgRef.b, 1e-6)),
    applied: true,
    note: ''
  };
}

// ============================================================
// A3 比值归一化 —— 跨设备一致性的核心指标
// ============================================================

// ---- 计算指定矩形区域的每通道线性光均值 ----
function _estimateRegionMeans(imageData, roi, ff) {
  var lut = _buildSRGBLUT();
  var data = imageData.data;
  var w = imageData.width;
  var h = imageData.height;

  // 整数化并钳制到图像边界（与 calculateStats 保持一致）
  var rx = Math.round(roi.x), ry = Math.round(roi.y);
  var rw = Math.round(roi.width), rh = Math.round(roi.height);
  if (rx < 0) { rw += rx; rx = 0; }
  if (ry < 0) { rh += ry; ry = 0; }
  if (rx + rw > w) rw = w - rx;
  if (ry + rh > h) rh = h - ry;
  if (rw <= 0 || rh <= 0) return null;

  var sr = 0, sg = 0, sb = 0, n = 0;
  for (var y = ry; y < ry + rh; y++) {
    for (var x = rx; x < rx + rw; x++) {
      var idx = (y * w + x) * 4;
      var lr = lut[data[idx]];
      var lg = lut[data[idx + 1]];
      var lb = lut[data[idx + 2]];
      if (!isFinite(lr) || !isFinite(lg) || !isFinite(lb)) continue;
      if (ff) {
        // 除以响应系数：暗角处记录值偏低，要补回来
        var f = _flatFieldFactor(ff, x, y, w, h);
        lr /= f; lg /= f; lb /= f;
      }
      sr += lr; sg += lg; sb += lb;
      n++;
    }
  }
  if (n === 0) return null;
  return { r: sr / n, g: sg / n, b: sb / n, count: n };
}

// ============================================================
// A5 自动平场（暗角）估计
// ============================================================

// ---- 估计平场分布 ----
// 分块取每块的「暗部均值」（20% 裁剪）作为该处的亮度响应。
// 镜头的暗角、激发光的不均匀都是低频且近似径向对称的，因此用
//     v(x,y) = a + b · r²      （r² 为到画面中心的归一化距离平方）
// 这一个二次模型就足以描述 —— 只拟合两个参数，天然不会去拟合荧光信号。
//
// 荧光斑块会让残差偏正，所以先做一次最小二乘，再剔掉残差最大的 30% 重新拟合。
// 这样即使荧光区域占了画面很大一块，也不会被误当成「这里更亮」而把信号压暗。
//
// 返回 { a, b, mean } 或 null
function estimateFlatField(imageData) {
  var lut = _buildSRGBLUT();
  var data = imageData.data;
  var w = imageData.width;
  var h = imageData.height;

  var n = CALIB.FLAT_FIELD_BLOCKS;
  var bw = Math.max(1, Math.ceil(w / n));
  var bh = Math.max(1, Math.ceil(h / n));
  var nx = Math.ceil(w / bw);
  var ny = Math.ceil(h / bh);
  if (nx < 3 || ny < 3) return null;

  var hist = new Uint32Array(256);
  var linSum = new Float64Array(256);
  var vals = [];    // 每块的暗部均值
  var maxes = [];   // 每块的最亮值（用来判断块内是否有结构）
  var r2s = [];     // 每块的归一化半径平方
  var i, b, bx, by;

  for (by = 0; by < ny; by++) {
    var y0 = by * bh;
    var y1 = Math.min(h, y0 + bh);
    for (bx = 0; bx < nx; bx++) {
      var x0 = bx * bw;
      var x1 = Math.min(w, x0 + bw);

      for (b = 0; b < 256; b++) { hist[b] = 0; linSum[b] = 0; }
      var cnt = 0;
      var bmax = 0;

      for (var y = y0; y < y1; y++) {
        for (var x = x0; x < x1; x++) {
          var idx = (y * w + x) * 4;
          var lr = lut[data[idx]];
          var lg = lut[data[idx + 1]];
          var lb = lut[data[idx + 2]];
          if (!isFinite(lr) || !isFinite(lg) || !isFinite(lb)) continue;
          var luma = _linearLuma(lr, lg, lb);
          if (!isFinite(luma)) continue;
          if (luma > bmax) bmax = luma;
          var bin = Math.min(255, Math.round(luma * 255));
          hist[bin]++; linSum[bin] += luma;
          cnt++;
        }
      }

      if (cnt < 8) continue;   // 块太小，样本不足
      vals.push(_trimmedLinearMean(hist, linSum, cnt, CALIB.FLAT_FIELD_TRIM));
      maxes.push(bmax);
      r2s.push(_normR2((x0 + x1 - 1) / 2, (y0 + y1 - 1) / 2, w, h));
    }
  }

  var m = vals.length;
  if (m < 8) return null;

  // 画面整体太暗时，分块估计会被 8bit 量化噪声主导，做出来的只是噪声放大
  var sorted = vals.slice().sort(function(a, b) { return a - b; });
  var globalRef = sorted[Math.floor(m / 2)];
  if (!(globalRef > 0) || globalRef < CALIB.FLAT_FIELD_MIN_LEVEL) return null;

  // ---- 最小二乘拟合 v = a + b·r²，并做一轮剔除离群块的稳健重拟合 ----
  function fit(idx) {
    var S0 = 0, S1 = 0, S2 = 0, T0 = 0, T1 = 0;
    for (var k = 0; k < idx.length; k++) {
      var j = idx[k];
      var r2 = r2s[j];
      S0 += 1; S1 += r2; S2 += r2 * r2;
      T0 += vals[j]; T1 += vals[j] * r2;
    }
    var det = S0 * S2 - S1 * S1;
    if (Math.abs(det) < 1e-12) return null;
    return {
      a: (T0 * S2 - T1 * S1) / det,
      b: (S0 * T1 - S1 * T0) / det
    };
  }

  var allIdx = [];
  for (i = 0; i < m; i++) allIdx.push(i);

  // 挑出「纯背景块」参与拟合。两条判据缺一不可：
  //
  // ① 整体偏亮（val > 2×中位数）→ 整块都落在荧光斑里。
  //    这一步必须在拟合之前 —— 荧光斑是画面最亮的部分，直接拟合会把它
  //    当成「中心更亮」把 a 抬高（实测抬 66%），归一化基准 mean 随之偏大。
  // ② 块内有结构（最亮值明显高于该块的暗部均值）→ 块被荧光斑盖住一部分。
  //    这种块只偏亮一点点，① 抓不到，但它同样会把「斑所在的位置」垫高，
  //    在没有暗角的图上凭空造出一个假的径向亮斑（实测中心虚高 8.6%）。
  //    背景是空间上平坦的，只有量化/传感器噪声；有对比度就说明混进了信号。
  var bgIdx = [];
  for (i = 0; i < m; i++) {
    if (vals[i] > globalRef * 2) continue;
    if (maxes[i] - vals[i] > globalRef * CALIB.FLAT_FIELD_UNIFORMITY) continue;
    bgIdx.push(i);
  }
  if (bgIdx.length < 8) bgIdx = allIdx;   // 筛得太狠就退回全量，别把估计做废

  var model = fit(bgIdx);
  if (!model) return null;

  // 再把残差最大的一批剔掉重拟合，进一步压住残留的离群块
  var resid = [];
  for (i = 0; i < bgIdx.length; i++) {
    var j = bgIdx[i];
    resid.push({ j: j, r: vals[j] - (model.a + model.b * r2s[j]) });
  }
  resid.sort(function(x, y) { return y.r - x.r; });
  var keepCount = Math.max(8, Math.floor(resid.length * 0.8));
  var keepIdx = [];
  for (i = 0; i < keepCount; i++) keepIdx.push(resid[i].j);

  var robust = fit(keepIdx);
  if (robust && robust.a > 0) { model = robust; bgIdx = keepIdx; }

  if (!(model.a > 0)) return null;

  // ---- 限制校正幅度 ----
  // 只允许在 FLAT_FIELD_RANGE 以内修正，超出的一律截断，
  // 免得模型的拟合误差真的把图像改坏
  var range = CALIB.FLAT_FIELD_RANGE;
  if (model.b > 0) model.b = Math.min(model.b, range * model.a);
  else model.b = Math.max(model.b, -range * model.a);

  // 归一化基准：只对背景块求模型值平均（块大小基本一致，按块数平均即可）。
  // 只校正暗角形状、不改整体亮度，所以基准必须来自背景块，不能被荧光斑拉高。
  var meanVal = 0;
  for (i = 0; i < bgIdx.length; i++) {
    meanVal += model.a + model.b * r2s[bgIdx[i]];
  }
  meanVal /= bgIdx.length;
  if (!(meanVal > 0)) return null;

  return { a: model.a, b: model.b, mean: meanVal };
}

// ============================================================
// A4 曝光质量检测
// ============================================================

// ---- 评估曝光是否可用（过曝/欠曝） ----
function assessExposure(imageData) {
  var data = imageData.data;
  var total = data.length / 4;
  if (total === 0) {
    return { status: 'ok', saturatedRatio: 0, dynamicRange: 0, message: '' };
  }

  var sat = 0;
  var minV = 255;
  var maxV = 0;

  for (var i = 0; i < data.length; i += 4) {
    var r = data[i], g = data[i + 1], b = data[i + 2];
    if (!isFinite(r) || !isFinite(g) || !isFinite(b)) continue;
    var v = r > g ? r : g;
    if (b > v) v = b;
    if (v >= CALIB.SATURATION_LEVEL) sat++;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  var saturatedRatio = sat / total;
  var dynamicRange = maxV - minV;
  var status = 'ok';
  var message = '';

  if (saturatedRatio > CALIB.SATURATION_WARN) {
    status = 'over';
    message = '画面存在过曝（' + (saturatedRatio * 100).toFixed(1) +
              '% 像素饱和），荧光强度会被低估，建议降低曝光后重拍';
  } else if (dynamicRange < CALIB.UNDEREXPOSURE_RANGE) {
    status = 'under';
    message = '画面动态范围过小（' + dynamicRange +
              '），信号可能不足，建议提高曝光或增强照明';
  }

  return {
    status: status,
    saturatedRatio: saturatedRatio,
    dynamicRange: dynamicRange,
    message: message
  };
}

// ============================================================
// 主入口
// ============================================================

// ---- 对整帧做自动校准（原地修改 imageData 的 RGB 通道） ----
// 参数：
//   imageData — 原始 RGB 图像（会被就地校正）
//   roi       — 选区矩形，用于计算比值归一化指标，可为 null
// 返回：校准报告对象
function calibrateFrame(imageData, roi) {
  var report = {
    applied: false,
    whiteBalance: { r: 1, g: 1, b: 1, applied: false, note: '' },
    flatField: false,
    backgroundLevel: null,
    roiLevel: null,
    relativeIntensity: null,
    exposure: { status: 'ok', saturatedRatio: 0, dynamicRange: 0, message: '' }
  };

  if (!CALIB.ENABLED) return report;
  if (!imageData || !imageData.width || !imageData.height) return report;

  var lut = _buildSRGBLUT();
  var data = imageData.data;
  var w = imageData.width;
  var h = imageData.height;

  // 1. 曝光质量（在任何校正之前评估，反映真实拍摄状态）
  report.exposure = assessExposure(imageData);

  // 2. 平场（暗角）估计 —— 必须排在背景估计之前。
  //    暗角会让边缘比中心暗，若先估背景就会把背景水平整体低估，
  //    白平衡增益随之偏大，整幅图被错误提亮。
  var ff = null;
  if (CALIB.FLAT_FIELD) {
    ff = estimateFlatField(imageData);
  }
  report.flatField = !!ff;

  // 3. 背景参考 → 白平衡增益（统计时先补偿平场）
  var bgRef = estimateBackgroundRef(imageData, CONFIG.BORDER_FRACTION, ff);
  var gains = computeWhiteBalanceGains(bgRef);
  report.whiteBalance = gains;
  report.backgroundLevel = bgRef ? bgRef.lum : null;

  // 4. 比值归一化指标（线性光域，增益可解析地作用到区域均值上）
  if (roi && bgRef && gains.applied && bgRef.lum > CALIB.MIN_BG_LEVEL) {
    var region = _estimateRegionMeans(imageData, roi, ff);
    if (region) {
      var bgLin = _linearLuma(gains.r * bgRef.r, gains.g * bgRef.g, gains.b * bgRef.b);
      var roiLin = _linearLuma(gains.r * region.r, gains.g * region.g, gains.b * region.b);
      if (bgLin > 1e-6) {
        report.backgroundLevel = bgLin;
        report.roiLevel = roiLin;
        report.relativeIntensity = (roiLin - bgLin) / bgLin;
      }
    }
  }

  var needWB = gains.applied;
  var needFF = !!ff;
  if (!needWB && !needFF) return report;

  // 5. 逐像素应用：sRGB → 线性光 → 增益 → 平场 → 重新编码 sRGB
  var enc = _buildLinToSRGBLUT();
  var gr = gains.r, gg = gains.g, gb = gains.b;

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var idx = (y * w + x) * 4;
      var lr = lut[data[idx]];
      var lg = lut[data[idx + 1]];
      var lb = lut[data[idx + 2]];
      if (!isFinite(lr) || !isFinite(lg) || !isFinite(lb)) continue;

      if (needWB) {
        lr *= gr; lg *= gg; lb *= gb;
      }

      if (needFF) {
        // 除以响应系数：暗角处记录值偏低，要补回来
        // 混合系数 <1 时只做部分校正，保留原始亮度的主观观感
        var f = _flatFieldFactor(ff, x, y, w, h);
        lr /= f; lg /= f; lb /= f;
      }

      // 查表代替 Math.pow，并对越界值钳制
      var ir = (lr * 4096) | 0;
      var ig = (lg * 4096) | 0;
      var ib = (lb * 4096) | 0;
      data[idx]     = ir <= 0 ? 0 : (ir >= 4096 ? 255 : enc[ir]);
      data[idx + 1] = ig <= 0 ? 0 : (ig >= 4096 ? 255 : enc[ig]);
      data[idx + 2] = ib <= 0 ? 0 : (ib >= 4096 ? 255 : enc[ib]);
    }
  }

  report.applied = needWB || needFF;
  return report;
}

// ---- 校准状态描述（供结果页展示） ----
function describeCalibration(report) {
  if (!report || !report.applied) return '未校准';
  var parts = [];
  if (report.whiteBalance && report.whiteBalance.applied) parts.push('白平衡');
  if (report.flatField) parts.push('平场');
  return parts.length > 0 ? '已校准（' + parts.join(' + ') + '）' : '未校准';
}
