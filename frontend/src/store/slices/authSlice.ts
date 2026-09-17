import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { authAPI, extractLoginError, LoginStatusResponse } from '../../services/api';
import { User } from '../../types';

/** 登录限制状态：锁定标志、服务端剩余秒数、失败次数等。 */
export interface LoginLockState {
  locked: boolean;
  secondsRemaining: number;
  failures: number;
  maxFailures: number;
  lockoutSeconds: number;
  /** 该状态对应的用户名（已规范化），供跨入口恢复时核对 */
  username: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  error: string | null;
  /** 上一次失败的提示（锁定解除时必须清掉，不允许残留） */
  lastFailureMessage: string | null;
  /** 锁定解除后的一次性提示，例如"已解锁，请重新登录" */
  infoMessage: string | null;
  loginLock: LoginLockState | null;
}

const initialState: AuthState = {
  user: null,
  token: localStorage.getItem('token'),
  isAuthenticated: !!localStorage.getItem('token'),
  loading: false,
  error: null,
  lastFailureMessage: null,
  infoMessage: null,
  loginLock: null,
};

interface LoginRejectPayload {
  message: string;
  code?: string;
  locked?: boolean;
  secondsRemaining?: number;
  failures?: number;
  attemptsLeft?: number;
  maxFailures?: number;
  lockoutSeconds?: number;
  username?: string;
}

export const login = createAsyncThunk(
  'auth/login',
  async (
    { username, password }: { username: string; password: string },
    { rejectWithValue }
  ) => {
    // 记住最近尝试登录的用户名：用户从其它入口（新标签页/401 被踢回/
    // 直接访问登录 URL）重新进入时，可凭它恢复同样的锁定提示与倒计时
    localStorage.setItem('last_login_username', username);
    try {
      const response = await authAPI.login(username, password);
      const { access_token } = response.data;
      localStorage.setItem('token', access_token);

      const userResponse = await authAPI.getCurrentUser();
      const user = userResponse.data;
      localStorage.setItem('user', JSON.stringify(user));
      localStorage.removeItem('last_login_username');

      return { user, token: access_token };
    } catch (error: any) {
      const info = extractLoginError(error);
      return rejectWithValue({ ...info, username } as LoginRejectPayload);
    }
  }
);

/** 按用户名+当前来源IP查询登录限制状态（跨入口恢复同一条提示）。 */
export const refreshLoginStatus = createAsyncThunk(
  'auth/refreshLoginStatus',
  async (
    { username }: { username: string },
    { rejectWithValue }
  ): Promise<LoginStatusResponse & { username: string } | ReturnType<typeof rejectWithValue>> => {
    try {
      const response = await authAPI.loginStatus(username);
      return { ...response.data, username };
    } catch {
      return rejectWithValue(null);
    }
  }
);

export const register = createAsyncThunk(
  'auth/register',
  async (userData: any, { rejectWithValue }) => {
    try {
      const response = await authAPI.register(userData);
      return response.data;
    } catch (error: any) {
      return rejectWithValue(error.response?.data?.detail?.message || error.response?.data?.detail || '注册失败');
    }
  }
);

export const getCurrentUser = createAsyncThunk('auth/getCurrentUser', async (_, { rejectWithValue }) => {
  try {
    const response = await authAPI.getCurrentUser();
    return response.data;
  } catch (error: any) {
    return rejectWithValue(error.response?.data?.detail || '获取用户信息失败');
  }
});

export const logout = createAsyncThunk('auth/logout', async () => {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  return null;
});

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    clearError: (state) => {
      state.error = null;
    },
    clearLoginNotices: (state) => {
      state.error = null;
      state.lastFailureMessage = null;
      state.infoMessage = null;
    },
    clearInfoMessage: (state) => {
      state.infoMessage = null;
    },
    /** 锁定到期后清除锁定与旧失败提示（由页面在服务端确认解锁后调用）。 */
    clearLock: (state) => {
      state.loginLock = null;
      state.error = null;
      state.lastFailureMessage = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(login.pending, (state) => {
        state.loading = true;
        state.error = null;
        state.infoMessage = null;
      })
      .addCase(login.fulfilled, (state, action: PayloadAction<{ user: User; token: string }>) => {
        state.loading = false;
        state.user = action.payload.user;
        state.token = action.payload.token;
        state.isAuthenticated = true;
        // 成功登录：失败提示与锁定状态一并清除，不允许残留
        state.error = null;
        state.lastFailureMessage = null;
        state.infoMessage = null;
        state.loginLock = null;
      })
      .addCase(login.rejected, (state, action) => {
        state.loading = false;
        const payload = (action.payload || {}) as LoginRejectPayload;
        state.error = payload.message || '登录失败';
        if (payload.locked) {
          // 锁住期间无论密码对错，都保留锁定提示，不覆盖成"密码错误"
          state.infoMessage = null;
          if (payload.secondsRemaining !== undefined) {
            state.loginLock = {
              locked: true,
              secondsRemaining: payload.secondsRemaining,
              failures: payload.failures ?? 0,
              maxFailures: payload.maxFailures ?? 0,
              lockoutSeconds: payload.lockoutSeconds ?? payload.secondsRemaining,
              username: payload.username || state.loginLock?.username || '',
            };
          }
        } else {
          // 记录上一次失败提示，锁定解除时要清掉，不能残留
          state.lastFailureMessage = state.error;
        }
      })
      .addCase(refreshLoginStatus.fulfilled, (state, action) => {
        const s = action.payload;
        if (s.locked) {
          state.loginLock = {
            locked: true,
            secondsRemaining: s.seconds_remaining,
            failures: s.failures,
            maxFailures: s.max_failures,
            lockoutSeconds: s.lockout_seconds,
            username: s.username,
          };
          state.error = null;
        } else if (state.loginLock && state.loginLock.username === s.username) {
          // 之前锁定、现在服务端确认已解锁：锁定与旧失败提示都不残留
          state.loginLock = null;
          state.error = null;
          state.lastFailureMessage = null;
          state.infoMessage = '锁定已解除，请重新输入密码登录';
        }
      })
      .addCase(register.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(register.fulfilled, (state) => {
        state.loading = false;
      })
      .addCase(register.rejected, (state, action: PayloadAction<any>) => {
        state.loading = false;
        state.error = action.payload as string;
      })
      .addCase(getCurrentUser.fulfilled, (state, action: PayloadAction<User>) => {
        state.user = action.payload;
      })
      .addCase(logout.fulfilled, (state) => {
        state.user = null;
        state.token = null;
        state.isAuthenticated = false;
      });
  },
});

export const { clearError, clearLoginNotices, clearInfoMessage, clearLock } =
  authSlice.actions;
export default authSlice.reducer;
