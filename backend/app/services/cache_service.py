from typing import Optional, Any
import json
import pickle
import time
from collections import OrderedDict

from ..config import get_settings

settings = get_settings()


class CacheService:
    def __init__(self):
        self._cache: OrderedDict = OrderedDict()
        self._use_redis = not settings.REDIS_URL.startswith("memory")
        if self._use_redis:
            try:
                import redis
                self.redis_client = redis.from_url(settings.REDIS_URL)
            except Exception as e:
                print(f"Redis not available, using memory cache: {e}")
                self._use_redis = False

    def _clean_expired(self):
        now = time.time()
        keys_to_delete = [k for k, (_, exp) in self._cache.items() if exp is not None and exp < now]
        for k in keys_to_delete:
            del self._cache[k]

    def get(self, key: str) -> Optional[Any]:
        if self._use_redis:
            try:
                data = self.redis_client.get(key)
                if data is None:
                    return None
                return pickle.loads(data)
            except Exception:
                return None
        self._clean_expired()
        if key in self._cache:
            value, expire = self._cache[key]
            if expire is None or expire > time.time():
                return value
            del self._cache[key]
        return None

    def set(self, key: str, value: Any, expire_seconds: int = 3600) -> None:
        if self._use_redis:
            try:
                self.redis_client.setex(key, expire_seconds, pickle.dumps(value))
                return
            except Exception as e:
                print(f"Cache set error: {e}")
        expire = time.time() + expire_seconds if expire_seconds else None
        self._cache[key] = (value, expire)
        if len(self._cache) > 1000:
            self._cache.popitem(last=False)

    def delete(self, key: str) -> None:
        if self._use_redis:
            try:
                self.redis_client.delete(key)
                return
            except Exception as e:
                print(f"Cache delete error: {e}")
        if key in self._cache:
            del self._cache[key]

    def increment(self, key: str, amount: int = 1, expire_seconds: Optional[int] = None) -> int:
        """原子自增；首次创建时可附带过期时间。Redis 不可用时降级为内存计数。"""
        if self._use_redis:
            try:
                pipe = self.redis_client.pipeline()
                pipe.incr(key, amount)
                if expire_seconds is not None:
                    pipe.expire(key, expire_seconds)
                results = pipe.execute()
                return int(results[0])
            except Exception as e:
                print(f"Cache increment error: {e}")
        self._clean_expired()
        value, expire = self._cache.get(key, (0, None))
        value = int(value) + amount
        if expire is None and expire_seconds is not None:
            expire = time.time() + expire_seconds
        self._cache[key] = (value, expire)
        return value

    def ttl(self, key: str) -> int:
        """剩余存活秒数；key 不存在或已过期返回 -1（与 Redis TTL 语义一致）。"""
        if self._use_redis:
            try:
                return int(self.redis_client.ttl(key))
            except Exception as e:
                print(f"Cache ttl error: {e}")
        self._clean_expired()
        if key not in self._cache:
            return -1
        _, expire = self._cache[key]
        if expire is None:
            return -1
        return max(0, int(expire - time.time()))

    def get_json(self, key: str) -> Optional[dict]:
        if self._use_redis:
            try:
                data = self.redis_client.get(key)
                if data is None:
                    return None
                return json.loads(data)
            except Exception:
                return None
        data = self.get(key)
        if isinstance(data, str):
            try:
                return json.loads(data)
            except Exception:
                return None
        return data if isinstance(data, dict) else None

    def set_json(self, key: str, value: dict, expire_seconds: int = 3600) -> None:
        if self._use_redis:
            try:
                self.redis_client.setex(key, expire_seconds, json.dumps(value))
                return
            except Exception as e:
                print(f"Cache set JSON error: {e}")
        self.set(key, value, expire_seconds)


cache_service = CacheService()
