/**
 * 登录锁定状态的本地持久化。
 *
 * 锁定的权威来源是后端（以缓存键 TTL 为准），这里只用于：
 * 1. 用户从其它入口重新进入登录页（或刷新页面）时恢复同一提示；
 * 2. 多个浏览器标签页之间通过 storage 事件同步。
 *
 * 按用户名分别保存，因此切换账号时不会显示别的账号的锁定信息。
 */

export interface ServerLoginStatus {
  username: string;
  locked: boolean;
  remaining_seconds: number;
  remaining_attempts: number | null;
  max_failures: number;
  lock_seconds: number;
}

export interface StoredLock {
  /** 服务端给出的到期 Unix 时间戳（毫秒），本地倒计时只围绕它做展示 */
  lockedUntil: number;
  maxFailures: number;
  lockSeconds: number;
}

const STORAGE_KEY = 'login_locks';

type LockMap = Record<string, StoredLock>;

function readAll(): LockMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as LockMap) : {};
  } catch {
    return {};
  }
}

function writeAll(map: LockMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 隐私模式等场景下 localStorage 可能不可写，忽略即可
  }
}

function prune(map: LockMap, now: number): LockMap {
  let changed = false;
  for (const [key, lock] of Object.entries(map)) {
    if (!lock || lock.lockedUntil <= now) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) writeAll(map);
  return map;
}

export function getLock(username: string, now: number = Date.now()): StoredLock | null {
  if (!username) return null;
  const map = prune(readAll(), now);
  return map[username] ?? null;
}

export function setLock(
  username: string,
  remainingSeconds: number,
  maxFailures: number,
  lockSeconds: number,
  now: number = Date.now()
): StoredLock {
  const map = readAll();
  const lock: StoredLock = {
    lockedUntil: now + Math.max(0, remainingSeconds) * 1000,
    maxFailures,
    lockSeconds,
  };
  map[username] = lock;
  writeAll(map);
  return lock;
}

export function clearLock(username: string): void {
  if (!username) return;
  const map = readAll();
  if (username in map) {
    delete map[username];
    writeAll(map);
  }
}

/** 应用服务端状态：服务端说没锁就必须清掉本地残留；说锁了就以服务端 TTL 为准 */
export function applyServerStatus(status: ServerLoginStatus, now: number = Date.now()): StoredLock | null {
  if (status.locked && status.remaining_seconds > 0) {
    return setLock(
      status.username,
      status.remaining_seconds,
      status.max_failures,
      status.lock_seconds,
      now
    );
  }
  clearLock(status.username);
  return null;
}
