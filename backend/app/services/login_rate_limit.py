"""登录失败计数与临时锁定。

计数与锁定均以 (规范化用户名, 来源IP) 为键：
- 不同账号互不影响；
- 同一账号在不同网络来源（IP）的失败次数分开计算。

锁定信息存的是绝对到期时间戳（服务端时钟），任何客户端读到的
剩余秒数都以服务端时间为准，避免本地倒计时与服务端判定不一致。

Redis 可用时使用 Redis（多进程/多实例共享状态，计数递增通过 Lua
脚本原子完成），否则降级为带锁的进程内存储。
"""
from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass
from typing import Optional, Tuple

from ..config import get_settings

settings = get_settings()

_FAIL_PREFIX = "login_fail:"
_LOCK_PREFIX = "login_lock:"

# 原子地完成"检查锁定 -> 窗口判定 -> 计数+1 -> 触发锁定"，
# 避免并发失败请求在 read-modify-write 间丢失计数。
_REGISTER_LUA = """
local now = tonumber(ARGV[4])
local max_failures = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local lockout = tonumber(ARGV[3])

local locked_until = redis.call('GET', KEYS[2])
if locked_until then
  local remain = tonumber(locked_until) - now
  if remain > 0 then
    return {tostring(max_failures), tostring(math.ceil(remain))}
  end
  redis.call('DEL', KEYS[2])
end

local data = redis.call('HMGET', KEYS[1], 'count', 'window_start')
local count = tonumber(data[1])
local ws = tonumber(data[2])
if not count or not ws or (now - ws) >= window then
  count = 0
  ws = now
end
count = count + 1

if count >= max_failures then
  redis.call('SET', KEYS[2], tostring(now + lockout), 'EX', lockout + 1)
  redis.call('DEL', KEYS[1])
  return {tostring(count), tostring(math.ceil(lockout))}
end

redis.call('HSET', KEYS[1], 'count', count, 'window_start', ws)
redis.call('EXPIRE', KEYS[1], window)
return {tostring(count), '0'}
"""


@dataclass
class FailureState:
    """单个 (用户名, IP) 的失败计数状态。"""
    count: int
    window_start: float  # 当前连续失败窗口的起点（时间戳）


def normalize_username(username: str) -> str:
    """用户名规范化：去除首尾空白。

    与前端提交前的处理保持同一套标准，避免 " demo" / "demo "
    被当成不同账号绕过计数。用户名不做大小写折叠（系统区分大小写）。
    """
    return (username or "").strip()


def _fail_key(username: str, ip: str) -> str:
    return f"{_FAIL_PREFIX}{username}|{ip}"


def _lock_key(username: str, ip: str) -> str:
    return f"{_LOCK_PREFIX}{username}|{ip}"


class LoginRateLimiter:
    def __init__(self) -> None:
        self._use_redis = not settings.REDIS_URL.startswith("memory")
        self._redis = None
        self._register_script = None
        if self._use_redis:
            try:
                import redis
                self._redis = redis.from_url(settings.REDIS_URL)
                self._redis.ping()
                self._register_script = self._redis.register_script(_REGISTER_LUA)
            except Exception as e:  # Redis 不可用时静默降级
                print(f"Redis not available for login limiter, using memory: {e}")
                self._use_redis = False
                self._redis = None

        # 内存降级存储：key -> (状态值, 条目过期时间戳)
        self._memory: dict[str, Tuple[object, Optional[float]]] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # 锁定查询
    # ------------------------------------------------------------------
    def get_lock_remaining(self, username: str, ip: str, *, now: Optional[float] = None) -> int:
        """返回剩余锁定秒数（向上取整，最小为 1）；未锁定返回 0。"""
        now = now if now is not None else time.time()
        username = normalize_username(username)
        locked_until = self._get_lock(username, ip)
        if locked_until is None or locked_until <= now:
            if locked_until is not None:
                self._clear_lock(username, ip)
            return 0
        return max(1, math.ceil(locked_until - now))

    def is_locked(self, username: str, ip: str, *, now: Optional[float] = None) -> bool:
        return self.get_lock_remaining(username, ip, now=now) > 0

    # ------------------------------------------------------------------
    # 失败登记
    # ------------------------------------------------------------------
    def register_failure(
        self, username: str, ip: str, *, now: Optional[float] = None
    ) -> Tuple[int, int]:
        """登记一次失败。

        返回 (当前窗口内连续失败次数, 锁定剩余秒数)。
        达到上限时写入锁定并清掉失败计数——锁定解除后不再残留上一轮
        的失败次数；锁定期间的尝试不改变计数与锁定到期时间。
        """
        now = now if now is not None else time.time()
        username = normalize_username(username)

        if self._use_redis:
            try:
                count, remaining = self._register_script(
                    keys=[_fail_key(username, ip), _lock_key(username, ip)],
                    args=[
                        settings.LOGIN_MAX_FAILURES,
                        settings.LOGIN_FAILURE_WINDOW_SECONDS,
                        settings.LOGIN_LOCKOUT_SECONDS,
                        now,
                    ],
                )
                return int(count), int(remaining)
            except Exception as e:
                print(f"Login limiter Redis error, falling back to memory: {e}")

        return self._register_failure_memory(username, ip, now)

    def _register_failure_memory(
        self, username: str, ip: str, now: float
    ) -> Tuple[int, int]:
        with self._lock:
            locked_until = self._memory_get(_lock_key(username, ip))
            if locked_until is not None:
                locked_until = float(locked_until)
                if locked_until > now:
                    return settings.LOGIN_MAX_FAILURES, max(
                        1, math.ceil(locked_until - now)
                    )
                self._memory.pop(_lock_key(username, ip), None)

            state = self._memory_get(_fail_key(username, ip))
            if (
                state is None
                or now - state.window_start >= settings.LOGIN_FAILURE_WINDOW_SECONDS
            ):
                state = FailureState(count=0, window_start=now)
            state.count += 1

            if state.count >= settings.LOGIN_MAX_FAILURES:
                locked_until = now + settings.LOGIN_LOCKOUT_SECONDS
                self._memory[_lock_key(username, ip)] = (
                    locked_until,
                    locked_until + 1,
                )
                # 计数随锁定一起失效；锁解除后从 0 重新计
                self._memory.pop(_fail_key(username, ip), None)
                return settings.LOGIN_MAX_FAILURES, math.ceil(
                    settings.LOGIN_LOCKOUT_SECONDS
                )

            self._memory[_fail_key(username, ip)] = (
                state,
                now + settings.LOGIN_FAILURE_WINDOW_SECONDS,
            )
            return state.count, 0

    # ------------------------------------------------------------------
    # 成功登录：清掉该 (用户名, IP) 的全部失败痕迹
    # ------------------------------------------------------------------
    def reset(self, username: str, ip: str) -> None:
        username = normalize_username(username)
        self._clear_failures(username, ip)
        self._clear_lock(username, ip)

    # ------------------------------------------------------------------
    # 状态汇总（供状态查询接口）
    # ------------------------------------------------------------------
    def status(self, username: str, ip: str, *, now: Optional[float] = None) -> dict:
        now = now if now is not None else time.time()
        username = normalize_username(username)
        remaining = self.get_lock_remaining(username, ip, now=now)
        state = None if remaining > 0 else self._get_failures(username, ip)
        # 窗口已过期的计数同样视为 0
        if state is not None and now - state.window_start >= settings.LOGIN_FAILURE_WINDOW_SECONDS:
            state = None
        return {
            "locked": remaining > 0,
            "seconds_remaining": remaining,
            "failures": state.count if state else 0,
            "max_failures": settings.LOGIN_MAX_FAILURES,
            "lockout_seconds": settings.LOGIN_LOCKOUT_SECONDS,
            "server_time": now,
        }

    # ------------------------------------------------------------------
    # 底层存取
    # ------------------------------------------------------------------
    def _get_lock(self, username: str, ip: str) -> Optional[float]:
        if self._use_redis:
            try:
                raw = self._redis.get(_lock_key(username, ip))
                return float(raw) if raw is not None else None
            except Exception:
                return None
        with self._lock:
            value = self._memory_get(_lock_key(username, ip))
        return float(value) if value is not None else None

    def _clear_lock(self, username: str, ip: str) -> None:
        if self._use_redis:
            try:
                self._redis.delete(_lock_key(username, ip))
                return
            except Exception:
                pass
        with self._lock:
            self._memory.pop(_lock_key(username, ip), None)

    def _get_failures(self, username: str, ip: str) -> Optional[FailureState]:
        if self._use_redis:
            try:
                data = self._redis.hmget(_fail_key(username, ip), "count", "window_start")
                if not data or data[0] is None:
                    return None
                return FailureState(int(data[0]), float(data[1]))
            except Exception:
                return None
        with self._lock:
            value = self._memory_get(_fail_key(username, ip))
        return value if isinstance(value, FailureState) else None

    def _clear_failures(self, username: str, ip: str) -> None:
        if self._use_redis:
            try:
                self._redis.delete(_fail_key(username, ip))
                return
            except Exception:
                pass
        with self._lock:
            self._memory.pop(_fail_key(username, ip), None)

    def _memory_get(self, key: str):
        """读取内存条目并顺带清理过期项（调用方需持锁或在锁内使用）。"""
        entry = self._memory.get(key)
        if not entry:
            return None
        value, exp = entry
        if exp is not None and exp < time.time():
            self._memory.pop(key, None)
            return None
        return value


login_limiter = LoginRateLimiter()
