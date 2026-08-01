// ========================================
// 伪彩色映射 — 荧光检测平台
// ========================================

var _thermalLUT = null; // 缓存热力图色表

// ---- 生成 256 条目热力图查找表 ----
function createThermalLUT() {
  if (_thermalLUT) return _thermalLUT;

  var lut = new Array(256);
  for (var i = 0; i < 256; i++) {
    if (i <= 50) {
      // 黑 → 蓝（0-50）
      var t = i / 50;
      lut[i] = [0, 0, Math.round(t * 255)];
    } else if (i <= 101) {
      // 蓝 → 绿（51-101）
      var t = (i - 51) / 50;
      lut[i] = [0, Math.round(t * 255), Math.round((1 - t) * 255)];
    } else if (i <= 152) {
      // 绿 → 黄（102-152）
      var t = (i - 102) / 50;
      lut[i] = [Math.round(t * 255), 255, 0];
    } else if (i <= 203) {
      // 黄 → 红（153-203）
      var t = (i - 153) / 50;
      lut[i] = [255, Math.round((1 - t) * 255), 0];
    } else {
      // 红 → 白（204-255）
      var t = (i - 204) / 51;
      lut[i] = [255, Math.round(t * 255), Math.round(t * 255)];
    }
  }

  _thermalLUT = lut;
  return lut;
}

// ---- 应用伪彩色 ----
// grayImageData: 灰度图像（R=G=B）
// lut: createThermalLUT() 返回的色表（可选，默认自动创建）
function applyPseudocolor(grayImageData, lut) {
  lut = lut || createThermalLUT();

  var src = grayImageData.data;
  var w = grayImageData.width;
  var h = grayImageData.height;
  var output = new ImageData(w, h);
  var dst = output.data;

  for (var i = 0; i < src.length; i += 4) {
    var gray = src[i]; // R 通道 = 灰度值（灰度图中 R=G=B）
    // 钳制到 0-255
    if (gray < 0) gray = 0;
    if (gray > 255) gray = 255;

    var color = lut[gray];
    dst[i] = color[0];
    dst[i + 1] = color[1];
    dst[i + 2] = color[2];
    dst[i + 3] = 255;
  }

  return output;
}
