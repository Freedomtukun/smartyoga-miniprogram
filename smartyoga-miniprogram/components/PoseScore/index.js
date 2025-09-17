// components/PoseScore/index.js
Component({
  properties: {
    // 基础属性
    poseName: { 
      type: String, 
      value: '' 
    },
    score: { 
      type: Number, 
      value: 0
    },
    advice: { 
      type: String, 
      value: '' 
    },
    keypoints: { 
      type: Array, 
      value: []
    },
    
    // Canvas 配置
    imgWidth: { 
      type: Number, 
      value: 480 
    },
    imgHeight: { 
      type: Number, 
      value: 480 
    },
    
    // 显示配置
    showDetails: { 
      type: Boolean, 
      value: false 
    },
    darkMode: { 
      type: Boolean, 
      value: false 
    },
    
    // 状态
    loading: { 
      type: Boolean, 
      value: false 
    },
    error: { 
      type: String, 
      value: '' 
    },
    
    // 元数据
    processingTime: { 
      type: Number, 
      value: 0 
    }
  },

  data: {
    // 显示分数
    displayScore: 0,
    
    // 分数等级
    scoreLevel: 'poor',
    scoreDescription: '继续努力',
    
    // 详情展开状态
    detailsExpanded: false,
    
    // 关键点统计
    validKeypoints: 0,
    totalKeypoints: 0,
    avgConfidence: 0,
    
    // Canvas 上下文
    canvasContext: null,
    
    // 设备像素比
    pixelRatio: 2
  },

  // 数据观察器
  observers: {
    'score': function(newScore) {
      this.updateScoreLevel(newScore);
      this.setData({ displayScore: Math.round(newScore) });
    },
    'keypoints': function(newKeypoints) {
      this.updateKeypointStats(newKeypoints);
      if (this.data.canvasContext) {
        this.drawSkeleton(newKeypoints);
      }
    }
  },

  lifetimes: {
    attached() {
      this.initCanvas();
      this.setData({ displayScore: Math.round(this.data.score) });
    },
    
    detached() {
      // 清理资源
      if (this.data.canvasContext) {
        this.clearCanvas();
      }
    }
  },

  methods: {
    /**
     * 初始化 Canvas
     */
    initCanvas() {
      try {
        const systemInfo = wx.getSystemInfoSync();
        const pixelRatio = systemInfo.pixelRatio || 2;
        
        const ctx = wx.createCanvasContext('skeletonCanvas', this);
        
        // 设置高分辨率
        const canvasWidth = this.data.imgWidth;
        const canvasHeight = this.data.imgHeight;
        
        this.setData({ 
          canvasContext: ctx,
          pixelRatio: pixelRatio
        });
        
        // 初始化画布
        this.clearCanvas();
        
      } catch (error) {
        console.error('Canvas 初始化失败:', error);
        this.setData({ error: 'Canvas 初始化失败' });
      }
    },

    /**
     * 清空 Canvas
     */
    clearCanvas() {
      const ctx = this.data.canvasContext;
      if (!ctx) return;
      
      const { imgWidth, imgHeight } = this.data;
      ctx.clearRect(0, 0, imgWidth, imgHeight);
      ctx.setFillStyle('#f8f9fa');
      ctx.fillRect(0, 0, imgWidth, imgHeight);
      ctx.draw();
    },

    /**
     * 更新分数等级
     */
    updateScoreLevel(score) {
      let level, description;
      
      if (score >= 90) {
        level = 'excellent';
        description = '完美！姿势非常标准';
      } else if (score >= 75) {
        level = 'good';
        description = '很好！继续保持';
      } else if (score >= 60) {
        level = 'average';
        description = '不错，还有提升空间';
      } else if (score >= 40) {
        level = 'poor';
        description = '需要调整，多加练习';
      } else {
        level = 'poor';
        description = '继续努力，加油！';
      }
      
      this.setData({
        scoreLevel: level,
        scoreDescription: description
      });
    },

    /**
     * 更新关键点统计
     */
    updateKeypointStats(keypoints) {
      if (!keypoints || keypoints.length === 0) {
        this.setData({
          validKeypoints: 0,
          totalKeypoints: 0,
          avgConfidence: 0
        });
        return;
      }
      
      const total = keypoints.length;
      const valid = keypoints.filter(kp => kp && kp.score >= 0.3).length;
      const totalConfidence = keypoints.reduce((sum, kp) => {
        return sum + (kp && kp.score ? kp.score : 0);
      }, 0);
      const avgConf = total > 0 ? totalConfidence / total : 0;
      
      this.setData({
        validKeypoints: valid,
        totalKeypoints: total,
        avgConfidence: Math.round(avgConf * 100)
      });
    },

    /**
     * 绘制骨架
     */
    drawSkeleton(keypoints) {
      const ctx = this.data.canvasContext;
      if (!ctx || !keypoints || keypoints.length === 0) {
        this.clearCanvas();
        return;
      }
      
      const { imgWidth, imgHeight } = this.data;
      
      // 清空画布
      ctx.clearRect(0, 0, imgWidth, imgHeight);
      
      // 设置背景
      ctx.setFillStyle(this.data.darkMode ? '#2d3748' : '#f8f9fa');
      ctx.fillRect(0, 0, imgWidth, imgHeight);
      
      // 先绘制连线
      this.drawSkeletonLines(ctx, keypoints);
      
      // 再绘制关键点（确保点在线的上方）
      keypoints.forEach((kp, index) => {
        if (!kp || kp.score < 0.2) return;
        
        let { x, y, score = 1 } = kp;
        
        // 处理坐标系转换
        if (x <= 1 && y <= 1) {
          x = x * imgWidth;
          y = y * imgHeight;
        }
        
        // 确保坐标在画布范围内
        x = Math.max(0, Math.min(x, imgWidth));
        y = Math.max(0, Math.min(y, imgHeight));
        
        // 根据置信度设置样式
        const alpha = Math.max(score, 0.4);
        const radius = score > 0.7 ? 8 : score > 0.5 ? 6 : 4;
        
        // 绘制外圈
        ctx.save();
        ctx.globalAlpha = alpha * 0.3;
        ctx.setFillStyle(this.getKeypointColor(index, score));
        ctx.beginPath();
        ctx.arc(x, y, radius + 2, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
        
        // 绘制内圈
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.setFillStyle(this.getKeypointColor(index, score));
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
        
        // 绘制中心点
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.setFillStyle('#ffffff');
        ctx.beginPath();
        ctx.arc(x, y, radius * 0.3, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
      });
      
      ctx.draw();
    },

    /**
     * 获取关键点颜色
     */
    getKeypointColor(index, score) {
      // 根据身体部位和置信度返回不同颜色
      const bodyParts = {
        face: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], // 面部
        arms: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22], // 手臂
        body: [11, 12, 23, 24], // 躯干
        legs: [23, 24, 25, 26, 27, 28, 29, 30, 31, 32] // 腿部
      };
      
      let baseColor = '#3b82f6'; // 默认蓝色
      
      if (bodyParts.face.includes(index)) {
        baseColor = '#f59e0b'; // 橙色 - 面部
      } else if (bodyParts.arms.includes(index)) {
        baseColor = '#10b981'; // 绿色 - 手臂
      } else if (bodyParts.body.includes(index)) {
        baseColor = '#8b5cf6'; // 紫色 - 躯干
      } else if (bodyParts.legs.includes(index)) {
        baseColor = '#ef4444'; // 红色 - 腿部
      }
      
      // 根据置信度调整颜色亮度
      if (score < 0.3) {
        return '#94a3b8'; // 灰色 - 低置信度
      } else if (score < 0.6) {
        return baseColor + '80'; // 半透明
      }
      
      return baseColor;
    },

    /**
     * 绘制骨架连线
     */
    drawSkeletonLines(ctx, keypoints) {
      // MediaPipe Pose 连接拓扑
      const connections = [
        // 面部轮廓
        [0, 1], [1, 2], [2, 3], [3, 7],
        [0, 4], [4, 5], [5, 6], [6, 8],
        [9, 10],
        
        // 躯干主线
        [11, 12], [11, 23], [12, 24], [23, 24],
        
        // 左臂
        [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
        
        // 右臂
        [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
        
        // 左腿
        [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
        
        // 右腿
        [24, 26], [26, 28], [28, 30], [28, 32], [30, 32]
      ];
      
      ctx.save();
      ctx.setStrokeStyle(this.data.darkMode ? '#60a5fa' : '#4f46e5');
      ctx.setLineWidth(3);
      ctx.setGlobalAlpha(0.6);
      ctx.setLineCap('round');
      
      connections.forEach(([startIdx, endIdx]) => {
        const start = keypoints[startIdx];
        const end = keypoints[endIdx];
        
        if (start && end && start.score > 0.3 && end.score > 0.3) {
          let startX = start.x, startY = start.y;
          let endX = end.x, endY = end.y;
          
          // 处理坐标系转换
          if (startX <= 1 && startY <= 1) {
            startX *= this.data.imgWidth;
            startY *= this.data.imgHeight;
          }
          if (endX <= 1 && endY <= 1) {
            endX *= this.data.imgWidth;
            endY *= this.data.imgHeight;
          }
          
          // 确保坐标在画布范围内
          startX = Math.max(0, Math.min(startX, this.data.imgWidth));
          startY = Math.max(0, Math.min(startY, this.data.imgHeight));
          endX = Math.max(0, Math.min(endX, this.data.imgWidth));
          endY = Math.max(0, Math.min(endY, this.data.imgHeight));
          
          ctx.beginPath();
          ctx.moveTo(startX, startY);
          ctx.lineTo(endX, endY);
          ctx.stroke();
        }
      });
      
      ctx.restore();
    },

    /**
     * 切换详情展开状态
     */
    toggleDetails() {
      this.setData({
        detailsExpanded: !this.data.detailsExpanded
      });
      
      // 触发展开/收起事件
      this.triggerEvent('detailsToggle', {
        expanded: !this.data.detailsExpanded
      });
    },

    /**
     * Canvas 点击事件
     */
    onCanvasTouch(e) {
      const { x, y } = e.touches[0];
      const { imgWidth, imgHeight } = this.data;
      
      // 转换为相对坐标
      const relativeX = x / imgWidth;
      const relativeY = y / imgHeight;
      
      // 查找最近的关键点
      const { keypoints } = this.data;
      if (keypoints && keypoints.length > 0) {
        let nearestPoint = null;
        let minDistance = Infinity;
        
        keypoints.forEach((kp, index) => {
          if (!kp || kp.score < 0.2) return;
          
          let kpX = kp.x, kpY = kp.y;
          if (kpX > 1 || kpY > 1) {
            kpX = kpX / imgWidth;
            kpY = kpY / imgHeight;
          }
          
          const distance = Math.sqrt(
            Math.pow(relativeX - kpX, 2) + Math.pow(relativeY - kpY, 2)
          );
          
          if (distance < minDistance && distance < 0.1) {
            minDistance = distance;
            nearestPoint = { index, keypoint: kp };
          }
        });
        
        if (nearestPoint) {
          this.triggerEvent('keypointTap', nearestPoint);
        }
      }
      
      this.triggerEvent('canvasTap', { x, y, relativeX, relativeY });
    },

    /**
     * 重试按钮点击
     */
    onRetry() {
      this.triggerEvent('retry', {
        timestamp: Date.now()
      });
    },

    /**
     * 导出当前骨架图
     */
    exportCanvas() {
      return new Promise((resolve, reject) => {
        if (!this.data.canvasContext) {
          reject(new Error('Canvas 未初始化'));
          return;
        }
        
        wx.canvasToTempFilePath({
          canvasId: 'skeletonCanvas',
          success: resolve,
          fail: reject
        }, this);
      });
    }
  }
});