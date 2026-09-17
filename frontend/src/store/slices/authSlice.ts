import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { authAPI } from '../../services/api';
import { User } from '../../types';
import { normalizeUsername, validateUsername, validatePassword } from '../../utils/validation';

export interface LoginErrorPayload {
  code: 'invalid_format' | 'bad_credentials' | 'locked' | 'unknown';
  message: string;
  remainingAttempts?: number;
  remainingSeconds?: number;
  maxFailures?: number;
  lockSeconds?: number;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  error: string | null;
}

const initialState: AuthState = {
  user: null,
  token: localStorage.getItem('token'),
  isAuthenticated: !!localStorage.getItem('token'),
  loading: false,
  error: null,
};

function normalizeLoginError(error: any): LoginErrorPayload {
  const detail = error.response?.data?.detail;
  if (detail && typeof detail === 'object' && detail.message) {
    return {
      code: detail.code ?? 'unknown',
      message: detail.message,
      remainingAttempts: detail.remaining_attempts,
      remainingSeconds: detail.remaining_seconds,
      maxFailures: detail.max_failures,
      lockSeconds: detail.lock_seconds,
    };
  }
  return {
    code: 'unknown',
    message: typeof detail === 'string' && detail ? detail : '登录失败，请稍后重试',
  };
}

export const login = createAsyncThunk(
  'auth/login',
  async ({ username, password }: { username: string; password: string }, { rejectWithValue }) => {
    // 提交前按统一标准归一化/校验，避免非法格式绕过前端规则
    const normalizedUsername = normalizeUsername(username);
    const usernameError = validateUsername(normalizedUsername);
    if (usernameError) {
      return rejectWithValue({ code: 'invalid_format', message: usernameError });
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      return rejectWithValue({ code: 'invalid_format', message: passwordError });
    }
    try {
      const response = await authAPI.login(normalizedUsername, password);
      const { access_token } = response.data;
      localStorage.setItem('token', access_token);

      const userResponse = await authAPI.getCurrentUser();
      const user = userResponse.data;
      localStorage.setItem('user', JSON.stringify(user));

      return { user, token: access_token };
    } catch (error: any) {
      return rejectWithValue(normalizeLoginError(error));
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
      const detail = error.response?.data?.detail;
      const message =
        detail && typeof detail === 'object'
          ? Object.values(detail).flat().join('；')
          : detail || '注册失败';
      return rejectWithValue(message);
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
  },
  extraReducers: (builder) => {
    builder
      .addCase(login.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(login.fulfilled, (state, action: PayloadAction<{ user: User; token: string }>) => {
        state.loading = false;
        state.user = action.payload.user;
        state.token = action.payload.token;
        state.isAuthenticated = true;
      })
      .addCase(login.rejected, (state, action: PayloadAction<any>) => {
        state.loading = false;
        state.error = (action.payload as LoginErrorPayload)?.message || '登录失败';
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

export const { clearError } = authSlice.actions;
export default authSlice.reducer;
