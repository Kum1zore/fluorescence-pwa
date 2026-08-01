# 图像处理算法说明 — 荧光检测平台

## 处理流水线总览

```
原始照片 (RGB)
    │  缩放到最大 1024px
    ▼
步骤 1: 灰度转换 (Grayscale)
    │  RGB → 亮度值 (0-255)
    ▼
步骤 2: 中值滤波 (Median Filter)
    │  去除椒盐噪声
    ▼
步骤 3: 直方图拉伸 (Histogram Stretch)
    │  增强对比度
    ▼
步骤 4: 背景扣除 (Background Subtraction)
    │  减去边缘背景均值
    ▼
处理完成，计算统计值
    │
    ├──→ 平均荧光强度 = Σpixels / N
    └──→ 总荧光密度 = Σpixels
```

---

## 步骤 1：灰度转换

### 算法
使用 ITU-R BT.601 亮度加权公式：

```
Gray = 0.299 × R + 0.587 × G + 0.114 × B
```

### 伪代码
```js
function grayscale(imageData) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2]);
    data[i] = data[i+1] = data[i+2] = gray;
    // data[i+3] (alpha) 不变
  }
  return imageData;
}
```

### 说明
- 加权公式比简单平均更准确，因为相机 Bayer 滤光片中绿色像素数量是红/蓝的两倍
- ThT 荧光发射峰在 ~480-490nm（蓝绿色），绿色通道权重大有利于信号提取

---

## 步骤 2：中值滤波（去噪）

### 算法
对每个像素取其 3×3 邻域的 9 个灰度值，排序后取中位数替换该像素。

### 伪代码
```js
function medianFilter(imageData, kernelSize = 3) {
  const src = imageData.data;
  const w = imageData.width;
  const h = imageData.height;
  const output = new Uint8ClampedArray(src.length);
  const half = Math.floor(kernelSize / 2);  // = 1 for 3x3

  // 复制 alpha 通道
  for (let i = 0; i < src.length; i += 4) {
    output[i+3] = src[i+3];
  }

  for (let y = half; y < h - half; y++) {
    for (let x = half; x < w - half; x++) {
      const neighbors = [];
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const idx = ((y + dy) * w + (x + dx)) * 4;
          neighbors.push(src[idx]);  // 灰度值，R=G=B
        }
      }
      neighbors.sort((a, b) => a - b);
      const median = neighbors[Math.floor(neighbors.length / 2)];  // index 4

      const idx = (y * w + x) * 4;
      output[idx] = output[idx+1] = output[idx+2] = median;
    }
  }

  // 边界像素（1px 宽）直接复制原值
  // ... (复制顶部、底部、左侧、右侧边界行)

  return new ImageData(output, w, h);
}
```

### 参数
- `kernelSize`: 固定 3（3×3 窗口）
- 更大的核会损失细节，3×3 对荧光图像已足够

### 为什么用中值滤波而非高斯滤波？
荧光显微图像常有 CMOS 传感器产生的 Salt-and-Pepper 噪声（个别像素值极端偏离）。中值滤波可以完全消除这些异常像素（它们在排序后永远不会成为中位数），而高斯滤波只能衰减它们。这对积分光密度计算至关重要——单颗热像素就能显著偏离总量。

---

## 步骤 3：直方图拉伸（对比度增强）

### 算法
1. 统计 0-255 每个灰度值的像素数
2. 从两端各裁剪 `clipPercent`（默认 0.5%）的像素（排除极端值干扰）
3. 找到剩余像素的最小值 `minVal` 和最大值 `maxVal`
4. 线性映射：`newValue = (oldValue - minVal) / (maxVal - minVal) × 255`

### 伪代码
```js
function histogramStretch(imageData, clipPercent = 0.5) {
  const data = imageData.data;
  const totalPixels = data.length / 4;

  // 1. 建直方图
  const hist = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    hist[data[i]]++;
  }

  // 2. 计算裁剪阈值
  const clipCount = Math.floor(totalPixels * clipPercent / 100);
  let minVal = 0;
  let sum = 0;
  while (sum < clipCount && minVal < 255) {
    sum += hist[minVal];
    minVal++;
  }

  let maxVal = 255;
  sum = 0;
  while (sum < clipCount && maxVal > 0) {
    sum += hist[maxVal];
    maxVal--;
  }

  // 3. 线性拉伸
  const range = maxVal - minVal;
  if (range === 0) {
    // 图像完全均匀，全部设为 128
    for (let i = 0; i < data.length; i += 4) {
      data[i] = data[i+1] = data[i+2] = 128;
    }
  } else {
    for (let i = 0; i < data.length; i += 4) {
      const stretched = Math.round((data[i] - minVal) / range * 255);
      const clamped = Math.max(0, Math.min(255, stretched));
      data[i] = data[i+1] = data[i+2] = clamped;
    }
  }

  return imageData;
}
```

### 参数
- `clipPercent`: 默认 0.5，即在两端各裁剪 0.5% 的最暗/最亮像素
- 裁剪是为了防止单个死像素（0）或热像素（255）导致拉伸失效

---

## 步骤 4：背景扣除

### 算法（边缘估计法）
1. 从图像四边各取 `borderFraction × min(width, height)` 宽的边缘区域
2. 计算边缘区域内所有像素的灰度均值 `bgMean`
3. 每个像素减去 `bgMean`：`newValue = max(0, oldValue - bgMean)`

### 伪代码
```js
function subtractBackground(imageData, borderFraction = 0.05) {
  const data = imageData.data;
  const w = imageData.width;
  const h = imageData.height;
  const border = Math.floor(Math.min(w, h) * borderFraction);

  // 收集边缘像素
  let bgSum = 0, bgCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 判断是否为边缘像素
      if (x < border || x >= w - border || y < border || y >= h - border) {
        const idx = (y * w + x) * 4;
        bgSum += data[idx];
        bgCount++;
      }
    }
  }

  const bgMean = bgSum / bgCount;

  // 减去背景
  for (let i = 0; i < data.length; i += 4) {
    const newVal = Math.max(0, data[i] - bgMean);
    data[i] = data[i+1] = data[i+2] = Math.round(newVal);
  }

  return imageData;
}
```

### 参数
- `borderFraction`: 默认 0.05（5%）

### 为什么用边缘估计？
此实验场景中，荧光信号集中在视场中心，图像边缘区域只包含非荧光背景（基底、封片剂）。直接用边缘均值作为背景估计值，避免了单独拍摄背景图像的需求。这是 ImageJ/Fiji 中常用的简化方法，在受控成像条件下效果良好。

---

## 步骤 5：伪彩色映射

### 算法
生成 256 个条目的热力图查找表 (LUT)，将 0-255 灰度值映射到 RGB 颜色。

### 5 段热力图色阶

| 灰度范围 | R 变化 | G 变化 | B 变化 | 视觉效果 |
|----------|--------|--------|--------|----------|
| 0-50     | 0      | 0      | 0→255  | 黑 → 蓝 |
| 51-101   | 0      | 0→255  | 255→0  | 蓝 → 绿 |
| 102-152  | 0→255  | 255    | 0      | 绿 → 黄 |
| 153-203  | 255    | 255→0  | 0      | 黄 → 红 |
| 204-255  | 255    | 0→255  | 0→255  | 红 → 白 |

### 伪代码
```js
function createThermalLUT() {
  const lut = new Array(256);
  for (let i = 0; i < 256; i++) {
    if (i <= 50) {
      lut[i] = [0, 0, Math.round(i / 50 * 255)];
    } else if (i <= 101) {
      const t = (i - 51) / 50;
      lut[i] = [0, Math.round(t * 255), Math.round((1 - t) * 255)];
    } else if (i <= 152) {
      const t = (i - 102) / 50;
      lut[i] = [Math.round(t * 255), 255, 0];
    } else if (i <= 203) {
      const t = (i - 153) / 50;
      lut[i] = [255, Math.round((1 - t) * 255), 0];
    } else {
      const t = (i - 204) / 51;
      lut[i] = [255, Math.round(t * 255), Math.round(t * 255)];
    }
  }
  return lut;
}

function applyPseudocolor(grayImageData, lut) {
  const src = grayImageData.data;
  const w = grayImageData.width;
  const h = grayImageData.height;
  const output = new ImageData(w, h);

  for (let i = 0; i < src.length; i += 4) {
    const gray = src[i];  // R=G=B=gray
    const [r, g, b] = lut[gray];
    output.data[i] = r;
    output.data[i+1] = g;
    output.data[i+2] = b;
    output.data[i+3] = 255;  // 完全不透明
  }

  return output;
}
```

---

## 荧光强度计算

在 ROI 区域内的背景扣除后的灰度图像上计算：

```
N = width × height (ROI 内的总像素数)
pixelValues = [g1, g2, ..., gN]  (ROI 内每个像素的灰度值)

平均荧光强度 (Mean) = Σ(pixelValues) / N
总荧光密度 (Integrated Density) = Σ(pixelValues)
```

- 平均强度：反映单位面积的荧光水平，适合比较不同大小的区域
- 总荧光密度：反映区域内荧光信号总量，适合区域面积变化的场景

### 伪代码
```js
function calculateStats(imageData, roi) {
  const data = imageData.data;
  const w = imageData.width;
  let sum = 0;
  let count = 0;

  for (let y = roi.y; y < roi.y + roi.height; y++) {
    for (let x = roi.x; x < roi.x + roi.width; x++) {
      const idx = (y * w + x) * 4;
      sum += data[idx];  // 灰度值
      count++;
    }
  }

  return {
    meanIntensity: count > 0 ? sum / count : 0,
    integratedDensity: sum
  };
}
```
