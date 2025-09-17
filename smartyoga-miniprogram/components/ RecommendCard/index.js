Component({
  properties: {
    item: {
      type: Object,
      value: null
    },
    showDistance: {
      type: Boolean,
      value: true
    },
    showRating: {
      type: Boolean,
      value: true
    },
    theme: {
      type: String,
      value: 'light'
    },
    unit: {
      type: String,
      value: 'metric' // metric | imperial
    }
  },

  data: {
    loading: false,
    formattedDistance: '',
    displayName: '',
    themeClass: ''
  },

  // 私有变量
  _busy: false,
  _timer: null,

  // 生命周期
  detached() {
    // ✅ 清理定时器，避免内存泄漏
    this.clearTimer();
  },

  methods: {
    // ✅ 提取防抖锁定逻辑
    lock() {
      if (this._busy) return false;
      this._busy = true;
      return true;
    },

    unlock(delay = 500) { // ✅ 调整为 500ms，对低端机更友好
      this.clearTimer();
      if (delay) {
        this._timer = setTimeout(() => {
          this._busy = false;
        }, delay);
      } else {
        this._busy = false;
      }
    },

    clearTimer() {
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
    },

    // ✅ 封装埋点方法
    analytics(event, data) {
      if (wx.reportAnalytics) {
        wx.reportAnalytics(event, data);
      }
    },

    // 主要点击事件 - 简化后
    tap() {
      if (!this.lock() || !this.data.item) return;
      
      const item = this.data.item;
      
      // 埋点统计
      if (item.id) {
        this.analytics('poi_click', { 
          id: item.id,
          name: item.name,
          category: item.category 
        });
      }
      
      this.triggerEvent('tap', item);
      this.unlock();
    },

    // 打开地图 - 优化错误处理
    openMap(e) {
      e.stopPropagation();
      
      if (!this.lock()) return;
      
      const item = this.data.item;
      if (!item || !item.location || !item.location.lat || !item.location.lng) {
        wx.showToast({
          title: '暂无位置信息',
          icon: 'none'
        });
        this.unlock();
        return;
      }

      this.setData({ loading: true });

      wx.openLocation({
        latitude: Number(item.location.lat),
        longitude: Number(item.location.lng),
        name: item.name || '推荐地点',
        address: item.address || '',
        scale: 16,
        success: () => {
          this.analytics('map_open', {
            poi_id: item.id,
            poi_name: item.name
          });
        },
        fail: (err) => {
          console.error('打开地图失败:', err);
          wx.showToast({
            title: '打开地图失败',
            icon: 'none'
          });
        },
        complete: () => {
          // ✅ 统一在 complete 处理，确保所有情况都会执行
          this.setData({ loading: false });
          this.unlock();
        }
      });
    }
  },

  // 数据监听器 - 优化性能
  observers: {
    'item': function(item) {
      // ✅ 使用 wx.nextTick 减少频繁 setData
      wx.nextTick(() => {
        if (!item) {
          this.setData({ 
            formattedDistance: '',
            displayName: ''
          });
          return;
        }

        const updates = {};
        
        // 格式化距离
        if (this.data.showDistance) {
          updates.formattedDistance = this.formatDistance(item.distance);
        }
        
        // 处理长文本 (优先使用 CSS 截断，JS 作为备选)
        updates.displayName = item.name || '';
        
        this.setData(updates);
      });
    },

    'theme': function(theme) {
      // ✅ 处理主题切换
      this.setData({
        themeClass: theme === 'dark' ? 'recommend-card--dark' : ''
      });
    }
  },

  // 工具方法
  formatDistance(distance) {
    if (!distance && distance !== 0) return '';
    
    const distanceNum = Number(distance);
    if (isNaN(distanceNum)) return '';
    
    const { unit } = this.data;
    
    if (unit === 'imperial') {
      // ✅ 英制单位支持
      const feet = distanceNum * 3.28084;
      const miles = distanceNum * 0.000621371;
      
      return miles >= 0.1 
        ? `${miles.toFixed(1)}mi`
        : `${Math.round(feet)}ft`;
    } else {
      // 公制单位
      return distanceNum < 1000 
        ? `${Math.round(distanceNum)}m`
        : `${(distanceNum / 1000).toFixed(1)}km`;
    }
  }
});