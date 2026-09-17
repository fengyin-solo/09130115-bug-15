import axios from 'axios';

declare module 'axios' {
  export interface AxiosRequestConfig {
    /** 标记该请求不触发“token 失效”强制跳转（登录/注册/状态查询接口使用） */
    skipAuthRedirect?: boolean;
  }
}

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
    const config = error.config as any;
    if (error.response?.status === 401 && !config?.skipAuthRedirect) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export const authAPI = {
  login: (username: string, password: string) =>
    api.post(
      '/auth/login',
      new URLSearchParams({ username, password }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        // 登录接口自身的 401/429 属于正常业务响应，不能触发“token 失效”跳转
        skipAuthRedirect: true,
      }
    ),
  // 状态查询接口同样不应触发鉴权跳转
  loginStatus: (username: string) =>
    api.get('/auth/login-status', { params: { username }, skipAuthRedirect: true }),
  register: (data: any) => api.post('/auth/register', data, { skipAuthRedirect: true }),
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
