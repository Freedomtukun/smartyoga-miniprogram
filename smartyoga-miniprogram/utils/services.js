/**
 * @typedef {{x:number, y:number, score:number}} Keypoint
 * @typedef {{poseName:string, score:number, advice:string, keypoints:Array<Keypoint>}} PoseResult
 * @typedef {{pois: Array}} PoiResult
 * @typedef {{text: string, audioUrl: string}} MeditationResult - The audioUrl can be a standard CDN link or a base64 data URI.
 * @typedef {{success: boolean, inviter: string}} InviteResult
 */

// 引入统一云函数调用封装
import { call } from './api';

// 🌟 推荐结构布局
// --------------------------------------
// 1. 姿势评分智能体（poseDetect）
// 2. 商家推荐智能体（map-recommend）
// 3. 冥想生成智能体（meditation-agent）
// 4. 邀请码/分享逻辑（可选）
// --------------------------------------

/**
 * 1. 姿势评分智能体
 */

/**
 * 姿势检测智能体：上传图片后触发评分/识别/建议
 * @param {string} imageKey - COS 路径（如 "user/pose123.jpg"）
 * @param {object} [options] - 可选参数
 * @param {boolean} [options.skipAudio=false] - 是否跳过语音生成
 * @param {any} [options.rest] - 其他未来可能增加的参数，如 modelVersion
 * @returns {Promise<PoseResult>}
 */
export const detectPose = async (imageKey, { skipAudio = false, ...rest } = {}) =>
  call('feedback-agent', {
    type: 'poseDetect',
    imageKey,
    skipAudio,
    ...rest
  });

/**
 * 2. 商家推荐智能体
 */

/**
 * 地图推荐智能体：基于定位返回附近推荐
 * @param {number|string} lng - 经度
 * @param {number|string} lat - 纬度
 * @param {string} [bizType='yoga'] - 推荐类别（如 'yoga'、'meditation'）
 * @returns {Promise<PoiResult>}
 */
export const recommendPoi = async (lng, lat, bizType = 'yoga') => {
  const lngNum = Number(lng);
  const latNum = Number(lat);

  // 防止页面传入空字符串或无效值导致 NaN
  if (Number.isNaN(lngNum)) {
    throw new Error('Invalid lng provided to recommendPoi service.');
  }
  if (Number.isNaN(latNum)) {
    throw new Error('Invalid lat provided to recommendPoi service.');
  }

  return call('map-recommend', {
    lng: lngNum,
    lat: latNum,
    bizType
  });
};

/**
 * 3. 冥想生成智能体
 */

/**
 * 冥想生成智能体：返回冥想文本 + 音频
 * @param {string} [theme='sleep'] - 如 'sleep', 'relax', 'focus'
 * @param {string} [lang='zh'] - 默认 'zh'
 * @returns {Promise<MeditationResult>}
 */
export const meditationGuide = async (theme = 'sleep', lang = 'zh') =>
  call('meditation-agent', {
    theme,
    lang
  });

/**
 * 4. 邀请码/分享逻辑
 */

// optional
/**
 * 使用邀请码（用于推荐功能绑定上下级）
 * @param {string} code - 邀请码
 * @returns {Promise<InviteResult>}
 */
export const applyInviteCode = async (code) =>
  call('feedback-agent', {
    type: 'invite',
    code
  });


/**
 * 统一导出，方便页面 `import services from '...'`
 */
export default {
  detectPose,
  recommendPoi,
  meditationGuide,
  applyInviteCode, // TODO: enable or remove based on whether the invite feature is online
};