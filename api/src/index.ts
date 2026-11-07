import type { Context } from 'hono'
import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

type Home = { id: string; name: string }
type Member = { id: string; homeId: string; name: string }
type Share = { id: string; memberId: string; amountCents: number; paidAt: string | null }
type Bill = { id: string; homeId: string; title: string; totalCents: number; shares: Share[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return isRecord(body) ? body : null
  } catch {
    return null
  }
}

function error(c: Context<{ Bindings: Env }>, status: 400 | 404 | 409 | 422, message: string) {
  return c.json({ error: message }, status)
}

async function homeExists(db: D1Database, id: string) {
  const result = await db
    .prepare('SELECT id FROM homes WHERE id = ?')
    .bind(id)
    .first<{ id: string }>()
  return result !== null
}

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.post('/api/homes', async (c) => {
  const body = await jsonBody(c.req.raw)
  if (typeof body?.name !== 'string' || body.name.trim() === '')
    return error(c, 422, 'name is required')

  const home: Home = { id: crypto.randomUUID(), name: body.name.trim() }
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
    .bind(home.id, home.name)
    .run()
  return c.json(home, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  if (!(await homeExists(c.env.DB, homeId))) return error(c, 404, 'home not found')
  const body = await jsonBody(c.req.raw)
  if (typeof body?.name !== 'string' || body.name.trim() === '')
    return error(c, 422, 'name is required')

  const member: Member = { id: crypto.randomUUID(), homeId, name: body.name.trim() }
  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
    .bind(member.id, member.homeId, member.name)
    .run()
  return c.json(member, 201)
})

app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  if (!(await homeExists(c.env.DB, homeId))) return error(c, 404, 'home not found')
  const body = await jsonBody(c.req.raw)
  if (
    typeof body?.title !== 'string' ||
    body.title.trim() === '' ||
    typeof body.totalCents !== 'number' ||
    !Number.isSafeInteger(body.totalCents) ||
    body.totalCents <= 0
  ) {
    return error(c, 422, 'totalCents must be a positive whole number')
  }

  const members = await c.env.DB.prepare('SELECT id FROM members WHERE home_id = ? ORDER BY rowid')
    .bind(homeId)
    .all<{ id: string }>()
  if (members.results.length === 0) return error(c, 422, 'home has no members')

  const billId = crypto.randomUUID()
  const base = Math.floor(body.totalCents / members.results.length)
  const remainder = body.totalCents % members.results.length
  const bill: Bill = {
    id: billId,
    homeId,
    title: body.title.trim(),
    totalCents: body.totalCents,
    shares: members.results.map((member, index) => ({
      id: crypto.randomUUID(),
      memberId: member.id,
      amountCents: base + (index < remainder ? 1 : 0),
      paidAt: null,
    })),
  }

  const statements = [
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
    ).bind(bill.id, bill.homeId, bill.title, bill.totalCents),
    ...bill.shares.map((share) =>
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      ).bind(share.id, bill.id, share.memberId, share.amountCents),
    ),
  ]
  await c.env.DB.batch(statements)
  return c.json(bill, 201)
})

async function billsForHome(db: D1Database, homeId: string): Promise<Bill[]> {
  const bills = await db
    .prepare('SELECT id, home_id, title, total_cents FROM bills WHERE home_id = ? ORDER BY rowid')
    .bind(homeId)
    .all<{ id: string; home_id: string; title: string; total_cents: number }>()
  const result: Bill[] = []
  for (const bill of bills.results) {
    const shares = await db
      .prepare(
        'SELECT id, member_id, amount_cents, paid_at FROM shares WHERE bill_id = ? ORDER BY rowid',
      )
      .bind(bill.id)
      .all<{ id: string; member_id: string; amount_cents: number; paid_at: string | null }>()
    result.push({
      id: bill.id,
      homeId: bill.home_id,
      title: bill.title,
      totalCents: bill.total_cents,
      shares: shares.results.map((share) => ({
        id: share.id,
        memberId: share.member_id,
        amountCents: share.amount_cents,
        paidAt: share.paid_at,
      })),
    })
  }
  return result
}

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  if (!(await homeExists(c.env.DB, homeId))) return error(c, 404, 'home not found')
  return c.json({ bills: await billsForHome(c.env.DB, homeId) })
})

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const key = c.req.header('Idempotency-Key')
  if (!key) return error(c, 400, 'Idempotency-Key header is required')
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const share = await c.env.DB.prepare(
    'SELECT id, bill_id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
  )
    .bind(shareId, billId)
    .first<{
      id: string
      bill_id: string
      member_id: string
      amount_cents: number
      paid_at: string | null
      idempotency_key: string | null
    }>()
  if (!share) return error(c, 404, 'bill or share not found')
  if (share.paid_at) {
    if (share.idempotency_key === key)
      return c.json({
        id: share.id,
        memberId: share.member_id,
        amountCents: share.amount_cents,
        paidAt: share.paid_at,
      })
    return error(c, 409, 'share is already paid')
  }

  const paidAt = new Date().toISOString()
  const updated = await c.env.DB.prepare(
    'UPDATE shares SET paid_at = ?, idempotency_key = ? WHERE id = ? AND bill_id = ? AND paid_at IS NULL',
  )
    .bind(paidAt, key, shareId, billId)
    .run()
  if (updated.meta.changes === 0) {
    const current = await c.env.DB.prepare(
      'SELECT member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ?',
    )
      .bind(shareId)
      .first<{
        member_id: string
        amount_cents: number
        paid_at: string
        idempotency_key: string
      }>()
    if (current?.idempotency_key === key)
      return c.json({
        id: shareId,
        memberId: current.member_id,
        amountCents: current.amount_cents,
        paidAt: current.paid_at,
      })
    return error(c, 409, 'share is already paid')
  }
  return c.json({
    id: share.id,
    memberId: share.member_id,
    amountCents: share.amount_cents,
    paidAt,
  })
})

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  if (!(await homeExists(c.env.DB, homeId))) return error(c, 404, 'home not found')
  const rows = await c.env.DB.prepare(`
		SELECT members.id AS member_id, members.name,
			COALESCE(SUM(CASE WHEN shares.paid_at IS NULL THEN shares.amount_cents ELSE 0 END), 0) AS outstanding_cents
		FROM members
		LEFT JOIN shares ON shares.member_id = members.id
		LEFT JOIN bills ON bills.id = shares.bill_id AND bills.home_id = members.home_id
		WHERE members.home_id = ?
		GROUP BY members.id, members.name
		ORDER BY members.rowid
	`)
    .bind(homeId)
    .all<{ member_id: string; name: string; outstanding_cents: number }>()
  return c.json({
    balances: rows.results.map((row) => ({
      memberId: row.member_id,
      name: row.name,
      outstandingCents: row.outstanding_cents,
    })),
  })
})

export default app
