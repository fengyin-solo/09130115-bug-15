/**
 * 登录安全策略展示常量。
 *
 * 判定以服务端配置为准（登录失败响应与 /auth/login-status 会返回
 * max_failures / lockout_seconds）；这里仅提供页面说明用的默认值，
 * 当服务端状态数据可用时应优先展示服务端值。
 */
export const DEFAULT_MAX_FAILURES = 5;
export const DEFAULT_LOCKOUT_SECONDS = 300;
