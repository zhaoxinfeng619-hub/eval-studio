import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createAuth, SESSION_COOKIE } from '../auth.mjs';

const INITIAL='test-initial-password-123!';
const UPDATED='test-updated-password-456!';
const request=(headers={},options={})=>({headers:{host:'127.0.0.1:4189',...headers},socket:{remoteAddress:'127.0.0.1',encrypted:false,...options}});
const credentials = result => ({cookie:result.setCookie.split(';')[0],'x-csrf-token':result.body.csrfToken});
const errorCode = code => error => error.code===code;
async function fixture(options={}) {
 const dir=await mkdtemp(join(tmpdir(),'eval-auth-'));
 const auth=createAuth({dataDir:dir,initialPassword:INITIAL,...options});
 return {dir,auth,async clean(){auth.close();await rm(dir,{recursive:true,force:true});}};
}

test('管理员初始密码只保存在私有文件，数据库使用salt+scrypt且没有会话明文',async()=>{
 const {dir,auth,clean}=await fixture();
 try {
  assert.equal((await stat(dir)).mode&0o777,0o700);
  assert.equal((await stat(join(dir,'auth.sqlite'))).mode&0o777,0o600);
  assert.equal((await stat(join(dir,'initial-admin-password.txt'))).mode&0o777,0o600);
  assert.equal((await readFile(join(dir,'initial-admin-password.txt'),'utf8')).trim(),INITIAL);
  assert.deepEqual(auth.status(request()),{authenticated:false,user:null});
  assert.throws(()=>auth.requireSession(request()),errorCode('UNAUTHENTICATED'));
  const login=auth.login(request(),{username:'admin',password:INITIAL});
  assert.equal(login.body.authenticated,true);assert.deepEqual(login.body.user,{username:'admin',role:'admin',mustChangePassword:true});
  assert(login.setCookie.includes('HttpOnly'));assert(login.setCookie.includes('SameSite=Strict'));assert(login.setCookie.includes('Path=/'));assert(login.setCookie.includes('Max-Age=43200'));assert(!login.setCookie.includes('Secure'));
  assert(!JSON.stringify(login).includes(INITIAL));assert(!JSON.stringify(login).includes('password_hash'));
  const db=new DatabaseSync(join(dir,'auth.sqlite'));
  try {
   const user=db.prepare('SELECT * FROM auth_users').get();
   assert.notEqual(user.password_hash,INITIAL);assert.equal(user.password_hash.length,128);assert.equal(user.salt.length,64);
   const session=db.prepare('SELECT * FROM auth_sessions').get(),token=login.setCookie.split(';')[0].slice(SESSION_COOKIE.length+1);
   assert.equal(session.token_hash.length,64);assert(!JSON.stringify(session).includes(token));
  }finally{db.close();}
  const req=request(credentials(login));
  assert.deepEqual(auth.status(req),login.body);
  assert.throws(()=>auth.requireSession(req),errorCode('PASSWORD_CHANGE_REQUIRED'));
  assert.throws(()=>auth.requireSession(request({cookie:credentials(login).cookie}),{mutation:true,allowPasswordChange:true}),errorCode('CSRF_INVALID'));
  assert.equal(auth.requireSession(req,{mutation:true,allowPasswordChange:true}).user.username,'admin');
 }finally{await clean();}
});

test('错误账户与密码使用同一错误；限速不信任转发IP且重启后保留',async()=>{
 let time=1000;
 const {dir,auth,clean}=await fixture({now:()=>time,maxLoginAttempts:3,loginWindowMs:10000});
 let restarted;
 try {
  let wrongName,wrongPassword;
  try{auth.login(request(),{username:'nobody',password:INITIAL});}catch(error){wrongName=error;}
  try{auth.login(request(),{username:'admin',password:'incorrect'});}catch(error){wrongPassword=error;}
  assert.equal(wrongName.message,wrongPassword.message);assert.equal(wrongName.code,'INVALID_CREDENTIALS');
  assert.throws(()=>auth.login(request({'x-forwarded-for':'203.0.113.10'}),{username:'admin',password:'incorrect'}),errorCode('INVALID_CREDENTIALS'));
  assert.throws(()=>auth.login(request({'x-forwarded-for':'203.0.113.11'}),{username:'admin',password:INITIAL}),errorCode('AUTH_RATE_LIMIT'));
  auth.close();restarted=createAuth({dataDir:dir,initialPassword:'ignored-existing-password',now:()=>time,maxLoginAttempts:3,loginWindowMs:10000});
  assert.throws(()=>restarted.login(request(),{username:'admin',password:INITIAL}),errorCode('AUTH_RATE_LIMIT'));
  time+=10001;assert.equal(restarted.login(request(),{username:'admin',password:INITIAL}).body.authenticated,true);
 }finally{restarted?.close();await clean();}
});

test('强制改密验证当前密码与CSRF，撤销旧票据、旋转本会话并删除初始密码文件',async()=>{
 const {dir,auth,clean}=await fixture();
 try {
  const first=auth.login(request(),{username:'admin',password:INITIAL});
  const second=auth.login(request(),{username:'admin',password:INITIAL});
  const req=request(credentials(first));
  assert.throws(()=>auth.changePassword(request({cookie:credentials(first).cookie}),{currentPassword:INITIAL,newPassword:UPDATED}),errorCode('CSRF_INVALID'));
  assert.throws(()=>auth.changePassword(req,{currentPassword:'incorrect',newPassword:UPDATED}),errorCode('CURRENT_PASSWORD_INVALID'));
  assert.equal(auth.status(req).authenticated,true);
  for(const password of ['short',' '.repeat(12),'x'.repeat(129)])assert.throws(()=>auth.changePassword(req,{currentPassword:INITIAL,newPassword:password}),errorCode('PASSWORD_INVALID'));
  assert.throws(()=>auth.changePassword(req,{currentPassword:INITIAL,newPassword:INITIAL}),errorCode('PASSWORD_UNCHANGED'));
  const changed=auth.changePassword(req,{currentPassword:INITIAL,newPassword:UPDATED});
  assert.equal(changed.body.user.mustChangePassword,false);
  assert.notEqual(changed.setCookie,first.setCookie);assert.notEqual(changed.body.csrfToken,first.body.csrfToken);
  assert.equal(auth.status(req).authenticated,false);assert.equal(auth.status(request(credentials(second))).authenticated,false);
  const fresh=request(credentials(changed));
  assert.equal(auth.requireSession(fresh,{mutation:true}).user.role,'admin');
  assert.throws(()=>auth.requireSession(request({...credentials(changed),'x-csrf-token':first.body.csrfToken}),{mutation:true}),errorCode('CSRF_INVALID'));
  await assert.rejects(access(join(dir,'initial-admin-password.txt')));
  assert.throws(()=>auth.login(request(),{username:'admin',password:INITIAL}),errorCode('INVALID_CREDENTIALS'));
  assert.equal(auth.login(request(),{username:'admin',password:UPDATED}).body.user.mustChangePassword,false);
 }finally{await clean();}
});

test('退出清除cookie并撤销会话，改密前也能退出；跨来源变更被拒绝',async()=>{
 const {auth,clean}=await fixture();
 try {
  const result=auth.login(request(),{username:'admin',password:INITIAL}),req=request(credentials(result));
  assert.throws(()=>auth.logout(request({...credentials(result),origin:'https://untrusted.example'})),errorCode('ORIGIN_INVALID'));
  assert.throws(()=>auth.login(request({origin:'https://untrusted.example'}),{username:'admin',password:INITIAL}),errorCode('ORIGIN_INVALID'));
  assert.throws(()=>auth.logout(request({cookie:credentials(result).cookie})),errorCode('CSRF_INVALID'));
  const out=auth.logout(req);assert.deepEqual(out.body,{authenticated:false,user:null});assert(out.setCookie.includes('Max-Age=0'));
  assert.equal(auth.status(req).authenticated,false);assert.throws(()=>auth.requireSession(req),errorCode('UNAUTHENTICATED'));
  assert.deepEqual(auth.logout(req).body,{authenticated:false,user:null});
  const https=auth.login(request({}, {encrypted:true}),{username:'admin',password:INITIAL});assert(https.setCookie.endsWith('; Secure'));
  const spoofed=auth.login(request({'x-forwarded-proto':'https'}),{username:'admin',password:INITIAL});assert(!spoofed.setCookie.includes('Secure'));
 }finally{await clean();}
});

test('密码与session跨重启持久，12小时到期后票据失效',async()=>{
 let time=1_800_000_000_000;
 const {dir,auth,clean}=await fixture({now:()=>time});let restarted;
 try {
  const login=auth.login(request(),{username:'admin',password:INITIAL});
  const changed=auth.changePassword(request(credentials(login)),{currentPassword:INITIAL,newPassword:UPDATED});
  const req=request(credentials(changed));auth.close();
  restarted=createAuth({dataDir:dir,initialPassword:'ignored-existing-password',now:()=>time});
  assert.deepEqual(restarted.status(req),changed.body);assert.equal(restarted.requireSession(req).user.role,'admin');
  time+=12*60*60*1000;assert.deepEqual(restarted.status(req),{authenticated:false,user:null});
  assert.throws(()=>restarted.requireSession(req),errorCode('UNAUTHENTICATED'));
  assert.equal(restarted.login(request(),{username:'admin',password:UPDATED}).body.user.mustChangePassword,false);
 }finally{restarted?.close();await clean();}
});

test('未提供环境初始密码时生成不同的随机密码；初始密码不满足长度时拒绝建号',async()=>{
 const previous=process.env.EVAL_ADMIN_PASSWORD;delete process.env.EVAL_ADMIN_PASSWORD;
 const a=await mkdtemp(join(tmpdir(),'eval-auth-random-')),b=await mkdtemp(join(tmpdir(),'eval-auth-random-'));let first,second;
 try {
  assert.throws(()=>createAuth({dataDir:a,initialPassword:'too-short'}),errorCode('PASSWORD_INVALID'));
  first=createAuth({dataDir:a});second=createAuth({dataDir:b});
  const one=(await readFile(join(a,'initial-admin-password.txt'),'utf8')).trim(),two=(await readFile(join(b,'initial-admin-password.txt'),'utf8')).trim();
  assert.equal(one.length,43);assert.equal(two.length,43);assert.notEqual(one,two);
  assert.equal(first.login(request(),{username:'admin',password:one}).body.authenticated,true);
 }finally{first?.close();second?.close();if(previous===undefined)delete process.env.EVAL_ADMIN_PASSWORD;else process.env.EVAL_ADMIN_PASSWORD=previous;await rm(a,{recursive:true,force:true});await rm(b,{recursive:true,force:true});}
});
