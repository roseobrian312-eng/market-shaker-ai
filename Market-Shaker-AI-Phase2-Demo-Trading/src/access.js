'use strict';
const crypto = require('node:crypto');
const SESSION_TTL = 8 * 60 * 60 * 1000;
function createAccess(password) {
  const sessions = new Map();
  const attempts = new Map();
  function checkPassword(candidate) {
    if (typeof password !== 'string' || password.length < 12 || typeof candidate !== 'string') return false;
    const a = crypto.createHash('sha256').update(password).digest();
    const b = crypto.createHash('sha256').update(candidate).digest();
    return crypto.timingSafeEqual(a, b);
  }
  function valid(req) {
    const cookie = req.headers.cookie || '';
    const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('ms_session='))?.slice('ms_session='.length);
    const expiry = token && sessions.get(token);
    if (!expiry) return false;
    if (expiry < Date.now()) { sessions.delete(token); return false; }
    return true;
  }
  function login(req, res, value) {
    const ip = req.socket.remoteAddress || 'local';
    const previous = attempts.get(ip) || { count: 0, until: Date.now() + 600000 };
    if (Date.now() > previous.until) { previous.count = 0; previous.until = Date.now() + 600000; }
    if (previous.count >= 5) { attempts.set(ip, previous); return false; }
    if (!checkPassword(value)) { previous.count++; attempts.set(ip, previous); return false; }
    attempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL);
    res.setHeader('Set-Cookie', `ms_session=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=28800${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`);
    return true;
  }
  function logout(req, res) {
    const cookie = req.headers.cookie || '';
    const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('ms_session='))?.slice('ms_session='.length);
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'ms_session=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0');
  }
  return { valid, login, logout, enabled: typeof password === 'string' && password.length >= 12 };
}
module.exports = { createAccess };
