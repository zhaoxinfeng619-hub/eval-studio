import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'eval_session';
const SESSION_DURATION = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW = 10 * 60 * 1000;
const SCRYPT_OPTIONS = { N:16384, r:8, p:1, maxmem:64 * 1024 * 1024 };
const deny = (message, status = 401, code = 'UNAUTHENTICATED') => {
  const error = new Error(message);error.status = status;error.code = code;throw error;
};
const digest = value => createHash('sha256').update(value).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');
const passwordHash = (password, salt) => scryptSync(password, salt, 64, SCRYPT_OPTIONS);
const validPassword = password => typeof password === 'string' && password.length >= 12 && password.length <= 128 && password.trim().length > 0;
const sameText = (a,b) => {
  if(typeof a !== 'string' || typeof b !== 'string')return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left,right);
};
const safeUser = user => ({username:user.username,role:'admin',mustChangePassword:Boolean(user.must_change_password)});
const anonymous = () => ({authenticated:false,user:null});

/** Local administrator authentication; it never reads the evaluation state database. */
export function createAuth({dataDir,initialPassword = process.env.EVAL_ADMIN_PASSWORD,now = () => Date.now(),sessionTtlMs = SESSION_DURATION,maxLoginAttempts = 5,loginWindowMs = LOGIN_WINDOW} = {}) {
  if(!dataDir)throw new Error('认证模块缺少数据目录。');
  if(!Number.isFinite(sessionTtlMs)||sessionTtlMs<=0||!Number.isInteger(maxLoginAttempts)||maxLoginAttempts<1||!Number.isFinite(loginWindowMs)||loginWindowMs<=0)throw new Error('认证模块配置无效。');
  mkdirSync(dataDir,{recursive:true,mode:0o700});chmodSync(dataDir,0o700);
  const databasePath = join(dataDir,'auth.sqlite'), initialFile = join(dataDir,'initial-admin-password.txt');
  const fd = openSync(databasePath,'a',0o600);closeSync(fd);chmodSync(databasePath,0o600);
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS auth_users (
        username TEXT PRIMARY KEY CHECK(username='admin'),
        password_hash TEXT NOT NULL, salt TEXT NOT NULL,
        must_change_password INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, password_changed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES auth_users(username),
        csrf_token TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, window_started INTEGER NOT NULL,
        blocked_until INTEGER NOT NULL DEFAULT 0
      );`);
    db.exec('BEGIN IMMEDIATE');
    try {
    if(!db.prepare('SELECT username FROM auth_users WHERE username=?').get('admin')) {
      const password = initialPassword === undefined ? randomToken() : initialPassword;
      if(!validPassword(password))deny('初始管理员密码须为12–128个字符，且不能全为空白。',400,'PASSWORD_INVALID');
      const salt = randomBytes(32).toString('hex');
      // Make the credential recoverable before committing the account, without logging it.
      writeFileSync(initialFile,password+'\n',{mode:0o600});chmodSync(initialFile,0o600);
      db.prepare('INSERT INTO auth_users(username,password_hash,salt,must_change_password,created_at) VALUES(?,?,?,?,?)')
        .run('admin',passwordHash(password,salt).toString('hex'),salt,1,now());
    } else {
      const user = db.prepare('SELECT must_change_password FROM auth_users WHERE username=?').get('admin');
      if(!user.must_change_password && existsSync(initialFile))unlinkSync(initialFile);
    }
    db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK');throw error; }
  } catch(error) { db.close();throw error; }

  const secure = req => req?.socket?.encrypted === true;
  function checkOrigin(req) {
    const origin = req?.headers?.origin;
    if(origin && origin !== `${secure(req)?'https':'http'}://${req.headers.host||''}`)deny('请求来源不匹配。',403,'ORIGIN_INVALID');
  }
  function cookie(token,req,expiresAt) {
    const expires = token ? expiresAt : 0;
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token?Math.floor(sessionTtlMs/1000):0}; Expires=${new Date(expires).toUTCString()}${secure(req)?'; Secure':''}`;
  }
  function cookieToken(req) {
    const header = req?.headers?.cookie;
    if(typeof header !== 'string'||header.length>8192)return null;
    const found = header.split(';').map(item=>item.trim()).filter(item=>item.startsWith(SESSION_COOKIE+'='));
    if(found.length !== 1)return null;
    const token = found[0].slice(SESSION_COOKIE.length+1);
    return /^[A-Za-z0-9_-]{43}$/.test(token)?token:null;
  }
  function lookup(req) {
    const token = cookieToken(req);if(!token)return null;
    const session = db.prepare(`SELECT s.token_hash,s.csrf_token,s.expires_at,u.username,u.must_change_password
      FROM auth_sessions s JOIN auth_users u ON u.username=s.username WHERE s.token_hash=?`).get(digest(token));
    if(!session)return null;
    if(session.expires_at<=now()){db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(session.token_hash);return null;}
    return session;
  }
  function sessionBody(session) {
    return {authenticated:true,user:safeUser(session),csrfToken:session.csrf_token};
  }
  function requireRecord(req,{mutation=false,allowPasswordChange=false}={}) {
    const session=lookup(req);if(!session)deny('请先登录。');
    if(mutation){checkOrigin(req);if(!sameText(req?.headers?.['x-csrf-token'],session.csrf_token))deny('操作校验已失效，请刷新页面后重试。',403,'CSRF_INVALID');}
    if(session.must_change_password&&!allowPasswordChange)deny('请先修改初始管理员密码。',403,'PASSWORD_CHANGE_REQUIRED');
    return session;
  }
  function issueSession(req,user) {
    const token=randomToken(),csrfToken=randomToken(),createdAt=now(),expiresAt=createdAt+sessionTtlMs;
    db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(createdAt);
    db.prepare('INSERT INTO auth_sessions(token_hash,username,csrf_token,created_at,expires_at) VALUES(?,?,?,?,?)')
      .run(digest(token),user.username,csrfToken,createdAt,expiresAt);
    return {body:{authenticated:true,user:safeUser(user),csrfToken},setCookie:cookie(token,req,expiresAt)};
  }
  function rateKey(req,purpose='login') {
    // Forwarded headers are never trusted as the client address.
    return purpose+':'+digest(String(req?.socket?.remoteAddress||'local'));
  }
  function rateCheck(key) {
    const limit=db.prepare('SELECT attempts,window_started,blocked_until FROM auth_rate_limits WHERE bucket=?').get(key);
    if(limit?.blocked_until>now()){
      const error=new Error('尝试次数过多，请稍后再试。');error.status=429;error.code='AUTH_RATE_LIMIT';
      error.retryAfterSeconds=Math.max(1,Math.ceil((limit.blocked_until-now())/1000));throw error;
    }
    if(limit&&now()-limit.window_started>=loginWindowMs)db.prepare('DELETE FROM auth_rate_limits WHERE bucket=?').run(key);
  }
  function rateFailure(key) {
    const time=now(),old=db.prepare('SELECT attempts,window_started FROM auth_rate_limits WHERE bucket=?').get(key);
    const fresh=!old||time-old.window_started>=loginWindowMs,attempts=(fresh?0:old.attempts)+1,started=fresh?time:old.window_started;
    db.prepare(`INSERT INTO auth_rate_limits(bucket,attempts,window_started,blocked_until) VALUES(?,?,?,?)
      ON CONFLICT(bucket) DO UPDATE SET attempts=excluded.attempts,window_started=excluded.window_started,blocked_until=excluded.blocked_until`)
      .run(key,attempts,started,attempts>=maxLoginAttempts?time+loginWindowMs:0);
  }
  function verify(password,user) {
    const acceptable=typeof password==='string'&&password.length<=128;
    const calculated=passwordHash(acceptable?password:'invalid-credential-placeholder',user.salt);
    const expected=Buffer.from(user.password_hash,'hex');
    return acceptable&&expected.length===calculated.length&&timingSafeEqual(expected,calculated);
  }
  let closed=false;
  return {
    status(req) { const session=lookup(req);return session?sessionBody(session):anonymous(); },
    requireSession(req,options) { const session=requireRecord(req,options);return {user:safeUser(session),csrfToken:session.csrf_token}; },
    login(req,{username,password}={}) {
      checkOrigin(req);const key=rateKey(req);rateCheck(key);
      const user=db.prepare('SELECT * FROM auth_users WHERE username=?').get('admin');
      const matched=verify(password,user);
      if(typeof username!=='string'||username.trim()!=='admin'||!matched){rateFailure(key);deny('用户名或密码错误。',401,'INVALID_CREDENTIALS');}
      db.prepare('DELETE FROM auth_rate_limits WHERE bucket=?').run(key);
      const old=lookup(req);if(old)db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(old.token_hash);
      return issueSession(req,user);
    },
    logout(req) {
      const session=lookup(req);
      if(session){requireRecord(req,{mutation:true,allowPasswordChange:true});db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(session.token_hash);}
      else checkOrigin(req);
      return {body:anonymous(),setCookie:cookie('',req,0)};
    },
    changePassword(req,{currentPassword,newPassword}={}) {
      const session=requireRecord(req,{mutation:true,allowPasswordChange:true}),key=rateKey(req,'password');rateCheck(key);
      const user=db.prepare('SELECT * FROM auth_users WHERE username=?').get(session.username);
      if(!verify(currentPassword,user)){rateFailure(key);deny('当前密码错误。',401,'CURRENT_PASSWORD_INVALID');}
      if(!validPassword(newPassword))deny('新密码须为12–128个字符，且不能全为空白。',400,'PASSWORD_INVALID');
      if(sameText(currentPassword,newPassword))deny('新密码不能与当前密码相同。',400,'PASSWORD_UNCHANGED');
      const salt=randomBytes(32).toString('hex'),hash=passwordHash(newPassword,salt).toString('hex');
      let result;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE auth_users SET password_hash=?,salt=?,must_change_password=0,password_changed_at=? WHERE username=?').run(hash,salt,now(),user.username);
        db.prepare('DELETE FROM auth_sessions WHERE username=?').run(user.username);
        db.prepare('DELETE FROM auth_rate_limits WHERE bucket IN (?,?)').run(key,rateKey(req));
        result=issueSession(req,{...user,must_change_password:0});db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      if(existsSync(initialFile))unlinkSync(initialFile);
      return result;
    },
    close() { if(!closed){db.close();closed=true;} }
  };
}
