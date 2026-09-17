from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: str = "postgresql://seismic:seismic123@localhost:5432/seismic_db"
    REDIS_URL: str = "redis://localhost:6379/0"
    MINIO_ENDPOINT: str = "localhost:9000"
    MINIO_ACCESS_KEY: str = "minioadmin"
    MINIO_SECRET_KEY: str = "minioadmin"
    MINIO_SECURE: bool = False
    MINIO_BUCKET: str = "seismic-data"

    SECRET_KEY: str = "your-secret-key-change-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7

    # 登录失败锁定策略：同一用户名 + 同一网络来源连续失败达到上限后临时锁定
    LOGIN_MAX_FAILURES: int = 5
    LOGIN_LOCK_SECONDS: int = 300

    SEISMIC_DATA_DIR: str = "/data/seismic"
    MAX_UPLOAD_SIZE: int = 10 * 1024 * 1024 * 1024
    CHUNK_SIZE: int = 8 * 1024 * 1024

    CORS_ORIGINS: list = ["http://localhost:3000", "http://localhost:8080"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
