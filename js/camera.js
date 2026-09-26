// ========================================
// 相机管理 — 荧光检测平台
// ========================================

var _currentStream = null;
var _cameraReady = false;

// 成像参数锁定状态（自动校准 A1）
var _lockState = {
  supported: [],   // 设备声明支持的属性
  applied: [],     // 实际下发成功的属性
  failed: [],      // 下发失败的属性（已静默降级）
  note: ''
};

// ---- 初始化摄像头 ----
// 优先后置摄像头，桌面/无可用的后置时自动回退到任意摄像头
// 返回 Promise<MediaStream>，失败时 toast 提示
function initCamera(videoEl) {
  _cameraReady = false;

  // 如果已有活跃流，先释放
  if (_currentStream) {
    stopCamera();
  }

  // 先尝试后置摄像头
  var tryRear = {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    },
    audio: false
  };

  // 回退：不限制摄像头方向
  var tryAny = {
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    },
    audio: false
  };

  function startStream(constraints) {
    return navigator.mediaDevices.getUserMedia(constraints)
      .then(function(stream) {
        _currentStream = stream;
        videoEl.srcObject = stream;

        return new Promise(function(resolve, reject) {
          videoEl.onloadedmetadata = function() {
            videoEl.play().then(function() {
              _cameraReady = true;
              // 先确保自动对焦是开着的（防止镜头停在别处导致画面发糊），
              // 再按需锁定成像参数。两者失败都不影响拍照。
              restoreAutoFocus();
              lockCameraParams();
              resolve(stream);
            }).catch(function(err) {
              reject(err);
            });
          };
          videoEl.onerror = function() {
            reject(new Error('视频加载失败'));
          };
        });
      });
  }

  return startStream(tryRear)
    .catch(function(rearErr) {
      // 后置失败（桌面常见），尝试不限制方向的约束
      console.warn('[Camera] 后置摄像头不可用，尝试回退:', rearErr.message);
      return startStream(tryAny);
    })
    .catch(function(err) {
      console.error('[Camera] 摄像头启动失败:', err.message);

      var message = '无法访问摄像头';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        message = '摄像头不可用，您可以通过下方按钮选择照片';
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        message = '未检测到摄像头，您可以通过下方按钮选择照片';
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        message = '摄像头被占用，您可以通过下方按钮选择照片';
      }

      showToast(message, 5000);
      throw err;
    });
}

// ---- 确保自动对焦处于开启状态 ----
// 单独拎出来、且不挂在 LOCK_CAMERA 开关下，是因为它属于「恢复」而不是「校准」：
// 万一镜头因为任何原因停在了某个固定位置（比如旧版本锁过手动对焦），
// 这里主动要一次连续对焦把它拉回来。不支持就静默跳过。
function restoreAutoFocus() {
  if (!_currentStream) return;

  var track = _currentStream.getVideoTracks()[0];
  if (!track || typeof track.getCapabilities !== 'function') return;

  var caps = null;
  try {
    caps = track.getCapabilities();
  } catch (e) {
    return;
  }
  var list = caps && caps.focusMode;
  if (!list || typeof list.indexOf !== 'function') return;

  // 连续对焦最省心；退而求其次用单次对焦，也能让画面重新清晰
  var want = null;
  if (list.indexOf('continuous') >= 0) want = 'continuous';
  else if (list.indexOf('single-shot') >= 0) want = 'single-shot';
  if (!want) return;

  track.applyConstraints({ advanced: [{ focusMode: want }] })
    .then(function() {
      console.log('[Camera] 自动对焦已开启:', want);
    })
    .catch(function(err) {
      // 设备不给这个权限也无所谓，保持系统默认行为即可
      console.warn('[Camera] 开启自动对焦失败（忽略）:', err && err.message);
    });
}

// ---- 锁定成像参数（自动校准 A1） ----
// 目标：关闭自动白平衡 / 自动曝光 / 自动对焦，减少帧间与设备间差异。
// 注意：这些属性在 W3C 规范里合法，但各机型实际支持率参差不齐，
//       所以必须先探测 getCapabilities()，只下发设备声明支持的属性，
//       全部失败时静默降级（绝不阻断拍照）。
function lockCameraParams() {
  _lockState = { supported: [], applied: [], failed: [], note: '' };

  if (!CALIB.ENABLED || !CALIB.LOCK_CAMERA) {
    _lockState.note = '未开启相机参数锁定（默认如此）';
    return _lockState;
  }

  if (!_currentStream) {
    _lockState.note = '无可用视频流';
    return _lockState;
  }

  var track = _currentStream.getVideoTracks()[0];
  if (!track || typeof track.getCapabilities !== 'function') {
    _lockState.note = '设备不支持参数探测';
    return _lockState;
  }

  var caps = null;
  try {
    caps = track.getCapabilities();
  } catch (e) {
    _lockState.note = '参数探测失败：' + e.message;
    return _lockState;
  }
  if (!caps) {
    _lockState.note = '设备未返回可用参数';
    return _lockState;
  }

  // 只收集设备明确声明支持的约束
  var desired = [];

  function pick(capName, wanted) {
    var list = caps[capName];
    if (!list || typeof list.indexOf !== 'function') return;
    for (var i = 0; i < wanted.length; i++) {
      if (list.indexOf(wanted[i]) >= 0) {
        var c = {};
        c[capName] = wanted[i];
        desired.push(c);
        _lockState.supported.push(capName);
        return;
      }
    }
  }

  // 优先 manual（完全锁定），其次 none（关闭自动算法）
  pick('whiteBalanceMode', ['manual', 'none']);
  pick('exposureMode', ['manual', 'none']);

  // 绝对不要锁 focusMode —— 这里踩过坑，记录一下：
  // 设成 'manual' 而不给 focusDistance，镜头会停在当时的物理位置上再也不动，
  // 取景画面和拍出来的照片全是糊的（实测就发生了这个）。
  // 而且对焦根本不是「光度参数」：它不影响荧光颜色，也不影响比值，
  // 糊了只会让测到的强度变低 —— 有百害而无一利。
  // 自动对焦保持开启。

  if (desired.length === 0) {
    _lockState.note = '该设备不支持锁定成像参数，已跳过';
    console.log('[Camera] ' + _lockState.note);
    return _lockState;
  }

  // 用 advanced 下发，避免与基础约束冲突导致 OverconstrainedError
  track.applyConstraints({ advanced: desired })
    .then(function() {
      var names = desired.map(function(d) { return Object.keys(d)[0]; });
      _lockState.applied = names;

      // 读回实际生效值，便于排查
      var s = (typeof track.getSettings === 'function') ? track.getSettings() : {};
      console.log('[Camera] 成像参数已锁定:', JSON.stringify({
        whiteBalanceMode: s.whiteBalanceMode,
        exposureMode: s.exposureMode,
        focusMode: s.focusMode
      }));
    })
    .catch(function(err) {
      _lockState.failed = desired.map(function(d) { return Object.keys(d)[0]; });
      _lockState.note = '锁定失败，已降级：' + (err && err.name ? err.name : err);
      console.warn('[Camera] 成像参数锁定失败（已降级，不影响拍照）:', err && err.message);
    });

  return _lockState;
}

// ---- 获取成像参数锁定状态 ----
function getCameraLockState() {
  return _lockState;
}

// ---- 释放摄像头 ----
function stopCamera() {
  _cameraReady = false;
  if (_currentStream) {
    _currentStream.getTracks().forEach(function(track) {
      track.stop();
    });
    _currentStream = null;
  }
}

// ---- 摄像头是否就绪 ----
function isCameraReady() {
  return _cameraReady;
}

// ---- 获取当前摄像头流 ----
function getCameraStream() {
  return _currentStream;
}

// ---- 捕获照片 ----
// 将视频当前帧绘制到 Canvas，返回该 Canvas
function capturePhoto(videoEl, canvas) {
  var videoWidth = videoEl.videoWidth;
  var videoHeight = videoEl.videoHeight;

  if (!videoWidth || !videoHeight) {
    console.error('[Camera] 视频未就绪，无法捕获');
    showToast('相机未就绪，请稍后重试', 3000);
    return null;
  }

  // Canvas 设为视频的实际分辨率
  canvas.width = videoWidth;
  canvas.height = videoHeight;

  var ctx = canvas.getContext('2d');
  // 后置摄像头直接绘制，不需要镜像
  ctx.drawImage(videoEl, 0, 0, videoWidth, videoHeight);

  return canvas;
}

// ---- 触发拍照闪白动画 ----
function triggerFlash() {
  var flash = document.getElementById('camera-flash');
  if (!flash) return;

  flash.classList.add('active');
  setTimeout(function() {
    flash.classList.remove('active');
  }, 300);
}
