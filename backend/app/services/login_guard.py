"""登录失败计数与临时锁定。

计数维度为「用户名 + 网络来源 IP」，不同账号、不同来源的重试互不影响。
锁定窗口与失败计数窗口保持一致：达到上限后进入锁定，锁定期间直接拒绝登录
（不再校验密码，因此正确密码也无法进入）；锁定到期后计数重新开始。

剩余锁定时间以缓存键的 TTL 为准（Redis 为唯一权威时钟，内存降级时同理），
前端应以此值校准本地倒计时。
"""

import re
import unicodedata
from typing import Optional

import bcrypt

from ..config import get_settings
from .cache_service import cache_service

settings = get_settings()

# 用于不存在用户时做等耗时哈希比对，避免通过响应耗时枚举出已注册用户名
DUMMY_HASH = bcrypt.hashpw(b"login-timing-equalizer", bcrypt.gensalt()).decode()

_FAILURE_PREFIX = "login:fail:"
_LOCK_PREFIX = "login:lock:"

# 与前端 src/utils/validation.ts 保持同一套标准
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_]{3,50}$")
PASSWORD_MIN_LENGTH = 6
PASSWORD_MAX_LENGTH = 72  # bcrypt 有效长度上限


def normalize_username(username: Optional[str]) -> str:
    """用户名先做 NFKC 兼容分解，再去除首尾空白。比较与存储均使用归一化结果。"""
    if username is None:
        return ""
    return unicodedata.normalize("NFKC", str(username)).strip()


def validate_username(username: str) -> Optional[str]:
    """返回错误信息；None 表示通过。"""
    if not username:
        return "请输入用户名"
    if len(username) < 3 or len(username) > 50:
        return "用户名长度需为3-50个字符"
    if not USERNAME_PATTERN.match(username):
        return "用户名只能包含字母、数字和下划线"
    return None


def validate_password(password: Optional[str]) -> Optional[str]:
    """返回错误信息；None 表示通过。登录与注册共用此标准。"""
    if password is None or password == "":
        return "请输入密码"
    if len(password) < PASSWORD_MIN_LENGTH:
        return "密码至少6个字符"
    if len(password) > PASSWORD_MAX_LENGTH:
        return f"密码不能超过{PASSWORD_MAX_LENGTH}个字符"
    if password != password.strip():
        return "密码首尾不能包含空白字符"
    if any(unicodedata.category(ch) == "Cc" for ch in password):
        return "密码不能包含控制字符"
    return None


def client_ip_from_request(request) -> str:
    """取网络来源：优先信任反向代理写入的 X-Forwarded-For 首段。"""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _failure_key(username: str, ip: str) -> str:
    return f"{_FAILURE_PREFIX}{username}:{ip}"


def _lock_key(username: str, ip: str) -> str:
    return f"{_LOCK_PREFIX}{username}:{ip}"


def get_lock_status(username: str, ip: str) -> Optional[dict]:
    """若该账号在该来源已被锁定，返回剩余秒数；否则返回 None。"""
    remaining = cache_service.ttl(_lock_key(username, ip))
    if remaining > 0:
        return {
            "locked": True,
            "remaining_seconds": remaining,
            "max_failures": settings.LOGIN_MAX_FAILURES,
            "lock_seconds": settings.LOGIN_LOCK_SECONDS,
        }
    return None


def remaining_attempts(username: str, ip: str) -> int:
    """当前还允许的失败次数（未锁定时才有意义）。"""
    cached = cache_service.get(_failure_key(username, ip))
    failures = int(cached) if cached is not None else 0
    return max(0, settings.LOGIN_MAX_FAILURES - failures)


def record_failure(username: str, ip: str) -> dict:
    """记录一次失败；达到上限则建立锁定键并清空当前窗口的失败计数。

    返回锁定状态（锁定时）或剩余尝试次数（未锁定时）。
    """
    failures = cache_service.increment(
        _failure_key(username, ip),
        expire_seconds=settings.LOGIN_LOCK_SECONDS,
    )

    if failures >= settings.LOGIN_MAX_FAILURES:
        cache_service.set(
            _lock_key(username, ip), 1, expire_seconds=settings.LOGIN_LOCK_SECONDS
        )
        # 计数窗口随锁定一起结束，解锁后从 0 开始重新计数
        cache_service.delete(_failure_key(username, ip))
        return {
            "locked": True,
            "remaining_seconds": settings.LOGIN_LOCK_SECONDS,
            "max_failures": settings.LOGIN_MAX_FAILURES,
            "lock_seconds": settings.LOGIN_LOCK_SECONDS,
        }

    return {
        "locked": False,
        "remaining_attempts": max(0, settings.LOGIN_MAX_FAILURES - failures),
        "max_failures": settings.LOGIN_MAX_FAILURES,
        "lock_seconds": settings.LOGIN_LOCK_SECONDS,
    }


def clear_failures(username: str, ip: str) -> None:
    """登录成功后清除该账号在该来源的失败计数（若存在残留锁定也一并清除）。"""
    cache_service.delete(_failure_key(username, ip))
    cache_service.delete(_lock_key(username, ip))
