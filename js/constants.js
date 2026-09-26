// ========================================
// 全局常量 — 荧光检测平台
// ========================================

// 主题色板（淡蓝色系）
const THEME = {
  bgLight:      '#E3F2FD',
  bgLight2:     '#BBDEFB',
  blueLight:    '#90CAF9',
  blueMid:      '#42A5F5',
  blueDark:     '#1E88E5',
  textDark:     '#0D47A1',
  white:        '#FFFFFF',
  bgGray:       '#F5F5F5',
  errorRed:     '#E53935',
  successGreen: '#43A047',
  borderGray:   '#BDBDBD',
  textGray:     '#757575'
};

// 图像处理参数
const CONFIG = {
  MAX_DIMENSION: 1024,         // 处理前缩放到此最大尺寸
  MEDIAN_KERNEL: 3,            // 中值滤波核大小（3x3）
  BORDER_FRACTION: 0.05,       // 背景估计边缘比例
  CONTRAST_CLIP_PERCENT: 0.5,  // 直方图拉伸裁剪比例
  ROI_MIN_SIZE: 20,            // 最小选区尺寸 (px)
  THUMB_WIDTH: 300             // 缩略图宽度 (px)
};

// 自动校准参数（跨设备荧光一致性）
// 目标：不同手机拍出的荧光颜色/强度尽可能一致，减小检测误差
// 关闭 ENABLED 后，处理流水线回到旧版行为，结果数值与旧版完全一致
const CALIB = {
  ENABLED: true,            // 自动校准总开关

  // 相机端（A1）：关闭自动白平衡/自动曝光，减少设备差异。
  //
  // 默认关闭，原因：
  //   1. 'manual' 模式不给具体数值时，是把当前值「冻住」，而不是给一个确定的
  //      好值。我们在 loadedmetadata 时就下发，此时自动曝光/自动白平衡
  //      通常还没收敛，冻住的可能是错误的初始值（照片过暗或偏色）。
  //   2. 各机型支持率参差不齐，锁不上时行为不可预测。
  //   3. 最关键的是：A2 和 A3 是「测量并校正」，对设备差异天然免疫 ——
  //      它们不依赖相机是否听话。实测 1.938% 的跨设备一致性
  //      是在完全没有相机锁定的情况下达成的。
  //   所以 A1 收益有限、风险不小，默认不开。想实验可以改成 true，
  //   但请务必在真机上确认取景画面和照片是清晰的（对焦永不上锁）。
  LOCK_CAMERA: false,

  // 背景参考区（A2）：用图像自身的空白基底作为参考物
  BG_TRIM: 0.25,            // 估计背景时丢弃最亮的 25%（防荧光信号污染）
  // 背景归一化目标（线性光 0~1）。
  // 取 0.10（≈ sRGB 89）而不是中灰 0.25：荧光图像本就是暗背景+亮斑，
  // 这个值让常见画面几乎不用放大/缩小，既保留信号动态范围又不放大噪声。
  TARGET_BG_LEVEL: 0.10,
  MIN_BG_LEVEL: 0.025,      // 背景低于此值则放弃归一化（增益会放大噪声）
  MIN_GAIN: 0.2,            // 单通道增益下限
  MAX_GAIN: 10.0,           // 单通道增益上限（与 MIN_BG_LEVEL 自洽：0.1/0.025=4 倍余量）

  // 平场（暗角）校正（A5）
  FLAT_FIELD: true,         // 自动估计并补偿镜头暗角
  FLAT_FIELD_BLOCKS: 16,    // 平场估计分块数（每边）
  FLAT_FIELD_TRIM: 0.20,    // 每块背景估计丢弃最亮的 20%
  FLAT_FIELD_MIN_LEVEL: 0.012,  // 整体亮度过低时放弃平场估计（分块估计被量化噪声主导）
  FLAT_FIELD_RANGE: 0.35,   // 校正幅度上限（±35%），防止过校正
  FLAT_FIELD_BLEND: 1.0,    // 校正混合系数（0=不校正，1=完全校正）
  // 块内「最亮值 − 暗部均值」超过背景水平的这个比例，就认为该块混进了荧光信号。
  // 纯背景块只有量化/传感器噪声（几个码值，≈3%）；被荧光斑盖住一部分的块
  // 对比度可达背景的好几倍，区分度很大，所以 15% 这个阈值很宽松也很安全。
  FLAT_FIELD_UNIFORMITY: 0.15,

  // 这里刻意不设「伪彩色显示增益」：
  // 伪彩图是把校准后的灰度直接查表映射（pseudocolor.js 没有自动拉伸），
  // 传递函数各设备完全相同 —— 同一个样品在任何手机上都会显示成同一种颜色，
  // 这正是「跨设备颜色一致」想要的效果。再加增益反而会破坏这个性质。

  // 曝光质量检测（A4）
  SATURATION_LEVEL: 250,    // 判定为过曝的像素值
  SATURATION_WARN: 0.02,    // 过曝像素比例超过 2% 则警告
  UNDEREXPOSURE_RANGE: 20   // 动态范围低于此值则提示欠曝
};

// IndexedDB 配置
const DB_NAME = 'fluorescenceDB';
const DB_VERSION = 1;
const STORE_NAME = 'records';

// 页面 ID 列表
const PAGES = ['start', 'camera', 'roi-select', 'results', 'history'];
