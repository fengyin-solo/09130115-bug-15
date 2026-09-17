import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:8000/api/v1';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 300000,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url: string = error.config?.url || '';
    const isAuthEndpoint = url.includes('/auth/login') || url.includes('/auth/login-status');
    // 登录接口自身的 401（密码错误）不能触发整页跳转——否则错误提示刚渲染
    // 就被页面重载清掉，表现为"弹窗一闪而过"。
    // 429（账号锁定）同样交给登录页持久展示。
    if (error.response?.status === 401 && !isAuthEndpoint) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

/** 从后端错误响应中提取结构化信息，兼容旧的字符串 detail。 */
export function extractLoginError(error: any): {
  message: string;
  code?: string;
  locked?: boolean;
  secondsRemaining?: number;
  failures?: number;
  attemptsLeft?: number;
  maxFailures?: number;
  lockoutSeconds?: number;
} {
  const detail = error?.response?.data?.detail;
  if (detail && typeof detail === 'object') {
    return {
      message: detail.message || '登录失败',
      code: detail.code,
      locked: detail.locked,
      secondsRemaining: detail.seconds_remaining,
      failures: detail.failures,
      attemptsLeft: detail.attempts_left,
      maxFailures: detail.max_failures,
      lockoutSeconds: detail.lockout_seconds,
    };
  }
  if (typeof detail === 'string' && detail) {
    return { message: detail };
  }
  if (error?.response?.status === 429) {
    const retryAfter = Number(error.response.headers?.['retry-after']);
    return {
      message: Number.isFinite(retryAfter)
        ? `密码错误次数过多，账号已临时锁定，请 ${retryAfter} 秒后再试`
        : '密码错误次数过多，账号已临时锁定，请稍后再试',
      code: 'account_locked',
      locked: true,
      secondsRemaining: Number.isFinite(retryAfter) ? retryAfter : undefined,
    };
  }
  return { message: error?.message ? '网络异常，请稍后重试' : '登录失败' };
}

export interface LoginStatusResponse {
  locked: boolean;
  seconds_remaining: number;
  failures: number;
  max_failures: number;
  lockout_seconds: number;
  server_time: number;
}

export const authAPI = {
  login: (username: string, password: string) =>
    api.post('/auth/login', new URLSearchParams({ username, password }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }),
  loginStatus: (username: string) =>
    api.get<LoginStatusResponse>('/auth/login-status', {
      params: { username },
    }),
  register: (data: any) => api.post('/auth/register', data),
  getCurrentUser: () => api.get('/auth/me'),
  updateCurrentUser: (data: any) => api.put('/auth/me', data),
};

export const projectsAPI = {
  list: () => api.get('/projects'),
  create: (data: any) => api.post('/projects', data),
  get: (id: number) => api.get(`/projects/${id}`),
  update: (id: number, data: any) => api.put(`/projects/${id}`, data),
  delete: (id: number) => api.delete(`/projects/${id}`),
  listMembers: (id: number) => api.get(`/projects/${id}/members`),
  addMember: (id: number, data: any) => api.post(`/projects/${id}/members`, data),
  updateMember: (projectId: number, memberId: number, data: any) =>
    api.put(`/projects/${projectId}/members/${memberId}`, data),
  removeMember: (projectId: number, memberId: number) =>
    api.delete(`/projects/${projectId}/members/${memberId}`),
};

export const seismicAPI = {
  list: (projectId: number) => api.get(`/seismic/project/${projectId}`),
  upload: (projectId: number, name: string, description: string, file: File, onProgress?: (progress: number) => void) => {
    const formData = new FormData();
    formData.append('name', name);
    if (description) formData.append('description', description);
    formData.append('file', file);

    return api.post(`/seismic/project/${projectId}/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          onProgress(progress);
        }
      },
    });
  },
  get: (id: number) => api.get(`/seismic/${id}`),
  delete: (id: number) => api.delete(`/seismic/${id}`),
  getSlice: (seismicId: number, sliceType: string, sliceIndex: number, params?: any) =>
    api.get(`/seismic/${seismicId}/slice/${sliceType}/${sliceIndex}`, {
      params: { format: 'json', ...params },
    }),
  getSliceImage: (seismicId: number, sliceType: string, sliceIndex: number, params?: any) =>
    api.get(`/seismic/${seismicId}/slice/${sliceType}/${sliceIndex}`, {
      params: { format: 'png', ...params },
      responseType: 'blob',
    }),
  getSubvolume: (seismicId: number, params: any) =>
    api.post(`/seismic/${seismicId}/subvolume`, null, { params }),
  measure: (data: any) => api.post('/seismic/measurement', data),
};

export const annotationsAPI = {
  list: (seismicId: number) => api.get(`/annotations/seismic/${seismicId}`),
  create: (data: any) => api.post('/annotations', data),
  get: (id: number) => api.get(`/annotations/${id}`),
  update: (id: number, data: any) => api.put(`/annotations/${id}`, data),
  delete: (id: number) => api.delete(`/annotations/${id}`),
};

export const wellsAPI = {
  list: (projectId: number) => api.get(`/wells/project/${projectId}`),
  create: (data: any) => api.post('/wells', data),
  get: (id: number) => api.get(`/wells/${id}`),
  update: (id: number, data: any) => api.put(`/wells/${id}`, data),
  delete: (id: number) => api.delete(`/wells/${id}`),
};

export default api;
