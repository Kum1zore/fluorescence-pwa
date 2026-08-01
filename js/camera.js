// ========================================
// 相机管理 — 荧光检测平台
// ========================================

var _currentStream = null;
var _cameraReady = false;

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
