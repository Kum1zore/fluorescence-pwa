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

// IndexedDB 配置
const DB_NAME = 'fluorescenceDB';
const DB_VERSION = 1;
const STORE_NAME = 'records';

// 页面 ID 列表
const PAGES = ['start', 'camera', 'roi-select', 'results', 'history'];
