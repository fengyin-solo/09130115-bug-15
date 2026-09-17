from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from ..database import get_db
from .. import models, schemas
from ..auth import (
    verify_password,
    create_access_token,
    get_current_user,
    get_password_hash,
)
from ..config import get_settings
from ..services.login_rate_limit import login_limiter, normalize_username
from ..validation import (
    validate_login_credentials,
    validate_password,
    validate_username,
)

settings = get_settings()
router = APIRouter(prefix="/auth", tags=["Authentication"])

# 用于用户不存在时做一次等价耗时的 bcrypt 比较，缓解时序枚举
_DUMMY_HASH = get_password_hash("not-a-real-password")


def _client_ip(request: Request) -> str:
    """获取请求来源 IP。

    优先取反向代理写入的 X-Forwarded-For 首段，否则取直连地址。
    失败计数按该值与用户名的组合隔离。
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _format_duration(seconds: int) -> str:
    """把锁定秒数格式化为对用户友好的时长。"""
    if seconds % 60 == 0:
        return f"{seconds // 60} 分钟"
    if seconds >= 60:
        return f"{seconds // 60} 分 {seconds % 60} 秒"
    return f"{seconds} 秒"


def _lockout_error(seconds: int) -> HTTPException:
    """锁定期间的统一响应（无论密码对错都返回它）。"""
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail={
            "code": "account_locked",
            "message": (
                f"密码错误次数过多，账号已临时锁定，请 {seconds} 秒后再试。"
                "锁定期间即使输入正确密码也无法登录。"
            ),
            "locked": True,
            "seconds_remaining": seconds,
            "max_failures": settings.LOGIN_MAX_FAILURES,
            "lockout_seconds": settings.LOGIN_LOCKOUT_SECONDS,
        },
        headers={"Retry-After": str(seconds)},
    )


@router.post("/login", response_model=schemas.Token)
async def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    ip = _client_ip(request)

    # 1) 格式按统一标准先处理；格式问题返回 400，不计入失败次数
    username, password, form_error = validate_login_credentials(
        form_data.username, form_data.password
    )
    if form_error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_credentials_format", "message": form_error},
        )

    # 2) 锁定判定优先于一切：锁住期间密码正确也不放行，且不重置计时
    remaining = login_limiter.get_lock_remaining(username, ip)
    if remaining > 0:
        raise _lockout_error(remaining)

    user = db.query(models.User).filter(models.User.username == username).first()

    password_valid = False
    if user:
        password_valid = verify_password(password, user.hashed_password)
    else:
        # 抹平"用户不存在"与"密码错误"的响应耗时差异
        verify_password(password, _DUMMY_HASH)

    # 3) 凭证错误：登记失败（按 用户名+IP 计数），返回剩余尝试次数或锁定信息
    if not user or not password_valid:
        failures, lock_remaining = login_limiter.register_failure(username, ip)
        if lock_remaining > 0:
            raise _lockout_error(lock_remaining)
        attempts_left = settings.LOGIN_MAX_FAILURES - failures
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "bad_credentials",
                "message": (
                    "用户名或密码错误，"
                    f"再错 {attempts_left} 次账号将临时锁定 "
                    f"{_format_duration(settings.LOGIN_LOCKOUT_SECONDS)}"
                ),
                "locked": False,
                "failures": failures,
                "attempts_left": attempts_left,
            },
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "inactive_user", "message": "账号已被停用"},
        )

    # 4) 登录成功：清掉该账号在该来源的失败痕迹，锁定解除不留残余
    login_limiter.reset(username, ip)

    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )

    return {"access_token": access_token, "token_type": "bearer"}


@router.get("/login-status", response_model=schemas.LoginStatus)
async def login_status(username: str, request: Request):
    """查询某用户名在当前来源 IP 下的锁定/失败状态。

    供用户从其它入口重新进入登录页时恢复同一套提示与倒计时；
    不区分用户是否存在，避免通过该接口枚举账号。
    """
    ip = _client_ip(request)
    username = normalize_username(username)
    return login_limiter.status(username, ip)


@router.post("/register", response_model=schemas.User)
async def register(user_in: schemas.UserCreate, db: Session = Depends(get_db)):
    # 与登录同一套格式标准
    username, username_error = validate_username(user_in.username)
    if username_error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_username", "message": username_error},
        )
    password, password_error = validate_password(user_in.password)
    if password_error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_password", "message": password_error},
        )

    db_user = db.query(models.User).filter(models.User.username == username).first()
    if db_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username already registered"
        )

    db_user = db.query(models.User).filter(models.User.email == user_in.email).first()
    if db_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered"
        )

    user = models.User(
        username=username,
        email=user_in.email,
        full_name=user_in.full_name,
        hashed_password=get_password_hash(password)
    )

    db.add(user)
    db.commit()
    db.refresh(user)

    return user


@router.get("/me", response_model=schemas.User)
async def read_current_user(current_user: models.User = Depends(get_current_user)):
    return current_user


@router.put("/me", response_model=schemas.User)
async def update_current_user(
    user_in: schemas.UserUpdate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if user_in.email:
        existing = db.query(models.User).filter(models.User.email == user_in.email).first()
        if existing and existing.id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email already registered"
            )
        current_user.email = user_in.email

    if user_in.full_name:
        current_user.full_name = user_in.full_name

    if user_in.password:
        password, password_error = validate_password(user_in.password)
        if password_error:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "invalid_password", "message": password_error},
            )
        current_user.hashed_password = get_password_hash(password)

    db.commit()
    db.refresh(current_user)

    return current_user
