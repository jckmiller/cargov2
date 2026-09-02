// Thin fetch wrapper that injects the JWT and parses JSON errors.
import { state } from './store.js';

const TOKEN_KEY = 'a3_token';

export function loadToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function saveToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = state.token || loadToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data && data.error) || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p),

  // Auth
  login: (username, password) => request('POST', '/api/login', { username, password }),
  me: () => request('GET', '/api/me'),

  // Projects
  listProjects: () => request('GET', '/api/projects'),
  getProject: (id) => request('GET', `/api/projects/${id}`),
  createProject: (p) => request('POST', '/api/projects', p),
  updateProject: (id, p) => request('PUT', `/api/projects/${id}`, p),
  deleteProject: (id) => request('DELETE', `/api/projects/${id}`),

  // Users (admin)
  listUsers: () => request('GET', '/api/users'),
  createUser: (u) => request('POST', '/api/users', u),
  updateUser: (id, u) => request('PUT', `/api/users/${id}`, u),
  deleteUser: (id) => request('DELETE', `/api/users/${id}`),
};
