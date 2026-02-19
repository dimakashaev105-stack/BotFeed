import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import pg from 'pg'
import crypto from 'crypto'

const { Pool } = pg
const app = Fastify({ logger: false })
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

db.query('SELECT 1').then(() => console.log('✅ База данных подключена')).catch(e => console.error('❌ БД:', e.message))

await app.register(cors, { origin: process.env.FRONTEND_URL || '*', credentials: true })
await app.register(jwt, { secret: process.env.JWT_SECRET || 'dev_secret_32_chars_minimum_here' })

// ── Middleware ──
async function auth(req, reply) {
  try { await req.jwtVerify() } catch { reply.code(401).send({ error: 'Нужна авторизация' }) }
}
async function optAuth(req) {
  try { await req.jwtVerify() } catch { req.user = null }
}

// ════════════════════════════════
// AUTH
// ════════════════════════════════

// Войти через Telegram
app.post('/api/auth/telegram', async (req, reply) => {
  const { id, first_name, last_name, username, photo_url, hash, auth_date } = req.body

  // Проверяем подпись Telegram
  const secret = crypto.createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN).digest()
  const str = Object.entries({ id, first_name, last_name, username, photo_url, auth_date })
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${v}`)
    .sort().join('\n')
  const hmac = crypto.createHmac('sha256', secret).update(str).digest('hex')

  if (hmac !== hash) return reply.code(401).send({ error: 'Неверная подпись' })
  if (Date.now() / 1000 - auth_date > 3600) return reply.code(401).send({ error: 'Данные устарели' })

  const { rows } = await db.query(`
    INSERT INTO users (telegram_id, username, first_name, last_name, photo_url)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (telegram_id) DO UPDATE SET
      username=EXCLUDED.username, first_name=EXCLUDED.first_name,
      last_name=EXCLUDED.last_name, photo_url=EXCLUDED.photo_url
    RETURNING *
  `, [id, username, first_name, last_name, photo_url])

  const user = rows[0]
  const token = app.jwt.sign({ id: user.id, telegram_id: user.telegram_id }, { expiresIn: '30d' })
  return { token, user: { id: user.id, first_name: user.first_name, username: user.username, photo_url: user.photo_url } }
})

// Текущий пользователь
app.get('/api/auth/me', { preHandler: auth }, async (req) => {
  const { rows } = await db.query('SELECT id,first_name,last_name,username,photo_url FROM users WHERE id=$1', [req.user.id])
  return rows[0]
})

// ════════════════════════════════
// БОТЫ
// ════════════════════════════════

// Каталог ботов
app.get('/api/bots', async (req) => {
  const { q, category, limit = 20, offset = 0 } = req.query
  let where = ['b.verified = true'], params = [], i = 1

  if (q) { where.push(`(b.name ILIKE $${i} OR b.description ILIKE $${i})`); params.push(`%${q}%`); i++ }
  if (category && category !== 'all') { where.push(`$${i} = ANY(b.categories)`); params.push(category); i++ }
  params.push(Number(limit), Number(offset))

  const { rows } = await db.query(`
    SELECT b.id,b.username,b.name,b.description,b.photo_url,b.members,b.categories,b.verified,b.created_at,
      u.first_name as owner_name,
      COUNT(DISTINCT s.id) as subscribers,
      COUNT(DISTINCT p.id) as posts_count
    FROM bots b
    JOIN users u ON b.owner_id=u.id
    LEFT JOIN subscriptions s ON b.id=s.bot_id
    LEFT JOIN posts p ON b.id=p.bot_id
    WHERE ${where.join(' AND ')}
    GROUP BY b.id,u.first_name
    ORDER BY b.members DESC
    LIMIT $${i} OFFSET $${i+1}
  `, params)
  return rows
})

// Страничка бота
app.get('/api/bots/:username', { preHandler: optAuth }, async (req, reply) => {
  const uid = req.user?.id
  const { rows } = await db.query(`
    SELECT b.*,u.first_name as owner_name,u.username as owner_username,
      COUNT(DISTINCT s.id) as subscribers,
      COUNT(DISTINCT p.id) as posts_count,
      ${uid ? `EXISTS(SELECT 1 FROM subscriptions WHERE user_id=$2 AND bot_id=b.id)` : 'false'} as is_subscribed
    FROM bots b
    JOIN users u ON b.owner_id=u.id
    LEFT JOIN subscriptions s ON b.id=s.bot_id
    LEFT JOIN posts p ON b.id=p.bot_id
    WHERE b.username=$1 AND b.verified=true
    GROUP BY b.id,u.first_name,u.username
  `, uid ? [req.params.username, uid] : [req.params.username])
  if (!rows[0]) return reply.code(404).send({ error: 'Бот не найден' })
  return rows[0]
})

// Мои боты
app.get('/api/my/bots', { preHandler: auth }, async (req) => {
  const { rows } = await db.query(`
    SELECT b.*,COUNT(DISTINCT s.id) as subscribers,COUNT(DISTINCT p.id) as posts_count
    FROM bots b
    LEFT JOIN subscriptions s ON b.id=s.bot_id
    LEFT JOIN posts p ON b.id=p.bot_id
    WHERE b.owner_id=$1 GROUP BY b.id ORDER BY b.created_at DESC
  `, [req.user.id])
  return rows
})

// Добавить бота
app.post('/api/bots', { preHandler: auth }, async (req, reply) => {
  const { username, name, description, long_desc, categories } = req.body
  if (!username || !name) return reply.code(400).send({ error: 'Username и имя обязательны' })
  const clean = username.replace('@', '').toLowerCase()
  const { rows } = await db.query(`
    INSERT INTO bots (owner_id,username,name,description,long_desc,categories)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
  `, [req.user.id, clean, name, description, long_desc, categories || []])
  return rows[0]
})

// Обновить бота
app.put('/api/bots/:id', { preHandler: auth }, async (req, reply) => {
  const { name, description, long_desc, categories } = req.body
  const { rows } = await db.query(`
    UPDATE bots SET name=$1,description=$2,long_desc=$3,categories=$4
    WHERE id=$5 AND owner_id=$6 RETURNING *
  `, [name, description, long_desc, categories, req.params.id, req.user.id])
  if (!rows[0]) return reply.code(404).send({ error: 'Бот не найден' })
  return rows[0]
})

// Запросить код верификации
app.post('/api/bots/:id/verify/request', { preHandler: auth }, async (req, reply) => {
  const { rows } = await db.query('SELECT * FROM bots WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id])
  if (!rows[0]) return reply.code(404).send({ error: 'Бот не найден' })
  if (rows[0].verified) return reply.code(400).send({ error: 'Уже верифицирован' })

  const code = Math.random().toString(36).substring(2, 8).toUpperCase()
  const exp = new Date(Date.now() + 10 * 60 * 1000)
  await db.query('UPDATE bots SET verify_code=$1,verify_exp=$2 WHERE id=$3', [code, exp, req.params.id])

  // Отправляем в Telegram
  try {
    const msg = `🔐 Код верификации для @${rows[0].username}:\n\n<b>${code}</b>\n\nДействителен 10 минут.`
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: req.user.telegram_id, text: msg, parse_mode: 'HTML' })
    })
    return { ok: true, message: 'Код отправлен в Telegram' }
  } catch {
    return { ok: true, code, message: 'Введи код вручную' }
  }
})

// Подтвердить код верификации
app.post('/api/bots/:id/verify/confirm', { preHandler: auth }, async (req, reply) => {
  const { rows } = await db.query('SELECT * FROM bots WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id])
  if (!rows[0]) return reply.code(404).send({ error: 'Бот не найден' })

  const bot = rows[0]
  if (bot.verify_code !== req.body.code?.toUpperCase()) return reply.code(400).send({ error: 'Неверный код' })
  if (new Date() > new Date(bot.verify_exp)) return reply.code(400).send({ error: 'Код устарел' })

  await db.query('UPDATE bots SET verified=true,verify_code=NULL,verify_exp=NULL WHERE id=$1', [req.params.id])
  return { ok: true, message: 'Бот верифицирован! ✅' }
})

// График участников
app.get('/api/bots/:id/members-history', async (req) => {
  const { rows } = await db.query(
    'SELECT members,recorded_at FROM members_history WHERE bot_id=$1 ORDER BY recorded_at ASC LIMIT 30',
    [req.params.id]
  )
  return rows
})

// ════════════════════════════════
// ПОСТЫ
// ════════════════════════════════

// Главная лента (для подписчиков)
app.get('/api/feed', { preHandler: auth }, async (req) => {
  const { limit = 20, offset = 0 } = req.query
  const { rows } = await db.query(`
    SELECT p.*,
      b.name as bot_name,b.username as bot_username,b.photo_url as bot_photo,b.verified as bot_verified,
      COALESCE(json_agg(DISTINCT jsonb_build_object('emoji',r.emoji,'count',r.cnt)) FILTER (WHERE r.emoji IS NOT NULL),'[]') as reactions,
      COUNT(DISTINCT c.id) as comments_count,
      array_remove(array_agg(DISTINCT ur.emoji),'') FILTER (WHERE ur.user_id=$1) as my_reactions
    FROM posts p
    JOIN bots b ON p.bot_id=b.id
    JOIN subscriptions s ON b.id=s.bot_id AND s.user_id=$1
    LEFT JOIN (SELECT post_id,emoji,COUNT(*) as cnt FROM reactions GROUP BY post_id,emoji) r ON p.id=r.post_id
    LEFT JOIN reactions ur ON p.id=ur.post_id AND ur.user_id=$1
    LEFT JOIN comments c ON p.id=c.post_id
    GROUP BY p.id,b.name,b.username,b.photo_url,b.verified
    ORDER BY p.created_at DESC LIMIT $2 OFFSET $3
  `, [req.user.id, Number(limit), Number(offset)])
  return rows
})

// Публичная лента (для всех)
app.get('/api/feed/discover', async (req) => {
  const { limit = 20, offset = 0 } = req.query
  const { rows } = await db.query(`
    SELECT p.*,
      b.name as bot_name,b.username as bot_username,b.photo_url as bot_photo,b.verified as bot_verified,
      COALESCE(json_agg(DISTINCT jsonb_build_object('emoji',r.emoji,'count',r.cnt)) FILTER (WHERE r.emoji IS NOT NULL),'[]') as reactions,
      COUNT(DISTINCT c.id) as comments_count
    FROM posts p
    JOIN bots b ON p.bot_id=b.id AND b.verified=true
    LEFT JOIN (SELECT post_id,emoji,COUNT(*) as cnt FROM reactions GROUP BY post_id,emoji) r ON p.id=r.post_id
    LEFT JOIN comments c ON p.id=c.post_id
    GROUP BY p.id,b.name,b.username,b.photo_url,b.verified
    ORDER BY p.created_at DESC LIMIT $1 OFFSET $2
  `, [Number(limit), Number(offset)])
  return rows
})

// Посты конкретного бота
app.get('/api/bots/:botId/posts', { preHandler: optAuth }, async (req) => {
  const uid = req.user?.id
  const { limit = 20, offset = 0 } = req.query
  const { rows } = await db.query(`
    SELECT p.*,
      COALESCE(json_agg(DISTINCT jsonb_build_object('emoji',r.emoji,'count',r.cnt)) FILTER (WHERE r.emoji IS NOT NULL),'[]') as reactions,
      COUNT(DISTINCT c.id) as comments_count,
      ${uid ? `array_remove(array_agg(DISTINCT ur.emoji) FILTER (WHERE ur.user_id=${uid}),'')` : 'ARRAY[]::text[]'} as my_reactions
    FROM posts p
    LEFT JOIN (SELECT post_id,emoji,COUNT(*) as cnt FROM reactions GROUP BY post_id,emoji) r ON p.id=r.post_id
    LEFT JOIN reactions ur ON p.id=ur.post_id
    LEFT JOIN comments c ON p.id=c.post_id
    WHERE p.bot_id=$1
    GROUP BY p.id ORDER BY p.created_at DESC LIMIT $2 OFFSET $3
  `, [req.params.botId, Number(limit), Number(offset)])
  return rows
})

// Создать пост (только владелец)
app.post('/api/bots/:botId/posts', { preHandler: auth }, async (req, reply) => {
  const { text, image_url } = req.body
  if (!text?.trim()) return reply.code(400).send({ error: 'Текст обязателен' })

  const { rows: b } = await db.query('SELECT id FROM bots WHERE id=$1 AND owner_id=$2', [req.params.botId, req.user.id])
  if (!b[0]) return reply.code(403).send({ error: 'Нет доступа' })

  const { rows } = await db.query('INSERT INTO posts (bot_id,text,image_url) VALUES ($1,$2,$3) RETURNING *',
    [req.params.botId, text.trim(), image_url || null])
  return rows[0]
})

// Удалить пост
app.delete('/api/posts/:id', { preHandler: auth }, async (req, reply) => {
  const { rows } = await db.query(`
    DELETE FROM posts p USING bots b
    WHERE p.id=$1 AND p.bot_id=b.id AND b.owner_id=$2 RETURNING p.id
  `, [req.params.id, req.user.id])
  if (!rows[0]) return reply.code(404).send({ error: 'Пост не найден' })
  return { ok: true }
})

// Реакция на пост (toggle)
app.post('/api/posts/:id/react', { preHandler: auth }, async (req, reply) => {
  const { emoji } = req.body
  if (!['🔥','👍','❤️','😂','👏','🎉'].includes(emoji)) return reply.code(400).send({ error: 'Неверный эмодзи' })

  const { rows } = await db.query('SELECT id FROM reactions WHERE post_id=$1 AND user_id=$2 AND emoji=$3',
    [req.params.id, req.user.id, emoji])

  if (rows[0]) {
    await db.query('DELETE FROM reactions WHERE id=$1', [rows[0].id])
    return { action: 'removed' }
  } else {
    await db.query('INSERT INTO reactions (post_id,user_id,emoji) VALUES ($1,$2,$3)', [req.params.id, req.user.id, emoji])
    return { action: 'added' }
  }
})

// Комментарии
app.get('/api/posts/:id/comments', async (req) => {
  const { rows } = await db.query(`
    SELECT c.*,u.first_name,u.username,u.photo_url
    FROM comments c JOIN users u ON c.user_id=u.id
    WHERE c.post_id=$1 ORDER BY c.created_at ASC
  `, [req.params.id])
  return rows
})

app.post('/api/posts/:id/comments', { preHandler: auth }, async (req, reply) => {
  if (!req.body.text?.trim()) return reply.code(400).send({ error: 'Комментарий пустой' })
  const { rows } = await db.query('INSERT INTO comments (post_id,user_id,text) VALUES ($1,$2,$3) RETURNING *',
    [req.params.id, req.user.id, req.body.text.trim()])
  return rows[0]
})

// ════════════════════════════════
// ПОДПИСКИ
// ════════════════════════════════

// Подписаться / отписаться
app.post('/api/bots/:botId/subscribe', { preHandler: auth }, async (req) => {
  const { rows } = await db.query('SELECT id FROM subscriptions WHERE user_id=$1 AND bot_id=$2',
    [req.user.id, req.params.botId])

  if (rows[0]) {
    await db.query('DELETE FROM subscriptions WHERE id=$1', [rows[0].id])
    return { subscribed: false }
  } else {
    await db.query('INSERT INTO subscriptions (user_id,bot_id) VALUES ($1,$2)', [req.user.id, req.params.botId])
    return { subscribed: true }
  }
})

// Мои подписки
app.get('/api/my/subscriptions', { preHandler: auth }, async (req) => {
  const { rows } = await db.query(`
    SELECT b.id,b.username,b.name,b.photo_url,b.members,b.verified,s.created_at as subscribed_at
    FROM subscriptions s JOIN bots b ON s.bot_id=b.id
    WHERE s.user_id=$1 ORDER BY s.created_at DESC
  `, [req.user.id])
  return rows
})

// Health check
app.get('/health', () => ({ status: 'ok', time: new Date().toISOString() }))

// Запуск
try {
  await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' })
  console.log(`🚀 BotFeed запущен на порту ${process.env.PORT || 3000}`)
} catch (err) {
  console.error(err)
  process.exit(1)
}
