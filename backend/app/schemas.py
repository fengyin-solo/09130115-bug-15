from datetime import datetime
from typing import Optional, List, Any
from pydantic import BaseModel, EmailStr, Field, field_validator

from .services import login_guard


class Token(BaseModel):
    access_token: str
    token_type: str


class TokenData(BaseModel):
    username: Optional[str] = None


class LoginStatus(BaseModel):
    """登录锁定状态查询结果（按 用户名 + 来源IP 维度）。"""
    username: str
    locked: bool
    remaining_seconds: int = 0
    remaining_attempts: Optional[int] = None
    max_failures: int
    lock_seconds: int


class UserBase(BaseModel):
    username: str
    email: EmailStr
    full_name: Optional[str] = None


class UserCreate(UserBase):
    password: str

    @field_validator("username")
    @classmethod
    def _normalize_and_check_username(cls, v: str) -> str:
        username = login_guard.normalize_username(v)
        error = login_guard.validate_username(username)
        if error:
            raise ValueError(error)
        return username

    @field_validator("password")
    @classmethod
    def _check_password(cls, v: str) -> str:
        error = login_guard.validate_password(v)
        if error:
            raise ValueError(error)
        return v


class UserUpdate(BaseModel):
    email: Optional[EmailStr] = None
    full_name: Optional[str] = None
    password: Optional[str] = None

    @field_validator("password")
    @classmethod
    def _check_password(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        error = login_guard.validate_password(v)
        if error:
            raise ValueError(error)
        return v


class User(UserBase):
    id: int
    is_active: bool
    is_admin: bool
    created_at: datetime

    class Config:
        from_attributes = True


class ProjectBase(BaseModel):
    name: str
    description: Optional[str] = None


class ProjectCreate(ProjectBase):
    pass


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class Project(ProjectBase):
    id: int
    created_by: int
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ProjectMemberBase(BaseModel):
    user_id: int
    role: str = "viewer"


class ProjectMemberCreate(ProjectMemberBase):
    pass


class ProjectMemberUpdate(BaseModel):
    role: Optional[str] = None


class ProjectMember(ProjectMemberBase):
    id: int
    project_id: int
    user: Optional[User] = None
    created_at: datetime

    class Config:
        from_attributes = True


class SeismicDataBase(BaseModel):
    name: str
    description: Optional[str] = None
    file_type: str = "segy"


class SeismicDataCreate(SeismicDataBase):
    project_id: int


class SeismicDataUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class SeismicDataStats(BaseModel):
    min_value: float
    max_value: float
    mean_value: float
    std_value: float


class SeismicDataDimensions(BaseModel):
    inline_start: int
    inline_end: int
    inline_step: int
    crossline_start: int
    crossline_end: int
    crossline_step: int
    depth_start: float
    depth_end: float
    depth_step: float
    num_inlines: int
    num_crosslines: int
    num_depths: int


class SeismicData(SeismicDataBase):
    id: int
    project_id: int
    file_size: Optional[float] = None
    status: str
    upload_progress: float
    created_by: int
    created_at: datetime
    dimensions: Optional[SeismicDataDimensions] = None
    statistics: Optional[SeismicDataStats] = None

    class Config:
        from_attributes = True


class SliceRequest(BaseModel):
    seismic_data_id: int
    slice_type: str
    slice_index: int
    colormap: Optional[str] = "seismic"
    min_value: Optional[float] = None
    max_value: Optional[float] = None


class SliceData(BaseModel):
    slice_type: str
    slice_index: int
    data: List[List[float]]
    width: int
    height: int


class WellBase(BaseModel):
    name: str
    uwi: Optional[str] = None
    x: Optional[float] = None
    y: Optional[float] = None
    kb_elevation: Optional[float] = None
    total_depth: Optional[float] = None


class WellCreate(WellBase):
    project_id: int


class WellUpdate(BaseModel):
    name: Optional[str] = None
    uwi: Optional[str] = None
    x: Optional[float] = None
    y: Optional[float] = None
    kb_elevation: Optional[float] = None
    total_depth: Optional[float] = None


class Well(WellBase):
    id: int
    project_id: int
    created_at: datetime

    class Config:
        from_attributes = True


class AnnotationBase(BaseModel):
    name: Optional[str] = None
    annotation_type: str
    geometry: dict
    properties: Optional[dict] = None


class AnnotationCreate(AnnotationBase):
    seismic_data_id: int


class AnnotationUpdate(BaseModel):
    name: Optional[str] = None
    geometry: Optional[dict] = None
    properties: Optional[dict] = None


class Annotation(AnnotationBase):
    id: int
    seismic_data_id: int
    owner_id: int
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ProcessingTaskBase(BaseModel):
    task_type: str
    seismic_data_id: Optional[int] = None
    parameters: Optional[dict] = None


class ProcessingTaskCreate(ProcessingTaskBase):
    pass


class ProcessingTask(ProcessingTaskBase):
    id: int
    status: str
    progress: float
    created_by: int
    created_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    error_message: Optional[str] = None

    class Config:
        from_attributes = True


class UploadSession(BaseModel):
    session_id: str
    file_name: str
    file_size: int
    project_id: int
    uploaded_chunks: List[int]
    total_chunks: int
    status: str


class MeasurementPoint(BaseModel):
    x: float
    y: float
    z: float


class MeasurementRequest(BaseModel):
    points: List[MeasurementPoint]
    measurement_type: str


class MeasurementResult(BaseModel):
    measurement_type: str
    value: float
    unit: str
    points: List[MeasurementPoint]
