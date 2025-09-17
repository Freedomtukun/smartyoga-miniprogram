/*----------------------------------------------------
 * utils/retry.js  ◇ SmartYoga 通用重试模块
 * - 智能退避重试算法
 * - 可配置重试条件
 * - 支持多种场景复用
 *--------------------------------------------------*/

/**
 * 错误类型枚举
 */
export const ErrorTypes = {
    NETWORK: 'NETWORK',
    SERVER: 'SERVER', 
    TIMEOUT: 'TIMEOUT',
    USER_ABORT: 'USER_ABORT',
    QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
    INVALID_PARAMS: 'INVALID_PARAMS'
  };
  
  /**
   * 预定义重试策略
   */
  export const RetryStrategies = {
    // 网络请求重试
    NETWORK: {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      backoffFactor: 2,
      retryCondition: (error) => {
        const retryableTypes = [ErrorTypes.NETWORK, ErrorTypes.TIMEOUT, ErrorTypes.SERVER];
        return retryableTypes.includes(error.type) || 
               (error.code && ['NETWORK_ERROR', 'TIMEOUT', 'HTTP_ERROR'].includes(error.code));
      }
    },
    
    // 文件上传重试
    UPLOAD: {
      maxRetries: 2,
      baseDelay: 2000,
      maxDelay: 15000,
      backoffFactor: 2.5,
      retryCondition: (error) => {
        // 不重试用户主动取消的操作
        if (error.wasAborted || error.code === 'USER_ABORT') return false;
        // 重试网络和服务器错误
        return ['UPLOAD_FAILED', 'HTTP_ERROR', 'NETWORK_ERROR'].includes(error.code);
      }
    },
    
    // 快速重试（API调用）
    FAST: {
      maxRetries: 2,
      baseDelay: 500,
      maxDelay: 2000,
      backoffFactor: 2,
      retryCondition: (error) => error.retryable !== false
    }
  };
  
  /**
   * 指数退避重试函数
   * @param {Function} fn - 要重试的异步函数
   * @param {Object|string} options - 重试配置或预定义策略名
   * @returns {Promise} 重试结果
   */
  export async function retryWithBackoff(fn, options = {}) {
    // 如果传入字符串，使用预定义策略
    if (typeof options === 'string') {
      options = RetryStrategies[options.toUpperCase()] || RetryStrategies.NETWORK;
    }
    
    const {
      maxRetries = 3,
      baseDelay = 1000,
      maxDelay = 10000,
      backoffFactor = 2,
      retryCondition = () => true,
      onRetry = null, // 重试回调 (attempt, error, delay) => void
      jitter = true   // 添加随机抖动避免雪崩
    } = options;
  
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // 记录重试开始时间
        const startTime = Date.now();
        const result = await fn();
        
        // 如果不是第一次尝试，记录成功日志
        if (attempt > 0) {
          console.log(`[retryWithBackoff] Success after ${attempt} retries, took ${Date.now() - startTime}ms`);
        }
        
        return result;
      } catch (error) {
        lastError = error;
        
        // 检查是否应该重试
        if (attempt === maxRetries || !retryCondition(error)) {
          console.error(`[retryWithBackoff] Final failure after ${attempt} attempts:`, error);
          throw error;
        }
  
        // 计算延迟时间
        let delay = Math.min(
          baseDelay * Math.pow(backoffFactor, attempt),
          maxDelay
        );
        
        // 添加随机抖动 (±25%)
        if (jitter) {
          const jitterAmount = delay * 0.25;
          delay += (Math.random() - 0.5) * 2 * jitterAmount;
          delay = Math.max(delay, baseDelay * 0.5); // 确保最小延迟
        }
  
        console.warn(`[retryWithBackoff] Attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${Math.round(delay)}ms`, {
          error: error.message || error,
          errorCode: error.code,
          errorType: error.type
        });
        
        // 调用重试回调
        if (onRetry) {
          try {
            onRetry(attempt + 1, error, delay);
          } catch (callbackError) {
            console.error('[retryWithBackoff] Retry callback error:', callbackError);
          }
        }
        
        // 等待后重试
        await sleep(delay);
      }
    }
    
    throw lastError;
  }
  
  /**
   * 批量重试函数
   * @param {Array<Function>} functions - 要重试的函数数组
   * @param {Object} options - 重试配置
   * @returns {Promise<Array>} 所有结果数组
   */
  export async function batchRetry(functions, options = {}) {
    const {
      concurrency = 3,
      failFast = false, // 是否在第一个失败时停止
      ...retryOptions
    } = options;
    
    const results = [];
    const errors = [];
    
    // 分批处理
    for (let i = 0; i < functions.length; i += concurrency) {
      const batch = functions.slice(i, i + concurrency);
      
      const batchPromises = batch.map(async (fn, index) => {
        try {
          const result = await retryWithBackoff(fn, retryOptions);
          return { success: true, result, index: i + index };
        } catch (error) {
          const errorInfo = { success: false, error, index: i + index };
          errors.push(errorInfo);
          
          if (failFast) {
            throw error;
          }
          
          return errorInfo;
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }
    
    return {
      results: results.filter(r => r.success).map(r => r.result),
      errors,
      totalCount: functions.length,
      successCount: results.filter(r => r.success).length,
      errorCount: errors.length
    };
  }
  
  /**
   * 条件重试：只有满足条件才执行重试
   * @param {Function} condition - 检查条件的函数
   * @param {Function} fn - 要执行的函数
   * @param {Object} options - 重试配置
   */
  export async function retryWhen(condition, fn, options = {}) {
    const shouldRetry = await condition();
    if (!shouldRetry) {
      throw new Error('Retry condition not met');
    }
    
    return retryWithBackoff(fn, options);
  }
  
  /**
   * 超时重试：为函数添加超时和重试
   * @param {Function} fn - 要执行的函数
   * @param {number} timeoutMs - 超时时间
   * @param {Object} retryOptions - 重试配置
   */
  export async function retryWithTimeout(fn, timeoutMs = 30000, retryOptions = {}) {
    const timeoutFn = async () => {
      return Promise.race([
        fn(),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(Object.assign(new Error('Timeout'), { 
              type: ErrorTypes.TIMEOUT,
              code: 'TIMEOUT'
            }));
          }, timeoutMs);
        })
      ]);
    };
    
    return retryWithBackoff(timeoutFn, {
      ...RetryStrategies.NETWORK,
      ...retryOptions
    });
  }
  
  /**
   * 辅助函数：等待指定时间
   * @param {number} ms - 等待毫秒数
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 创建可取消的重试
   * @param {Function} fn - 要重试的函数
   * @param {Object} options - 重试配置
   * @returns {{promise: Promise, cancel: Function}}
   */
  export function cancellableRetry(fn, options = {}) {
    let cancelled = false;
    let currentController = null;
    
    const cancel = () => {
      cancelled = true;
      if (currentController && typeof currentController.abort === 'function') {
        currentController.abort();
      }
    };
    
    const promise = retryWithBackoff(async () => {
      if (cancelled) {
        throw Object.assign(new Error('Cancelled'), { 
          type: ErrorTypes.USER_ABORT,
          code: 'USER_ABORT',
          wasAborted: true 
        });
      }
      
      // 如果原函数支持取消，传入控制器
      if (typeof fn === 'function' && fn.length > 0) {
        currentController = { abort: cancel };
        return fn(currentController);
      }
      
      return fn();
    }, {
      ...options,
      retryCondition: (error) => {
        if (cancelled || error.wasAborted) return false;
        return options.retryCondition ? options.retryCondition(error) : true;
      }
    });
    
    return { promise, cancel };
  }