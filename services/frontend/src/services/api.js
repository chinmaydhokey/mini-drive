import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true, // send cookies (refresh token)
});

// ── Token management (persisted in localStorage + in-memory) ──
let accessToken = null;
try {
  accessToken = localStorage.getItem('minidrive_access_token') || null;
} catch {}

export const setAccessToken = (token) => {
  accessToken = token;
  try {
    if (token) localStorage.setItem('minidrive_access_token', token);
    else localStorage.removeItem('minidrive_access_token');
  } catch {}
};
export const getAccessToken = () => accessToken;
export const clearAccessToken = () => {
  accessToken = null;
  try { localStorage.removeItem('minidrive_access_token'); } catch {}
};

// ── Request interceptor: attach JWT ──────────────────────────
api.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

// ── Response interceptor: auto-refresh on 401 ────────────────
let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach((prom) => {
    if (error) prom.reject(error);
    else prom.resolve(token);
  });
  failedQueue = [];
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // If 401 and not already retrying and not a refresh/login request
    if (
      error.response?.status === 401 &&
      !originalRequest._retry &&
      !originalRequest.url?.includes('/auth/login') &&
      !originalRequest.url?.includes('/auth/register') &&
      !originalRequest.url?.includes('/auth/refresh')
    ) {
      if (isRefreshing) {
        // Queue this request until refresh completes
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((token) => {
          originalRequest.headers.Authorization = `Bearer ${token}`;
          return api(originalRequest);
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const { data } = await axios.post(`${API_BASE}/auth/refresh`, {}, { withCredentials: true });
        const newToken = data.data.accessToken;
        setAccessToken(newToken);
        processQueue(null, newToken);
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        clearAccessToken();
        window.location.href = '/login';
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

// ── Auth API ─────────────────────────────────────────────────
export const authAPI = {
  register: (data) => api.post('/auth/register', data),
  login: (data) => api.post('/auth/login', data),
  logout: () => api.post('/auth/logout'),
  getMe: () => api.get('/auth/me'),
  refresh: () => api.post('/auth/refresh'),
};

// ── Files API ────────────────────────────────────────────────
export const filesAPI = {
  list: (params) => api.get('/files', { params }),
  get: (id) => api.get(`/files/${id}`),
  upload: (formData, onProgress) =>
    api.post('/files/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: onProgress,
    }),
  download: (id) => api.get(`/files/${id}/download`, { responseType: 'blob' }),
  viewBlob: (id) => api.get(`/files/${id}/view`, { responseType: 'blob' }),
  viewUrl: (id) => {
    const base = `/api/files/${id}/view`;
    return accessToken ? `${base}?token=${encodeURIComponent(accessToken)}` : base;
  },
  getText: (id) => api.get(`/files/${id}/view`, { responseType: 'text' }),
  update: (id, data) => api.patch(`/files/${id}`, data),
  delete: (id) => api.delete(`/files/${id}`),
  search: (params) => api.get('/files/search', { params }),
  storage: () => api.get('/files/storage'),
  // Versions
  listVersions: (id) => api.get(`/files/${id}/versions`),
  uploadVersion: (id, formData, onProgress) =>
    api.post(`/files/${id}/versions`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: onProgress,
    }),
  downloadVersion: (id, vNum) => api.get(`/files/${id}/versions/${vNum}/download`, { responseType: 'blob' }),
  restoreVersion: (id, vNum) => api.post(`/files/${id}/versions/${vNum}/restore`),
  // Resumable chunked upload
  uploadInit: (data) => api.post('/files/upload/init', data),
  uploadChunk: (formData, signal) =>
    api.post('/files/upload/chunk', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 60000,
      signal,
    }),
  uploadComplete: (data) => api.post('/files/upload/complete', data),
  uploadStatus: (fileId) => api.get(`/files/upload/status/${fileId}`),
};

// ── Folders API ──────────────────────────────────────────────
export const foldersAPI = {
  create: (data) => api.post('/folders', data),
  getContents: (id) => api.get(`/folders/${id}`),
  getTree: (id = 'root') => api.get(`/folders/${id}/tree`),
  update: (id, data) => api.patch(`/folders/${id}`, data),
  delete: (id) => api.delete(`/folders/${id}`),
};

// ── Shares API ───────────────────────────────────────────────
export const sharesAPI = {
  create: (data) => api.post('/shares', data),
  createBatch: (data) => api.post('/shares/batch', data),
  createPrivate: (data) => api.post('/shares/private', data),
  createBatchPrivate: (data) => api.post('/shares/batch-private', data),
  getForFile: (fileId) => api.get(`/shares/file/${fileId}`),
  sharedWithMe: () => api.get('/shares/shared-with-me'),
  access: (token, password) => api.get(`/shares/${token}`, { params: password ? { password } : {} }),
  download: (token, password) => api.get(`/shares/${token}/download`, {
    responseType: 'blob',
    params: password ? { password } : {},
  }),
  viewUrl: (token, password) => {
    const base = `/api/shares/${token}/view`;
    return password ? `${base}?password=${encodeURIComponent(password)}` : base;
  },
  downloadBatchFile: (token, fileId, password) => api.get(`/shares/${token}/files/${fileId}/download`, {
    responseType: 'blob',
    params: password ? { password } : {},
  }),
  viewBatchFileUrl: (token, fileId, password) => {
    const base = `/api/shares/${token}/files/${fileId}/view`;
    return password ? `${base}?password=${encodeURIComponent(password)}` : base;
  },
  revoke: (shareId) => api.delete(`/shares/${shareId}`),
  updatePermissions: (shareId, data) => api.patch(`/shares/${shareId}/permissions`, data),
  removeUser: (shareId, userId) => api.delete(`/shares/${shareId}/users/${userId}`),
};

// ── Trash API ────────────────────────────────────────────────
export const trashAPI = {
  list: (params) => api.get('/trash', { params }),
  restore: (id, type = 'file') => api.post(`/trash/${id}/restore?type=${type}`),
  permanentDelete: (id, type = 'file') => api.delete(`/trash/${id}?type=${type}`),
  empty: () => api.delete('/trash'),
};

// ── Bulk API ─────────────────────────────────────────────────
export const bulkAPI = {
  softDelete: (ids) => api.post('/bulk/delete', { ids }),
  restore: (ids) => api.post('/bulk/restore', { ids }),
  permanentDelete: (ids) => api.delete('/bulk/permanent-delete', { data: { ids } }),
  downloadZip: (fileIds) => api.post('/bulk/download', { fileIds }, { responseType: 'blob' }),
};

// ── Admin API ────────────────────────────────────────────────
export const adminAPI = {
  getStats: () => api.get('/admin/stats'),
  listUsers: (params) => api.get('/admin/users', { params }),
  updateUser: (userId, data) => api.patch(`/admin/users/${userId}`, data),
  getNodes: () => api.get('/admin/nodes'),
  drainNode: (nodeId) => api.post(`/admin/nodes/${nodeId}/drain`),
};

export default api;
