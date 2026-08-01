// ========================================
// IndexedDB 存储 — 荧光检测平台
// ========================================

var _db = null;

// ---- 初始化数据库 ----
function initDB() {
  return new Promise(function(resolve, reject) {
    if (_db) {
      resolve(_db);
      return;
    }

    var request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        var store = db.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true
        });
        // 按时间戳排序的索引
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };

    request.onsuccess = function(e) {
      _db = e.target.result;
      resolve(_db);
    };

    request.onerror = function(e) {
      console.error('[Storage] IndexedDB 打开失败:', e.target.error);
      reject(e.target.error);
    };

    request.onblocked = function() {
      console.warn('[Storage] IndexedDB 被阻塞，请关闭其他标签页');
      reject(new Error('数据库被阻塞'));
    };
  });
}

// ---- 获取数据库实例（内部使用） ----
function _getDB() {
  if (_db) return Promise.resolve(_db);
  return initDB();
}

// ---- 保存记录 ----
function saveRecord(record) {
  return _getDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readwrite');
      var store = tx.objectStore(STORE_NAME);

      // 补充日期标签
      var toStore = {
        timestamp: record.timestamp,
        dateLabel: formatDate(record.timestamp),
        originalThumb: record.originalThumb || '',
        processedThumb: record.processedThumb || '',
        roi: record.roi,
        meanIntensity: record.meanIntensity,
        integratedDensity: record.integratedDensity
      };

      var request = store.add(toStore);

      request.onsuccess = function(e) {
        resolve(e.target.result); // 返回自增 id
      };

      request.onerror = function(e) {
        console.error('[Storage] 保存记录失败:', e.target.error);
        reject(e.target.error);
      };
    });
  });
}

// ---- 获取全部记录（按时间倒序） ----
function getAllRecords() {
  return _getDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readonly');
      var store = tx.objectStore(STORE_NAME);
      var index = store.index('timestamp');
      var records = [];

      var request = index.openCursor(null, 'prev'); // 倒序

      request.onsuccess = function(e) {
        var cursor = e.target.result;
        if (cursor) {
          records.push(cursor.value);
          cursor.continue();
        } else {
          resolve(records);
        }
      };

      request.onerror = function(e) {
        console.error('[Storage] 读取记录失败:', e.target.error);
        reject(e.target.error);
      };
    });
  });
}

// ---- 获取单条记录 ----
function getRecord(id) {
  return _getDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readonly');
      var store = tx.objectStore(STORE_NAME);
      var request = store.get(id);

      request.onsuccess = function(e) {
        resolve(e.target.result || null);
      };

      request.onerror = function(e) {
        console.error('[Storage] 读取记录失败:', e.target.error);
        reject(e.target.error);
      };
    });
  });
}

// ---- 删除单条记录 ----
function deleteRecord(id) {
  return _getDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readwrite');
      var store = tx.objectStore(STORE_NAME);
      var request = store.delete(id);

      request.onsuccess = function() {
        resolve();
      };

      request.onerror = function(e) {
        console.error('[Storage] 删除记录失败:', e.target.error);
        reject(e.target.error);
      };
    });
  });
}

// ---- 清空全部记录 ----
function clearAll() {
  return _getDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readwrite');
      var store = tx.objectStore(STORE_NAME);
      var request = store.clear();

      request.onsuccess = function() {
        resolve();
      };

      request.onerror = function(e) {
        console.error('[Storage] 清空记录失败:', e.target.error);
        reject(e.target.error);
      };
    });
  });
}
