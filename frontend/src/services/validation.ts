/**
 * 用户名/密码格式的统一标准（前后端一致）。
 *
 * - 用户名：去除首尾空白；3-50 字符；仅允许字母、数字、下划线、点、连字符
 * - 密码：保留原始输入（首尾空格可以是密码的一部分）；
 *         注册/改密要求 6-72 字节；登录只要求非空
 *
 * 登录与注册表单在提交前都必须经过这里处理，不允许各入口各写一套。
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 50;
export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_BYTES = 72;

/** UTF-8 字节数（与后端 len(password.encode('utf-8')) 对齐）。 */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** 提交前统一处理用户名：去首尾空白。 */
export function normalizeUsername(username: string): string {
  return (username ?? '').trim();
}

export interface ValidationResult {
  value?: string;
  error?: string;
}

/** 注册用的完整用户名校验。 */
export function validateUsername(username: string): ValidationResult {
  const value = normalizeUsername(username);
  if (!value) {
    return { error: '请输入用户名' };
  }
  if (value.length < USERNAME_MIN_LENGTH || value.length > USERNAME_MAX_LENGTH) {
    return {
      error: `用户名长度需为 ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} 个字符`,
    };
  }
  if (!USERNAME_PATTERN.test(value)) {
    return { error: '用户名只能包含字母、数字、下划线、点和连字符' };
  }
  return { value };
}

/** 登录前的用户名处理：只去空白并要求非空（不套用注册规则，与后端一致）。 */
export function validateLoginUsername(username: string): ValidationResult {
  const value = normalizeUsername(username);
  if (!value) {
    return { error: '请输入用户名' };
  }
  return { value };
}

/** 注册/改密用的完整密码校验（不做 trim）。 */
export function validatePassword(password: string): ValidationResult {
  if (!password) {
    return { error: '请输入密码' };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { error: `密码至少 ${PASSWORD_MIN_LENGTH} 个字符` };
  }
  if (byteLength(password) > PASSWORD_MAX_BYTES) {
    return { error: `密码不能超过 ${PASSWORD_MAX_BYTES} 个字节` };
  }
  return { value: password };
}

/** 登录前的密码处理：非空 + bcrypt 硬上限。 */
export function validateLoginPassword(password: string): ValidationResult {
  if (!password) {
    return { error: '请输入密码' };
  }
  if (byteLength(password) > PASSWORD_MAX_BYTES) {
    return { error: `密码不能超过 ${PASSWORD_MAX_BYTES} 个字节` };
  }
  return { value: password };
}
