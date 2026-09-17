from datetime import timedelta
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from ..database import get_db
from .. import models, schemas
from ..auth import verify_password, create_access_token, get_current_user, get_password_hash
from ..config import get_settings
from ..services import login_guard

settings = get_settings()
router = APIRouter(prefix="/auth", tags=["Authentication"])


def _login_status_payload(username: str, ip: str) -> dict:
    locked = login_guard.get_lock_status(username, ip)
    if locked:
        return {
            "username": username,
            "locked": True,
            "remaining_seconds": locked["remaining_seconds"],
            "remaining_attempts": 0,
            "max_failures": settings.LOGIN_MAX_FAILURES,
            "lock_seconds": settings.LOGIN_LOCK_SECONDS,
        }
    return {
        "username": username,
        "locked": False,
        "remaining_seconds": 0,
        "remaining_attempts": login_guard.remaining_attempts(username, ip),
        "max_failures": settings.LOGIN_MAX_FAILURES,
        "lock_seconds": settings.LOGIN_LOCK_SECONDS,
    }


@router.get("/login-status", response_model=schemas.LoginStatus)
async def login_status(username: str, request: Request):
    """供登录页在进入页面/切换用户名时查询当前锁定状态，

    使用户从其它入口重新进入登录页时仍能看到同一提示与剩余时间。
    """
    normalized = login_guard.normalize_username(username)
    # 格式非法的用户名不可能命中任何锁定记录，按未锁定状态返回即可
    ip = login_guard.client_ip_from_request(request)
    return _login_status_payload(normalized, ip)


@router.post("/login", response_model=schemas.Token)
async def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db)
):
    username = login_guard.normalize_username(form_data.username)
    ip = login_guard.client_ip_from_request(request)

    username_error = login_guard.validate_username(username)
    if username_error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_format", "message": username_error},
        )
    password_error = login_guard.validate_password(form_data.password)
    if password_error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_format", "message": password_error},
        )

    # 锁定优先：锁定期间不查询、不校验密码，正确密码同样拒绝
    lock = login_guard.get_lock_status(username, ip)
    if lock:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "locked",
                "message": "登录失败次数过多，账号已临时锁定，请稍后再试",
                "remaining_seconds": lock["remaining_seconds"],
                "max_failures": settings.LOGIN_MAX_FAILURES,
                "lock_seconds": settings.LOGIN_LOCK_SECONDS,
            },
            headers={"Retry-After": str(lock["remaining_seconds"])},
        )

    user = db.query(models.User).filter(models.User.username == username).first()
    if user:
        password_ok = verify_password(form_data.password, user.hashed_password)
    else:
        # 对不存在的用户执行一次同样耗时的哈希校验，降低用户名枚举风险
        password_ok = verify_password(form_data.password, login_guard.DUMMY_HASH)

    if not user or not password_ok:
        result = login_guard.record_failure(username, ip)
        if result["locked"]:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail={
                    "code": "locked",
                    "message": "连续登录失败次数过多，账号已临时锁定，请稍后再试",
                    "remaining_seconds": result["remaining_seconds"],
                    "max_failures": settings.LOGIN_MAX_FAILURES,
                    "lock_seconds": settings.LOGIN_LOCK_SECONDS,
                },
                headers={"Retry-After": str(result["remaining_seconds"])},
            )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "bad_credentials",
                "message": "用户名或密码错误",
                "remaining_attempts": result["remaining_attempts"],
                "max_failures": settings.LOGIN_MAX_FAILURES,
            },
            headers={"WWW-Authenticate": "Bearer"},
        )

    # 成功登录：清除该账号在该来源的失败计数与残留锁定
    login_guard.clear_failures(username, ip)

    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )

    return {"access_token": access_token, "token_type": "bearer"}


@router.post("/register", response_model=schemas.User)
async def register(user_in: schemas.UserCreate, db: Session = Depends(get_db)):
    # 校验器已对用户名做归一化，这里使用归一化后的值查重与入库
    username = login_guard.normalize_username(user_in.username)

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
        hashed_password=get_password_hash(user_in.password)
    )

    db.add(user)
    db.commit()
    db.refresh(user)

    return user
