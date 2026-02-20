import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import pg from 'pg'
import crypto from 'crypto'

const { Pool } = pg
const app = Fastify({ logger: true })
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

db.query('SELECT 1').then(() => console.log('✅ БД подключена')).catch(e => console.error('❌ БД:', e.message))

// CORS — открытый для всех
await app.register(cors, {
  origin: true,
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
})

await app.register(jwt, {
  secret: process.env.JWT_SECRET || 'botfeed_secret_key_32_chars_min!'
})

// ── Middleware ──
async function auth(req, reply) {
  try { await req.jwtVerify() }
  catch { reply.code(401).send({ error: 'Нужна авторизация' }) }
}
async function optAuth(req) {
  try { await req.jwtVerify() } catch { req.user = null }
}

// ════════════════════════════════
// AUTH
// ════════════════════════════════
app.post('/api/auth/telegram', async (req, reply) => {
  try {
    const { id, first_name, last_name, username, photo_url } = req.body
    console.log('Auth attempt for:', first_name, id)

    if (!id || !first_name) {
      return reply.code(400).send({ error: 'Нет данных от Telegram' })
    }

    const { rows } = await db.query(`
      INSERT INTO users (telegram_id, username, first_name, last_name, photo_url)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (telegram_id) DO UPDATE SET
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        photo_url = EXCLUDED.photo_url
      RETURNING *
    `, [id, username || null, first_name, last_name || null, photo_url || null])

    const user = rows[0]
    const token = app.jwt.sign(
      { id: user.id, telegram_id: user.telegram_id },
      { expiresIn: '30d' }
    )

    console.log('Auth success:', user.first_name)
    return {
      token,
      user: {
        id: user.id,
        first_name: user.first_name,
        username: user.username,
        photo_url: user.photo_url
      }
    }
  } catch (e) {
    console.error('Auth error:', e.message)
    return reply.code(500).send({ error: 'Ошибка сервера: ' + e.message })
  }
})

app.get('/api/auth/me', { preHandler: auth }, async (req) => {
  const { rows } = await db.query(
    'SELECT id, first_name, last_name, username, photo_url FROM users WHERE id = $1',
    [req.user.id]
  )
  return rows[0] || null
})

// ════════════════════════════════
// БОТЫ
// ════════════════════════════════
app.get('/api/bots', async (req) => {
  try {
    const { q, category, limit = 20, offset = 0 } = req.query
    let where = ['b.verified = true']
    let params = []
    let i = 1

    if (q) {
      where.push(`(b.name ILIKE $${i} OR b.description ILIKE $${i})`)
      params.push(`%${q}%`)
      i++
    }
    if (category && category !== 'all') {
      where.push(`$${i} = ANY(b.categories)`)
      params.push(category)
      i++
    }
    params.push(Number(limit), Number(offset))

    const { rows } = await db.query(`
      SELECT b.id, b.username, b.name, b.description, b.photo_url,
             b.members, b.categories, b.verified, b.created_at,
             u.first_name as owner_name,
             COUNT(DISTINCT s.id) as subscribers,
             COUNT(DISTINCT p.id) as posts_count
      FROM bots b
      JOIN users u ON b.owner_id = u.id
      LEFT JOIN subscriptions s ON b.id = s.bot_id
      LEFT JOIN posts p ON b.id = p.bot_id
      WHERE ${where.join(' AND ')}
      GROUP BY b.id, u.first_name
      ORDER BY b.members DESC
      LIMIT $${i} OFFSET $${i + 1}
    `, params)
    return rows
  } catch (e) {
    console.error('GET /bots error:', e.message)
    return []
  }
})

app.get('/api/my/bots', { preHandler: auth }, async (req) => {
  const { rows } = await db.query(`
    SELECT b.*, COUNT(DISTINCT s.id) as subscribers, COUNT(DISTINCT p.id) as posts_count
    FROM bots b
    LEFT JOIN subscriptions s ON b.id = s.bot_id
    LEFT JOIN posts p ON b.id = p.bot_id
    WHERE b.owner_id = $1
    GROUP BY b.id
    ORDER BY b.created_at DESC
  `, [req.user.id])
  return rows
})

app.post('/api/bots', { preHandler: auth }, async (req, reply) => {
  try {
    const { username, name, description, long_desc, categories } = req.body
    if (!username || !name) return reply.code(400).send({ error: 'Username и имя обязательны' })
    const clean = username.replace('@', '').toLowerCase()

    // Лимит: 1 бот на пользователя
    const { rows: existing } = await db.query(
      'SELECT id FROM bots WHERE owner_id = $1',
      [req.user.id]
    )
    if (existing.length >= 1) {
      return reply.code(400).send({ error: 'У вас уже есть бот. Удалите его, чтобы добавить новый.' })
    }

    const { rows } = await db.query(`
      INSERT INTO bots (owner_id, username, name, description, long_desc, categories)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [req.user.id, clean, name, description || '', long_desc || '', categories || []])

    return rows[0]
  } catch (e) {
    if (e.message.includes('unique')) {
      return reply.code(400).send({ error: 'Бот с таким username уже существует' })
    }
    return reply.code(500).send({ error: e.message })
  }
})

app.put('/api/bots/:id', { preHandler: auth }, async (req, reply) => {
  const { name, description, long_desc, categories } = req.body
  const { rows } = await db.query(`
    UPDATE bots SET name=$1, description=$2, long_desc=$3, categories=$4
    WHERE id=$5 AND owner_id=$6
    RETURNING *
  `, [name, description, long_desc, categories || [], req.params.id, req.user.id])
  if (!rows[0]) return reply.code(404).send({ error: 'Бот не найден' })
  return rows[0]
})

// Удалить бота
app.delete('/api/bots/:id', { preHandler: auth }, async (req, reply) => {
  try {
    const { rows } = await db.query(
      'SELECT id FROM bots WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'Бот не найден или нет доступа' })

    // Каскадное удаление: реакции → комментарии → посты → подписки → бот
    await db.query('DELETE FROM reactions WHERE post_id IN (SELECT id FROM posts WHERE bot_id = $1)', [req.params.id])
    await db.query('DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE bot_id = $1)', [req.params.id])
    await db.query('DELETE FROM posts WHERE bot_id = $1', [req.params.id])
    await db.query('DELETE FROM subscriptions WHERE bot_id = $1', [req.params.id])
    await db.query('DELETE FROM bots WHERE id = $1', [req.params.id])

    return { ok: true, message: 'Бот удалён' }
  } catch (e) {
    console.error('Delete bot error:', e.message)
    return reply.code(500).send({ error: e.message })
  }
})

// Верификация — запросить код
app.post('/api/bots/:id/verify/request', { preHandler: auth }, async (req, reply) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM bots WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'Бот не найден' })
    if (rows[0].verified) return reply.code(400).send({ error: 'Бот уже верифицирован' })

    // Генерируем уникальный код-токен для вставки в описание бота
    const code = 'botfeed-' + crypto.randomBytes(6).toString('hex')
    const exp = new Date(Date.now() + 30 * 60 * 1000) // 30 минут

    await db.query(
      'UPDATE bots SET verify_code=$1, verify_exp=$2 WHERE id=$3',
      [code, exp, req.params.id]
    )

    return {
      ok: true,
      code,
      message: 'Вставь этот токен в описание бота через BotFather',
      instructions: [
        '1. Открой @BotFather в Telegram',
        '2. Отправь команду /setdescription',
        '3. Выбери своего бота @' + rows[0].username,
        '4. Вставь токен: ' + code,
        '5. Вернись и нажми «Проверить»'
      ]
    }
  } catch (e) {
    console.error('Verify request error:', e.message)
    return reply.code(500).send({ error: e.message })
  }
})

// Верификация — проверить description через Bot API
app.post('/api/bots/:id/verify/confirm', { preHandler: auth }, async (req, reply) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM bots WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'Бот не найден' })

    const bot = rows[0]
    if (!bot.verify_code) return reply.code(400).send({ error: 'Сначала запроси код верификации' })
    if (new Date() > new Date(bot.verify_exp)) {
      return reply.code(400).send({ error: 'Токен устарел, запроси новый' })
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN
    if (!botToken) return reply.code(500).send({ error: 'TELEGRAM_BOT_TOKEN не настроен на сервере' })

    // Получаем информацию о боте через Bot API
    const tgRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getChat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: '@' + bot.username })
      }
    )
    const tgData = await tgRes.json()
    console.log('getChat result for @' + bot.username + ':', JSON.stringify(tgData))

    if (!tgData.ok) {
      return reply.code(400).send({
        error: `Не удалось найти бота @${bot.username} в Telegram. Проверь правильность username.`
      })
    }

    const chatInfo = tgData.result
    const description = chatInfo.description || ''
    const bio = chatInfo.bio || ''
    const combined = (description + ' ' + bio).toLowerCase()

    console.log('Bot description:', description, '| Bio:', bio)
    console.log('Looking for code:', bot.verify_code)

    if (!combined.includes(bot.verify_code.toLowerCase())) {
      return reply.code(400).send({
        error: `Токен не найден в описании бота. Убедись что вставил "${bot.verify_code}" через BotFather → /setdescription`,
        description_found: description || '(пусто)'
      })
    }

    // Верификация прошла!
    await db.query(
      'UPDATE bots SET verified=true, verify_code=NULL, verify_exp=NULL WHERE id=$1',
      [req.params.id]
    )

    console.log('Bot verified:', bot.username)
    return { ok: true, message: 'Бот верифицирован! ✅ Можешь убрать токен из описания.' }
  } catch (e) {
    console.error('Verify confirm error:', e.message)
    return reply.code(500).send({ error: e.message })
  }
})


// ════════════════════════════════
// ПОСТЫ
// ════════════════════════════════
app.get('/api/feed/discover', async (req) => {
  try {
    const { limit = 20, offset = 0 } = req.query
    const { rows } = await db.query(`
      SELECT p.*,
        b.name as bot_name, b.username as bot_username,
        b.photo_url as bot_photo, b.verified as bot_verified,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('emoji', r.emoji, 'count', r.cnt))
          FILTER (WHERE r.emoji IS NOT NULL), '[]'
        ) as reactions,
        COUNT(DISTINCT c.id) as comments_count
      FROM posts p
      JOIN bots b ON p.bot_id = b.id
      LEFT JOIN (
        SELECT post_id, emoji, COUNT(*) as cnt FROM reactions GROUP BY post_id, emoji
      ) r ON p.id = r.post_id
      LEFT JOIN comments c ON p.id = c.post_id
      GROUP BY p.id, b.name, b.username, b.photo_url, b.verified
      ORDER BY p.created_at DESC
      LIMIT $1 OFFSET $2
    `, [Number(limit), Number(offset)])
    return rows
  } catch (e) {
    console.error('Feed error:', e.message)
    return []
  }
})

app.get('/api/feed', { preHandler: auth }, async (req) => {
  try {
    const { limit = 20, offset = 0 } = req.query
    const { rows } = await db.query(`
      SELECT p.*,
        b.name as bot_name, b.username as bot_username,
        b.photo_url as bot_photo, b.verified as bot_verified,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('emoji', r.emoji, 'count', r.cnt))
          FILTER (WHERE r.emoji IS NOT NULL), '[]'
        ) as reactions,
        COUNT(DISTINCT c.id) as comments_count
      FROM posts p
      JOIN bots b ON p.bot_id = b.id
      JOIN subscriptions s ON b.id = s.bot_id AND s.user_id = $1
      LEFT JOIN (
        SELECT post_id, emoji, COUNT(*) as cnt FROM reactions GROUP BY post_id, emoji
      ) r ON p.id = r.post_id
      LEFT JOIN comments c ON p.id = c.post_id
      GROUP BY p.id, b.name, b.username, b.photo_url, b.verified
      ORDER BY p.created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.user.id, Number(limit), Number(offset)])
    return rows
  } catch (e) {
    return []
  }
})

app.get('/api/bots/:botId/posts', { preHandler: optAuth }, async (req) => {
  try {
    const { limit = 20, offset = 0 } = req.query
    const { rows } = await db.query(`
      SELECT p.*,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('emoji', r.emoji, 'count', r.cnt))
          FILTER (WHERE r.emoji IS NOT NULL), '[]'
        ) as reactions,
        COUNT(DISTINCT c.id) as comments_count
      FROM posts p
      LEFT JOIN (
        SELECT post_id, emoji, COUNT(*) as cnt FROM reactions GROUP BY post_id, emoji
      ) r ON p.id = r.post_id
      LEFT JOIN comments c ON p.id = c.post_id
      WHERE p.bot_id = $1
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.params.botId, Number(limit), Number(offset)])
    return rows
  } catch (e) {
    return []
  }
})

app.post('/api/bots/:botId/posts', { preHandler: auth }, async (req, reply) => {
  const { text, image_url } = req.body
  if (!text?.trim()) return reply.code(400).send({ error: 'Текст обязателен' })

  const { rows: b } = await db.query(
    'SELECT id FROM bots WHERE id = $1 AND owner_id = $2',
    [req.params.botId, req.user.id]
  )
  if (!b[0]) return reply.code(403).send({ error: 'Нет доступа' })

  const { rows } = await db.query(
    'INSERT INTO posts (bot_id, text, image_url) VALUES ($1, $2, $3) RETURNING *',
    [req.params.botId, text.trim(), image_url || null]
  )
  return rows[0]
})

app.delete('/api/posts/:id', { preHandler: auth }, async (req, reply) => {
  try {
    await db.query(`
      DELETE FROM posts WHERE id = $1
      AND bot_id IN (SELECT id FROM bots WHERE owner_id = $2)
    `, [req.params.id, req.user.id])
    return { ok: true }
  } catch (e) {
    return reply.code(500).send({ error: e.message })
  }
})

app.post('/api/posts/:id/react', { preHandler: auth }, async (req, reply) => {
  const { emoji } = req.body
  if (!['🔥', '👍', '❤️', '😂', '👏', '🎉'].includes(emoji)) {
    return reply.code(400).send({ error: 'Неверный эмодзи' })
  }
  const { rows } = await db.query(
    'SELECT id FROM reactions WHERE post_id=$1 AND user_id=$2 AND emoji=$3',
    [req.params.id, req.user.id, emoji]
  )
  if (rows[0]) {
    await db.query('DELETE FROM reactions WHERE id=$1', [rows[0].id])
    return { action: 'removed' }
  } else {
    await db.query(
      'INSERT INTO reactions (post_id, user_id, emoji) VALUES ($1, $2, $3)',
      [req.params.id, req.user.id, emoji]
    )
    return { action: 'added' }
  }
})

app.get('/api/posts/:id/comments', async (req) => {
  const { rows } = await db.query(`
    SELECT c.*, u.first_name, u.username, u.photo_url
    FROM comments c JOIN users u ON c.user_id = u.id
    WHERE c.post_id = $1 ORDER BY c.created_at ASC
  `, [req.params.id])
  return rows
})

app.post('/api/posts/:id/comments', { preHandler: auth }, async (req, reply) => {
  if (!req.body.text?.trim()) return reply.code(400).send({ error: 'Пустой комментарий' })
  const { rows } = await db.query(
    'INSERT INTO comments (post_id, user_id, text) VALUES ($1, $2, $3) RETURNING *',
    [req.params.id, req.user.id, req.body.text.trim()]
  )
  return rows[0]
})

// ════════════════════════════════
// ПОДПИСКИ
// ════════════════════════════════
app.post('/api/bots/:botId/subscribe', { preHandler: auth }, async (req) => {
  const { rows } = await db.query(
    'SELECT id FROM subscriptions WHERE user_id=$1 AND bot_id=$2',
    [req.user.id, req.params.botId]
  )
  if (rows[0]) {
    await db.query('DELETE FROM subscriptions WHERE id=$1', [rows[0].id])
    return { subscribed: false }
  } else {
    await db.query(
      'INSERT INTO subscriptions (user_id, bot_id) VALUES ($1, $2)',
      [req.user.id, req.params.botId]
    )
    return { subscribed: true }
  }
})

app.get('/api/my/subscriptions', { preHandler: auth }, async (req) => {
  const { rows } = await db.query(`
    SELECT b.id, b.username, b.name, b.photo_url, b.members, b.verified, s.created_at as subscribed_at
    FROM subscriptions s JOIN bots b ON s.bot_id = b.id
    WHERE s.user_id = $1 ORDER BY s.created_at DESC
  `, [req.user.id])
  return rows
})

// Health check
app.get('/health', () => ({ status: 'ok', time: new Date().toISOString() }))

// Запуск
try {
  await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' })
} catch (err) {
  console.error(err)
  process.exit(1)
}
