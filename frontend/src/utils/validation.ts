/**
 * 用户名/密码格式标准 —— 前后端唯一事实来源。
 * 后端对应实现：backend/app/services/login_guard.py
 * 修改规则时两处必须同步。
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 50;
export const PASSWORD_MIN_LENGTH = 6;
// bcrypt 有效长度上限
export const PASSWORD_MAX_LENGTH = 72;

const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,50}$/;
// Cc = Unicode 控制字符类别
const CONTROL_CHAR_PATTERN = /\p{Cc}/u;

/** 用户名：NFKC 兼容分解后去除首尾空白，比较与提交均使用归一化结果 */
export function normalizeUsername(value: string): string {
  if (value === null || value === undefined) return '';
  return String(value).normalize('NFKC').trim();
}

/** 校验用户名，返回错误信息；null 表示通过 */
export function validateUsername(value: string): string | null {
  const username = normalizeUsername(value);
  if (!username) return '请输入用户名';
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    return `用户名长度需为${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH}个字符`;
  }
  if (!USERNAME_PATTERN.test(username)) {
    return '用户名只能包含字母、数字和下划线';
  }
  return null;
}

/** 校验密码（不做 trim，首尾空格本身属于非法格式），返回错误信息；null 表示通过 */
export function validatePassword(value: string): string | null {
  if (value === null || value === undefined || value === '') return '请输入密码';
  if (value.length < PASSWORD_MIN_LENGTH) return '密码至少6个字符';
  if (value.length > PASSWORD_MAX_LENGTH) return `密码不能超过${PASSWORD_MAX_LENGTH}个字符`;
  if (value !== value.trim()) return '密码首尾不能包含空白字符';
  if (CONTROL_CHAR_PATTERN.test(value)) return '密码不能包含控制字符';
  return null;
}
