/*----------------------------------------------------
 * utils/api.js  ◇ SmartYoga 云函数封装
 * - 统一云函数调用接口
 * - 标准化错误处理
 * - 请求日志和监控
 *--------------------------------------------------*/

/**
 * 错误码枚举
 */
export const ApiErrorCodes = {
  SUCCESS: 0,
  PARAM_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SERVER_ERROR: 500,
  NETWORK_ERROR: 1001,
  TIMEOUT: 1002,
  FUNCTION_NOT_FOUND: 1003
};

/**
 * 通用云函数调用封装
 * @param {string} name - 云函数名称
 * @param {Object} data - 传递的数据
 * @param {Object} config - 调用配置
 * @returns {Promise<any>} 返回云函数结果数据
 */
export const call = async (name, data = {}, config = {}) => {
  const {
    timeout = 30000,      // 超时时间
    enableLog = true,     // 启用日志
    retries = 0,          // 重试次数（暂时保留，建议用 retry.js）
    headers = {}          // 自定义头部
  } = config;
  
  const startTime = Date.now();
  
  if (enableLog) {
    console.log(`[API] 调用云函数: ${name}`, { data, config });
  }
  
  try {
    const result = await wx.cloud.callFunction({
      name,
      data,
      config: {
        timeout,
        ...headers
      }
    });
    
    const duration = Date.now() - startTime;
    const response = result.result || {};
    
    if (enableLog) {
      console.log(`[API] 云函数 ${name} 响应 (${duration}ms):`, {
        code: response.code,
        message: response.message,
        dataLength: response.data ? JSON.stringify(response.data).length : 0
      });
    }
    
    // 检查业务错误码
    if (response.code !== ApiErrorCodes.SUCCESS) {
      const error = new Error(response.message || '云函数调用失败');
      error.code = response.code;
      error.functionName = name;
      error.serverResponse = response;
      throw error;
    }
    
    return response.data;
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    // 增强错误信息
    if (error.errCode) {
      // 微信小程序错误
      error.code = error.errCode;
      error.apiError = true;
      
      switch (error.errCode) {
        case -404011:
          error.message = `云函数 ${name} 不存在`;
          error.code = ApiErrorCodes.FUNCTION_NOT_FOUND;
          break;
        case -404013:
          error.message = '云函数执行超时';
          error.code = ApiErrorCodes.TIMEOUT;
          break;
        case -404012:
          error.message = '云函数执行失败';
          error.code = ApiErrorCodes.SERVER_ERROR;
          break;
        default:
          error.message = error.errMsg || `云函数调用异常: ${error.errCode}`;
          error.code = ApiErrorCodes.NETWORK_ERROR;
      }
    }
    
    error.functionName = name;
    error.duration = duration;
    error.requestData = data;
    
    console.error(`[API] 云函数 ${name} 调用失败 (${duration}ms):`, {
      code: error.code,
      message: error.message,
      errCode: error.errCode,
      errMsg: error.errMsg
    });
    
    throw error;
  }
};

/**
 * 批量调用云函数
 * @param {Array<{name: string, data: Object}>} calls - 调用配置数组
 * @param {Object} options - 选项
 * @returns {Promise<Array>} 结果数组
 */
export const batchCall = async (calls, options = {}) => {
  const {
    concurrency = 3,
    failFast = false,    // 是否在第一个失败时停止
    enableLog = true
  } = options;
  
  if (enableLog) {
    console.log(`[API] 批量调用 ${calls.length} 个云函数, 并发: ${concurrency}`);
  }
  
  const results = [];
  const errors = [];
  
  // 分批处理
  for (let i = 0; i < calls.length; i += concurrency) {
    const batch = calls.slice(i, i + concurrency);
    
    const batchPromises = batch.map(async (callConfig, index) => {
      try {
        const result = await call(callConfig.name, callConfig.data, callConfig.config);
        return { 
          success: true, 
          result, 
          index: i + index,
          functionName: callConfig.name 
        };
      } catch (error) {
        const errorInfo = { 
          success: false, 
          error, 
          index: i + index,
          functionName: callConfig.name 
        };
        
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
  
  if (enableLog) {
    console.log(`[API] 批量调用完成: ${results.filter(r => r.success).length}/${calls.length} 成功`);
  }
  
  return {
    results: results.filter(r => r.success).map(r => ({ 
      result: r.result, 
      index: r.index, 
      functionName: r.functionName 
    })),
    errors,
    totalCount: calls.length,
    successCount: results.filter(r => r.success).length,
    errorCount: errors.length
  };
};

/**
 * 获取云函数调用统计（本地存储）
 */
export const getCallStats = () => {
  try {
    const stats = wx.getStorageSync('api-call-stats') || {
      totalCalls: 0,
      successCalls: 0,
      errorCalls: 0,
      lastCallTime: null,
      functionStats: {} // functionName -> { calls, errors, lastCall }
    };
    return stats;
  } catch (e) {
    return { totalCalls: 0, successCalls: 0, errorCalls: 0 };
  }
};

/**
 * 更新调用统计
 * @private
 */
const updateCallStats = (functionName, success = true) => {
  try {
    const stats = getCallStats();
    stats.totalCalls++;
    stats.lastCallTime = Date.now();
    
    if (success) {
      stats.successCalls++;
    } else {
      stats.errorCalls++;
    }
    
    // 更新函数级统计
    if (!stats.functionStats[functionName]) {
      stats.functionStats[functionName] = { calls: 0, errors: 0, lastCall: null };
    }
    
    stats.functionStats[functionName].calls++;
    stats.functionStats[functionName].lastCall = Date.now();
    
    if (!success) {
      stats.functionStats[functionName].errors++;
    }
    
    wx.setStorageSync('api-call-stats', stats);
  } catch (e) {
    console.warn('[API] Failed to update call stats:', e);
  }
};

/**
 * 清除调用统计
 */
export const clearCallStats = () => {
  try {
    wx.removeStorageSync('api-call-stats');
    console.log('[API] Call stats cleared');
  } catch (e) {
    console.warn('[API] Failed to clear call stats:', e);
  }
};

// 增强原有的 call 函数，添加统计功能
const originalCall = call;
export { originalCall as callWithoutStats };

// 重新导出带统计的 call 函数
export const call = async (name, data = {}, config = {}) => {
  try {
    const result = await originalCall(name, data, config);
    updateCallStats(name, true);
    return result;
  } catch (error) {
    updateCallStats(name, false);
    throw error;
  }
};