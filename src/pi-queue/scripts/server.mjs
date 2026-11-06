#!/usr/bin/env node
import { execFileSync as exec } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const { QUEUE_USER_PERMISSIONS } = createRequire(import.meta.url)('../acl.js');

process.umask(0o077);
const base = join(homedir(), '.config/pi-queue');
const server = join(base, 'server');
const data = join(homedir(), '.local/state/pi-queue/redis');
const image = 'redis@sha256:0bf6577d7774e592b29d093e3ac9390eb91e13d72c21e506afce736de5e0eeb0';
const host = process.env.PI_QUEUE_HOST_IP;
if (!host) throw new Error('PI_QUEUE_HOST_IP must be set to the broker host IP');
const tlsDns = process.env.PI_QUEUE_TLS_DNS || host;
const name = 'pi-queue-redis';
const owner = 'pi-harness-request-queue';
const run = (cmd, args) => exec(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const put = (path, text) => writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
function cert(id, dir, serverCert = false) {
  run('openssl', ['req', '-new', '-newkey', 'rsa:3072', '-nodes', '-keyout', join(dir, `${id}.key`), '-out', join(dir, `${id}.csr`), '-subj', `/CN=${id}`]);
  const ext = join(dir, `${id}.ext`);
  put(ext, serverCert
    ? `subjectAltName=IP:${host},IP:127.0.0.1,DNS:${tlsDns}\nextendedKeyUsage=serverAuth\n`
    : 'extendedKeyUsage=clientAuth\n');
  run('openssl', ['x509', '-req', '-in', join(dir, `${id}.csr`), '-CA', join(base, 'ca.crt'), '-CAkey', join(base, 'ca.key'), '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-out', join(dir, `${id}.crt`), '-days', '365', '-sha256', '-extfile', ext]);
}
function issue(id) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,50}$/.test(id)) throw new Error('Use a short alphanumeric/hyphen client ID');
  const dir = join(base, 'clients', id);
  mkdirSync(join(base, 'clients'), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  cert(id, dir);
  put(join(dir, 'ca.crt'), readFileSync(join(base, 'ca.crt')));
  const password = readFileSync(join(base, 'queue-password'), 'utf8').trim();
  put(join(dir, 'connection.env'), `REDIS_HOST=${host}\nREDIS_PORT=6380\nREDIS_USERNAME=queue\nREDIS_PASSWORD=${password}\nREDIS_CA=${join(dir, 'ca.crt')}\nREDIS_CERT=${join(dir, `${id}.crt`)}\nREDIS_KEY=${join(dir, `${id}.key`)}\nQUEUE_PREFIX=piq\n`);
  console.log(`Client bundle created at ${dir}; transfer securely, then update certificate paths. Do NOT copy ca.key or server credentials.`);
}
const action = process.argv[2];
if (action === 'init') {
  mkdirSync(join(homedir(), '.config'), { recursive: true, mode: 0o700 });
  // Reserve the entire fresh configuration before OpenSSL can write any keys.
  mkdirSync(base, { mode: 0o700 });
  mkdirSync(server, { mode: 0o700 });
  mkdirSync(data, { recursive: true, mode: 0o700 });
  run('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-keyout', join(base, 'ca.key'), '-out', join(base, 'ca.crt'), '-days', '3650', '-sha256', '-subj', '/CN=Pi Queue Private CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  put(join(server, 'ca.crt'), readFileSync(join(base, 'ca.crt')));
  cert('redis', server, true);
  const queuePass = randomBytes(32).toString('hex');
  const adminPass = randomBytes(32).toString('hex');
  put(join(base, 'queue-password'), `${queuePass}\n`);
  put(join(base, 'admin-password'), `${adminPass}\n`);
  const hash = p => createHash('sha256').update(p).digest('hex');
  put(join(server, 'users.acl'), `user default off\nuser admin on #${hash(adminPass)} ~* &* +@all\nuser queue on #${hash(queuePass)} ${QUEUE_USER_PERMISSIONS}\n`);
  put(join(server, 'redis.conf'), `bind 0.0.0.0\nprotected-mode yes\nport 0\ntls-port 6380\ntls-cert-file /config/redis.crt\ntls-key-file /config/redis.key\ntls-ca-cert-file /config/ca.crt\ntls-auth-clients yes\ntls-protocols "TLSv1.2 TLSv1.3"\naclfile /config/users.acl\ndir /data\nappendonly yes\nappendfsync always\nno-appendfsync-on-rewrite no\nauto-aof-rewrite-percentage 100\nauto-aof-rewrite-min-size 64mb\naof-load-truncated yes\nsave ""\nmaxmemory 256mb\nmaxmemory-policy noeviction\nmaxclients 128\ntimeout 0\ntcp-keepalive 60\nloglevel notice\n`);
  console.log('Initialized. From pi-harness run: node src/pi-queue/scripts/server.mjs start, then issue-client ID for each machine');
} else if (action === 'issue-client') {
  issue(process.argv[3] ?? '');
} else if (action === 'start') {
  if (!existsSync(join(server, 'redis.conf'))) throw new Error('Run init first');
  let existing;
  try { existing = JSON.parse(run('docker', ['inspect', name]))[0]; }
  catch (error) { if (!/no such object/i.test(String(error.stderr))) throw error; }
  if (existing) {
    if (existing.Config.Labels?.['pi-queue.owner'] !== owner) throw new Error('Existing container is not owned by this project');
    run('docker', ['start', name]);
  } else {
    run('docker', ['run', '-d', '--name', name, '--label', `pi-queue.owner=${owner}`, '--restart', 'unless-stopped', '--user', `${process.getuid()}:${process.getgid()}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--cpus', '0.5', '--memory', '768m', '--memory-swap', '768m', '--pids-limit', '64', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '-p', '127.0.0.1:6380:6380', '-p', `${host}:6380:6380`, '--mount', `type=bind,src=${server},dst=/config,readonly`, '--mount', `type=bind,src=${data},dst=/data`, '--entrypoint', '/usr/local/bin/redis-server', image, '/config/redis.conf']);
  }
  console.log(`${name} started; TLS only at 127.0.0.1:6380 and ${host}:6380; persistent data ${data}`);
} else {
  console.error('Usage: node src/pi-queue/scripts/server.mjs init | start | issue-client CLIENT-ID');
  process.exitCode = 2;
}
