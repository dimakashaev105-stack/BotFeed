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

// Авто-миграция: добавляем google_id и email если нет
db.query(`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_idx ON users(google_id) WHERE google_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users(email) WHERE email IS NOT NULL;
`).then(() => console.log('✅ Миграция OK')).catch(e => console.log('Migration note:', e.message))

// Таблица для Telegram OTP кодов
try {
  await db.query(`
    CREATE TABLE IF NOT EXISTS email_otp (
      email TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tg_otp (
      session_id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      telegram_id BIGINT,
      first_name TEXT,
      username TEXT,
      photo_url TEXT,
      expires BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `)
  console.log('✅ OTP tables OK')
} catch(e) {
  console.log('OTP table note:', e.message)
}

// In-memory fallback
const emailCodes = new Map()
const tgOtpMap   = new Map()

// ════════════════════════════════
// TELEGRAM BOT (уведомления админу)
// ════════════════════════════════
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN  // токен @BotFeeds_bot
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID    // твой Telegram ID (число)

async function tgSend(chatId, text, replyMarkup) {
  if (!TG_TOKEN || !chatId) return
  try {
    const body = { chat_id: String(chatId), text, parse_mode: 'HTML' }
    if (replyMarkup) body.reply_markup = replyMarkup
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const json = await res.json()
    if (!json.ok) console.error('TG error:', json.description)
  } catch (e) {
    console.error('TG send error:', e.message)
  }
}

async function tgEditMessage(chatId, messageId, text) {
  if (!TG_TOKEN) return
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), message_id: messageId, text, parse_mode: 'HTML' })
    })
  } catch (e) {
    console.error('TG edit error:', e.message)
  }
}

async function tgAnswerCallback(callbackId, text) {
  if (!TG_TOKEN) return
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackId, text })
    })
  } catch (e) {}
}

// ════════════════════════════════
// CORS — открытый для всех
// ════════════════════════════════
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
// TELEGRAM WEBHOOK (кнопки одобрить/отклонить)
// ════════════════════════════════
app.post('/api/tg/webhook', async (req, reply) => {
  try {
    const update = req.body
    const cb  = update.callback_query
    const msg = update.message

    // ── Обработка /start LOGIN_<sessionId> ──
    if (msg?.text?.startsWith('/start LOGIN_')) {
      const sessionId = msg.text.replace('/start LOGIN_', '').trim()
      const chatId    = msg.chat.id
      const from      = msg.from

      // Ищем сессию
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

      // Получаем фото профиля пользователя
      let photo_url = null
      try {
        const photosRes  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUserProfilePhotos?user_id=${chatId}&limit=1`)
        const photosData = await photosRes.json()
        const fileId     = photosData?.result?.photos?.[0]?.[2]?.file_id || photosData?.result?.photos?.[0]?.[0]?.file_id
        if (fileId) {
          const fileRes  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${fileId}`)
          const fileData = await fileRes.json()
          if (fileData?.result?.file_path) {
            photo_url = `https://api.telegram.org/file/bot${TG_TOKEN}/${fileData.result.file_path}`
          }
        }
      } catch {}

      // Сохраняем данные пользователя и отправляем код
      const code = String(Math.floor(100000 + Math.random() * 900000))
      const updated = {
        ...session,
        code,
        telegram_id: chatId,
        first_name:  from.first_name || '',
        username:    from.username   || null,
        photo_url,
        expires:     Date.now() + 10 * 60 * 1000
      }
      tgOtpMap.set(sessionId, updated)
      try {
        await db.query(`
          INSERT INTO tg_otp (session_id, code, telegram_id, first_name, username, photo_url, expires)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (session_id) DO UPDATE SET
            code=$2, telegram_id=$3, first_name=$4, username=$5, photo_url=$6, expires=$7
        `, [sessionId, code, chatId, updated.first_name, updated.username, null, updated.expires])
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

    // ── Обработка callback кнопок (одобрить/отклонить бота) ──
    if (!cb) return { ok: true }

    const data = cb.data || ''
    const [action, botId] = data.split(':')
    const msgId  = cb.message?.message_id
    const chatId = cb.message?.chat?.id

    if (!botId || !['approve', 'reject'].includes(action)) {
      await tgAnswerCallback(cb.id, '⚠️ Неизвестное действие')
      return { ok: true }
    }

    // Получаем данные бота и его владельца
    const { rows } = await db.query(`
      SELECT b.id, b.name, b.username, b.description, b.categories,
             u.telegram_id, u.first_name
      FROM bots b JOIN users u ON b.owner_id = u.id
      WHERE b.id = $1
    `, [botId])

    const b = rows[0]
    if (!b) {
      await tgAnswerCallback(cb.id, '⚠️ Бот не найден')
      return { ok: true }
    }

    if (action === 'approve') {
      await db.query('UPDATE bots SET verified=true WHERE id=$1', [botId])

      // Редактируем сообщение у себя
      await tgEditMessage(chatId, msgId,
        `✅ <b>ОДОБРЕНО</b>\n\n` +
        `Бот: <b>${b.name}</b> (@${b.username})\n` +
        `Владелец: ${b.first_name}\n` +
        `Статус: верифицирован ✓`
      )

      // Уведомляем владельца
      await tgSend(b.telegram_id,
        `🎉 <b>Поздравляем! Бот верифицирован</b>\n\n` +
        `Ваш бот <b>${b.name}</b> (@${b.username}) прошёл проверку и теперь отображается в каталоге BotFeed с галочкой верификации ✓\n\n` +
        `Открыть BotFeed → https://t.me/BotFeeds_bot`
      )

      await tgAnswerCallback(cb.id, '✅ Бот одобрен!')

    } else if (action === 'reject') {
      await db.query('UPDATE bots SET verified=false WHERE id=$1', [botId])

      // Редактируем сообщение у себя
      await tgEditMessage(chatId, msgId,
        `❌ <b>ОТКЛОНЕНО</b>\n\n` +
        `Бот: <b>${b.name}</b> (@${b.username})\n` +
        `Владелец: ${b.first_name}\n` +
        `Статус: верификация отказана`
      )

      // Уведомляем владельца
      await tgSend(b.telegram_id,
        `❌ <b>Верификация отклонена</b>\n\n` +
        `Бот <b>${b.name}</b> (@${b.username}) не прошёл проверку.\n\n` +
        `Если вы считаете что это ошибка — напишите в поддержку.`
      )

      await tgAnswerCallback(cb.id, '❌ Отклонено')
    }

  } catch (e) {
    console.error('Webhook error:', e.message)
  }
  return { ok: true }
})

// ════════════════════════════════
// AUTH
// ════════════════════════════════

// ════════════════════════════════
// AUTH — Email OTP (через Resend)
// ════════════════════════════════

// Отправка кода на email
app.post('/api/auth/email/send', async (req, reply) => {
  try {
    const { email } = req.body
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ error: 'Некорректный email' })
    }

    // Генерируем 6-значный код
    const code    = String(Math.floor(100000 + Math.random() * 900000))
    const expires = Date.now() + 10 * 60 * 1000 // 10 минут
    const key     = email.toLowerCase()

    // Отправляем через Resend
    const resendKey = process.env.RESEND_API_KEY
    if (!resendKey) return reply.code(500).send({ error: 'RESEND_API_KEY не настроен' })

    const r = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + resendKey,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        from:    'BotFeed <onboarding@resend.dev>',
        to:      [email],
        subject: 'Код входа в BotFeed: ' + code,
        html:    `
          <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px;">
            <h2 style="color:#2ea6ff;margin-bottom:8px;">BotFeed</h2>
            <p style="color:#666;margin-bottom:24px;">Каталог Telegram-ботов</p>
            <p style="font-size:16px;color:#333;">Твой код для входа:</p>
            <div style="background:#f4f4f4;border-radius:12px;padding:24px;text-align:center;margin:16px 0;">
              <span style="font-size:40px;font-weight:900;letter-spacing:8px;color:#1a1a1a;">${code}</span>
            </div>
            <p style="color:#999;font-size:13px;">Код действителен 10 минут. Если ты не запрашивал вход — просто игнорируй это письмо.</p>
          </div>
        `
      })
    })

    const rData = await r.json()
    console.log('Resend response status:', r.status, 'body:', JSON.stringify(rData))
    if (!r.ok || rData.error) {
      console.error('Resend error:', rData)
      return reply.code(500).send({ error: 'Ошибка отправки письма: ' + (rData.error?.message || rData.message || JSON.stringify(rData)) })
    }

    // Письмо отправлено — сохраняем код (БД + fallback в память)
    emailCodes.set(key, { code, expires })
    console.log('Code saved for:', key, '| code:', code)
    try {
      await db.query(
        `INSERT INTO email_otp (email, code, expires) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET code = $2, expires = $3, created_at = NOW()`,
        [key, code, expires]
      )
    } catch(dbErr) {
      console.warn('OTP DB save failed, using memory fallback:', dbErr.message)
    }

    console.log('✅ Email code sent to:', email)
    return { ok: true }
  } catch (e) {
    console.error('Send email error:', e.message)
    return reply.code(500).send({ error: 'Ошибка сервера: ' + e.message })
  }
})

// Проверка кода и вход
app.post('/api/auth/email/verify', async (req, reply) => {
  try {
    const { email, code } = req.body
    if (!email || !code) return reply.code(400).send({ error: 'Нет email или кода' })

    const key         = email.toLowerCase().trim()
    const codeClean   = String(code).replace(/\D/g, '').trim()

    console.log('Verify attempt — email:', key, '| code received:', JSON.stringify(code), '| cleaned:', codeClean)

    // Ищем код: сначала в БД, потом в памяти (fallback)
    let entry = null
    try {
      const { rows: otpRows } = await db.query(
        'SELECT code, expires FROM email_otp WHERE email = $1',
        [key]
      )
      if (otpRows[0]) entry = otpRows[0]
    } catch(dbErr) {
      console.warn('OTP DB read failed:', dbErr.message)
    }
    // Fallback на память
    if (!entry && emailCodes.has(key)) {
      entry = emailCodes.get(key)
    }

    if (!entry)                            return reply.code(400).send({ error: 'Код не найден. Запроси новый.' })
    if (Date.now() > Number(entry.expires)) {
      await db.query('DELETE FROM email_otp WHERE email = $1', [key]).catch(() => {})
      emailCodes.delete(key)
      return reply.code(400).send({ error: 'Код истёк. Запроси новый.' })
    }
    console.log('Stored code:', entry.code, '| Received code:', codeClean, '| Match:', entry.code === codeClean)
    if (entry.code !== codeClean) return reply.code(400).send({ error: 'Неверный код' })

    // Код верный — удаляем отовсюду
    await db.query('DELETE FROM email_otp WHERE email = $1', [key]).catch(() => {})
    emailCodes.delete(key)

    // Генерируем username из email
    const baseUsername = key.split('@')[0].replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 25)

    // Upsert пользователя по email
    const { rows } = await db.query(`
      INSERT INTO users (email, username, first_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
      RETURNING *
    `, [key, baseUsername, baseUsername])

    const user  = rows[0]
    const token = app.jwt.sign({ id: user.id, telegram_id: user.telegram_id }, { expiresIn: '30d' })

    console.log('✅ Email auth:', user.email)
    return {
      token,
      user: { id: user.id, first_name: user.first_name, username: user.username, photo_url: user.photo_url }
    }
  } catch (e) {
    console.error('Verify email error:', e.message)
    return reply.code(500).send({ error: 'Ошибка сервера: ' + e.message })
  }
})

// ════════════════════════════════
// AUTH — Telegram OTP через бота
// ════════════════════════════════

// Шаг 1: создаём сессию, отдаём sessionId и ссылку на бота
app.post('/api/auth/tg/start', async (req, reply) => {
  try {
    const sessionId = crypto.randomBytes(16).toString('hex')
    const expires   = Date.now() + 15 * 60 * 1000 // 15 минут
    const entry     = { session_id: sessionId, code: null, telegram_id: null, expires }

    tgOtpMap.set(sessionId, entry)
    try {
      await db.query(`
        INSERT INTO tg_otp (session_id, code, expires)
        VALUES ($1, $2, $3)
        ON CONFLICT (session_id) DO UPDATE SET expires=$3
      `, [sessionId, '', expires])
    } catch {}

    return {
      ok: true,
      sessionId,
      botUrl: `https://t.me/BotFeeds_bot?start=LOGIN_${sessionId}`
    }
  } catch (e) {
    return reply.code(500).send({ error: e.message })
  }
})

// Шаг 2: проверяем код
app.post('/api/auth/tg/verify', async (req, reply) => {
  try {
    const { sessionId, code } = req.body
    if (!sessionId || !code) return reply.code(400).send({ error: 'Нет данных' })

    const codeClean = String(code).replace(/\D/g, '').trim()

    // Ищем сессию
    let session = tgOtpMap.get(sessionId)
    if (!session) {
      try {
        const { rows } = await db.query('SELECT * FROM tg_otp WHERE session_id=$1', [sessionId])
        if (rows[0]) session = rows[0]
      } catch {}
    }

    if (!session)                          return reply.code(400).send({ error: 'Сессия не найдена. Начни заново.' })
    if (Date.now() > Number(session.expires)) return reply.code(400).send({ error: 'Код истёк. Начни заново.' })
    if (!session.code)                     return reply.code(400).send({ error: 'Код ещё не получен. Открой бота.' })
    if (session.code !== codeClean)        return reply.code(400).send({ error: 'Неверный код' })

    // Код верный — удаляем сессию
    tgOtpMap.delete(sessionId)
    db.query('DELETE FROM tg_otp WHERE session_id=$1', [sessionId]).catch(() => {})

    // Upsert пользователя
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
    return {
      token,
      user: { id: user.id, first_name: user.first_name, username: user.username, photo_url: user.photo_url }
    }
  } catch (e) {
    console.error('TG verify error:', e.message)
    return reply.code(500).send({ error: e.message })
  }
})


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
    'SELECT id, first_name, last_name, username, photo_url, telegram_id FROM users WHERE id = $1',
    [req.user.id]
  )
  const user = rows[0]
  if (!user) return null

  // Обновляем фото из Telegram если есть telegram_id
  if (user.telegram_id && TG_TOKEN) {
    try {
      const photosRes  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUserProfilePhotos?user_id=${user.telegram_id}&limit=1`)
      const photosData = await photosRes.json()
      const fileId     = photosData?.result?.photos?.[0]?.[2]?.file_id || photosData?.result?.photos?.[0]?.[0]?.file_id
      if (fileId) {
        const fileRes  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${fileId}`)
        const fileData = await fileRes.json()
        if (fileData?.result?.file_path) {
          const newPhoto = `https://api.telegram.org/file/bot${TG_TOKEN}/${fileData.result.file_path}`
          if (newPhoto !== user.photo_url) {
            await db.query('UPDATE users SET photo_url=$1 WHERE id=$2', [newPhoto, user.id])
            user.photo_url = newPhoto
          }
        }
      }
    } catch {}
  }

  return { id: user.id, first_name: user.first_name, last_name: user.last_name, username: user.username, photo_url: user.photo_url }
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

    // Только Telegram-пользователи могут добавлять ботов
    const { rows: me } = await db.query('SELECT telegram_id FROM users WHERE id = $1', [req.user.id])
    if (!me[0]?.telegram_id) {
      return reply.code(403).send({ error: 'Для добавления бота нужно войти через Telegram' })
    }

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
  try {
    const { name, description, long_desc, categories } = req.body

    const { rows: cur } = await db.query(
      'SELECT * FROM bots WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    )
    if (!cur[0]) return reply.code(404).send({ error: 'Бот не найден' })

    const { rows } = await db.query(`
      UPDATE bots SET
        name        = $1,
        description = $2,
        long_desc   = $3,
        categories  = $4
      WHERE id=$5 AND owner_id=$6
      RETURNING *
    `, [
      name        ?? cur[0].name,
      description ?? cur[0].description,
      long_desc   ?? cur[0].long_desc,
      categories  ?? cur[0].categories,
      req.params.id,
      req.user.id
    ])
    return rows[0]
  } catch (e) {
    console.error('PUT /bots/:id error:', e.message)
    return reply.code(500).send({ error: e.message })
  }
})

// Удалить бота
app.delete('/api/bots/:id', { preHandler: auth }, async (req, reply) => {
  try {
    const { rows } = await db.query(
      'SELECT id FROM bots WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'Бот не найден или нет доступа' })

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

// ════════════════════════════════
// ВЕРИФИКАЦИЯ — теперь с уведомлением админу
// ════════════════════════════════

// Глобальный хук: разрешаем пустое тело для POST запросов верификации
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    done(null, body ? JSON.parse(body) : {})
  } catch (e) {
    done(null, {})
  }
})

app.post('/api/bots/:id/verify/request', { preHandler: auth }, async (req, reply) => {
  try {
    const { rows } = await db.query(
      'SELECT b.*, u.first_name, u.username as owner_username, u.telegram_id FROM bots b JOIN users u ON b.owner_id = u.id WHERE b.id = $1 AND b.owner_id = $2',
      [req.params.id, req.user.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'Бот не найден' })
    const b = rows[0]

    // Генерируем токен верификации
    const verifyToken = crypto.randomBytes(12).toString('hex')
    await db.query('UPDATE bots SET verify_token=$1 WHERE id=$2', [verifyToken, req.params.id])

    console.log('Verify request: bot', b.username, '| ADMIN_CHAT_ID:', ADMIN_CHAT_ID, '| TG_TOKEN set:', !!TG_TOKEN)

    // Отправляем уведомление админу с кнопками
    if (ADMIN_CHAT_ID && TG_TOKEN) {
      const cats = (b.categories || []).join(', ') || 'не указаны'
      await tgSend(
        ADMIN_CHAT_ID,
        `🔔 <b>Новая заявка на верификацию!</b>\n\n` +
        `Бот: <b>${b.name}</b> (@${b.username})\n` +
        `Описание: ${b.description || '—'}\n` +
        `Категории: ${cats}\n` +
        `Владелец: ${b.first_name}${b.owner_username ? ` (@${b.owner_username})` : ''}\n` +
        `Ссылка: https://t.me/${b.username}\n\n` +
        `Токен верификации: <code>${verifyToken}</code>`,
        {
          inline_keyboard: [[
            { text: '✅ Одобрить', callback_data: `approve:${b.id}` },
            { text: '❌ Отклонить', callback_data: `reject:${b.id}` }
          ]]
        }
      )
    } else {
      console.warn('TG не настроен. ADMIN_CHAT_ID:', ADMIN_CHAT_ID, 'TG_TOKEN:', !!TG_TOKEN)
    }

    return { ok: true, code: verifyToken }
  } catch (e) {
    console.error('Verify request error:', e.message)
    return reply.code(500).send({ error: e.message })
  }
})

// Verify confirm — пользователь нажал "Проверить" (для совместимости оставляем)
app.post('/api/bots/:id/verify/confirm', { preHandler: auth }, async (req, reply) => {
  try {
    // Проверяем токен в описании бота через Telegram API
    const { rows } = await db.query(
      'SELECT b.*, u.telegram_id FROM bots b JOIN users u ON b.owner_id = u.id WHERE b.id = $1 AND b.owner_id = $2',
      [req.params.id, req.user.id]
    )
    if (!rows[0]) return reply.code(404).send({ error: 'Бот не найден' })
    const b = rows[0]

    if (!TG_TOKEN || !b.verify_token) {
      return { ok: true, pending: true, message: 'Заявка отправлена на проверку' }
    }

    // Проверяем описание бота в Telegram
    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getChat?chat_id=@${b.username}`)
      const tgData = await tgRes.json()
      const desc = tgData?.result?.description || ''

      if (desc.includes(b.verify_token)) {
        // Токен найден — подтверждаем верификацию автоматически
        await db.query('UPDATE bots SET verified=true WHERE id=$1', [req.params.id])

        // Уведомляем себя
        if (ADMIN_CHAT_ID) {
          await tgSend(ADMIN_CHAT_ID,
            `✅ <b>Авто-верификация прошла</b>\n\nБот @${b.username} подтвердил владение через токен в описании.`
          )
        }

        return { ok: true, verified: true, message: 'Бот верифицирован!' }
      } else {
        return { ok: false, verified: false, message: 'Токен не найден в описании бота. Заявка ожидает ручной проверки.' }
      }
    } catch (tgErr) {
      // Не смогли проверить — ждём ручной проверки
      return { ok: true, pending: true, message: 'Заявка отправлена. Мы проверим вручную.' }
    }

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

app.get('/api/feed', { preHandler: optAuth }, async (req) => {
  try {
    const { limit = 20, offset = 0 } = req.query
    // Если авторизован — посты подписок, иначе — все посты
    if (req.user?.id) {
      const { rows } = await db.query(`
        SELECT p.*,
          b.name as bot_name, b.username as bot_username, b.id as bot_id,
          b.photo_url as bot_photo, b.verified as bot_verified,
          COALESCE(
            json_agg(DISTINCT jsonb_build_object('emoji', r.emoji, 'count', r.cnt))
            FILTER (WHERE r.emoji IS NOT NULL), '[]'
          ) as reactions,
          COUNT(DISTINCT c.id) as comments_count,
          COALESCE(
            json_agg(DISTINCT mr.emoji) FILTER (WHERE mr.emoji IS NOT NULL), '[]'
          ) as my_reactions
        FROM posts p
        JOIN bots b ON p.bot_id = b.id
        JOIN subscriptions s ON b.id = s.bot_id AND s.user_id = $1
        LEFT JOIN (
          SELECT post_id, emoji, COUNT(*) as cnt FROM reactions GROUP BY post_id, emoji
        ) r ON p.id = r.post_id
        LEFT JOIN comments c ON p.id = c.post_id
        LEFT JOIN reactions mr ON p.id = mr.post_id AND mr.user_id = $1
        GROUP BY p.id, b.name, b.username, b.id, b.photo_url, b.verified
        ORDER BY p.created_at DESC
        LIMIT $2 OFFSET $3
      `, [req.user.id, Number(limit), Number(offset)])
      return rows
    } else {
      const { rows } = await db.query(`
        SELECT p.*,
          b.name as bot_name, b.username as bot_username, b.id as bot_id,
          b.photo_url as bot_photo, b.verified as bot_verified,
          COALESCE(
            json_agg(DISTINCT jsonb_build_object('emoji', r.emoji, 'count', r.cnt))
            FILTER (WHERE r.emoji IS NOT NULL), '[]'
          ) as reactions,
          COUNT(DISTINCT c.id) as comments_count,
          '[]'::json as my_reactions
        FROM posts p
        JOIN bots b ON p.bot_id = b.id
        LEFT JOIN (
          SELECT post_id, emoji, COUNT(*) as cnt FROM reactions GROUP BY post_id, emoji
        ) r ON p.id = r.post_id
        LEFT JOIN comments c ON p.id = c.post_id
        WHERE b.verified = true
        GROUP BY p.id, b.name, b.username, b.id, b.photo_url, b.verified
        ORDER BY p.created_at DESC
        LIMIT $1 OFFSET $2
      `, [Number(limit), Number(offset)])
      return rows
    }
  } catch (e) {
    console.error('Feed error:', e.message)
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
  const { text, image_url, post_type } = req.body
  if (!text?.trim()) return reply.code(400).send({ error: 'Текст обязателен' })

  const { rows: b } = await db.query(
    'SELECT id FROM bots WHERE id = $1 AND owner_id = $2',
    [req.params.botId, req.user.id]
  )
  if (!b[0]) return reply.code(403).send({ error: 'Нет доступа' })

  // Добавляем post_type если колонка есть (безопасный INSERT)
  let rows
  try {
    const r = await db.query(
      'INSERT INTO posts (bot_id, text, image_url, post_type) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.params.botId, text.trim(), image_url || null, post_type || null]
    )
    rows = r.rows
  } catch {
    // Если колонки нет — вставляем без неё
    const r = await db.query(
      'INSERT INTO posts (bot_id, text, image_url) VALUES ($1, $2, $3) RETURNING *',
      [req.params.botId, text.trim(), image_url || null]
    )
    rows = r.rows
  }
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
app.post('/api/bots/:botId/subscribe', { preHandler: auth }, async (req, reply) => {
  try {
    const userId = req.user.id
    const botId = parseInt(req.params.botId)

    const { rows } = await db.query(
      'SELECT id FROM subscriptions WHERE user_id=$1 AND bot_id=$2',
      [userId, botId]
    )

    if (rows[0]) {
      await db.query('DELETE FROM subscriptions WHERE id=$1', [rows[0].id])
      return { subscribed: false }
    } else {
      await db.query(
        'INSERT INTO subscriptions (user_id, bot_id) VALUES ($1, $2)',
        [userId, botId]
      )
      return { subscribed: true }
    }
  } catch (e) {
    console.error('Subscribe error:', e.message)
    return reply.code(500).send({ error: e.message })
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
