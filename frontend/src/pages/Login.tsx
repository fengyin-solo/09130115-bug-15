import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Form, Input, Button, Card, Typography, Alert, Tabs } from 'antd';
import { UserOutlined, LockOutlined, MailOutlined } from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { login, register, clearError, LoginErrorPayload } from '../store/slices/authSlice';
import { authAPI } from '../services/api';
import { RootState, AppDispatch } from '../store';
import {
  normalizeUsername,
  validateUsername,
  validatePassword,
  USERNAME_MIN_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
} from '../utils/validation';
import {
  ServerLoginStatus,
  StoredLock,
  applyServerStatus,
  getLock,
  clearLock,
} from '../utils/loginLockStore';

const { Title, Text, Paragraph } = Typography;

/** 锁定信息定时与服务端对账的间隔（倒计时本身每秒本地刷新） */
const SYNC_INTERVAL_MS = 10_000;

function formatRemaining(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const Login: React.FC = () => {
  const [loginForm] = Form.useForm();
  const [registerForm] = Form.useForm();
  const [activeTab, setActiveTab] = useState<string>('login');
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const location = useLocation();

  const { loading, error, isAuthenticated } = useSelector((state: RootState) => state.auth);

  // 锁定信息与规则参数。按当前用户名维度存储，不同账号互不串显
  const [lock, setLock] = useState<StoredLock | null>(null);
  const [maxFailures, setMaxFailures] = useState<number>(5);
  const [lockSeconds, setLockSeconds] = useState<number>(300);
  const [remainingAttempts, setRemainingAttempts] = useState<number | null>(null);
  const [now, setNow] = useState<number>(Date.now());

  const watchedUsername = Form.useWatch('username', loginForm) as string | undefined;
  const username = normalizeUsername(watchedUsername ?? '');

  const inFlightRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const from = (location.state as any)?.from?.pathname || '/';

  const remainingSeconds = lock ? Math.max(0, (lock.lockedUntil - now) / 1000) : 0;

  /**
   * 以服务端状态为准同步本地锁定信息。
   * 剩余时间一律采用服务端 TTL，防止本地时钟/倒计时与实际锁定时间对不上。
   */
  const syncStatus = useCallback(async (targetUsername: string) => {
    const normalized = normalizeUsername(targetUsername);
    if (!normalized) return;
    inFlightRef.current?.abort();
    const controller = new AbortController();
    inFlightRef.current = controller;
    try {
      const response = await authAPI.loginStatus(normalized);
      if (controller.signal.aborted) return;
      const serverStatus = response.data as ServerLoginStatus;
      setMaxFailures(serverStatus.max_failures);
      setLockSeconds(serverStatus.lock_seconds);
      const stored = applyServerStatus(serverStatus);
      setLock(stored);
      setRemainingAttempts(
        serverStatus.locked ? 0 : serverStatus.remaining_attempts ?? null
      );
    } catch {
      // 查询失败时保留本地已持久化的状态，避免误清除提示；下个周期再对账
    } finally {
      if (inFlightRef.current === controller) inFlightRef.current = null;
    }
  }, []);

  // 进入页面（含从其它入口跳转、刷新）时：恢复持久化的锁定提示并与服务端对账
  useEffect(() => {
    const initialUsername = normalizeUsername(loginForm.getFieldValue('username') ?? '');
    if (initialUsername) {
      setLock(getLock(initialUsername));
      syncStatus(initialUsername);
    }
    // 仅在挂载时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 用户名变化：切换账号时立即丢弃上一账号的锁定/失败提示，并防抖查询新账号状态
  useEffect(() => {
    setLock(getLock(username));
    setRemainingAttempts(null);
    dispatch(clearError());
    if (!username) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      // 合法用户名才查询，避免无意义请求（同时也不会误清其它账号状态）
      if (validateUsername(username) === null) {
        syncStatus(username);
      }
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [username, syncStatus, dispatch]);

  // 本地倒计时每秒刷新
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 锁定期间定时与服务端对账；倒计时走到 0 时必须经服务端确认才解除
  useEffect(() => {
    if (!lock) return;
    if (remainingSeconds <= 0) {
      syncStatus(username);
      return;
    }
    const timer = setInterval(() => syncStatus(username), SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [lock, remainingSeconds, username, syncStatus]);

  // 多标签页同步
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'login_locks' && username) {
        setLock(getLock(username));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [username]);

  useEffect(() => {
    if (isAuthenticated) {
      navigate(from, { replace: true });
    }
  }, [isAuthenticated, navigate, from]);

  useEffect(() => {
    dispatch(clearError());
  }, [activeTab, dispatch]);

  const handleLogin = async (values: any) => {
    const normalizedUsername = normalizeUsername(values.username);

    // 提交前按同一套标准校验（与注册、后端规则一致）
    const usernameError = validateUsername(normalizedUsername);
    if (usernameError) {
      loginForm.setFields([{ name: 'username', errors: [usernameError] }]);
      return;
    }
    const passwordError = validatePassword(values.password ?? '');
    if (passwordError) {
      loginForm.setFields([{ name: 'password', errors: [passwordError] }]);
      return;
    }

    // 已锁定：不提交，直接以服务端状态为准（正确密码在锁定期间也无法进入）
    if (lock && remainingSeconds > 0) {
      syncStatus(normalizedUsername);
      return;
    }

    // 提交前先和服务端确认一次锁定状态，避免本地状态滞后导致的误放行
    await syncStatus(normalizedUsername);
    const latestLock = getLock(normalizedUsername);
    if (latestLock && latestLock.lockedUntil > Date.now()) {
      setLock(latestLock);
      return;
    }

    loginForm.setFieldValue('username', normalizedUsername);
    const result = await dispatch(
      login({ username: normalizedUsername, password: values.password })
    );
    if (login.fulfilled.match(result)) {
      // 登录成功：清除该账号残留的锁定标记与失败提示
      clearLock(normalizedUsername);
      setLock(null);
      setRemainingAttempts(null);
      dispatch(clearError());
      navigate(from, { replace: true });
      return;
    }

    const payload = result.payload as LoginErrorPayload | undefined;
    if (payload?.code === 'locked' && payload.remainingSeconds) {
      const stored = applyServerStatus({
        username: normalizedUsername,
        locked: true,
        remaining_seconds: payload.remainingSeconds,
        remaining_attempts: 0,
        max_failures: payload.maxFailures ?? maxFailures,
        lock_seconds: payload.lockSeconds ?? lockSeconds,
      });
      setLock(stored);
      setRemainingAttempts(0);
    } else if (payload?.code === 'bad_credentials') {
      // 普通失败：用服务端返回的剩余次数提示，并对账一次拿到最新计数
      setRemainingAttempts(payload.remainingAttempts ?? null);
      syncStatus(normalizedUsername);
    }
  };

  const handleRegister = async (values: any) => {
    const result = await dispatch(
      register({ ...values, username: normalizeUsername(values.username) })
    );
    if (register.fulfilled.match(result)) {
      setActiveTab('login');
      loginForm.setFieldsValue({ username: normalizeUsername(values.username) });
    }
  };

  const locked = !!lock && remainingSeconds > 0;

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #001529 0%, #003a70 100%)',
        padding: 24,
      }}
    >
      <Card
        style={{
          width: 420,
          maxWidth: '100%',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div
            style={{
              width: 64,
              height: 64,
              margin: '0 auto 16px',
              borderRadius: 12,
              background: 'linear-gradient(135deg, #1890ff 0%, #722ed1 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span style={{ fontSize: 32, color: 'white' }}>🌍</span>
          </div>
          <Title level={3} style={{ margin: 0, marginBottom: 8 }}>
            SeismicVision
          </Title>
          <Text type="secondary">三维地震数据可视化系统</Text>
        </div>

        {/* 锁定提示：常驻页面（非弹窗），刷新或从其它入口进入仍然显示，直至服务端确认解锁 */}
        {activeTab === 'login' && locked && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={`账号已临时锁定，请 ${formatRemaining(remainingSeconds)} 后再试`}
            description={
              <div>
                <div>
                  连续输错密码已达到 {maxFailures} 次上限，锁定期间即使密码正确也无法登录。
                </div>
                <div>剩余锁定时间：{formatRemaining(remainingSeconds)}</div>
              </div>
            }
          />
        )}

        {/* 普通失败提示：仅在未锁定时显示；锁定解除、切换账号或登录成功后不会残留 */}
        {activeTab === 'login' && !locked && error && (
          <Alert
            message={
              remainingAttempts !== null && remainingAttempts > 0
                ? `${error}，还可尝试 ${remainingAttempts} 次`
                : error
            }
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            closable
            onClose={() => dispatch(clearError())}
          />
        )}

        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          centered
          items={[
            {
              key: 'login',
              label: '登录',
              children: (
                <Form
                  form={loginForm}
                  onFinish={handleLogin}
                  size="large"
                  // 锁定期间禁止再次提交（用户名仍可切换以登录其它账号）
                  disabled={loading || locked}
                >
                  <Form.Item
                    name="username"
                    rules={[
                      { required: true, message: '请输入用户名' },
                      {
                        validator: (_, value) => {
                          const err = validateUsername(normalizeUsername(value ?? ''));
                          return err
                            ? Promise.reject(new Error(err))
                            : Promise.resolve();
                        },
                      },
                    ]}
                    validateTrigger={['onBlur', 'onSubmit']}
                  >
                    <Input
                      prefix={<UserOutlined />}
                      placeholder="用户名"
                      autoComplete="username"
                      // 锁定时仍允许切换到其它账号，因此不禁用整个输入框
                      disabled={loading}
                    />
                  </Form.Item>

                  <Form.Item
                    name="password"
                    rules={[
                      { required: true, message: '请输入密码' },
                      {
                        validator: (_, value) => {
                          const err = validatePassword(value ?? '');
                          return err
                            ? Promise.reject(new Error(err))
                            : Promise.resolve();
                        },
                      },
                    ]}
                    validateTrigger={['onBlur', 'onSubmit']}
                  >
                    <Input.Password
                      prefix={<LockOutlined />}
                      placeholder="密码"
                      autoComplete="current-password"
                    />
                  </Form.Item>

                  <Form.Item>
                    <Button
                      type="primary"
                      htmlType="submit"
                      loading={loading}
                      block
                    >
                      {locked ? `已锁定（${formatRemaining(remainingSeconds)}）` : '登录'}
                    </Button>
                  </Form.Item>
                </Form>
              ),
            },
            {
              key: 'register',
              label: '注册',
              children: (
                <Form
                  form={registerForm}
                  onFinish={handleRegister}
                  size="large"
                  disabled={loading}
                >
                  <Form.Item
                    name="username"
                    rules={[
                      { required: true, message: '请输入用户名' },
                      {
                        validator: (_, value) => {
                          const err = validateUsername(normalizeUsername(value ?? ''));
                          return err
                            ? Promise.reject(new Error(err))
                            : Promise.resolve();
                        },
                      },
                    ]}
                    validateTrigger={['onBlur', 'onSubmit']}
                  >
                    <Input prefix={<UserOutlined />} placeholder="用户名" />
                  </Form.Item>

                  <Form.Item
                    name="email"
                    rules={[
                      { required: true, message: '请输入邮箱' },
                      { type: 'email', message: '请输入有效的邮箱地址' },
                    ]}
                  >
                    <Input prefix={<MailOutlined />} placeholder="邮箱" />
                  </Form.Item>

                  <Form.Item
                    name="full_name"
                    rules={[{ required: true, message: '请输入姓名' }]}
                  >
                    <Input placeholder="姓名" />
                  </Form.Item>

                  <Form.Item
                    name="password"
                    rules={[
                      { required: true, message: '请输入密码' },
                      {
                        validator: (_, value) => {
                          const err = validatePassword(value ?? '');
                          return err
                            ? Promise.reject(new Error(err))
                            : Promise.resolve();
                        },
                      },
                    ]}
                    validateTrigger={['onBlur', 'onSubmit']}
                  >
                    <Input.Password prefix={<LockOutlined />} placeholder="密码" />
                  </Form.Item>

                  <Form.Item>
                    <Button
                      type="primary"
                      htmlType="submit"
                      loading={loading}
                      block
                    >
                      注册
                    </Button>
                  </Form.Item>
                </Form>
              ),
            },
          ]}
        />

        {/* 判定规则常驻页面说明，不依赖弹窗一闪而过 */}
        <Paragraph
          type="secondary"
          style={{ fontSize: 12, marginTop: 8, marginBottom: 8, lineHeight: 1.7 }}
        >
          登录安全规则：同一账号在同一网络来源下连续输错密码达到 {maxFailures} 次后，账号将临时锁定{' '}
          {Math.round(lockSeconds / 60)} 分钟，锁定期间即使输入正确密码也无法登录；不同账号、不同网络来源的失败次数分别计算。
          用户名需为 {USERNAME_MIN_LENGTH}-50 位字母、数字或下划线；密码长度为 {PASSWORD_MIN_LENGTH}-{PASSWORD_MAX_LENGTH} 位，首尾不能有空格。
        </Paragraph>

        <div style={{ textAlign: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            演示账号: demo / demo123
          </Text>
        </div>
      </Card>
    </div>
  );
};

export default Login;
