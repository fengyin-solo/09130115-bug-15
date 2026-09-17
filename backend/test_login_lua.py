"""用 fakeredis 验证 Redis(Lua) 路径的锁定逻辑，与内存路径行为一致。"""
import math
import time

import fakeredis

from app.services.login_rate_limit import _REGISTER_LUA

r = fakeredis.FakeStrictRedis()
script = r.register_script(_REGISTER_LUA)

MAX_FAIL, WINDOW, LOCKOUT = 3, 60, 2


def register(fk, lk, now):
    count, remain = script(
        keys=[fk, lk], args=[MAX_FAIL, WINDOW, LOCKOUT, now]
    )
    return int(count), int(remain)


failures = []
def check(name, cond, detail=""):
    failures.append(cond)
    print(f"{'PASS' if cond else 'FAIL'}: {name} {detail}")


t0 = 1000.0
fk1, lk1 = "login_fail:demo|1.1.1.1", "login_lock:demo|1.1.1.1"
fk2, lk2 = "login_fail:demo|2.2.2.2", "login_lock:demo|2.2.2.2"
fka, lka = "login_fail:admin|1.1.1.1", "login_lock:admin|1.1.1.1"

c, rem = register(fk1, lk1, t0)
check("第1次: count=1 未锁", (c, rem) == (1, 0), (c, rem))
c, rem = register(fk1, lk1, t0 + 1)
check("第2次: count=2", (c, rem) == (2, 0), (c, rem))
c, rem = register(fk1, lk1, t0 + 2)
check("第3次: 触发锁定", c == 3 and rem == LOCKOUT, (c, rem))
check("失败计数键已删除（解除不残留）", r.get(fk1) is None)
check("锁定键存绝对到期时间戳", abs(float(r.get(lk1)) - (t0 + 2 + LOCKOUT)) < 1e-6,
      r.get(lk1))
check("锁定键TTL", 2 <= r.ttl(lk1) <= 3, r.ttl(lk1))

# 锁定期内尝试不改变到期时间
c, rem = register(fk1, lk1, t0 + 3)
check("锁定中尝试: 仍锁，剩余随时间减少", c == 3 and rem == LOCKOUT - 1, (c, rem))
check("锁定到期时间未被续期/缩短",
      abs(float(r.get(lk1)) - (t0 + 2 + LOCKOUT)) < 1e-6)

# 倒计时以服务端绝对时间为准：剩余 = 到期 - now
remain_at = math.ceil(float(r.get(lk1)) - (t0 + 3.2))
check("任意时刻剩余秒数一致", remain_at == 1, remain_at)

# 不同 IP 独立
c, rem = register(fk2, lk2, t0)
check("不同IP: count=1 独立计数", (c, rem) == (1, 0), (c, rem))
# 不同账号独立
c, rem = register(fka, lka, t0)
check("不同账号: count=1 独立计数", (c, rem) == (1, 0), (c, rem))

# 锁定过期后自动重新计数
c, rem = register(fk1, lk1, t0 + 2 + LOCKOUT + 0.1)
check("过期后首次: 旧锁清除，count 从1重新计", (c, rem) == (1, 0), (c, rem))
check("过期后锁键已删除", r.get(lk1) is None)

# 滚动窗口外失败不计入
r.delete(fk1, lk1)
register(fk1, lk1, t0)
register(fk1, lk1, t0 + WINDOW + 1)
h = r.hgetall(fk1)
check("超出窗口: 计数重置为1", int(h[b"count"]) == 1, h)

# 并发：10 个"同时"失败（同一 now），必须恰好触发一次锁定
r.delete(fka, lka)
res = [script(keys=[fka, lka], args=[MAX_FAIL, WINDOW, LOCKOUT, t0]) for _ in range(10)]
counts = [int(x[1]) for x in res]
check("并发突发: 恰好2次未锁+其余锁定",
      counts.count(0) == MAX_FAIL - 1 and all(x > 0 for x in counts[2:]),
      counts)

print(f"\n{'='*40}\n{'全部通过' if all(failures) else '存在失败'}")
raise SystemExit(0 if all(failures) else 1)
