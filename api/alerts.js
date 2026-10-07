const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});
const SEV = ['attn', 'stop', 'danger'];
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function hit(key, secs) {
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, secs);
  return n;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();

    if (req.method === 'POST') {
      if ((await hit('post:' + ip, 3600)) > 30) return res.status(429).json({ error: 'slow down' });
      const b = req.body || {};
      if (!SEV.includes(b.sev)) return res.status(400).json({ error: 'bad severity' });
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const rec = {
        id, t: Date.now(), sev: b.sev,
        sym: String(b.sym || 'Other').slice(0, 60),
        who: String(b.who || 'Operator').slice(0, 40),
        note: String(b.note || '').slice(0, 300),
        status: 'open',
      };
      await redis.hset('alerts', { [id]: rec });
      return res.status(200).json({ ok: true });
    }

    const pin = process.env.MANAGER_PIN;
    if (!pin) return res.status(500).json({ error: 'MANAGER_PIN not set' });
    const failKey = 'fail:' + ip;
    if (Number((await redis.get(failKey)) || 0) >= 10) return res.status(429).json({ error: 'locked' });
    if (req.headers['x-pin'] !== pin) {
      await hit(failKey, 600);
      return res.status(401).json({ error: 'wrong pin' });
    }

    if (req.method === 'GET') {
      const all = (await redis.hgetall('alerts')) || {};
      const alerts = Object.values(all).map(parse).sort((a, b) => b.t - a.t).slice(0, 100);
      return res.status(200).json({ alerts });
    }

    if (req.method === 'PATCH') {
      const { id, action } = req.body || {};
      const cur = await redis.hget('alerts', String(id));
      if (!cur) return res.status(404).json({ error: 'not found' });
      const a = parse(cur);
      const now = Date.now();
      if (action === 'ack' && a.status === 'open') { a.status = 'ack'; a.ack = now; }
      else if (action === 'done') { a.status = 'resolved'; a.done = now; a.ack = a.ack || now; }
      await redis.hset('alerts', { [a.id]: a });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'server error' });
  }
};
