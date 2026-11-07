import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import './styles.css'

type Share = { id: string; memberId: string; amountCents: number; paidAt: string | null }
type Bill = { id: string; title: string; totalCents: number; shares: Share[] }
type BillsResponse = { bills: Bill[] }

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const [draftHomeId, setDraftHomeId] = useState('')
  const [homeId, setHomeId] = useState(
    () => new URLSearchParams(window.location.search).get('home') ?? '',
  )
  const [bills, setBills] = useState<Bill[]>([])
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [payingShareId, setPayingShareId] = useState<string | null>(null)

  useEffect(() => {
    if (!homeId) return
    const controller = new AbortController()
    setState('loading')
    setMessage('')
    fetch(`/api/homes/${encodeURIComponent(homeId)}/bills`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as BillsResponse | { error?: string }
        if (!response.ok)
          throw new Error('error' in body && body.error ? body.error : 'Could not load bills')
        return body as BillsResponse
      })
      .then((body) => {
        setBills(body.bills)
        setState('ready')
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setState('error')
        setMessage(cause instanceof Error ? cause.message : 'Could not load bills')
      })
    return () => controller.abort()
  }, [homeId])

  function loadHome(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextHomeId = draftHomeId.trim()
    if (nextHomeId) setHomeId(nextHomeId)
  }

  async function payShare(billId: string, shareId: string) {
    setPayingShareId(shareId)
    setMessage('')
    try {
      const response = await fetch(`/api/bills/${billId}/shares/${shareId}/pay`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      })
      const body = (await response.json()) as Share | { error?: string }
      if (!response.ok)
        throw new Error('error' in body && body.error ? body.error : 'Payment failed')
      const paid = body as Share
      setBills((current) =>
        current.map((bill) => ({
          ...bill,
          shares: bill.shares.map((share) =>
            share.id === shareId ? { ...share, paidAt: paid.paidAt } : share,
          ),
        })),
      )
    } catch (cause: unknown) {
      setMessage(cause instanceof Error ? cause.message : 'Payment failed')
    } finally {
      setPayingShareId(null)
    }
  }

  return (
    <main className="shell">
      <header className="masthead">
        <p className="eyebrow">Shared home ledger</p>
        <h1>Every share, accounted for.</h1>
        <p className="lede">
          See what is due for this home and settle your share when it is ready.
        </p>
      </header>

      <form className="lookup" onSubmit={loadHome}>
        <label htmlFor="home-id">Home ID</label>
        <div className="lookup-row">
          <input
            id="home-id"
            value={draftHomeId}
            onChange={(event) => setDraftHomeId(event.target.value)}
            placeholder="Paste a home ID"
            spellCheck={false}
          />
          <button type="submit">View bills</button>
        </div>
      </form>

      {state === 'idle' && (
        <section className="state-panel">
          <span className="state-mark">+</span>
          <h2>Choose a home</h2>
          <p>Enter a home ID to see its current bills.</p>
        </section>
      )}
      {state === 'loading' && (
        <section className="state-panel">
          <span className="spinner" />
          <h2>Loading bills</h2>
          <p>Checking the latest balances.</p>
        </section>
      )}
      {state === 'error' && (
        <section className="state-panel error-panel">
          <span className="state-mark">!</span>
          <h2>Could not load this home</h2>
          <p>{message}</p>
        </section>
      )}
      {state === 'ready' && bills.length === 0 && (
        <section className="state-panel">
          <span className="state-mark">0</span>
          <h2>No bills yet</h2>
          <p>This home does not have any bills to split.</p>
        </section>
      )}
      {message && state === 'ready' && (
        <p className="notice" role="alert">
          {message}
        </p>
      )}
      {state === 'ready' && bills.length > 0 && (
        <section className="bill-list" aria-label="Bills">
          {bills.map((bill) => (
            <article className="bill" key={bill.id}>
              <div className="bill-heading">
                <div>
                  <p className="bill-kicker">Bill</p>
                  <h2>{bill.title}</h2>
                </div>
                <strong>${(bill.totalCents / 100).toFixed(2)}</strong>
              </div>
              <div className="shares">
                {bill.shares.map((share) => (
                  <div className={`share ${share.paidAt ? 'paid' : ''}`} key={share.id}>
                    <div>
                      <p className="share-name">Member</p>
                      <p className="share-id">{share.memberId.slice(0, 8)}</p>
                    </div>
                    <strong>${(share.amountCents / 100).toFixed(2)}</strong>
                    {share.paidAt ? (
                      <span className="paid-label">Paid</span>
                    ) : (
                      <button
                        type="button"
                        disabled={payingShareId !== null}
                        onClick={() => payShare(bill.id, share.id)}
                      >
                        {payingShareId === share.id ? 'Paying...' : 'Pay share'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  )
}
