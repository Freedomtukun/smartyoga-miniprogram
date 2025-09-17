/*----------------------------------------------------
 * utils/upload-manager.js  ◇ SmartYoga 上传管理模块
 * - 管理多个上传任务的生命周期
 * - 支持批量处理和并发控制
 * - 集成智能重试机制
 *--------------------------------------------------*/

import { retryWithBackoff, RetryStrategies, cancellableRetry } from './retry';
import { uploadAndScore, processFrameScores } from './yoga-api';

/**
 * 上传任务状态枚举
 */
export const TaskStatus = {
  PENDING: 'pending',
  UPLOADING: 'uploading', 
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

/**
 * 上传管理器类
 * @typedef {Object} UploadTaskInfo
 * @property {wx.UploadTask} task - 微信上传任务
 * @property {string} poseId - 姿势ID
 * @property {string} status - 任务状态
 * @property {number} startTime - 开始时间
 * @property {number} progress - 上传进度 0-100
 * @property {Object} result - 结果数据
 * @property {Object} error - 错误信息
 */
export class UploadManager {
  constructor(options = {}) {
    const {
      maxConcurrent = 3,      // 最大并发数
      autoCleanMs = 10000,    // 自动清理延迟
      enableRetry = true,     // 启用重试
      retryStrategy = 'UPLOAD' // 重试策略
    } = options;
    
    this.config = { maxConcurrent, autoCleanMs, enableRetry, retryStrategy };
    this.tasks = new Map(); // taskId -> UploadTaskInfo
    this.listeners = new Set();
    this.activeCount = 0;   // 当前活跃任务数
    this.queue = [];        // 等待队列
    
    console.log('[UploadManager] Initialized with config:', this.config);
  }

  /**
   * 添加状态监听器
   * @param {Function} listener - (taskId, taskInfo, eventType) => void
   * @returns {Function} 取消监听函数
   */
  addListener(listener) {
    this.listeners.add(listener);
    
    // 返回清理函数
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 添加上传任务（支持队列管理）
   * @param {string} taskId - 任务唯一标识
   * @param {string} filePath - 文件路径
   * @param {string} poseId - 姿势ID
   * @param {Object} options - 任务配置
   * @returns {Promise<Object>} 上传结果
   */
  async addTask(taskId, filePath, poseId, options = {}) {
    const {
      priority = 0,        // 优先级，数字越大越优先
      timeout = 60000,     // 超时时间
      skipRetry = false    // 跳过重试
    } = options;
    
    console.log(`[UploadManager] Adding task: ${taskId}, queue size: ${this.queue.length}`);
    
    // 创建任务信息
    const taskInfo = {
      taskId,
      filePath,
      poseId,
      status: TaskStatus.PENDING,
      startTime: Date.now(),
      progress: 0,
      priority,
      timeout,
      skipRetry,
      result: null,
      error: null
    };
    
    this.tasks.set(taskId, taskInfo);
    this.notifyListeners(taskId, taskInfo, 'added');
    
    // 如果超过并发限制，加入队列
    if (this.activeCount >= this.config.maxConcurrent) {
      return new Promise((resolve, reject) => {
        this.queue.push({
          taskId,
          resolve,
          reject,
          execute: () => this._executeTask(taskId)
        });
        
        // 按优先级排序队列
        this.queue.sort((a, b) => {
          const taskA = this.tasks.get(a.taskId);
          const taskB = this.tasks.get(b.taskId);
          return (taskB?.priority || 0) - (taskA?.priority || 0);
        });
      });
    }
    
    // 直接执行任务
    return this._executeTask(taskId);
  }

  /**
   * 执行单个上传任务
   * @private
   */
  async _executeTask(taskId) {
    const taskInfo = this.tasks.get(taskId);
    if (!taskInfo || taskInfo.status === TaskStatus.CANCELLED) {
      return null;
    }
    
    this.activeCount++;
    this.updateTaskStatus(taskId, TaskStatus.UPLOADING);
    
    try {
      let result;
      
      if (this.config.enableRetry && !taskInfo.skipRetry) {
        // 使用重试机制
        const { promise, cancel } = cancellableRetry(
          () => this._doUpload(taskInfo),
          {
            ...RetryStrategies[this.config.retryStrategy],
            onRetry: (attempt, error, delay) => {
              console.log(`[UploadManager] Task ${taskId} retry ${attempt}, delay ${delay}ms`);
              this.notifyListeners(taskId, { ...taskInfo, retryAttempt: attempt }, 'retry');
            }
          }
        );
        
        // 保存取消函数
        taskInfo.cancelFn = cancel;
        result = await promise;
      } else {
        // 直接上传
        result = await this._doUpload(taskInfo);
      }
      
      this.updateTaskStatus(taskId, TaskStatus.COMPLETED, { result });
      return result;
      
    } catch (error) {
      console.error(`[UploadManager] Task ${taskId} failed:`, error);
      this.updateTaskStatus(taskId, TaskStatus.FAILED, { error });
      throw error;
      
    } finally {
      this.activeCount--;
      this._processQueue(); // 处理队列中的下一个任务
      this._scheduleCleanup(taskId); // 安排清理
    }
  }

  /**
   * 执行实际的上传操作
   * @private
   */
  async _doUpload(taskInfo) {
    const { filePath, poseId, taskId, timeout } = taskInfo;
    
    // 调用原有的上传函数
    const { promise, task } = uploadAndScore(filePath, poseId);
    
    // 保存微信上传任务引用
    taskInfo.wxTask = task;
    
    // 监听上传进度
    task.onProgressUpdate((res) => {
      this.updateTaskStatus(taskId, TaskStatus.UPLOADING, { 
        progress: res.progress 
      });
    });
    
    // 添加超时控制
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        task.abort();
        reject(Object.assign(new Error('Upload timeout'), { 
          code: 'TIMEOUT',
          taskId 
        }));
      }, timeout);
    });
    
    return Promise.race([promise, timeoutPromise]);
  }

  /**
   * 处理等待队列
   * @private
   */
  _processQueue() {
    while (this.queue.length > 0 && this.activeCount < this.config.maxConcurrent) {
      const queueItem = this.queue.shift();
      
      queueItem.execute()
        .then(queueItem.resolve)
        .catch(queueItem.reject);
    }
  }

  /**
   * 安排任务清理
   * @private
   */
  _scheduleCleanup(taskId) {
    setTimeout(() => {
      const taskInfo = this.tasks.get(taskId);
      if (taskInfo && [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED].includes(taskInfo.status)) {
        this.tasks.delete(taskId);
        this.notifyListeners(taskId, taskInfo, 'cleaned');
        console.log(`[UploadManager] Task ${taskId} cleaned up`);
      }
    }, this.config.autoCleanMs);
  }

  /**
   * 更新任务状态
   * @param {string} taskId - 任务ID
   * @param {string} status - 新状态
   * @param {Object} updates - 其他更新字段
   */
  updateTaskStatus(taskId, status, updates = {}) {
    const taskInfo = this.tasks.get(taskId);
    if (!taskInfo) return;
    
    const oldStatus = taskInfo.status;
    taskInfo.status = status;
    taskInfo.lastUpdate = Date.now();
    Object.assign(taskInfo, updates);
    
    this.notifyListeners(taskId, taskInfo, 'updated', { oldStatus });
  }

  /**
   * 通知所有监听器
   * @private
   */
  notifyListeners(taskId, taskInfo, eventType, extra = {}) {
    this.listeners.forEach(listener => {
      try {
        listener(taskId, taskInfo, eventType, extra);
      } catch (e) {
        console.error('[UploadManager] Listener error:', e);
      }
    });
  }

  /**
   * 取消指定任务
   * @param {string} taskId - 任务ID
   */
  cancelTask(taskId) {
    const taskInfo = this.tasks.get(taskId);
    if (!taskInfo) return false;
    
    // 取消微信上传任务
    if (taskInfo.wxTask) {
      taskInfo.wxTask.abort();
    }
    
    // 取消重试
    if (taskInfo.cancelFn) {
      taskInfo.cancelFn();
    }
    
    // 从队列中移除
    this.queue = this.queue.filter(item => item.taskId !== taskId);
    
    this.updateTaskStatus(taskId, TaskStatus.CANCELLED);
    console.log(`[UploadManager] Task cancelled: ${taskId}`);
    return true;
  }

  /**
   * 取消所有任务
   */
  cancelAllTasks() {
    console.log(`[UploadManager] Cancelling ${this.tasks.size} tasks`);
    
    const taskIds = Array.from(this.tasks.keys());
    taskIds.forEach(taskId => this.cancelTask(taskId));
    
    // 清空队列
    this.queue = [];
    this.activeCount = 0;
  }

  /**
   * 获取任务统计信息
   */
  getStats() {
    const tasks = Array.from(this.tasks.values());
    const stats = {
      total: tasks.length,
      active: this.activeCount,
      queued: this.queue.length,
      completed: tasks.filter(t => t.status === TaskStatus.COMPLETED).length,
      failed: tasks.filter(t => t.status === TaskStatus.FAILED).length,
      cancelled: tasks.filter(t => t.status === TaskStatus.CANCELLED).length
    };
    
    return stats;
  }

  /**
   * 获取所有任务信息
   */
  getAllTasks() {
    return Array.from(this.tasks.entries()).map(([id, info]) => ({
      id,
      ...info
    }));
  }
}

/**
 * 批量处理帧图片（使用PromisePool避免内存峰值）
 * @param {Array<string>} framePaths - 帧图片路径数组
 * @param {string} poseId - 姿势ID
 * @param {Object} options - 配置选项
 * @returns {Promise<Object>} 批处理结果
 */
export async function batchProcessFrames(framePaths, poseId, options = {}) {
  const {
    concurrency = 3,
    onProgress = null,
    onFrameComplete = null,
    enableRetry = true,
    maxRetries = 2,
    skipFailedFrames = true
  } = options;

  console.log(`[batchProcessFrames] Processing ${framePaths.length} frames, concurrency: ${concurrency}`);

  const results = [];
  const errors = [];
  let completed = 0;

  // 创建专用的上传管理器
  const manager = new UploadManager({
    maxConcurrent: concurrency,
    enableRetry,
    retryStrategy: 'UPLOAD'
  });

  // 监听任务状态变化
  const unsubscribe = manager.addListener((taskId, taskInfo, eventType) => {
    if (eventType === 'updated' && taskInfo.status === TaskStatus.COMPLETED) {
      completed++;
      results.push({
        index: parseInt(taskId.split('_')[1]),
        result: taskInfo.result,
        framePath: taskInfo.filePath
      });
      
      if (onFrameComplete) {
        onFrameComplete(taskInfo.result, completed, framePaths.length);
      }
      
      if (onProgress) {
        onProgress({
          completed,
          total: framePaths.length,
          progress: Math.round((completed / framePaths.length) * 100),
          currentResult: taskInfo.result
        });
      }
    } else if (eventType === 'updated' && taskInfo.status === TaskStatus.FAILED) {
      completed++;
      errors.push({
        index: parseInt(taskId.split('_')[1]),
        error: taskInfo.error,
        framePath: taskInfo.filePath
      });
    }
  });

  try {
    // 创建所有任务
    const taskPromises = framePaths.map((framePath, index) => {
      const taskId = `frame_${index}`;
      return manager.addTask(taskId, framePath, poseId, {
        priority: framePaths.length - index, // 优先处理前面的帧
        skipRetry: !enableRetry
      }).catch(error => {
        // 如果启用跳过失败帧，不抛出错误
        if (skipFailedFrames) {
          return null;
        }
        throw error;
      });
    });

    // 等待所有任务完成
    await Promise.all(taskPromises);

    // 处理结果
    const validResults = results
      .filter(r => r.result && r.result.score !== undefined)
      .sort((a, b) => a.index - b.index)
      .map(r => r.result);

    const processedScores = processFrameScores(validResults);

    return {
      ...processedScores,
      totalFrames: framePaths.length,
      processedFrames: results.length,
      failedFrames: errors.length,
      errors: errors,
      rawResults: results.sort((a, b) => a.index - b.index)
    };

  } finally {
    // 清理监听器和管理器
    unsubscribe();
    manager.cancelAllTasks();
  }
}

/**
 * 带重试的单次上传
 * @param {string} filePath - 文件路径
 * @param {string} poseId - 姿势ID
 * @param {Object} retryOptions - 重试配置
 * @returns {Promise<Object>} 上传结果
 */
export function uploadWithRetry(filePath, poseId, retryOptions = {}) {
  return retryWithBackoff(
    () => uploadAndScore(filePath, poseId).promise,
    {
      ...RetryStrategies.UPLOAD,
      ...retryOptions
    }
  );
}

// 导出全局上传管理器实例
export const globalUploadManager = new UploadManager();