"""登录失败锁定规则的端到端验证（内存缓存 + SQLite，无需 Redis/Postgres）。"""
import os
import time

os.environ["DATABASE_URL"] = "sqlite:///./test_login.db"
os.environ["REDIS_URL"] = "memory://"
os.environ["LOGIN_MAX_FAILURES"] = "5"
os.environ["LOGIN_LOCK_SECONDS"] = "3"  # 测试用短锁定，便于验证解锁

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.database import Base, engine, SessionLocal
from app import models
from app.auth import get_password_hash
from app.routers import auth as auth_router
from app.services.cache_service import cache_service  # noqa: F401

Base.metadata.drop_all(bind=engine)
Base.metadata.create_all(bind=engine)

app = FastAPI()
app.include_router(auth_router.router, prefix="/api/v1")

db = SessionLocal()
db.add_all([
    models.User(username="alice", email="alice@test.local",
                hashed_password=get_password_hash("secret1"), is_active=True),
    models.User(username="bob", email="bob@test.local",
                hashed_password=get_password_hash("secret1"), is_active=True),
])
db.commit()
db.close()

client = TestClient(app)
PASS = FAIL = 0


def check(name: str, cond: bool, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS: {name}")
    else:
        FAIL += 1
        print(f"  FAIL: {name} {extra}")


def login(username, password, ip="1.1.1.1"):
    return client.post(
        "/api/v1/auth/login",
        data={"username": username, "password": password},
        headers={"X-Forwarded-For": ip},
    )


def status(username, ip="1.1.1.1"):
    return client.get(
        "/api/v1/auth/login-status",
        params={"username": username},
        headers={"X-Forwarded-For": ip},
    )


print("== 1. 连续失败 4 次：401 且剩余次数递减 ==")
for i in range(4):
    r = login("alice", "wrong-pw")
    check(f"第{i+1}次失败返回401", r.status_code == 401, r.status_code)
    check(f"第{i+1}次剩余次数={4-i}",
          r.json()["detail"]["remaining_attempts"] == 4 - i, r.json())

print("== 2. 第 5 次失败触发锁定 ==")
r = login("alice", "wrong-pw")
check("返回429", r.status_code == 429, r.status_code)
check("code=locked", r.json()["detail"]["code"] == "locked")
check("remaining_seconds=3", r.json()["detail"]["remaining_seconds"] == 3)
check("Retry-After 头", r.headers.get("Retry-After") == "3", r.headers.get("Retry-After"))

print("== 3. 锁定期间正确密码也拒绝 ==")
r = login("alice", "secret1")
check("正确密码仍429", r.status_code == 429, r.status_code)
check("不颁发token", "access_token" not in r.json())

print("== 4. 状态查询接口（其它入口进入登录页）= =")
r = status("alice")
data = r.json()
check("查询返回locked", data["locked"] is True, data)
check("剩余秒数>0", 0 < data["remaining_seconds"] <= 3, data)

print("== 5. 不同账号独立计数（bob 不受影响）==")
r = login("bob", "secret1")
check("bob 正常登录成功", r.status_code == 200, r.status_code)

print("== 6. 不同网络来源独立计数 ==")
r = login("alice", "secret1", ip="2.2.2.2")
check("另一IP来源未锁定，正确密码可登录", r.status_code == 200, r.status_code)

print("== 7. 倒计时以服务端TTL为准（睡 1 秒后 TTL 递减）==")
time.sleep(1.1)
r = status("alice")
check("TTL已递减到 <=2", r.json()["remaining_seconds"] <= 2, r.json())
check("仍处于锁定", r.json()["locked"] is True, r.json())
r = login("alice", "secret1")
check("锁定未解除前正确密码仍429", r.status_code == 429, r.status_code)

print("== 8. 锁定到期后服务端确认解锁，正确密码可进入 ==")
time.sleep(2.2)
r = status("alice")
check("状态查询已解锁", r.json()["locked"] is False, r.json())
r = login("alice", "secret1")
check("解锁后正确密码登录成功", r.status_code == 200, r.status_code)

print("== 9. 解锁后失败计数从零重新开始 ==")
r = login("alice", "wrong-pw")
check("重新计次，剩余4次", r.json()["detail"]["remaining_attempts"] == 4, r.json())

print("== 10. 成功登录清除失败计数 ==")
r = login("alice", "secret1")
check("成功登录", r.status_code == 200, r.status_code)
r = login("alice", "wrong-pw")
check("计数已清零，重新剩余4次", r.json()["detail"]["remaining_attempts"] == 4, r.json())
login("alice", "secret1")

print("== 11. 用户名归一化：首尾空白与全角字符按同一标准处理 ==")
r = login("  alice  ", "secret1")
check("带空格用户名归一化后登录成功", r.status_code == 200, r.status_code)
# 全角小写字母 NFKC 归一化后等于 alice
r = login("ａlice", "secret1")
check("全角字母NFKC归一化后登录成功", r.status_code == 200, r.status_code)

print("== 12. 格式校验（提交前同一套标准，后端兜底）==")
r = login("ab", "secret1")
check("用户名过短返回400", r.status_code == 400, r.status_code)
check("错误码invalid_format", r.json()["detail"]["code"] == "invalid_format")
r = login("alice", "12345")
check("密码过短返回400", r.status_code == 400, r.status_code)
# 格式非法不消耗失败次数
r = status("alice")
check("非法格式请求不消耗失败计数", r.json()["remaining_attempts"] == 5, r.json())

print("== 13. 不存在用户的失败同样计入（按用户名维度）==")
for i in range(5):
    r = login("ghost", "whatever1")
check("不存在用户5次后也锁定", r.status_code == 429 and r.json()["detail"]["code"] == "locked", r.status_code)

print("== 14. 注册接口共用格式标准 ==")
r = client.post("/api/v1/auth/register",
                json={"username": "ok_user", "email": "ok@test.local",
                      "full_name": "Ok", "password": "12345"})
check("注册时密码过短被拒", r.status_code == 422, r.status_code)
r = client.post("/api/v1/auth/register",
                json={"username": "  new_user  ", "email": "new@example.com",
                      "full_name": "New", "password": "secret1"})
check("注册成功且用户名已归一化", r.status_code == 200 and r.json()["username"] == "new_user",
      r.status_code)

print(f"\n结果: {PASS} passed, {FAIL} failed")
raise SystemExit(1 if FAIL else 0)
