// ========================================
// UI 工具函数 — 荧光检测平台
// ========================================

// ---- 页面路由 ----
function showPage(pageId) {
  // 隐藏所有页面
  document.querySelectorAll('.page').forEach(page => {
    page.classList.remove('active');
  });
  // 显示目标页面
  const target = document.getElementById(pageId + '-page');
  if (target) {
    target.classList.add('active');
  }
}

// ---- Toast 提示 ----
let toastTimer = null;

function showToast(message, duration) {
  duration = duration || 3000;
  const toast = document.getElementById('toast');

  // 清除之前的定时器
  if (toastTimer) {
    clearTimeout(toastTimer);
  }

  toast.textContent = message;
  toast.classList.add('show');

  toastTimer = setTimeout(function() {
    toast.classList.remove('show');
    toastTimer = null;
  }, duration);
}

// ---- 加载遮罩 ----
function showLoading(show) {
  var overlay = document.getElementById('loading-overlay');
  if (show) {
    overlay.classList.add('show');
  } else {
    overlay.classList.remove('show');
  }
}

// ---- 禁用/启用按钮 ----
function setButtonEnabled(selector, enabled) {
  var btn = document.querySelector(selector);
  if (!btn) return;
  if (enabled) {
    btn.disabled = false;
    btn.classList.remove('disabled');
  } else {
    btn.disabled = true;
    btn.classList.add('disabled');
  }
}

// ---- 日期格式化 ----
function formatDate(isoStr) {
  var d = new Date(isoStr);
  var year = d.getFullYear();
  var month = d.getMonth() + 1;
  var day = d.getDate();
  var hour = d.getHours();
  var min = d.getMinutes();
  // 补零
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  return year + '年' + month + '月' + day + '日 ' + pad(hour) + ':' + pad(min);
}

// ---- 数字格式化（千分位 + 保留两位小数） ----
function formatNumber(n) {
  if (typeof n !== 'number') return '--';
  var fixed = n.toFixed(2);
  var parts = fixed.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}
