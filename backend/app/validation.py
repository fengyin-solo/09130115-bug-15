"""用户名/密码格式的统一校验标准。

登录与注册共用本模块，保证"提交前按同一套标准处理"：
- 用户名：去除首尾空白后校验长度与字符集；
- 密码：保留原始输入（首尾空格可能是密码的一部分），校验长度，
  上限 72 字节（bcrypt 有效长度）。
"""
from __future__ import annotations

import re
from typing import Optional, Tuple

USERNAME_MIN_LENGTH = 3
USERNAME_MAX_LENGTH = 50
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")

PASSWORD_MIN_LENGTH = 6
# bcrypt 只使用前 72 个字节，超过的部分不参与校验，直接拒绝以避免错觉
PASSWORD_MAX_BYTES = 72


def normalize_username(username: Optional[str]) -> str:
    """去除首尾空白。登录、注册、锁定查询必须一致调用。"""
    return (username or "").strip()


def validate_username(username: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """返回 (规范化用户名, 错误信息)；校验失败时规范化值为 None。"""
    normalized = normalize_username(username)
    if not normalized:
        return None, "请输入用户名"
    if not (USERNAME_MIN_LENGTH <= len(normalized) <= USERNAME_MAX_LENGTH):
        return None, (
            f"用户名长度需为 {USERNAME_MIN_LENGTH}-{USERNAME_MAX_LENGTH} 个字符"
        )
    if not USERNAME_PATTERN.match(normalized):
        return None, "用户名只能包含字母、数字、下划线、点和连字符"
    return normalized, None


def validate_password(password: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """注册/改密用：返回 (原密码, 错误信息)。不做 strip，两端与前端规则保持一致。"""
    if password is None or password == "":
        return None, "请输入密码"
    if len(password) < PASSWORD_MIN_LENGTH:
        return None, f"密码至少 {PASSWORD_MIN_LENGTH} 个字符"
    if len(password.encode("utf-8")) > PASSWORD_MAX_BYTES:
        return None, f"密码不能超过 {PASSWORD_MAX_BYTES} 个字节"
    return password, None


def validate_login_credentials(
    username: Optional[str], password: Optional[str]
) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """登录提交前的统一处理。

    登录不套用注册的长度/字符集规则（历史用户密码可能更短，且格式错误
    不应消耗失败计数）：仅做用户名去空白、非空以及 bcrypt 72 字节硬上限。
    """
    norm_username = normalize_username(username)
    if not norm_username:
        return None, None, "请输入用户名"
    if password is None or password == "":
        return None, None, "请输入密码"
    if len(password.encode("utf-8")) > PASSWORD_MAX_BYTES:
        return None, None, f"密码不能超过 {PASSWORD_MAX_BYTES} 个字节"
    return norm_username, password, None
