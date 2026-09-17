"""登录锁定规则的端到端验证（不依赖 Redis/PG，使用 SQLite + 内存存储）。"""
import os
import tempfile

os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.mkdtemp()}/test.db"
os.environ["REDIS_URL"] = "memory://"
os.environ["LOGIN_MAX_FAILURES"] = "3"
os.environ["LOGIN_LOCKOUT_SECONDS"] = "2"
os.environ["LOGIN_FAILURE_WINDOW_SECONDS"] = "60"

from fastapi.testclient import TestClient  # noqa: E402
from fastapi import FastAPI  # noqa: E402

from app.routers import auth as auth_router  # noqa: E402
from app.database import engine, Base  # noqa: E402
from app.init_data import init_db  # noqa: E402

Base.metadata.create_all(bind=engine)
init_db()

app = FastAPI()
app.include_router(auth_router.router, prefix="/api/v1")
client = TestClient(app)

IP1 = {"X-Forwarded-For": "10.0.0.1"}
IP2 = {"X-Forwarded-For": "10.0.0.2"}
failures = []


def check(name, cond, detail=""):
    failures.append((name, cond))
    print(f"{'PASS' if cond else 'FAIL'}: {name} {detail}")


def login(username, password, headers=None):
    return client.post(
        "/api/v1/auth/login",
        data={"username": username, "password": password},
        headers=headers or {},
    )


def status(username, headers=None):
    return client.get(
        "/api/v1/auth/login-status",
        params={"username": username},
        headers=headers or {},
    )


# 1) 连续失败：前 2 次 401，第 3 次触发 429 锁定
r1 = login("demo", "wrong", IP1)
r2 = login("demo", "wrong", IP1)
r3 = login("demo", "wrong", IP1)
check("第1次失败 401", r1.status_code == 401, r1.status_code)
check("第1次失败提示剩余2次", r1.json()["detail"]["attempts_left"] == 2,
      r1.json()["detail"])
check("第2次失败 401", r2.status_code == 401 and
      r2.json()["detail"]["attempts_left"] == 1, r2.json())
check("第3次失败触发锁定 429", r3.status_code == 429, r3.status_code)
detail = r3.json()["detail"]
check("锁定响应带剩余秒数", detail["locked"] and 0 < detail["seconds_remaining"] <= 2,
      detail)
check("Retry-After 头", r3.headers.get("Retry-After") == str(detail["seconds_remaining"]),
      r3.headers.get("Retry-After"))

# 2) 锁住期间即使密码正确也不允许进入，且不续期/缩短
r_correct = login("demo", "demo123", IP1)
check("锁定期内正确密码仍 429", r_correct.status_code == 429,
      r_correct.status_code)
s = status("demo", IP1).json()
check("状态接口显示锁定中", s["locked"] and s["seconds_remaining"] > 0, s)

# 3) 锁定提示持久：状态查询接口可恢复（用户从其它入口进来也看得到）
s_again = status("demo", IP1).json()
check("从其它入口查询状态一致", s_again["locked"] is True, s_again)

# 4) 不同账号分开计算：demo 被锁，admin 不受影响
r_admin = login("admin", "admin123", IP1)
check("其它账号在同一 IP 可正常登录", r_admin.status_code == 200,
      r_admin.status_code)

# 5) 不同网络来源分开计算：demo 在 IP2 仍可正常登录
r_other_ip = login("demo", "demo123", IP2)
check("同一账号换 IP 不受锁定影响", r_other_ip.status_code == 200,
      r_other_ip.status_code)

# 6) 倒计时与服务端一致：seconds_remaining 以服务端绝对时间为准
import time
time.sleep(2.2)
s_after = status("demo", IP1).json()
check("到期后自动解锁", s_after["locked"] is False and
      s_after["seconds_remaining"] == 0, s_after)

# 7) 锁解除后旧失败不残留，计数清零，正确密码可进入
check("解锁后失败计数清零", s_after["failures"] == 0, s_after)
r_after = login("demo", "demo123", IP1)
check("解锁后正确密码可登录", r_after.status_code == 200, r_after.status_code)
s_reset = status("demo", IP1).json()
check("成功登录后无任何锁定/失败残留",
      s_reset["failures"] == 0 and s_reset["locked"] is False, s_reset)

# 8) 用户名规范化：前后空格按同一标准处理，" demo " 与 demo 同一计数键
login(" demo ", "wrong", IP1)
r_ws = login(" demo ", "wrong", IP1)
check("带空格用户名失败计入同一账号(剩余1次)",
      r_ws.status_code == 401 and r_ws.json()["detail"]["attempts_left"] == 1,
      r_ws.json())
login("demo", "wrong", IP1)  # 第3次 -> 再次锁定
r_ws_locked = login("demo", "demo123", IP1)
check("再次锁定", r_ws_locked.status_code == 429, r_ws_locked.status_code)
time.sleep(2.2)

# 9) 格式问题（空用户名/超长密码）返回 400 且不计入失败次数
r_fmt = login("   ", "x", IP2)
check("空白用户名 400 格式错误", r_fmt.status_code == 400, r_fmt.status_code)
r_fmt2 = login("demo", "x" * 73, IP2)
check("超长密码 400 格式错误", r_fmt2.status_code == 400, r_fmt2.json())
s_ip2 = status("demo", IP2).json()
check("格式错误不消耗失败计数", s_ip2["failures"] == 0, s_ip2)

# 10) 成功登录会重置计数（失败 2 次后用正确密码登录，再失败从 0 开始）
login("admin", "bad", IP2)
login("admin", "bad", IP2)
login("admin", "admin123", IP2)
r_reset_half = login("admin", "bad", IP2)
check("成功登录后计数重置，再失败剩余2次",
      r_reset_half.json()["detail"]["attempts_left"] == 2,
      r_reset_half.json())

# 11) 并发失败不丢计数：10 个并发错误请求，恰好触发一次锁定，最终为锁定态
import threading
client2 = TestClient(app)
IP3 = {"X-Forwarded-For": "10.0.0.3"}
results = []


def burst():
    results.append(login("admin", "bad", IP3).status_code)


threads = [threading.Thread(target=burst) for _ in range(10)]
for t in threads:
    t.start()
for t in threads:
    t.join()
check("并发突发: 2 个 401 后全部 429（计数不丢）",
      results.count(401) == 2 and results.count(429) == 8,
      f"401={results.count(401)}, 429={results.count(429)}")

passed = all(ok for _, ok in failures)
print(f"\n{'='*50}\n总计 {len(failures)} 项，{'全部通过' if passed else '存在失败'}")
raise SystemExit(0 if passed else 1)
