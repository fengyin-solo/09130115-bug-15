import {
  normalizeUsername,
  validateUsername,
  validatePassword,
} from './validation';
import {
  applyServerStatus,
  getLock,
  clearLock,
  setLock,
} from './loginLockStore';

describe('用户名/密码统一校验标准', () => {
  test('用户名：首尾空白被归一化去除', () => {
    expect(normalizeUsername('  alice ')).toBe('alice');
  });

  test('用户名：全角字母 NFKC 归一化', () => {
    expect(normalizeUsername('ａlice')).toBe('alice');
  });

  test('用户名：长度与字符集限制', () => {
    expect(validateUsername('ab')).not.toBeNull();
    expect(validateUsername('a'.repeat(51))).not.toBeNull();
    expect(validateUsername('bad-name')).not.toBeNull();
    expect(validateUsername('good_user_1')).toBeNull();
  });

  test('密码：长度 6-72，首尾不能有空格', () => {
    expect(validatePassword('12345')).not.toBeNull();
    expect(validatePassword('x'.repeat(73))).not.toBeNull();
    expect(validatePassword(' abcd12 ')).not.toBeNull();
    expect(validatePassword('abcd12')).toBeNull();
  });

  test('密码：控制字符非法', () => {
    expect(validatePassword('abcd12\n')).not.toBeNull();
  });
});

describe('锁定状态本地持久化', () => {
  beforeEach(() => localStorage.clear());

  test('按写入的到期时间计算剩余时间', () => {
    const t0 = 1_000_000;
    setLock('alice', 300, 5, 300, t0);
    expect(getLock('alice', t0 + 299_000)?.lockedUntil).toBe(t0 + 300_000);
    // 到期后读取自动清除
    expect(getLock('alice', t0 + 300_001)).toBeNull();
  });

  test('不同账号分别保存、互不串显', () => {
    const t0 = 2_000_000;
    setLock('alice', 300, 5, 300, t0);
    expect(getLock('bob', t0)).toBeNull();
    expect(getLock('alice', t0)).not.toBeNull();
    clearLock('alice');
    expect(getLock('alice', t0)).toBeNull();
  });

  test('服务端状态为唯一权威：说未锁定时必须清掉本地残留', () => {
    const t0 = 3_000_000;
    setLock('alice', 300, 5, 300, t0);
    const result = applyServerStatus(
      {
        username: 'alice',
        locked: false,
        remaining_seconds: 0,
        remaining_attempts: 5,
        max_failures: 5,
        lock_seconds: 300,
      },
      t0 + 1000
    );
    expect(result).toBeNull();
    expect(getLock('alice', t0 + 1000)).toBeNull();
  });

  test('服务端说锁定时以服务端 TTL 覆盖本地倒计时（纠正漂移）', () => {
    const t0 = 4_000_000;
    // 本地错误地以为还剩 200 秒
    setLock('alice', 200, 5, 300, t0);
    // 服务端权威值为 42 秒
    applyServerStatus(
      {
        username: 'alice',
        locked: true,
        remaining_seconds: 42,
        remaining_attempts: 0,
        max_failures: 5,
        lock_seconds: 300,
      },
      t0 + 1000
    );
    const lock = getLock('alice', t0 + 1000);
    expect(lock!.lockedUntil).toBe(t0 + 1000 + 42_000);
  });
});
