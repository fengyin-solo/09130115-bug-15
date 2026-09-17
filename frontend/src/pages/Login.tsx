import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Form, Input, Button, Card, Typography, Alert, Tabs } from 'antd';
import { UserOutlined, LockOutlined, MailOutlined } from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import {
  login,
  register,
  clearError,
  clearInfoMessage,
  refreshLoginStatus,
} from '../store/slices/authSlice';
import { RootState, AppDispatch } from '../store';
import {
  normalizeUsername,
  validateLoginUsername,
  validateLoginPassword,
  validateUsername,
  validatePassword,
} from '../services/validation';
import {
  DEFAULT_MAX_FAILURES,
  DEFAULT_LOCKOUT_SECONDS,
} from '../services/authPolicy';

const { Title, Text, Paragraph } = Typography;

/** 倒计时平滑刷新间隔（ms）；到期边界仍以服务端状态接口为准 */
const TICK_MS = 1000;
/** 锁定期间向服务端校准剩余时间的间隔（ms），防止本地计时漂移 */
const RESYNC_MS = 15000;

const Login: React.FC = () => {
  const [loginForm] = Form.useForm();
  const [registerForm] = Form.useForm();
  const [activeTab, setActiveTab] = useState<string>('login');
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const location = useLocation();

  const { loading, error, isAuthenticated, infoMessage, loginLock } = useSelector(
    (state: RootState) => state.auth
  );

  /** 页面展示的倒计时秒数（本地平滑递减，定期用服务端值校准） */
  const [countdown, setCountdown] = useState<number>(0);
  const [justUnlocked, setJustUnlocked] = useState<boolean>(false);
  /** 已向服务端查询过状态的用户名，避免重复请求 */
  const queriedRef = useRef<Set<string>>(new Set());

  const from = (location.state as any)?.from?.pathname || '/';
  const locked = !!loginLock?.locked;

  useEffect(() => {
    if (isAuthenticated) {
      navigate(from, { replace: true });
    }
  }, [isAuthenticated, navigate, from]);

  useEffect(() => {
    dispatch(clearError());
  }, [activeTab, dispatch]);

  /** 查询某用户名在当前来源下的锁定状态（进入页面/从其它入口回来时调用）。 */
  const queryStatus = useCallback(
    (rawUsername: string, { force = false }: { force?: boolean } = {}) => {
      const username = normalizeUsername(rawUsername);
      if (!username) return;
      if (!force && queriedRef.current.has(username)) return;
      queriedRef.current.add(username);
      dispatch(refreshLoginStatus({ username }));
    },
    [dispatch]
  );

  // 进入登录页时恢复同一套提示：
  // 1) 表单里已有用户名（页内切换）直接查；
  // 2) 否则取本地记住的最近尝试用户名（新标签页/被 401 踢回/直接输 URL
  //    等"其它入口"），回填后查询锁定状态。
  useEffect(() => {
    if (activeTab !== 'login') return;
    const formUsername = normalizeUsername(loginForm.getFieldValue('username') || '');
    const remembered =
      formUsername || normalizeUsername(localStorage.getItem('last_login_username') || '');
    if (remembered) {
      if (!formUsername) {
        loginForm.setFieldsValue({ username: remembered });
      }
      queriedRef.current.clear();
      queryStatus(remembered, { force: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 锁定状态变化时同步本地倒计时
  useEffect(() => {
    if (loginLock?.locked) {
      setCountdown(loginLock.secondsRemaining);
      setJustUnlocked(false);
      const username = normalizeUsername(loginForm.getFieldValue('username') || '');
      if (loginLock.username && username !== loginLock.username) {
        loginForm.setFieldsValue({ username: loginLock.username });
      }
    } else {
      setCountdown(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginLock?.locked, loginLock?.secondsRemaining, loginLock?.username]);

  // 倒计时：本地每秒递减；定期向服务端校准；到 0 时必须等服务端确认解锁
  useEffect(() => {
    if (!locked) {
      setCountdown(0);
      return;
    }
    const tickTimer = setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, TICK_MS);
    const resyncTimer = setInterval(() => {
      if (loginLock?.username) {
        queriedRef.current.clear();
        queryStatus(loginLock.username, { force: true });
      }
    }, RESYNC_MS);
    return () => {
      clearInterval(tickTimer);
      clearInterval(resyncTimer);
    };
  }, [locked, loginLock?.username, queryStatus]);

  // 本地倒计时到 0：向服务端确认。确认解锁后清掉上一次失败提示，
  // 显示一次性"已解锁"说明；若服务端仍有剩余秒数则以服务端为准。
  const lockUsername = loginLock?.username;
  useEffect(() => {
    if (!locked || countdown > 0 || !lockUsername) return;
    let cancelled = false;
    const t = setTimeout(() => {
      dispatch(refreshLoginStatus({ username: lockUsername })).then(
        (result) => {
          if (cancelled) return;
          if (refreshLoginStatus.fulfilled.match(result)) {
            if (!result.payload.locked) {
              setJustUnlocked(true);
            }
          }
        }
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [locked, countdown, lockUsername, dispatch]);

  const dismissJustUnlocked = () => {
    setJustUnlocked(false);
    dispatch(clearInfoMessage());
  };

  const handleLogin = async () => {
    // 提交前按统一标准处理格式（与后端 validate_login_credentials 同源）
    const raw = loginForm.getFieldsValue();
    const u = validateLoginUsername(raw.username);
    if (u.error || u.value === undefined) {
      loginForm.setFields([{ name: 'username', errors: [u.error!] }]);
      return;
    }
    const p = validateLoginPassword(raw.password);
    if (p.error || p.value === undefined) {
      loginForm.setFields([{ name: 'password', errors: [p.error!] }]);
      return;
    }
    // 用规范化后的值回填并提交
    loginForm.setFieldsValue({ username: u.value });
    setJustUnlocked(false);
    await dispatch(login({ username: u.value, password: p.value }));
  };

  const handleRegister = async () => {
    try {
      const values = await registerForm.validateFields();
      const u = validateUsername(values.username);
      if (u.error || u.value === undefined) return;
      const p = validatePassword(values.password);
      if (p.error || p.value === undefined) return;
      const result = await dispatch(
        register({ ...values, username: u.value, password: p.value })
      );
      if (register.fulfilled.match(result)) {
        setActiveTab('login');
        loginForm.setFieldsValue({ username: u.value });
      }
    } catch {
      // 表单校验错误由 antd 内联展示
    }
  };

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
          width: 460,
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

        {/* 锁定提示：常驻页面，随倒计时实时更新，非一闪而过的弹窗 */}
        {locked && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={
              countdown > 0
                ? `账号已临时锁定，请 ${countdown} 秒后再试`
                : '账号锁定即将解除…'
            }
            description={
              <div>
                <Paragraph style={{ margin: 0, marginBottom: 4 }}>
                  连续输错密码次数已达上限。锁定期间
                  <Text strong>即使输入正确密码也无法登录</Text>，请耐心等待倒计时结束。
                </Paragraph>
                {loginLock && loginLock.maxFailures > 0 && (
                  <Text style={{ fontSize: 12 }} type="secondary">
                    规则：同一账号在当前网络来源连续错 {loginLock.maxFailures} 次将锁定{' '}
                    {loginLock.lockoutSeconds >= 60
                      ? `${loginLock.lockoutSeconds / 60} 分钟`
                      : `${loginLock.lockoutSeconds} 秒`}
                    ；不同账号、不同网络来源分开计算。
                  </Text>
                )}
              </div>
            }
          />
        )}

        {/* 上一次失败的提示；锁定期间被锁定提示取代，解锁后立即清除不残留 */}
        {!locked && error && (
          <Alert
            message={error}
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            closable
            onClose={() => dispatch(clearError())}
          />
        )}

        {/* 服务端确认解锁后的一次性提示 */}
        {!locked && (justUnlocked || infoMessage) && (
          <Alert
            message={infoMessage || '锁定已解除，请重新输入密码登录'}
            type="success"
            showIcon
            style={{ marginBottom: 16 }}
            closable
            onClose={dismissJustUnlocked}
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
                <Form form={loginForm} onFinish={handleLogin} size="large">
                  <Form.Item
                    name="username"
                    rules={[{ required: true, message: '请输入用户名' }]}
                  >
                    <Input
                      prefix={<UserOutlined />}
                      placeholder="用户名（自动去除首尾空格）"
                      autoComplete="username"
                      disabled={locked}
                      onBlur={(e) => queryStatus(e.target.value, { force: true })}
                    />
                  </Form.Item>

                  <Form.Item
                    name="password"
                    rules={[{ required: true, message: '请输入密码' }]}
                  >
                    <Input.Password
                      prefix={<LockOutlined />}
                      placeholder="密码（保留原始输入，含空格）"
                      autoComplete="current-password"
                      disabled={locked}
                    />
                  </Form.Item>

                  <Form.Item>
                    <Button
                      type="primary"
                      htmlType="submit"
                      loading={loading}
                      block
                      disabled={locked}
                    >
                      {locked ? `已锁定（${countdown}s）` : '登录'}
                    </Button>
                  </Form.Item>
                </Form>
              ),
            },
            {
              key: 'register',
              label: '注册',
              children: (
                <Form form={registerForm} onFinish={handleRegister} size="large">
                  <Form.Item
                    name="username"
                    rules={[
                      { required: true, message: '请输入用户名' },
                      { min: 3, max: 50, message: '用户名长度为 3-50 个字符' },
                      {
                        pattern: /^[A-Za-z0-9_.-]+$/,
                        message: '只能包含字母、数字、下划线、点和连字符',
                      },
                    ]}
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
                      { min: 6, message: '密码至少 6 个字符' },
                      {
                        validator: (_, value) =>
                          !value || new TextEncoder().encode(value).length <= 72
                            ? Promise.resolve()
                            : Promise.reject(new Error('密码不能超过 72 个字节')),
                      },
                    ]}
                  >
                    <Input.Password prefix={<LockOutlined />} placeholder="密码（至少 6 位）" />
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

        {/* 判定规则常驻页面说明，不仅在弹窗里出现 */}
        <div
          style={{
            marginTop: 8,
            padding: '10px 12px',
            background: '#fafafa',
            borderRadius: 6,
            border: '1px solid #f0f0f0',
          }}
        >
          <Text style={{ fontSize: 12 }} type="secondary">
            <div style={{ fontWeight: 600, marginBottom: 2 }}>登录安全规则</div>
            同一用户名在同一网络来源连续输错 {DEFAULT_MAX_FAILURES} 次密码，账号将临时锁定{' '}
            {DEFAULT_LOCKOUT_SECONDS / 60} 分钟；锁定期间即使密码正确也无法登录，倒计时结束后自动解除并重新计数。不同账号、不同网络来源的失败次数分别计算。用户名提交时自动去除首尾空格，密码按原始输入校验。
          </Text>
        </div>

        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            演示账号: demo / demo123
          </Text>
        </div>
      </Card>
    </div>
  );
};

export default Login;
