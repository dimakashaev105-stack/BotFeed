import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import pg from 'pg'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'

// Supabase Storage для загрузки изображений
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null

const { Pool } = pg
const app = Fastify({ logger: true })
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

db.query('SELECT 1').then(() => console.log('✅ БД подключена')).catch(e => console.error('❌ БД:', e.message))

// Миграции
db.query(`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_idx ON users(google_id) WHERE google_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users(email) WHERE email IS NOT NULL;
`).catch(e => console.log('Migration note:', e.message))

// Миграция комментариев — reply_to_id
db.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES comments(id) ON DELETE SET NULL`)
  .catch(e => console.log('Comments migration note:', e.message))

// Миграция постов — кнопки
db.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS buttons JSONB DEFAULT '[]'`)
  .catch(e => console.log('Buttons migration note:', e.message))

db.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS views_count INTEGER DEFAULT 0`)
  .catch(e => console.log('Views migration note:', e.message))

// Индексы для производительности
db.query(`
  CREATE INDEX IF NOT EXISTS idx_reactions_post_id    ON reactions(post_id);
  CREATE INDEX IF NOT EXISTS idx_comments_post_id     ON comments(post_id);
  CREATE INDEX IF NOT EXISTS idx_posts_bot_id         ON posts(bot_id);
  CREATE INDEX IF NOT EXISTS idx_posts_created_at     ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_subscriptions_user   ON subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_subscriptions_bot    ON subscriptions(bot_id);
`).catch(e => console.log('Indexes note:', e.message))

db.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS notify BOOLEAN DEFAULT true`)
  .then(() => db.query(`UPDATE subscriptions SET notify = true WHERE notify IS NULL`))
  .catch(e => console.log('Notify migration note:', e.message))

// Миграция — хранение фото бота в БД
db.query(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS photo_data BYTEA`)
  .catch(e => console.log('Bot photo_data migration note:', e.message))

// Миграция — лимит постов в час на бота (можно менять вручную в БД)
db.query(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS posts_per_hour INTEGER NOT NULL DEFAULT 1`)
  .catch(e => console.log('Posts per hour migration note:', e.message))

// OTP таблицы
try {
  await db.query(`
    CREATE TABLE IF NOT EXISTS tg_otp (
      session_id TEXT PRIMARY KEY,
      code TEXT,
      telegram_id BIGINT,
      first_name TEXT,
      username TEXT,
      photo_url TEXT,
      expires BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  console.log('✅ OTP table OK')
} catch(e) {
  console.log('OTP note:', e.message)
}

// In-memory fallback для OTP
const tgOtpMap = new Map()

// ════════════════════════════════
// TELEGRAM BOT helpers
// ════════════════════════════════
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID

async function tgSend(chatId, text, replyMarkup) {
  if (!TG_TOKEN || !chatId) return
  try {
    const body = { chat_id: String(chatId), text, parse_mode: 'HTML' }
    if (replyMarkup) body.reply_markup = replyMarkup
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    const json = await res.json()
    if (!json.ok) console.error('TG error:', json.description)
  } catch (e) { console.error('TG send error:', e.message) }
}

async function tgEditMessage(chatId, messageId, text) {
  if (!TG_TOKEN) return
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/editMessageText`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), message_id: messageId, text, parse_mode: 'HTML' })
    })
  } catch (e) { console.error('TG edit error:', e.message) }
}

async function tgAnswerCallback(callbackId, text) {
  if (!TG_TOKEN) return
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackId, text })
    })
  } catch (e) {}
}

async function getTgPhoto(telegramId) {
  if (!TG_TOKEN) return null
  try {
    const res  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUserProfilePhotos?user_id=${telegramId}&limit=1`)
    const data = await res.json()
    const fileId = data?.result?.photos?.[0]?.[2]?.file_id || data?.result?.photos?.[0]?.[0]?.file_id
    if (!fileId) return null
    const fRes  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${fileId}`)
    const fData = await fRes.json()
    if (!fData?.result?.file_path) return null
    return `https://api.telegram.org/file/bot${TG_TOKEN}/${fData.result.file_path}`
  } catch { return null }
}

// ════════════════════════════════
// CORS & JWT
// ════════════════════════════════
await app.register(cors, {
  origin: true, credentials: false,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
})

await app.register(jwt, {
  secret: process.env.JWT_SECRET || 'botfeed_secret_key_32_chars_min!'
})

await app.register(multipart, {
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
})

// JSON parser (разрешаем пустое тело)
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try { done(null, body ? JSON.parse(body) : {}) } catch (e) { done(null, {}) }
})

// Middleware
async function auth(req, reply) {
  try { await req.jwtVerify() } catch { reply.code(401).send({ error: 'Нужна авторизация' }) }
}
async function optAuth(req) {
  try { await req.jwtVerify() } catch { req.user = null }
}

// ════════════════════════════════
// TELEGRAM WEBHOOK
// ════════════════════════════════
app.post('/api/tg/webhook', async (req, reply) => {
  try {
    const update = req.body
    const msg = update.message
    const cb  = update.callback_query

    // /start LOGIN_<sessionId> — OTP авторизация
    if (msg?.text?.startsWith('/start LOGIN_')) {
      const sessionId = msg.text.replace('/start LOGIN_', '').trim()
      const chatId    = msg.chat.id
      const from      = msg.from

      let session = tgOtpMap.get(sessionId)
      if (!session) {
        try {
          const { rows } = await db.query('SELECT * FROM tg_otp WHERE session_id=$1', [sessionId])
          if (rows[0]) session = rows[0]
        } catch {}
      }

      if (!session || Date.now() > Number(session.expires)) {
        await tgSend(chatId, '❌ Сессия устарела. Вернись на сайт и нажми кнопку снова.')
        return { ok: true }
      }

      const photo_url = await getTgPhoto(chatId)
      const code = String(Math.floor(100000 + Math.random() * 900000))
      const updated = {
        session_id: sessionId, code,
        telegram_id: chatId,
        first_name: from.first_name || '',
        username: from.username || null,
        photo_url,
        expires: Date.now() + 10 * 60 * 1000
      }
      tgOtpMap.set(sessionId, updated)
      try {
        await db.query(`
          INSERT INTO tg_otp (session_id, code, telegram_id, first_name, username, photo_url, expires)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (session_id) DO UPDATE SET
            code=$2, telegram_id=$3, first_name=$4, username=$5, photo_url=$6, expires=$7
        `, [sessionId, code, chatId, updated.first_name, updated.username, photo_url, updated.expires])
      } catch {}

      await tgSend(chatId,
        `👋 <b>Привет, ${updated.first_name}!</b>\n\n` +
        `Твой код для входа в <b>BotFeed</b>:\n\n` +
        `<code>${code}</code>\n\n` +
        `⏱ Код действителен 10 минут.\n` +
        `Вернись на сайт и введи этот код.`
      )
      return { ok: true }
    }

    // Кнопки одобрить/отклонить бота
    if (cb) {
      const data = cb.data || ''
      const [action, botId] = data.split(':')
      const msgId  = cb.message?.message_id
      const chatId = cb.message?.chat?.id

      if (!botId || !['approve', 'reject'].includes(action)) {
        await tgAnswerCallback(cb.id, '⚠️ Неизвестное действие')
        return { ok: true }
      }

      const { rows } = await db.query(`
        SELECT b.id, b.name, b.username, u.telegram_id, u.first_name
        FROM bots b JOIN users u ON b.owner_id = u.id WHERE b.id = $1
      `, [botId])
      const b = rows[0]
      if (!b) { await tgAnswerCallback(cb.id, '⚠️ Бот не найден'); return { ok: true } }

      if (action === 'approve') {
        await db.query('UPDATE bots SET verified=true WHERE id=$1', [botId])
        await tgEditMessage(chatId, msgId, `✅ <b>ОДОБРЕНО</b>\n\nБот: <b>${b.name}</b> (@${b.username})\nВладелец: ${b.first_name}`)
        await tgSend(b.telegram_id, `🎉 <b>Бот верифицирован!</b>\n\nВаш бот <b>${b.name}</b> (@${b.username}) прошёл проверку ✓`)
        await tgAnswerCallback(cb.id, '✅ Одобрено!')
      } else {
        await db.query('UPDATE bots SET verified=false WHERE id=$1', [botId])
        await tgEditMessage(chatId, msgId, `❌ <b>ОТКЛОНЕНО</b>\n\nБот: <b>${b.name}</b> (@${b.username})\nВладелец: ${b.first_name}`)
        await tgSend(b.telegram_id, `❌ <b>Верификация отклонена</b>\n\nБот <b>${b.name}</b> не прошёл проверку.`)
        await tgAnswerCallback(cb.id, '❌ Отклонено')
      }
    }
  } catch (e) { console.error('Webhook error:', e.message) }
  return { ok: true }
})

// ════════════════════════════════
// AUTH — Telegram OTP (через бота)
// ════════════════════════════════

// Шаг 1: создать сессию
app.post('/api/auth/tg/start', async (req, reply) => {
  try {
    const sessionId = crypto.randomBytes(16).toString('hex')
    const expires   = Date.now() + 15 * 60 * 1000
    tgOtpMap.set(sessionId, { session_id: sessionId, code: null, expires })
    try {
      await db.query(
        `INSERT INTO tg_otp (session_id, code, expires) VALUES ($1,'',  $2) ON CONFLICT (session_id) DO UPDATE SET expires=$2`,
        [sessionId, expires]
      )
    } catch {}
    return { ok: true, sessionId, botUrl: `https://t.me/BotFeeds_bot?start=LOGIN_${sessionId}` }
  } catch (e) { return reply.code(500).send({ error: e.message }) }
})

// Шаг 2: проверить код
app.post('/api/auth/tg/verify', async (req, reply) => {
  try {
    const { sessionId, code } = req.body
    if (!sessionId || !code) return reply.code(400).send({ error: 'Нет данных' })
    const codeClean = String(code).replace(/\D/g, '').trim()

    let session = tgOtpMap.get(sessionId)
    if (!session) {
      try {
        const { rows } = await db.query('SELECT * FROM tg_otp WHERE session_id=$1', [sessionId])
        if (rows[0]) session = rows[0]
      } catch {}
    }

    if (!session)                            return reply.code(400).send({ error: 'Сессия не найдена. Начни заново.' })
    if (Date.now() > Number(session.expires)) return reply.code(400).send({ error: 'Код истёк. Начни заново.' })
    if (!session.code)                        return reply.code(400).send({ error: 'Код ещё не получен. Открой бота и нажми Start.' })
    if (session.code !== codeClean)           return reply.code(400).send({ error: 'Неверный код' })

    tgOtpMap.delete(sessionId)
    db.query('DELETE FROM tg_otp WHERE session_id=$1', [sessionId]).catch(() => {})

    const { rows } = await db.query(`
      INSERT INTO users (telegram_id, username, first_name, photo_url)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (telegram_id) DO UPDATE SET
        username   = COALESCE(EXCLUDED.username, users.username),
        first_name = EXCLUDED.first_name,
        photo_url  = COALESCE(EXCLUDED.photo_url, users.photo_url)
      RETURNING *
    `, [session.telegram_id, session.username || null, session.first_name || 'User', session.photo_url || null])

    const user  = rows[0]
    const token = app.jwt.sign({ id: user.id, telegram_id: user.telegram_id }, { expiresIn: '30d' })
    console.log('✅ TG OTP auth:', user.first_name, user.telegram_id)
    return { token, user: { id: user.id, first_name: user.first_name, username: user.username, photo_url: user.photo_url } }
  } catch (e) {
    console.error('TG verify error:', e.message)
    return reply.code(500).send({ error: e.message })
  }
})

// Старый Telegram Widget auth (оставляем для совместимости)
app.post('/api/auth/telegram', async (req, reply) => {
  try {
    const { id, first_name, last_name, username, photo_url } = req.body
    if (!id || !first_name) return reply.code(400).send({ error: 'Нет данных от Telegram' })

    const { rows } = await db.query(`
      INSERT INTO users (telegram_id, username, first_name, last_name, photo_url)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (telegram_id) DO UPDATE SET
        username = EXCLUDED.username, first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name, photo_url = EXCLUDED.photo_url
      RETURNING *
    `, [id, username || null, first_name, last_name || null, photo_url || null])

    const user  = rows[0]
    const token = app.jwt.sign({ id: user.id, telegram_id: user.telegram_id }, { expiresIn: '30d' })
    return { token, user: { id: user.id, first_name: user.first_name, username: user.username, photo_url: user.photo_url } }
  } catch (e) {
    console.error('Auth error:', e.message)
    return reply.code(500).send({ error: e.message })
  }
})

// ════════════════════════════════
// AUTH — Telegram Mini App (initData)
// Верифицируем подпись от Telegram автоматически
// ════════════════════════════════
app.post('/api/auth/webapp', async (req, reply) => {
  try {
    const { initData } = req.body
    if (!initData) return reply.code(400).send({ error: 'Нет initData' })

    // Верифицируем HMAC подпись
    const botToken = process.env.TELEGRAM_BOT_TOKEN
    if (!botToken) return reply.code(500).send({ error: 'Бот не настроен' })

    const params = new URLSearchParams(initData)
    const hash = params.get('hash')
    if (!hash) return reply.code(400).send({ error: 'Нет hash' })

    // Строим data-check-string
    params.delete('hash')
    const dataCheckArr = []
    for (const [key, val] of [...params.entries()].sort()) {
      dataCheckArr.push(`${key}=${val}`)
    }
    const dataCheckString = dataCheckArr.join('\n')

    // HMAC-SHA256: key = HMAC("WebAppData", botToken), data = dataCheckString
    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest()
    const expectedHash = crypto.createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex')

    if (expectedHash !== hash) {
      return reply.code(401).send({ error: 'Невалидная подпись Telegram' })
    }

    // Проверяем свежесть (не старше 24 часов)
    const authDate = parseInt(params.get('auth_date') || '0')
    if (Date.now() / 1000 - authDate > 86400) {
      return reply.code(401).send({ error: 'initData устарел' })
    }

    // Парсим пользователя
    const userJson = params.get('user')
    if (!userJson) return reply.code(400).send({ error: 'Нет данных пользователя' })
    const tgUser = JSON.parse(userJson)

    // Сохраняем/обновляем в БД
    const photoUrl = tgUser.photo_url || await getTgPhoto(tgUser.id).catch(() => null)
    const { rows } = await db.query(`
      INSERT INTO users (telegram_id, username, first_name, last_name, photo_url)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (telegram_id) DO UPDATE SET
        username   = COALESCE(EXCLUDED.username, users.username),
        first_name = EXCLUDED.first_name,
        last_name  = COALESCE(EXCLUDED.last_name, users.last_name),
        photo_url  = COALESCE(EXCLUDED.photo_url, users.photo_url)
      RETURNING *
    `, [tgUser.id, tgUser.username || null, tgUser.first_name, tgUser.last_name || null, photoUrl])

    const user  = rows[0]
    const token = app.jwt.sign({ id: user.id, telegram_id: user.telegram_id }, { expiresIn: '90d' })
    console.log('✅ WebApp auth:', user.first_name, user.telegram_id)
    return { token, user: { id: user.id, first_name: user.first_name, last_name: user.last_name, username: user.username, photo_url: user.photo_url } }
  } catch (e) {
    console.error('WebApp auth error:', e.message)
    return reply.code(500).send({ error: e.message })
  }
})

// Текущий пользователь
app.get('/api/auth/me', { preHandler: auth }, async (req) => {
  try {
    const { rows } = await db.query(
      'SELECT id, first_name, last_name, username, photo_url, telegram_id FROM users WHERE id=$1',
      [req.user.id]
    )
    const user = rows[0]
    if (!user) return reply.code(404).send({ error: 'Not found' })

    // Обновляем фото из Telegram
    if (user.telegram_id && TG_TOKEN) {
      const newPhoto = await getTgPhoto(user.telegram_id)
      if (newPhoto && newPhoto !== user.photo_url) {
        await db.query('UPDATE users SET photo_url=$1 WHERE id=$2', [newPhoto, user.id])
        user.photo_url = newPhoto
      }
    }
    return { id: user.id, first_name: user.first_name, last_name: user.last_name, username: user.username, photo_url: user.photo_url }
  } catch (e) { return { error: e.message } }
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
    if (q) { where.push(`(b.name ILIKE $${i} OR b.description ILIKE $${i})`); params.push(`%${q}%`); i++ }
    if (category && category !== 'all') { where.push(`$${i} = ANY(b.categories)`); params.push(category); i++ }
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
  } catch (e) { console.error('GET /bots error:', e.message); return [] }
})

// Один бот по id — без фильтра верификации
app.get('/api/bots/:botId', async (req, reply) => {
  try {
    const { rows } = await db.query(`
      SELECT b.id, b.username, b.name, b.description, b.long_desc, b.photo_url,
             b.members, b.categories, b.verified, b.created_at,
             u.first_name as owner_name,
             COUNT(DISTINCT s.id) as subscribers,
             COUNT(DISTINCT p.id) as posts_count
      FROM bots b
      JOIN users u ON b.owner_id = u.id
      LEFT JOIN subscriptions s ON b.id = s.bot_id
      LEFT JOIN posts p ON b.id = p.bot_id
      WHERE b.id = $1
      GROUP BY b.id, u.first_name
    `, [parseInt(req.params.botId)])
    if (!rows[0]) return reply.code(404).send({ error: 'Бот не найден' })
    return rows[0]
  } catch (e) { return reply.code(500).send({ error: e.message }) }
})

app.get('/api/my/bots', { preHandler: auth }, async (req) => {
  const { rows } = await db.query(`
    SELECT b.*, COUNT(DISTINCT s.id) as subscribers, COUNT(DISTINCT p.id) as posts_count
    FROM bots b
    LEFT JOIN subscriptions s ON b.id = s.bot_id
    LEFT JOIN posts p ON b.id = p.bot_id
    WHERE b.owner_id = $1 GROUP BY b.id ORDER BY b.created_at DESC
  `, [req.user.id])
  return rows
})

app.post('/api/bots', { preHandler: auth }, async (req, reply) => {
  try {
    const { username, name, description, long_desc, categories } = req.body
    if (!username || !name) return reply.code(400).send({ error: 'Username и имя обязательны' })
    const clean = username.replace('@', '').toLowerCase()

    const { rows: me } = await db.query('SELECT telegram_id FROM users WHERE id=$1', [req.user.id])
    if (!me[0]?.telegram_id) return reply.code(403).send({ error: 'Для добавления бота нужно войти через Telegram' })

    const { rows: existing } = await db.query('SELECT id FROM bots WHERE owner_id=$1', [req.user.id])
    if (existing.length >= 1) return reply.code(400).send({ error: 'У вас уже есть бот. Удалите его, чтобы добавить новый.' })

    const { rows } = await db.query(`
      INSERT INTO bots (owner_id, username, name, description, long_desc, categories)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [req.user.id, clean, name, description || '', long_desc || '', categories || []])
    return rows[0]
  } catch (e) {
    if (e.message.includes('unique')) return reply.code(400).send({ error: 'Бот с таким username уже существует' })
    return reply.code(500).send({ error: e.message })
  }
})

// Загрузка фото бота
app.post('/api/bots/:id/photo', { preHandler: auth }, async (req, reply) => {
  try {
    const { rows } = await db.query('SELECT id FROM bots WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id])
    if (!rows[0]) return reply.code(403).send({ error: 'Нет доступа' })

    const data = await req.file()
    if (!data) return reply.code(400).send({ error: 'Файл не найден' })
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    if (!allowed.includes(data.mimetype)) return reply.code(400).send({ error: 'Недопустимый тип файла' })

    const buf = await data.toBuffer()
    if (buf.length > 5 * 1024 * 1024) return reply.code(400).send({ error: 'Файл больше 5 МБ' })

    // Пробуем Supabase если настроен
    if (supabase) {
      const ext = (data.filename || 'photo').split('.').pop() || 'jpg'
      const fileName = `bots/${req.params.id}_${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage.from('posts').upload(fileName, buf, {
        contentType: data.mimetype, upsert: true
      })
      if (!upErr) {
        const { data: { publicUrl } } = supabase.storage.from('posts').getPublicUrl(fileName)
        await db.query('UPDATE bots SET photo_url=$1, photo_data=NULL WHERE id=$2', [publicUrl, req.params.id])
        return { url: publicUrl }
      }
    }

    // Fallback — сохраняем байты прямо в БД, отдаём через /avatar
    await db.query('UPDATE bots SET photo_data=$1, photo_url=NULL WHERE id=$2', [buf, req.params.id])
    return { url: `/api/bots/${req.params.id}/avatar` }
  } catch (e) { return reply.code(500).send({ error: e.message }) }
})


// Проксирование фото бота (чтобы избежать проблем с CORS и истечением TG-ссылок)
app.get('/api/bots/:id/avatar', async (req, reply) => {
  try {
    const { rows } = await db.query('SELECT photo_url, photo_data FROM bots WHERE id=$1', [req.params.id])
    if (!rows[0]) return reply.code(404).send('Not found')

    // Если есть сохранённые байты — отдаём их
    if (rows[0].photo_data) {
      const buf = rows[0].photo_data
      reply.header('Content-Type', 'image/jpeg')
      reply.header('Cache-Control', 'public, max-age=86400')
      return reply.send(buf)
    }

    // Иначе редиректим на внешний URL
    if (rows[0].photo_url) {
      return reply.redirect(rows[0].photo_url)
    }

    return reply.code(404).send('No photo')
  } catch (e) { return reply.code(500).send({ error: e.message }) }
})

// Авто-подтягивание фото бота из Telegram
app.post('/api/bots/:id/fetch-photo', { preHandler: auth }, async (req, reply) => {
  try {
    const { rows } = await db.query('SELECT b.*, u.telegram_id FROM bots b JOIN users u ON b.owner_id=u.id WHERE b.id=$1 AND b.owner_id=$2', [req.params.id, req.user.id])
    if (!rows[0]) return reply.code(403).send({ error: 'Нет доступа' })
    const b = rows[0]
    if (!TG_TOKEN) return reply.code(400).send({ error: 'TG_TOKEN не настроен' })

    const tgRes  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getChat?chat_id=@${b.username}`)
    const tgData = await tgRes.json()

    // Пробуем big_file_id первым (лучшее качество)
    const fileId = tgData?.result?.photo?.big_file_id || tgData?.result?.photo?.small_file_id
    if (!fileId) return reply.code(404).send({ error: 'У бота нет фото профиля в Telegram' })

    const fRes  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${fileId}`)
    const fData = await fRes.json()
    if (!fData?.result?.file_path) return reply.code(404).send({ error: 'Не удалось получить ссылку на файл' })

    const tgFileUrl = `https://api.telegram.org/file/bot${TG_TOKEN}/${fData.result.file_path}`

    // Скачиваем файл и сохраняем байты в БД чтобы не зависеть от истечения TG-ссылок
    try {
      const imgRes = await fetch(tgFileUrl)
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer())
        // Сохраняем и байты и URL
        await db.query('UPDATE bots SET photo_url=$1, photo_data=$2 WHERE id=$3',
          [tgFileUrl, buf, req.params.id])
        // Возвращаем проксированный URL
        const proxyUrl = `/api/bots/${req.params.id}/avatar`
        return { url: proxyUrl }
      }
    } catch (downloadErr) {
      console.error('Photo download error:', downloadErr.message)
    }

    // Fallback — просто сохраняем TG URL как есть
    await db.query('UPDATE bots SET photo_url=$1 WHERE id=$2', [tgFileUrl, req.params.id])
    return { url: tgFileUrl }
  } catch (e) { return reply.code(500).send({ error: e.message }) }
})

app.put('/api/bots/:id', { preHandler: auth }, async (req, reply) => {
  try {
    const { name, description, long_desc, categories } = req.body
    const { rows: cur } = await db.query('SELECT * FROM bots WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id])
    if (!cur[0]) return reply.code(404).send({ error: 'Бот не найден' })
    const { rows } = await db.query(`
      UPDATE bots SET name=$1, description=$2, long_desc=$3, categories=$4
      WHERE id=$5 AND owner_id=$6 RETURNING *
    `, [name ?? cur[0].name, description ?? cur[0].description, long_desc ?? cur[0].long_desc, categories ?? cur[0].categories, req.params.id, req.user.id])
    return rows[0]
  } catch (e) { return reply.code(500).send({ error: e.message }) }
})

app.delete('/api/bots/:id', { preHandler: auth }, async (req, reply) => {
  try {
    const { rows } = await db.query('SELECT id FROM bots WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id])
    if (!rows[0]) return reply.code(404).send({ error: 'Бот не найден или нет доступа' })
    await db.query('DELETE FROM reactions WHERE post_id IN (SELECT id FROM posts WHERE bot_id=$1)', [req.params.id])
    await db.query('DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE bot_id=$1)', [req.params.id])
    await db.query('DELETE FROM posts WHERE bot_id=$1', [req.params.id])
    await db.query('DELETE FROM subscriptions WHERE bot_id=$1', [req.params.id])
    await db.query('DELETE FROM bots WHERE id=$1', [req.params.id])
    return { ok: true }
  } catch (e) { return reply.code(500).send({ error: e.message }) }
})

// ════════════════════════════════
// ВЕРИФИКАЦИЯ
// ════════════════════════════════
app.post('/api/bots/:id/verify/request', { preHandler: auth }, async (req, reply) => {
  try {
    const { rows } = await db.query(
      'SELECT b.*, u.first_name, u.username as owner_username, u.telegram_id FROM bots b JOIN users u ON b.owner_id=u.id WHERE b.id=$1 AND b.owner_id=$2',
      [req.params.id, req.user.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'Бот не найден' })
    const b = rows[0]
    const verifyToken = crypto.randomBytes(12).toString('hex')
    await db.query('UPDATE bots SET verify_token=$1 WHERE id=$2', [verifyToken, req.params.id])
    if (ADMIN_CHAT_ID && TG_TOKEN) {
      await tgSend(ADMIN_CHAT_ID,
        `🔔 <b>Новая заявка на верификацию!</b>\n\nБот: <b>${b.name}</b> (@${b.username})\nОписание: ${b.description || '—'}\nВладелец: ${b.first_name}\nСсылка: https://t.me/${b.username}`,
        { inline_keyboard: [[{ text: '✅ Одобрить', callback_data: `approve:${b.id}` }, { text: '❌ Отклонить', callback_data: `reject:${b.id}` }]] }
      )
    }
    return { ok: true, code: verifyToken }
  } catch (e) { return reply.code(500).send({ error: e.message }) }
})

app.post('/api/bots/:id/verify/confirm', { preHandler: auth }, async (req, reply) => {
  try {
    const { rows } = await db.query(
      'SELECT b.*, u.telegram_id FROM bots b JOIN users u ON b.owner_id=u.id WHERE b.id=$1 AND b.owner_id=$2',
      [req.params.id, req.user.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'Бот не найден' })
    const b = rows[0]
    if (!TG_TOKEN || !b.verify_token) return { ok: true, pending: true, message: 'Заявка отправлена на проверку' }
    try {
      const tgRes  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getChat?chat_id=@${b.username}`)
      const tgData = await tgRes.json()
      if ((tgData?.result?.description || '').includes(b.verify_token)) {
        // Подтягиваем фото бота из Telegram
        let botPhotoUrl = null
        try {
          const chatPhoto = tgData?.result?.photo?.small_file_id || tgData?.result?.photo?.big_file_id
          if (chatPhoto && TG_TOKEN) {
            const fRes  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${chatPhoto}`)
            const fData = await fRes.json()
            if (fData?.result?.file_path) {
              botPhotoUrl = `https://api.telegram.org/file/bot${TG_TOKEN}/${fData.result.file_path}`
            }
          }
        } catch {}
        await db.query(
          `UPDATE bots SET verified=true${botPhotoUrl ? ', photo_url=$2' : ''} WHERE id=$1`,
          botPhotoUrl ? [req.params.id, botPhotoUrl] : [req.params.id]
        )
        return { ok: true, verified: true, message: 'Бот верифицирован!' }
      }
      return { ok: false, verified: false, message: 'Токен не найден. Заявка ожидает ручной проверки.' }
    } catch { return { ok: true, pending: true, message: 'Заявка отправлена. Проверим вручную.' } }
  } catch (e) { return reply.code(500).send({ error: e.message }) }
})

// ════════════════════════════════
// ПОСТЫ
// ════════════════════════════════
app.get('/api/feed/discover', async (req) => {
  try {
    const { limit = 20, offset = 0 } = req.query
    const { rows } = await db.query(`
      SELECT p.*, b.id as bot_id, b.name as bot_name, b.username as bot_username, b.photo_url as bot_photo, b.verified as bot_verified,
        COALESCE(json_agg(DISTINCT jsonb_build_object('emoji', r.emoji, 'count', r.cnt)) FILTER (WHERE r.emoji IS NOT NULL), '[]') as reactions,
        COUNT(DISTINCT c.id) as comments_count
      FROM posts p JOIN bots b ON p.bot_id=b.id
      LEFT JOIN (SELECT post_id, emoji, COUNT(*) as cnt FROM reactions GROUP BY post_id, emoji) r ON p.id=r.post_id
      LEFT JOIN comments c ON p.id=c.post_id
      GROUP BY p.id, b.id, b.name, b.username, b.photo_url, b.verified
      ORDER BY p.created_at DESC LIMIT $1 OFFSET $2
    `, [Number(limit), Number(offset)])
    return rows
  } catch (e) { return [] }
})

app.get('/api/feed', { preHandler: optAuth }, async (req) => {
  try {
    const { limit = 20, offset = 0 } = req.query
    if (req.user?.id) {
      const { rows } = await db.query(`
        SELECT p.*, b.name as bot_name, b.username as bot_username, b.id as bot_id,
          b.photo_url as bot_photo, b.verified as bot_verified,
          COALESCE(json_agg(DISTINCT jsonb_build_object('emoji', r.emoji, 'count', r.cnt)) FILTER (WHERE r.emoji IS NOT NULL), '[]') as reactions,
          COUNT(DISTINCT c.id) as comments_count,
          COALESCE(json_agg(DISTINCT mr.emoji) FILTER (WHERE mr.emoji IS NOT NULL), '[]') as my_reactions
        FROM posts p JOIN bots b ON p.bot_id=b.id
        JOIN subscriptions s ON b.id=s.bot_id AND s.user_id=$1
        LEFT JOIN (SELECT post_id, emoji, COUNT(*) as cnt FROM reactions GROUP BY post_id, emoji) r ON p.id=r.post_id
        LEFT JOIN comments c ON p.id=c.post_id
        LEFT JOIN reactions mr ON p.id=mr.post_id AND mr.user_id=$1
        GROUP BY p.id, b.name, b.username, b.id, b.photo_url, b.verified
        ORDER BY p.created_at DESC LIMIT $2 OFFSET $3
      `, [req.user.id, Number(limit), Number(offset)])
      return rows
    } else {
      const { rows } = await db.query(`
        SELECT p.*, b.name as bot_name, b.username as bot_username, b.id as bot_id,
          b.photo_url as bot_photo, b.verified as bot_verified,
          COALESCE(json_agg(DISTINCT jsonb_build_object('emoji', r.emoji, 'count', r.cnt)) FILTER (WHERE r.emoji IS NOT NULL), '[]') as reactions,
          COUNT(DISTINCT c.id) as comments_count, '[]'::json as my_reactions
        FROM posts p JOIN bots b ON p.bot_id=b.id
        LEFT JOIN (SELECT post_id, emoji, COUNT(*) as cnt FROM reactions GROUP BY post_id, emoji) r ON p.id=r.post_id
        LEFT JOIN comments c ON p.id=c.post_id
        WHERE b.verified=true
        GROUP BY p.id, b.name, b.username, b.id, b.photo_url, b.verified
        ORDER BY p.created_at DESC LIMIT $1 OFFSET $2
      `, [Number(limit), Number(offset)])
      return rows
    }
  } catch (e) { return [] }
})

app.get('/api/bots/:botId/posts', { preHandler: optAuth }, async (req) => {
  try {
    const { limit = 20, offset = 0 } = req.query
    const { rows } = await db.query(`
      SELECT p.*,
        COALESCE(json_agg(DISTINCT jsonb_build_object('emoji', r.emoji, 'count', r.cnt)) FILTER (WHERE r.emoji IS NOT NULL), '[]') as reactions,
        COUNT(DISTINCT c.id) as comments_count
      FROM posts p
      LEFT JOIN (SELECT post_id, emoji, COUNT(*) as cnt FROM reactions GROUP BY post_id, emoji) r ON p.id=r.post_id
      LEFT JOIN comments c ON p.id=c.post_id
      WHERE p.bot_id=$1 GROUP BY p.id ORDER BY p.created_at DESC LIMIT $2 OFFSET $3
    `, [req.params.botId, Number(limit), Number(offset)])
    return rows
  } catch (e) { return [] }
})

app.post('/api/bots/:botId/posts', { preHandler: auth }, async (req, reply) => {
  const { text, image_url, post_type, buttons } = req.body
  if (!text?.trim()) return reply.code(400).send({ error: 'Текст обязателен' })
  const { rows: b } = await db.query('SELECT id, name, username, posts_per_hour FROM bots WHERE id=$1 AND owner_id=$2', [req.params.botId, req.user.id])
  if (!b[0]) return reply.code(403).send({ error: 'Нет доступа' })

  // ── Проверка лимита постов в час ──
  const limit = b[0].posts_per_hour ?? 1
  const { rows: recent } = await db.query(
    `SELECT COUNT(*) as cnt FROM posts WHERE bot_id=$1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [req.params.botId]
  )
  if (parseInt(recent[0].cnt) >= limit) {
    const { rows: lastPost } = await db.query(
      `SELECT created_at FROM posts WHERE bot_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [req.params.botId]
    )
    const nextAllowed = new Date(new Date(lastPost[0].created_at).getTime() + 60 * 60 * 1000)
    const waitMin = Math.ceil((nextAllowed - Date.now()) / 60000)
    return reply.code(429).send({
      error: `Лимит: ${limit} пост в час. Следующий пост можно опубликовать через ${waitMin} мин.`
    })
  }
  // ──────────────────────────────────

  const cleanButtons = Array.isArray(buttons)
    ? buttons.filter(b => b?.label?.trim() && b?.url?.trim()).slice(0, 4)
    : []

  let rows
  try {
    const r = await db.query(
      'INSERT INTO posts (bot_id, text, image_url, post_type, buttons) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.params.botId, text.trim(), image_url || null, post_type || null, JSON.stringify(cleanButtons)]
    )
    rows = r.rows
  } catch {
    try {
      const r = await db.query(
        'INSERT INTO posts (bot_id, text, image_url, post_type) VALUES ($1,$2,$3,$4) RETURNING *',
        [req.params.botId, text.trim(), image_url || null, post_type || null]
      )
      rows = r.rows
    } catch {
      const r = await db.query('INSERT INTO posts (bot_id, text, image_url) VALUES ($1,$2,$3) RETURNING *', [req.params.botId, text.trim(), image_url || null])
      rows = r.rows
    }
  }

  const post = rows[0]

  // Отправляем уведомления подписчикам асинхронно (параллельно, до 10 одновременно)
  ;(async () => {
    try {
      const { rows: subs } = await db.query(`
        SELECT u.telegram_id FROM subscriptions s
        JOIN users u ON s.user_id = u.id
        WHERE s.bot_id = $1 AND s.notify = true AND u.telegram_id IS NOT NULL
      `, [req.params.botId])
      const preview = text.trim().length > 200 ? text.trim().slice(0, 200) + '…' : text.trim()
      const postUrl = `${process.env.SITE_URL || 'https://botfeed.vercel.app'}?post=${post.id}`
      const msg = `🔔 <b>${b[0].name}</b> опубликовал новый пост!\n\n${preview}\n\n<a href="${postUrl}">Открыть →</a>`

      // Батчами по 10 — не блокируем, не спамим TG API
      const BATCH = 10
      for (let i = 0; i < subs.length; i += BATCH) {
        const batch = subs.slice(i, i + BATCH)
        await Promise.allSettled(batch.map(sub => tgSend(sub.telegram_id, msg)))
        if (i + BATCH < subs.length) await new Promise(r => setTimeout(r, 100))
      }
    } catch (e) { console.error('Notify error:', e.message) }
  })()

  // SSE — разослать ВСЕМ подключённым (реальный реалтайм)
  ;(async () => {
    try {
      const payload = {
        ...post,
        bot_id: b[0].id,
        bot_name: b[0].name,
        bot_username: b[0].username,
        reactions: [], comments_count: 0, views_count: 0
      }
      // Рассылаем всем — и авторизованным и гостям
      ssePublish('new_post', payload)
    } catch(e) { console.error('SSE post err:', e.message) }
  })()

  return post
})

app.delete('/api/posts/:id', { preHandler: auth }, async (req, reply) => {
  try {
    await db.query('DELETE FROM posts WHERE id=$1 AND bot_id IN (SELECT id FROM bots WHERE owner_id=$2)', [req.params.id, req.user.id])
    return { ok: true }
  } catch (e) { return reply.code(500).send({ error: e.message }) }
})

app.post('/api/posts/:id/react', { preHandler: auth }, async (req, reply) => {
  const { emoji } = req.body
  if (!['🔥', '👍', '❤️', '😂', '👏', '🎉'].includes(emoji)) return reply.code(400).send({ error: 'Неверный эмодзи' })

  const postId = parseInt(req.params.id)
  const userId = req.user.id

  // Ищем текущую реакцию пользователя на этот пост (любую)
  const { rows: existing } = await db.query(
    'SELECT id, emoji FROM reactions WHERE post_id=$1 AND user_id=$2',
    [postId, userId]
  )

  let action
  let removedEmoji = null

  if (existing[0]?.emoji === emoji) {
    // Тот же emoji — убираем (toggle off)
    await db.query('DELETE FROM reactions WHERE id=$1', [existing[0].id])
    action = 'removed'
  } else {
    // Другой или нет — удаляем старую (если была) и ставим новую
    if (existing[0]) {
      removedEmoji = existing[0].emoji
      await db.query('DELETE FROM reactions WHERE id=$1', [existing[0].id])
    }
    await db.query('INSERT INTO reactions (post_id, user_id, emoji) VALUES ($1,$2,$3)', [postId, userId, emoji])
    action = 'added'
  }

  // SSE — актуальные счётчики всем
  const { rows: cnt } = await db.query(
    'SELECT emoji, COUNT(*) as count FROM reactions WHERE post_id=$1 GROUP BY emoji',
    [postId]
  )
  ssePublish('reaction_update', { post_id: postId, emoji, action, removed_emoji: removedEmoji, by_user_id: userId, reactions: cnt.map(r => ({ emoji: r.emoji, count: parseInt(r.count) })) })

  return { action, removed_emoji: removedEmoji }
})

// Один пост по id — со всеми данными бота
app.get('/api/posts/:id', { preHandler: optAuth }, async (req, reply) => {
  try {
    const userId = req.user?.id
    const { rows } = await db.query(`
      SELECT p.*, b.id as bot_id, b.name as bot_name, b.username as bot_username,
             b.photo_url as bot_photo, b.verified as bot_verified,
        COALESCE(json_agg(DISTINCT jsonb_build_object('emoji', r.emoji, 'count', r.cnt)) FILTER (WHERE r.emoji IS NOT NULL), '[]') as reactions,
        COUNT(DISTINCT c.id) as comments_count,
        COALESCE(json_agg(DISTINCT mr.emoji) FILTER (WHERE mr.emoji IS NOT NULL), '[]') as my_reactions
      FROM posts p
      JOIN bots b ON p.bot_id = b.id
      LEFT JOIN (SELECT post_id, emoji, COUNT(*) as cnt FROM reactions GROUP BY post_id, emoji) r ON p.id=r.post_id
      LEFT JOIN comments c ON p.id=c.post_id
      LEFT JOIN reactions mr ON p.id=mr.post_id AND mr.user_id=$2
      WHERE p.id = $1
      GROUP BY p.id, b.id, b.name, b.username, b.photo_url, b.verified
    `, [parseInt(req.params.id), userId || null])
    if (!rows[0]) return reply.code(404).send({ error: 'Пост не найден' })
    return rows[0]
  } catch (e) { return reply.code(500).send({ error: e.message }) }
})

app.get('/api/posts/:id/comments', async (req) => {
  const { rows } = await db.query(`
    SELECT c.*, u.first_name, u.username, u.photo_url,
      rc.text as reply_to_text, ru.first_name as reply_to_name
    FROM comments c 
    JOIN users u ON c.user_id=u.id
    LEFT JOIN comments rc ON c.reply_to_id=rc.id
    LEFT JOIN users ru ON rc.user_id=ru.id
    WHERE c.post_id=$1 ORDER BY c.created_at ASC
  `, [req.params.id])
  return rows
})

app.post('/api/posts/:id/comments', { preHandler: auth }, async (req, reply) => {
  if (!req.body.text?.trim()) return reply.code(400).send({ error: 'Пустой комментарий' })
  const replyToId = req.body.reply_to_id ? parseInt(req.body.reply_to_id) : null
  const postId = parseInt(req.params.id)

  let comment
  try {
    const { rows } = await db.query(
      'INSERT INTO comments (post_id, user_id, text, reply_to_id) VALUES ($1,$2,$3,$4) RETURNING *',
      [postId, req.user.id, req.body.text.trim(), replyToId]
    )
    comment = rows[0]
  } catch {
    // Fallback без reply_to_id если колонки ещё нет
    const { rows } = await db.query(
      'INSERT INTO comments (post_id, user_id, text) VALUES ($1,$2,$3) RETURNING *',
      [postId, req.user.id, req.body.text.trim()]
    )
    comment = rows[0]
  }

  // Обогащаем данными автора нового комментария
  const { rows: uRows } = await db.query(
    'SELECT first_name, username, photo_url FROM users WHERE id=$1',
    [req.user.id]
  )
  const enriched = { ...comment, ...uRows[0] }

  // SSE — всем кто смотрит этот пост
  ssePublish('new_comment', { post_id: postId, comment: enriched, by_user_id: req.user.id })

  // ════════════════════════════════════════
  // TG УВЕДОМЛЕНИЕ — если это ответ на чужой комментарий
  // ════════════════════════════════════════
  if (replyToId) {
    ;(async () => {
      try {
        const { rows: origRows } = await db.query(`
          SELECT c.text, c.user_id, u.telegram_id, u.first_name
          FROM comments c
          JOIN users u ON c.user_id = u.id
          WHERE c.id = $1
        `, [replyToId])

        const orig = origRows[0]
        if (!orig) return
        if (orig.user_id === req.user.id) return
        if (!orig.telegram_id) return

        const senderName = uRows[0]?.first_name || 'Кто-то'
        const senderUsername = uRows[0]?.username ? `@${uRows[0].username}` : ''
        const origPreview = orig.text.length > 60 ? orig.text.slice(0, 60) + '…' : orig.text
        const replyPreview = req.body.text.trim().length > 120
          ? req.body.text.trim().slice(0, 120) + '…'
          : req.body.text.trim()
        const postUrl = `${process.env.SITE_URL || 'https://botfeed.vercel.app'}?post=${postId}`

        await tgSend(
          orig.telegram_id,
          `💬 <b>${senderName}</b>${senderUsername ? ` (${senderUsername})` : ''} ответил на твой комментарий:\n\n` +
          `<i>«${origPreview}»</i>\n\n` +
          `➤ ${replyPreview}\n\n` +
          `<a href="${postUrl}">Открыть пост →</a>`,
          { inline_keyboard: [[{ text: '💬 Открыть пост', url: postUrl }]] }
        )
      } catch (e) { console.error('Reply notify error:', e.message) }
    })()
  }

  // ════════════════════════════════════════
  // TG УВЕДОМЛЕНИЕ — автору поста о новом комментарии
  // ════════════════════════════════════════
  ;(async () => {
    try {
      // Находим владельца бота (автора поста)
      const { rows: postOwnerRows } = await db.query(`
        SELECT u.id, u.telegram_id, u.first_name
        FROM posts p
        JOIN bots b ON p.bot_id = b.id
        JOIN users u ON b.owner_id = u.id
        WHERE p.id = $1
      `, [postId])

      const owner = postOwnerRows[0]
      if (!owner) return
      // Не уведомляем если автор сам себе написал
      if (owner.id === req.user.id) return
      if (!owner.telegram_id) return

      const senderName = uRows[0]?.first_name || 'Кто-то'
      const senderUsername = uRows[0]?.username ? ` (@${uRows[0].username})` : ''
      const textPreview = req.body.text.trim().length > 120
        ? req.body.text.trim().slice(0, 120) + '…'
        : req.body.text.trim()
      const postUrl = `${process.env.SITE_URL || 'https://botfeed.vercel.app'}?post=${postId}`

      await tgSend(
        owner.telegram_id,
        `🗨 <b>${senderName}</b>${senderUsername} прокомментировал твой пост:\n\n` +
        `${textPreview}\n\n` +
        `<a href="${postUrl}">Открыть пост →</a>`,
        { inline_keyboard: [[{ text: '💬 Открыть', url: postUrl }]] }
      )
    } catch (e) { console.error('Post owner comment notify error:', e.message) }
  })()

  return enriched
})

// Удаление комментария — только автор
app.delete('/api/comments/:id', { preHandler: auth }, async (req, reply) => {
  try {
    const { rows } = await db.query(
      'SELECT id, post_id FROM comments WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    )
    if (!rows[0]) return reply.code(403).send({ error: 'Нет доступа или комментарий не найден' })

    // Удаляем комментарий (replies через CASCADE или SET NULL)
    await db.query('DELETE FROM comments WHERE id=$1', [req.params.id])

    // SSE — обновляем счётчик комментариев
    const { rows: cnt } = await db.query(
      'SELECT COUNT(*) as count FROM comments WHERE post_id=$1',
      [rows[0].post_id]
    )
    ssePublish('comment_deleted', { post_id: rows[0].post_id, comment_id: parseInt(req.params.id), comments_count: parseInt(cnt[0].count) })

    return { ok: true }
  } catch (e) { return reply.code(500).send({ error: e.message }) }
})

// ════════════════════════════════
// ПОДПИСКИ
// ════════════════════════════════
app.post('/api/posts/:id/view', async (req, reply) => {
  try {
    await db.query('UPDATE posts SET views_count = COALESCE(views_count,0) + 1 WHERE id=$1', [req.params.id])
    return { ok: true }
  } catch (e) { return reply.code(500).send({ error: e.message }) }
})

app.post('/api/bots/:botId/subscribe', { preHandler: auth }, async (req, reply) => {
  try {
    const { rows } = await db.query('SELECT id FROM subscriptions WHERE user_id=$1 AND bot_id=$2', [req.user.id, parseInt(req.params.botId)])
    if (rows[0]) { await db.query('DELETE FROM subscriptions WHERE id=$1', [rows[0].id]); return { subscribed: false } }
    await db.query('INSERT INTO subscriptions (user_id, bot_id) VALUES ($1,$2)', [req.user.id, parseInt(req.params.botId)])
    return { subscribed: true }
  } catch (e) { return reply.code(500).send({ error: e.message }) }
})

app.post('/api/bots/:botId/notify', { preHandler: auth }, async (req, reply) => {
  try {
    const { rows } = await db.query('SELECT id, notify FROM subscriptions WHERE user_id=$1 AND bot_id=$2', [req.user.id, parseInt(req.params.botId)])
    if (!rows[0]) return reply.code(404).send({ error: 'Нет подписки' })
    const current = rows[0].notify !== false  // NULL и true считаем как "включено"
    const newNotify = !current
    await db.query('UPDATE subscriptions SET notify=$1 WHERE id=$2', [newNotify, rows[0].id])
    return { notify: newNotify }
  } catch (e) { return reply.code(500).send({ error: e.message }) }
})

app.get('/api/my/subscriptions', { preHandler: auth }, async (req) => {
  const { rows } = await db.query(`
    SELECT b.id, b.username, b.name, b.photo_url, b.members, b.verified,
           s.created_at as subscribed_at, COALESCE(s.notify, true) as notify
    FROM subscriptions s JOIN bots b ON s.bot_id=b.id
    WHERE s.user_id=$1 ORDER BY s.created_at DESC
  `, [req.user.id])
  return rows
})


// ════════════════════════════════════════
// SSE — Server-Sent Events (real-time)
// ════════════════════════════════════════
const sseClients = new Map() // userId (or 'guest_N') -> Set<Reply>
let guestCounter = 0

// ════════════════════════════════════════
// KEEP-ALIVE — не даём Render засыпать
// ════════════════════════════════════════
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SITE_URL || 'http://localhost:3000'
setInterval(async () => {
  try {
    await fetch(`${SELF_URL}/health`)
    console.log('[keep-alive] ping ok')
  } catch(e) {
    console.warn('[keep-alive] ping failed:', e.message)
  }
}, 10 * 60 * 1000) // каждые 10 минут

function ssePublish(event, data, targetUserIds = null) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const send = (r) => {
    try {
      if (r.raw.socket?.writable) r.raw.write(msg)
    } catch {}
  }
  if (targetUserIds) {
    for (const uid of targetUserIds) {
      const clients = sseClients.get(String(uid))
      if (clients) clients.forEach(send)
    }
  } else {
    for (const clients of sseClients.values()) {
      clients.forEach(send)
    }
  }
}

// Чистим мёртвые guest-соединения каждые 5 минут
setInterval(() => {
  for (const [uid, clients] of sseClients.entries()) {
    for (const r of clients) {
      if (!r.raw.socket?.writable) clients.delete(r)
    }
    if (clients.size === 0) sseClients.delete(uid)
  }
  console.log(`[SSE] active connections: ${[...sseClients.values()].reduce((n,s) => n + s.size, 0)}`)
}, 5 * 60 * 1000)

// SSE подключение — EventSource не поддерживает заголовки, токен идёт в query
app.get('/api/sse', async (req, reply) => {
  let userId = `guest_${++guestCounter}`
  if (req.query.token) {
    try {
      const decoded = app.jwt.verify(req.query.token)
      if (decoded?.id) userId = String(decoded.id)
    } catch {}
  }

  reply.raw.setHeader('Content-Type', 'text/event-stream')
  reply.raw.setHeader('Cache-Control', 'no-cache')
  reply.raw.setHeader('Connection', 'keep-alive')
  reply.raw.setHeader('X-Accel-Buffering', 'no')
  reply.raw.flushHeaders()

  // Регистрируем клиента
  if (!sseClients.has(userId)) sseClients.set(userId, new Set())
  sseClients.get(userId).add(reply)

  // Приветствие
  reply.raw.write(`event: connected\ndata: {"userId":"${userId}"}\n\n`)

  // Heartbeat каждые 15 сек чтобы не дропало соединение (Render убивает после 30с тишины)
  const heartbeat = setInterval(() => {
    try { reply.raw.write(': heartbeat\n\n') } catch { clearInterval(heartbeat) }
  }, 15000)

  // Cleanup при дисконнекте
  req.socket.on('close', () => {
    clearInterval(heartbeat)
    const clients = sseClients.get(userId)
    if (clients) {
      clients.delete(reply)
      if (clients.size === 0) sseClients.delete(userId)
    }
  })

  // Висим — не отвечаем
  await new Promise(() => {})
})

// SSE stats endpoint
app.get('/api/sse/stats', async () => ({
  connections: [...sseClients.values()].reduce((n, s) => n + s.size, 0),
  users: sseClients.size
}))

// ════════════════════════════════
// ЗАГРУЗКА ИЗОБРАЖЕНИЙ
// ════════════════════════════════
app.post('/api/upload/image', { preHandler: auth }, async (req, reply) => {
  try {
    if (!supabase) {
      return reply.code(503).send({ error: 'Загрузка изображений не настроена (нет SUPABASE_URL/SUPABASE_SERVICE_KEY)' })
    }

    const data = await req.file()
    if (!data) return reply.code(400).send({ error: 'Файл не найден' })

    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    if (!allowed.includes(data.mimetype)) {
      return reply.code(400).send({ error: 'Только JPEG, PNG, GIF, WebP' })
    }

    const ext = data.mimetype.split('/')[1].replace('jpeg', 'jpg')
    const filename = `posts/${req.user.id}_${Date.now()}.${ext}`

    const buf = await data.toBuffer()

    const { error: upErr } = await supabase.storage
      .from('botfeed')
      .upload(filename, buf, { contentType: data.mimetype, upsert: false })

    if (upErr) {
      console.error('Supabase upload error:', upErr)
      return reply.code(500).send({ error: 'Ошибка загрузки: ' + upErr.message })
    }

    const { data: urlData } = supabase.storage.from('botfeed').getPublicUrl(filename)
    return { ok: true, url: urlData.publicUrl }
  } catch (e) {
    console.error('Upload error:', e.message)
    return reply.code(500).send({ error: e.message })
  }
})

// Health check
app.get('/health', () => ({ status: 'ok', time: new Date().toISOString() }))

// ════════════════════════════════
// СТАТИСТИКА — реальные данные
// ════════════════════════════════
app.get('/api/stats', async () => {
  try {
    const { rows } = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM users)                          AS users,
        (SELECT COUNT(*) FROM bots WHERE verified = true)     AS bots,
        (SELECT COUNT(*) FROM posts)                          AS posts,
        (SELECT COALESCE(SUM(members), 0) FROM bots WHERE verified = true) AS members
    `)
    return {
      users:   Number(rows[0].users),
      bots:    Number(rows[0].bots),
      posts:   Number(rows[0].posts),
      members: Number(rows[0].members),
    }
  } catch (e) { return { users: 0, bots: 0, posts: 0, members: 0 } }
})

// Запуск
try {
  await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' })
} catch (err) {
  console.error(err)
  process.exit(1)
            }
