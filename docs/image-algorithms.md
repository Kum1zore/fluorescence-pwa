# 图像处理算法说明 — 荧光检测平台

## 处理流水线总览

```
原始照片 (RGB)
    │  缩放到最大 1024px
    ▼
步骤 0: 自动校准 (Auto Calibration)          ← 见下方专章
    │  线性化 → 白平衡 → 平场校正 → 重新编码
    │  同时输出「相对荧光强度 I_rel」
    ▼
步骤 1: 灰度转换 (Grayscale)
    │  RGB → 亮度值 (0-255)
    ▼
步骤 2: 中值滤波 (Median Filter)
    │  去除椒盐噪声
    ▼
步骤 3: 直方图拉伸 (Histogram Stretch)
    │  增强对比度 —— 仅在校准关闭时执行
    ▼
步骤 4: 背景扣除 (Background Subtraction)
    │  减去边缘背景均值
    ▼
处理完成，计算统计值
    │
    ├──→ 相对荧光强度 = (ROI − 背景) / 背景   ← 跨设备比对用这个
    ├──→ 平均荧光强度 = Σpixels / N
    └──→ 总荧光密度 = Σpixels
```

> **为什么要跳过直方图拉伸**：拉伸窗口由图像内容决定（0.5% / 99.5% 分位数），
> 会把设备之间的亮度差异重新引入，抵消白平衡归一化的效果 ——
> 同一张芯片在不同手机上会被拉伸成不同结果，正是要消除的误差来源。
> 关闭 `CALIB.ENABLED` 后流水线回到旧版行为，历史数据数值不变。

---

## 步骤 0：自动校准（跨设备荧光一致性）

### 要解决的问题

不同手机的镜头、传感器、白平衡算法、曝光策略都不同，同一张芯片拍出来
颜色和亮度可以差很多，直接比数值没有意义。目标是**全自动、零操作**地
把这些差异压到最小 —— 用户不需要拍白板、不需要填参数。

### 核心思路：用图像自身的空白基底做参考

芯片的基底在所有手机上都是同一个物理对象。把它归一到固定水平，各设备
就被拉齐到同一基准。而且基底与样品在**同一帧内**，光照和曝光完全一致，
这是手动拍白板做不到的。

### 关键前提：必须在线性光空间做增益运算

sRGB 是显示编码（近似 γ=2.2），不是线性光。**直接在 sRGB 值上做除法是错的**，
会把 1.5 倍的亮度差算成 1.15 倍。所以所有增益运算都先反伽马到线性光：

```
线性光 = (V/255 ≤ 0.04045) ? (V/255)/12.92 : ((V/255 + 0.055)/1.055)^2.4
```

用 256 项查找表实现（`_buildSRGBLUT`）。反向编码用 4096 级查找表
（`_buildLinToSRGBLUT`）代替逐像素 `Math.pow` —— 每格宽 1/4096，
而 sRGB 编码最陡处斜率约 3300/单位，即每格最多跨 0.8 个码值，
取整后与直接计算完全一致，但把整帧耗时从 164ms 降到 56ms。

### 三个措施

| 编号 | 措施 | 解决的问题 |
|------|------|-----------|
| A1 | 相机参数锁定 | 手机自动白平衡/自动曝光每帧都在变 |
| A2 | 背景参考自动白平衡 | 色偏 + 曝光差异 |
| A5 | 平场（暗角）校正 | 镜头暗角导致中心与边缘亮度不同 |
| A3 | 比值归一化 I_rel | 光源强度波动、曝光时间差异 |
| A4 | 曝光质量检测 | 过曝/欠曝导致数值不可用 |

---

### A1 相机参数锁定

拍照前请求关闭手机的自动白平衡、自动曝光、自动对焦（锁定为手动）：

```js
var caps = track.getCapabilities();
var desired = [];
if (caps.whiteBalanceMode && caps.whiteBalanceMode.indexOf('manual') >= 0) {
  desired.push({ whiteBalanceMode: 'manual' });
}
// exposureMode / focusMode 同理
track.applyConstraints({ advanced: desired });
```

**必须先用 `getCapabilities()` 探测再申请**，否则不支持的机型会直接抛
`OverconstrainedError`，导致整个拍照流程失败。探测不到就静默跳过
（记在 `_lockState.failed` 里，只打 `console.warn`，不打扰用户）。

> 注意：这只是「减少变量」。手机的 ISP 局部色调映射/HDR 无法从浏览器关闭，
> 也没法用数学反解，这是目前剩下最主要的误差来源。

---

### A2 背景参考自动白平衡

1. 取图像四边宽 `BORDER_FRACTION × min(w,h)` 的条带作为背景参考区
2. 统计时**裁剪掉最亮的 25%**（`BG_TRIM`）—— 荧光信号是线性光空间的极亮
   离群值，裁掉最亮部分就把它们排除了
3. 各通道均值归一到 `TARGET_BG_LEVEL = 0.10`（≈ sRGB 89）：
   `增益_c = 0.10 / 背景_c`

```js
function _trimmedLinearMean(hist, linSum, count, trim) {
  // 按 sRGB 值(0~255)分箱，但箱内累加真实的线性光值之和
  var keep = Math.max(1, Math.floor(count * (1 - trim)));
  var sum = 0, n = 0;
  for (var b = 0; b < 256 && n < keep; b++) {
    var c = hist[b];
    if (c === 0) continue;
    var take = Math.min(c, keep - n);
    sum += (linSum[b] / c) * take;
    n += take;
  }
  return n > 0 ? sum / n : 0;
}
```

> **这里有个容易踩的坑**：如果直接用箱索引 `b/255` 当线性值，暗背景会被
> 系统性低估约 2%，这个偏差会 1:1 传导到白平衡增益和 I_rel 上。
> 所以箱内累加的是真实线性光值之和，`linSum[b]/c` 是精确值，无分箱偏差。

**为什么目标值取 0.10 而不是中灰 0.25**：荧光图像本就是暗背景 + 亮斑，
0.10 让常见画面几乎不用放大缩小，既保留信号动态范围又不放大噪声。
目标值取得越低，噪声放大越厉害，而且 8bit 量化误差占比越大
（背景落在 sRGB 56 时，1 个码值 ≈ 1.7% 线性光误差）。

**保护条件**：背景低于 `MIN_BG_LEVEL`（0.025）时放弃归一化并给出提示
（"背景过暗，未做归一化"），否则增益会把噪声放大到不可靠。
增益本身限制在 `[MIN_GAIN, MAX_GAIN]` = [0.2, 10.0]。

---

### A5 平场（暗角）校正

镜头暗角让边缘比中心暗。**不校正的话背景估计会被系统性拉低** ——
背景参考取的正是边缘条带，暗角使边缘最暗，白平衡增益于是偏大，
整幅图被错误提亮（实测能偏差 40%）。

镜头的暗角和激发光不均匀都是**低频且近似径向对称**的，因此用：

```
v(x, y) = a + b · r²        r² = 到画面中心的归一化距离平方
```

只需拟合 2 个参数，模型自由度极低，天然不会去拟合荧光信号。

#### 拟合流程

1. 画面分成 16×16 块，每块算「暗部均值」（裁剪最亮 20%）作为该处响应
2. 画面整体太暗（中位数 < `FLAT_FIELD_MIN_LEVEL` = 0.012）→ 放弃，
   此时分块估计被 8bit 量化噪声主导
3. **筛出纯背景块**参与拟合，两条判据缺一不可：
   - 整体偏亮（`val > 2 × 中位数`）→ 整块都在荧光斑里
   - **块内有结构**（`最亮值 − 暗部均值 > 0.15 × 背景水平`）→ 块被荧光斑
     盖住一部分

   > 第二条判据是关键。只被盖住一部分的块只偏亮一点点，第一条抓不到，
   > 但它同样会把这个位置垫高，**在没有暗角的图上凭空造出一个假的径向亮斑**
   >（实测中心虚高 8.6%，导致 ROI 均值低估 10%）。
   > 背景在空间上是平坦的，只有量化/传感器噪声；有对比度就说明混进了信号。

4. 最小二乘拟合，再剔除残差最大的 20% 重拟合
5. 限制校正幅度：`|b| ≤ FLAT_FIELD_RANGE × a`（±35%），防止过校正
6. 归一化基准 `mean` = **只对背景块**求模型值平均（只校正暗角形状、
   不改整体亮度，所以基准不能被荧光斑拉高）

#### 应用

```js
// 暗角处记录值偏低，要「除以」响应系数补回来
function _flatFieldFactor(ff, x, y, w, h) {
  var raw = (ff.a + ff.b * _normR2(x, y, w, h)) / ff.mean;
  return 1 + CALIB.FLAT_FIELD_BLEND * (raw - 1);
}
```

> **顺序很重要**：平场估计必须排在背景估计**之前**，
> 而且背景统计时要先用平场系数把采样值补正回来
>（`estimateBackgroundRef(imageData, borderFraction, ff)`）。

#### 实测效果（合成暗角图，真实 a=0.10, b=−0.035）

| 指标 | 结果 |
|------|------|
| 拟合出的模型 | `a=0.1000, b=−0.0350`（与真值完全一致） |
| 角落/中央背景（校准前） | 74 / 85（差 11 个码值） |
| 角落/中央背景（校准后） | 90 / 90（差 0） |
| 离轴 ROI 的 I_rel 偏差（关平场） | **+14.1%**（4 台设备一致地错，极差仅 0.14%） |
| 离轴 ROI 的 I_rel 偏差（开平场） | **+0.1%**（极差 0.32%） |

> 最后两行说明一个容易误判的现象：**跨设备一致 ≠ 正确**。
> 关掉平场时四台设备的结果高度一致，但全都偏了 14%。
> 所以验证时必须拿已知真值的合成图，不能只看设备间是否吻合。

---

### A3 比值归一化 —— 跨设备一致性的核心指标

```
I_rel = (ROI 区域线性光均值 − 背景线性光均值) / 背景线性光均值
```

这个量对**曝光时间、激发光强度、传感器灵敏度都不变** —— 只有信号本身
能改变它。文献里叫 ODR（optical density ratio）：

- Microsystems & Nanoengineering (2019)：校正荧光强度 = 测量区均值 − 背景区均值
- CVAC review, ACA 2015：ODR = (I_b − I_s) / I_b，
  "minimizes measurement error due to fluctuations in the light source
  intensity or camera performance"

```js
// 增益可以解析地作用到区域均值上，不必逐像素重算
var bgLin  = _linearLuma(gains.r * bgRef.r, gains.g * bgRef.g, gains.b * bgRef.b);
var roiLin = _linearLuma(gains.r * region.r, gains.g * region.g, gains.b * region.b);
report.relativeIntensity = (roiLin - bgLin) / bgLin;
```

---

### A4 曝光质量检测

在**任何校正之前**评估，反映真实拍摄状态：

- 过曝：像素值 ≥ `SATURATION_LEVEL`(250) 的比例 > `SATURATION_WARN`(2%)
  → 提示"荧光强度会被低估，建议降低曝光后重拍"
- 欠曝：动态范围 < `UNDEREXPOSURE_RANGE`(20)
  → 提示"信号可能不足，建议提高曝光或增强照明"

结果页用琥珀色提示条展示（不是红色错误，因为仍然可以测，只是数值不可靠）。

---

### 实测：跨设备一致性

合成 4 台特性差异很大的设备（不同白平衡 + 不同曝光），拍同一张芯片：

| 设备 | 校准前背景 RGB | 校准后背景 RGB | 白平衡增益 R/G/B | I_rel |
|------|---------------|---------------|-----------------|-------|
| A 中性/正常曝光 | 89,89,89 | 89,89,89 | 1.001 / 1.001 / 1.001 | 2.7571 |
| B 偏蓝/曝光 2.2× | 146,129,113 | 89,89,89 | 0.348 / 0.456 / 0.606 | 2.7353 |
| C 偏暖/曝光 0.5× | 56,63,75 | 89,89,89 | 2.529 / 2.012 / 1.421 | 2.7863 |
| D 偏绿/曝光 1.6× | 109,119,103 | 89,89,89 | 0.654 / 0.542 / 0.737 | 2.7330 |

- **I_rel 相对极差 = 1.938%**（目标 < 3%）
- 四台设备的背景全部归一到同一个值 89,89,89 = sRGB(0.10)
- 合成真值 I_rel = 2.7533，设备 A 测得 2.7571（偏差 0.14%）

**残余偏差的来源**：8bit sRGB 量化。暗背景每 1 个码值 ≈ 1.7% 线性光误差，
这是数据格式本身的极限，不是算法可以再优化的部分。

### 性能

1024×768 下 `calibrateFrame` 约 180ms（背景估计 17ms + 平场估计 45ms），
加上原有流水线约 440ms，总计约 620ms，满足 < 2s 的要求。

### 向后兼容

`CALIB.ENABLED = false` 时 `calibrateFrame` 直接返回，**像素改动数 = 0**，
流水线行为与旧版完全一致，历史数据数值不变。

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

### 相对荧光强度（跨设备比对用这个）

在**线性光空间**、背景归一化之后计算，见步骤 0 的 A3：

```
I_rel = (ROI 区域线性光均值 − 背景线性光均值) / 背景线性光均值
```

这是唯一跨设备可比的指标。下面的两个量都是在 8bit 灰度图上算的，
受每台手机的曝光和自动白平衡影响，**只适合同一台设备内的相对比较**，
不要拿不同手机的结果直接比。

### 平均荧光强度 / 总荧光密度

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
