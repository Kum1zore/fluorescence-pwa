// ========================================
// 应用启动入口 — 荧光检测平台
// ========================================

(function() {
  'use strict';

  // ---- DOMContentLoaded ----
  document.addEventListener('DOMContentLoaded', function() {

    // 1. 注册 Service Worker（离线支持）
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .then(function(reg) {
          console.log('[App] Service Worker registered:', reg.scope);
        })
        .catch(function(err) {
          console.warn('[App] Service Worker registration failed:', err.message);
        });
    }

    // 2. 初始化 IndexedDB
    initDB().then(function() {
      console.log('[App] IndexedDB initialized');
    }).catch(function(err) {
      console.warn('[App] IndexedDB init failed:', err.message);
    });

    // 3. 显示开始页
    showPage('start');

    // 4. 绑定导航事件
    bindNavigation();

    console.log('[App] 荧光检测平台 启动完成');
  });

  // ---- 导航事件绑定 ----
  function bindNavigation() {

    // 开始页 → 拍照页
    document.getElementById('btn-start-detect').addEventListener('click', function() {
      showPage('camera');
      var videoEl = document.getElementById('camera-video');
      initCamera(videoEl).catch(function() {
        // 摄像头不可用时仍然留在拍照页，用户可使用"从相册选择"
      });
    });

    // 开始页 → 历史记录页
    document.getElementById('btn-view-history').addEventListener('click', function() {
      showPage('history');
      loadHistoryList();
    });

    // 拍照页 → 返回开始页
    document.getElementById('btn-camera-back').addEventListener('click', function() {
      stopCamera();
      showPage('start');
    });

    // 拍照按钮
    document.getElementById('btn-capture').addEventListener('click', function() {
      // 检查摄像头是否真正就绪
      if (!isCameraReady()) {
        showToast('摄像头未就绪，请使用下方「从相册选择照片」功能', 4000);
        return;
      }

      var videoEl = document.getElementById('camera-video');
      var canvas = document.getElementById('capture-canvas');

      var result = capturePhoto(videoEl, canvas);
      if (!result) return; // capturePhoto 已处理 toast

      // 闪白动画
      triggerFlash();

      // 暂停摄像头（保持流但暂停预览，释放资源）
      stopCamera();

      // 短暂延迟后跳转（等闪白动画）
      setTimeout(function() {
        showPage('roi-select');
        setupROIPage();
      }, 350);
    });

    // 从相册选择照片
    document.getElementById('btn-pick-file').addEventListener('click', function() {
      document.getElementById('file-input').click();
    });

    document.getElementById('file-input').addEventListener('change', function(e) {
      var file = e.target.files[0];
      if (!file) return;

      var isTIFF = (file.name.toLowerCase().endsWith('.tif') ||
                    file.name.toLowerCase().endsWith('.tiff') ||
                    file.type === 'image/tiff');

      showLoading(true);
      stopCamera();

      if (isTIFF) {
        // ---- TIFF 文件（显微镜常用格式） ----
        var reader = new FileReader();
        reader.onload = function(ev) {
          try {
            var buffer = ev.target.result;
            var ifds = UTIF.decode(buffer);

            if (!ifds || ifds.length === 0) {
              throw new Error('TIFF 文件中未找到图像数据');
            }

            // 使用第一帧
            UTIF.decodeImage(buffer, ifds[0]);
            var rgba = UTIF.toRGBA8(ifds[0]);
            var w = ifds[0].width;
            var h = ifds[0].height;

            // 调试：输出 TIFF 属性
            console.log('[App] TIFF 解码: ' + w + 'x' + h +
              ', 光度解释(t262)=' + (ifds[0]["t262"] ? ifds[0]["t262"][0] : '?') +
              ', 位深(t258)=' + (ifds[0]["t258"] ? ifds[0]["t258"][0] : '?'));

            // ---- 规范化像素数据 ----
            // 部分显微镜 TIFF 的 UTIF 输出可能含有 16-bit 残留值或异常值
            var hasNaNorInf = false;
            var maxVal = 0;
            for (var p = 0; p < rgba.length; p++) {
              if (p % 4 === 3) continue; // 跳过 alpha
              var v = rgba[p];
              if (!isFinite(v)) { hasNaNorInf = true; break; }
              if (v > maxVal) maxVal = v;
            }
            // 如果最大值 > 255，说明含 16-bit 原始值，需缩放到 0-255
            if (!hasNaNorInf && maxVal > 255 && maxVal <= 65535) {
              console.log('[App] TIFF 像素值范围: 0-' + maxVal + ', 正在缩放到 0-255');
              var normScale = 255 / maxVal;
              for (var p = 0; p < rgba.length; p++) {
                if (p % 4 === 3) continue;
                rgba[p] = Math.round(rgba[p] * normScale);
              }
            }
            // 清除 NaN/Infinity
            var nanCount = 0;
            for (var p = 0; p < rgba.length; p++) {
              if (!isFinite(rgba[p])) { rgba[p] = 0; nanCount++; }
            }
            if (nanCount > 0 || hasNaNorInf) {
              console.warn('[App] TIFF 发现 ' + nanCount + ' 个异常像素值，已归零');
            }
            console.log('[App] TIFF 规范化完成, 像素最大值=' + maxVal + ', NaN数量=' + nanCount);

            var canvas = document.getElementById('capture-canvas');
            canvas.width = w;
            canvas.height = h;
            var ctx = canvas.getContext('2d');

            // 创建 ImageData 并写入 RGBA 数据
            var imageData = ctx.createImageData(w, h);
            imageData.data.set(rgba);
            ctx.putImageData(imageData, 0, 0);

            showLoading(false);
            showPage('roi-select');
            setupROIPage();

            if (ifds.length > 1) {
              showToast('TIFF 含 ' + ifds.length + ' 页，已使用第 1 页', 3000);
            }
          } catch (err) {
            console.error('[App] TIFF 解码失败:', err);
            showLoading(false);
            showToast('TIFF 文件解析失败，请确认文件未损坏', 3000);
          }
          e.target.value = '';
        };
        reader.onerror = function() {
          showLoading(false);
          showToast('文件读取失败', 2000);
          e.target.value = '';
        };
        reader.readAsArrayBuffer(file);
      } else {
        // ---- 常规图片（JPEG/PNG/WebP 等） ----
        if (!file.type.match(/^image\//)) {
          showLoading(false);
          showToast('请选择图片文件', 2000);
          return;
        }

        var img = new Image();
        img.onload = function() {
          var canvas = document.getElementById('capture-canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);

          // 验证 capture-canvas 有数据
          var testData = ctx.getImageData(0, 0, Math.min(10, img.width), 1);
          console.log('[App] 常规图片加载 — 尺寸:' + img.width + '×' + img.height +
            ', capture-canvas前10像素:', Array.prototype.slice.call(testData.data, 0, 10));

          showLoading(false);
          showPage('roi-select');
          setupROIPage();
          e.target.value = '';
        };
        img.onerror = function() {
          showLoading(false);
          showToast('图片加载失败，请重试', 3000);
          e.target.value = '';
        };

        var reader = new FileReader();
        reader.onload = function(ev) {
          img.src = ev.target.result;
        };
        reader.onerror = function() {
          showLoading(false);
          showToast('文件读取失败', 2000);
          e.target.value = '';
        };
        reader.readAsDataURL(file);
      }
    });

    // 选区域页 → 返回拍照页（重新初始化相机）
    document.getElementById('btn-roi-back').addEventListener('click', function() {
      showPage('camera');
      var videoEl = document.getElementById('camera-video');
      initCamera(videoEl).catch(function() {});
    });

    // 分析按钮
    document.getElementById('btn-analyze').addEventListener('click', function() {
      runAnalysis();
    });

    // 结果页 → 返回首页
    document.getElementById('btn-results-back').addEventListener('click', function() {
      showPage('start');
    });

    // 保存结果按钮
    document.getElementById('btn-save-result').addEventListener('click', function() {
      saveCurrentResult();
    });

    // 结果页双标签切换
    document.getElementById('tab-original').addEventListener('click', function() {
      this.classList.add('active');
      document.getElementById('tab-pseudocolor').classList.remove('active');
      if (_currentResult) drawResultImage(_currentResult.originalCrop);
    });
    document.getElementById('tab-pseudocolor').addEventListener('click', function() {
      this.classList.add('active');
      document.getElementById('tab-original').classList.remove('active');
      if (_currentResult) drawResultImage(_currentResult.pseudoCrop);
    });

    // 历史记录页 → 返回开始页
    document.getElementById('btn-history-back').addEventListener('click', function() {
      showPage('start');
    });

    // 清空所有记录（二次确认）
    document.getElementById('btn-clear-all').addEventListener('click', function() {
      showConfirm('清空全部记录', '此操作不可恢复，确认清空所有检测历史？', function() {
        clearAll().then(function() {
          loadHistoryList();
          showToast('所有记录已清空', 2000);
        }).catch(function() {
          showToast('清空失败，请重试', 2000);
        });
      });
    });
  }

  // ---- ROI 页面初始化 ----
  function setupROIPage() {
    var captureCanvas = document.getElementById('capture-canvas');
    var roiImageCanvas = document.getElementById('roi-image-canvas');
    var roiOverlayCanvas = document.getElementById('roi-overlay-canvas');

    // 将捕获的照片缩放到适配尺寸，绘制到 ROI 图片层
    var srcW = captureCanvas.width;
    var srcH = captureCanvas.height;

    if (!srcW || !srcH) {
      showToast('未找到照片，请重新拍照', 3000);
      showPage('camera');
      return;
    }

    // 计算缩放后尺寸（最大 MAX_DIMENSION）
    var scale = 1;
    if (Math.max(srcW, srcH) > CONFIG.MAX_DIMENSION) {
      scale = CONFIG.MAX_DIMENSION / Math.max(srcW, srcH);
    }
    var dstW = Math.round(srcW * scale);
    var dstH = Math.round(srcH * scale);

    roiImageCanvas.width = dstW;
    roiImageCanvas.height = dstH;
    roiOverlayCanvas.width = dstW;
    roiOverlayCanvas.height = dstH;

    var ctx = roiImageCanvas.getContext('2d');
    ctx.drawImage(captureCanvas, 0, 0, dstW, dstH);

    // 验证 roi-image-canvas 有数据
    var verifyData = ctx.getImageData(0, 0, Math.min(10, dstW), 1);
    console.log('[App] setupROIPage — roiImageCanvas:' + dstW + '×' + dstH +
      ', 前10像素:', Array.prototype.slice.call(verifyData.data, 0, 10));

    // 初始化 ROI 选区交互
    setButtonEnabled('#btn-analyze', false);

    initROISelection(roiImageCanvas, roiOverlayCanvas, function(roi) {
      setButtonEnabled('#btn-analyze', roi !== null);
    });
  }

  // ---- 全局：当前分析结果 ----
  var _currentResult = null; // { roi, stats, originalCrop, pseudoCrop, timestamp }

  // ---- 执行图像分析 ----
  function runAnalysis() {
    var roi = getROI();
    if (!roi) {
      showToast('请先选择荧光区域', 2000);
      return;
    }

    var roiImageCanvas = document.getElementById('roi-image-canvas');
    var imgCtx = roiImageCanvas.getContext('2d');

    // 获取图像数据
    var imageData = imgCtx.getImageData(0, 0, roiImageCanvas.width, roiImageCanvas.height);

    console.log('[App] runAnalysis — roi:', JSON.stringify(roi),
      'imageData:', imageData.width + '×' + imageData.height,
      '前10个像素:', Array.prototype.slice.call(imageData.data, 0, 10));

    showLoading(true);

    // 使用 setTimeout 避免阻塞 UI
    setTimeout(function() {
      try {
        // 运行处理流水线
        var result = processPipeline(imageData, roi);

        // 裁剪 ROI 区域的原始图像
        var originalCrop = _cropImageData(imageData, roi);
        console.log('[App] originalCrop:', originalCrop.width + '×' + originalCrop.height,
          '前10个像素:', Array.prototype.slice.call(originalCrop.data, 0, 10));

        // 对处理结果应用伪彩色，再裁剪 ROI
        var pseudo = applyPseudocolor(result.processedData);
        var pseudoCrop = _cropImageData(pseudo, roi);
        console.log('[App] pseudoCrop:', pseudoCrop.width + '×' + pseudoCrop.height,
          '前10个像素:', Array.prototype.slice.call(pseudoCrop.data, 0, 10));

        // 存储结果
        _currentResult = {
          roi: {
            x: roi.x,
            y: roi.y,
            width: roi.width,
            height: roi.height
          },
          stats: result.stats,
          originalCrop: originalCrop,
          pseudoCrop: pseudoCrop,
          timestamp: new Date().toISOString()
        };

        // 显示结果（先切换页面让容器可见，再绘制图片）
        showPage('results');
        displayResults(_currentResult);
        showLoading(false);
      } catch (err) {
        console.error('[App] 图像分析失败:', err);
        showLoading(false);
        showToast('图像分析失败，请重试', 3000);
      }
    }, 50);
  }

  // ---- 裁剪 ImageData 的子区域 ----
  function _cropImageData(imageData, roi) {
    // 整数化 ROI 坐标和尺寸，防止浮点导致 stride 错位
    var rx = Math.round(roi.x);
    var ry = Math.round(roi.y);
    var rw = Math.round(roi.width);
    var rh = Math.round(roi.height);

    // 钳制到源图像边界内
    var srcW = imageData.width;
    var srcH = imageData.height;
    if (rx < 0) { rw += rx; rx = 0; }
    if (ry < 0) { rh += ry; ry = 0; }
    if (rx + rw > srcW) rw = srcW - rx;
    if (ry + rh > srcH) rh = srcH - ry;
    if (rw <= 0 || rh <= 0) {
      console.warn('[App] _cropImageData — 无效 ROI:', {rx:rx, ry:ry, rw:rw, rh:rh});
      return new ImageData(1, 1);
    }

    var crop = new ImageData(rw, rh);
    var src = imageData.data;
    var dst = crop.data;

    for (var y = 0; y < rh; y++) {
      for (var x = 0; x < rw; x++) {
        var srcIdx = ((ry + y) * srcW + (rx + x)) * 4;
        var dstIdx = (y * rw + x) * 4;
        dst[dstIdx] = src[srcIdx];
        dst[dstIdx + 1] = src[srcIdx + 1];
        dst[dstIdx + 2] = src[srcIdx + 2];
        dst[dstIdx + 3] = src[srcIdx + 3];
      }
    }

    return crop;
  }

  // ---- 保存当前结果 ----
  function saveCurrentResult() {
    if (!_currentResult) return;

    showLoading(true);

    // 生成缩略图
    var originalThumb = _generateThumbnail(_currentResult.originalCrop);
    var processedThumb = _generateThumbnail(_currentResult.pseudoCrop);

    var record = {
      timestamp: _currentResult.timestamp,
      roi: _currentResult.roi,
      meanIntensity: _currentResult.stats.meanIntensity,
      integratedDensity: _currentResult.stats.integratedDensity,
      originalThumb: originalThumb,
      processedThumb: processedThumb
    };

    saveRecord(record).then(function() {
      showLoading(false);
      showPage('start');
      showToast('检测结果已保存', 2000);
    }).catch(function(err) {
      console.error('[App] 保存失败:', err);
      showLoading(false);
      showToast('保存失败，存储空间可能不足', 3000);
    });
  }

  // ---- 生成缩略图 Base64 ----
  function _generateThumbnail(imageData) {
    var temp = document.createElement('canvas');
    var scale = CONFIG.THUMB_WIDTH / imageData.width;
    temp.width = CONFIG.THUMB_WIDTH;
    temp.height = Math.round(imageData.height * scale);

    var fullCanvas = document.createElement('canvas');
    fullCanvas.width = imageData.width;
    fullCanvas.height = imageData.height;
    fullCanvas.getContext('2d').putImageData(imageData, 0, 0);

    var ctx = temp.getContext('2d');
    ctx.drawImage(fullCanvas, 0, 0, temp.width, temp.height);

    return temp.toDataURL('image/jpeg', 0.8);
  }

  // ---- 加载历史记录列表 ----
  function loadHistoryList() {
    var listEl = document.getElementById('history-list');
    var emptyEl = document.getElementById('history-empty');
    var countEl = document.getElementById('history-count');

    getAllRecords().then(function(records) {
      if (records.length === 0) {
        listEl.innerHTML = '';
        emptyEl.style.display = 'block';
        countEl.textContent = '共 0 条记录';
        return;
      }

      emptyEl.style.display = 'none';
      countEl.textContent = '共 ' + records.length + ' 条记录';

      // 渲染卡片列表
      var html = '';
      records.forEach(function(record) {
        var thumbSrc = record.originalThumb || record.processedThumb || '';
        html += '<div class="history-card" data-id="' + record.id + '">';
        html += '<img class="history-card-thumb" src="' + thumbSrc + '" alt="缩略图">';
        html += '<div class="history-card-info">';
        html += '<div class="history-card-date">' + (record.dateLabel || formatDate(record.timestamp)) + '</div>';
        html += '<div class="history-card-value">平均强度: ' + formatNumber(record.meanIntensity) + ' a.u.</div>';
        html += '</div>';
        html += '<button class="history-card-delete" data-id="' + record.id + '" title="删除">×</button>';
        html += '</div>';
      });

      listEl.innerHTML = html;

      // 绑定卡片点击（查看详情）
      var cards = listEl.querySelectorAll('.history-card');
      cards.forEach(function(card) {
        card.addEventListener('click', function(e) {
          // 如果点击的是删除按钮则不触发
          if (e.target.classList.contains('history-card-delete')) return;
          var id = parseInt(card.getAttribute('data-id'));
          viewHistoryDetail(id);
        });
      });

      // 绑定删除按钮
      var deleteBtns = listEl.querySelectorAll('.history-card-delete');
      deleteBtns.forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var id = parseInt(btn.getAttribute('data-id'));
          showConfirm('删除记录', '确认删除这条检测记录？', function() {
            deleteRecord(id).then(function() {
              loadHistoryList();
              showToast('记录已删除', 2000);
            }).catch(function() {
              showToast('删除失败，请重试', 2000);
            });
          });
        });
      });
    }).catch(function() {
      emptyEl.style.display = 'block';
      countEl.textContent = '共 0 条记录';
    });
  }

  // ---- 查看历史详情 ----
  var _isViewingHistory = false;

  function viewHistoryDetail(id) {
    showLoading(true);
    getRecord(id).then(function(record) {
      if (!record) {
        showLoading(false);
        showToast('记录不存在', 2000);
        return;
      }

      // 将缩略图 base64 加载为 ImageData
      Promise.all([
        _base64ToImageData(record.originalThumb),
        _base64ToImageData(record.processedThumb)
      ]).then(function(results) {
        var originalCrop = results[0];
        var pseudoCrop = results[1];

        // 构造兼容 _currentResult 的对象
        _currentResult = {
          roi: record.roi,
          stats: {
            meanIntensity: record.meanIntensity,
            integratedDensity: record.integratedDensity
          },
          originalCrop: originalCrop,
          pseudoCrop: pseudoCrop,
          timestamp: record.timestamp
        };

        _isViewingHistory = true;

        // 修改保存按钮为返回按钮
        var saveBtn = document.getElementById('btn-save-result');
        saveBtn.textContent = '返回历史记录';
        saveBtn.onclick = function() {
          _isViewingHistory = false;
          saveBtn.textContent = '保存记录并返回首页';
          saveBtn.onclick = function() { saveCurrentResult(); };
          showPage('history');
          loadHistoryList();
        };

        // 修改返回按钮行为
        var backBtn = document.getElementById('btn-results-back');
        var origBackHandler = backBtn.onclick;
        backBtn.onclick = function() {
          _isViewingHistory = false;
          saveBtn.textContent = '保存记录并返回首页';
          saveBtn.onclick = function() { saveCurrentResult(); };
          backBtn.onclick = origBackHandler;
          showPage('history');
          loadHistoryList();
        };

        showPage('results');
        displayResults(_currentResult);
        showLoading(false);
      }).catch(function() {
        showLoading(false);
        showToast('加载图片失败', 2000);
      });
    }).catch(function() {
      showLoading(false);
      showToast('读取记录失败', 2000);
    });
  }

  // ---- Base64 → ImageData ----
  function _base64ToImageData(base64) {
    return new Promise(function(resolve, reject) {
      if (!base64) {
        // 空缩略图，返回 1px 占位
        resolve(new ImageData(1, 1));
        return;
      }

      var img = new Image();
      img.onload = function() {
        var canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, img.width, img.height));
      };
      img.onerror = function() {
        reject(new Error('图片加载失败'));
      };
      img.src = base64;
    });
  }

  // ---- 自定义确认对话框 ----
  function showConfirm(title, message, onConfirm) {
    // 移除旧弹窗
    var old = document.querySelector('.confirm-overlay');
    if (old) old.remove();

    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    overlay.innerHTML =
      '<div class="confirm-dialog">' +
      '<div class="confirm-dialog-title">' + title + '</div>' +
      '<div class="confirm-dialog-msg">' + message + '</div>' +
      '<div class="confirm-dialog-buttons">' +
      '<button class="confirm-btn-cancel">取消</button>' +
      '<button class="confirm-btn-danger">确认</button>' +
      '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    // 点击遮罩关闭
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) {
        overlay.remove();
      }
    });

    // 取消按钮
    overlay.querySelector('.confirm-btn-cancel').addEventListener('click', function() {
      overlay.remove();
    });

    // 确认按钮
    overlay.querySelector('.confirm-btn-danger').addEventListener('click', function() {
      overlay.remove();
      if (onConfirm) onConfirm();
    });
  }

})();
