import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Clipboard,
  Download,
  FileCheck2,
  Hash,
  LoaderCircle,
  LockKeyhole,
  Phone,
  RotateCw,
  ShieldCheck,
  Ticket,
  X,
} from 'lucide-react';
import { api, copyText, downloadJson, shortHash, verifyReceipt, wait } from './lib.js';

function Modal({ children, onClose, label, className = '' }) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal-card ${className}`} role="dialog" aria-modal="true" aria-label={label}>
        <button className="modal-close icon-button" type="button" onClick={onClose} aria-label="Close dialog">
          <X size={20} />
        </button>
        {children}
      </section>
    </div>
  );
}

function MpesaMark() {
  return (
    <span className="mpesa-mark" aria-label="M-Pesa">
      <span className="mpesa-dot" />
      M-PESA
    </span>
  );
}

export function PaymentModal({ open, onClose, campaign, onEntry, onSpinReady }) {
  const [step, setStep] = useState('form');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [entry, setEntry] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open && (!entry || entry.paymentStatus === 'failed' || entry.paymentStatus === 'review')) {
      setStep('form');
      setError('');
    }
  }, [open, entry]);

  useEffect(() => {
    if (step !== 'waiting' || !entry?.id) return undefined;
    let cancelled = false;

    const finish = (paidEntry) => {
      if (cancelled) return;
      setEntry(paidEntry);
      onEntry(paidEntry);
      setStep('ready');
    };

    const monitorPayment = async () => {
      try {
        if (campaign.paymentMode === 'demo') {
          await wait(1400);
          const response = await api('/api/demo/complete-payment', {
            method: 'POST',
            body: JSON.stringify({ entryId: entry.id }),
          });
          finish(response.entry);
          return;
        }

        const startedAt = Date.now();
        while (!cancelled && Date.now() - startedAt < 120_000) {
          const response = await api(`/api/entries/${entry.id}`);
          if (response.entry.paymentStatus === 'paid') {
            finish(response.entry);
            return;
          }
          if (['failed', 'review'].includes(response.entry.paymentStatus)) {
            throw new Error(response.entry.failureReason || 'Payment was not completed.');
          }
          await wait(1600);
        }
        if (!cancelled) throw new Error('Still waiting for Paystack confirmation. If you completed payment, keep this page open and check again shortly.');
      } catch (paymentError) {
        if (!cancelled) {
          setError(paymentError.message);
          setStep('form');
        }
      }
    };

    monitorPayment();
    return () => {
      cancelled = true;
    };
  }, [step, entry?.id, campaign.paymentMode, onEntry]);

  if (!open) return null;

  const submitPayment = async (event) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const response = await api('/api/payments/initiate', {
        method: 'POST',
        body: JSON.stringify({ phone, email: campaign.paymentMode === 'live' ? email : undefined, acceptedTerms: accepted }),
      });
      setEntry(response.entry);
      onEntry(response.entry);
      setStep('waiting');
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose} label="Pay and enter the ticket drop" className="payment-modal">
      <div className="modal-kicker">
        <MpesaMark />
        <span>PAYSTACK · ENTRY CHECKOUT</span>
      </div>
      <div className="checkout-steps" aria-label="Checkout progress">
        <span className="active"><b>1</b> Pay</span>
        <i />
        <span className={step === 'ready' ? 'active' : ''}><b>2</b> Spin</span>
        <i />
        <span><b>3</b> Result</span>
      </div>

      {step === 'form' && (
        <form onSubmit={submitPayment}>
          <h2>One payment. One spin.</h2>
          <p className="modal-intro">Enter your M-Pesa number{campaign.paymentMode === 'live' ? ' and email' : ''}. Paystack will send a payment prompt directly to your phone.</p>

          <div className="order-summary">
            <div className="order-icon"><Ticket size={22} /></div>
            <div>
              <strong>Detty Dezemba ticket drop</strong>
              <span>1 entry · 1 spin · instant result</span>
            </div>
            <b>KES 500</b>
          </div>

          <label className="field-label" htmlFor="mpesa-phone">M-Pesa phone number</label>
          <div className="phone-field">
            <span>+254</span>
            <input
              id="mpesa-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="712 345 678"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              autoFocus
              required
              aria-describedby="phone-help"
            />
            <Phone size={18} />
          </div>
          <p className="field-help" id="phone-help">
            {campaign.paymentMode === 'demo' ? 'Use 712 345 678. No real payment is made.' : 'Use the Safaricom number you want to pay with.'}
          </p>

          {campaign.paymentMode === 'live' && (
            <>
              <label className="field-label" htmlFor="paystack-email">Email for your Paystack receipt</label>
              <div className="phone-field">
                <input
                  id="paystack-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </div>
              <p className="field-help">Paystack requires an email address for the payment record.</p>
            </>
          )}

          <label className="terms-check">
            <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} required />
            <span>I confirm I’m 18+ and agree to the drop terms, including the limit of {campaign.maxEntriesPerPhone} paid entries per number.</span>
          </label>

          {error && <div className="form-error" role="alert">{error}</div>}

          <button className="button button-primary button-full payment-button" type="submit" disabled={!accepted || submitting || campaign.status === 'closed'}>
            {submitting ? <LoaderCircle size={19} className="spin-icon" /> : <LockKeyhole size={18} />}
            {submitting ? 'Starting secure payment…' : 'Pay KES 500 with Paystack'}
            {!submitting && <ArrowRight size={18} />}
          </button>
          <div className="pin-warning"><ShieldCheck size={15} /> Your M-Pesa PIN is only entered on your phone. Never type it here.</div>
        </form>
      )}

      {step === 'waiting' && (
        <div className="payment-waiting">
          <div className="phone-pulse">
            <Phone size={30} />
            <span />
          </div>
          <span className="eyebrow">{campaign.paymentMode === 'demo' ? 'SIMULATING PAYSTACK' : 'PAYSTACK M-PESA PROMPT SENT'}</span>
          <h2>Check your phone</h2>
          <p>{campaign.paymentMode === 'demo'
            ? 'We’re simulating a successful Paystack M-Pesa approval. You will not be charged.'
            : `Approve the KES 500 prompt on ${entry.phone}. Paystack will confirm your payment.`}</p>
          <div className="waiting-line"><LoaderCircle size={18} className="spin-icon" /> Waiting for Paystack confirmation</div>
          <div className="pin-warning"><ShieldCheck size={15} /> This website will never ask for your M-Pesa PIN.</div>
        </div>
      )}

      {step === 'ready' && entry && (
        <div className="payment-ready">
          <div className="success-seal"><Check size={34} strokeWidth={2.5} /></div>
          <span className="eyebrow">PAYMENT CONFIRMED</span>
          <h2>Your spin is unlocked.</h2>
          <p>Entry <strong>#{String(entry.entryNumber).padStart(3, '0')}</strong> is in the fixed pool. Your outcome is now locked; the wheel will reveal it.</p>
          <div className="ready-receipt">
            <span>Receipt</span><strong>{entry.receipt}</strong>
            <span>Paid</span><strong>KES {entry.amount}</strong>
          </div>
          <button className="button button-primary button-full" type="button" onClick={() => {
            onSpinReady(entry);
            setStep('form');
            setEntry(null);
            setPhone('');
            setEmail('');
            setAccepted(false);
          }}>
            Spin now <ArrowRight size={18} />
          </button>
          <p className="microcopy">One paid entry = one reveal. Any Free Spin adds a KES 0 bonus reveal. Refreshing cannot change results.</p>
        </div>
      )}
    </Modal>
  );
}

export function ResultModal({ entry, campaign, bonusEntry, onFreeSpin, onClose, onToast }) {
  const [verified, setVerified] = useState(false);
  if (!entry) return null;
  const won = entry.outcome === 'win' || entry.outcome === 'vip-win';
  const freeSpin = entry.outcome === 'free-spin';
  const bonus = entry.amount === 0;

  const saveReceipt = () => {
    downloadJson(`tiketi-${entry.receipt}.json`, {
      campaignId: campaign.id,
      commitment: campaign.commitment,
      entry,
      verification: 'SHA-256 of the canonical tiketi.result.v1 payload',
    });
    onToast('Receipt downloaded. Keep it somewhere safe.');
  };

  const checkReceipt = async () => {
    const valid = await verifyReceipt(entry);
    setVerified(valid);
    onToast(valid ? 'Receipt hash verified on this device.' : 'Receipt verification failed.');
  };

  return (
    <Modal
      onClose={onClose}
      label={won ? 'Winning result' : freeSpin ? 'Free Spin result' : 'Spin result'}
      className={`result-modal ${won ? 'won' : ''} ${freeSpin ? 'free-spin' : ''}`}
    >
      {(won || freeSpin) && (
        <div className="confetti" aria-hidden="true">
          {Array.from({ length: 20 }, (_, index) => (
            <i key={index} style={{ '--i': index, '--x': `${(index * 37) % 100}%`, '--delay': `${(index % 6) * 0.08}s` }} />
          ))}
        </div>
      )}
      <div className={`result-symbol ${won ? 'win' : ''} ${freeSpin ? 'free-spin' : ''}`}>
        {won ? <Ticket size={38} /> : freeSpin ? <RotateCw size={36} /> : <Hash size={34} />}
      </div>
      <span className="eyebrow">OFFICIAL RESULT · {entry.receipt}</span>
      <h2>{won ? 'You’re going to Detty Dezemba!' : freeSpin ? 'Free Spin unlocked!' : 'Not this time.'}</h2>
      <p className="result-lead">
        {won
          ? `You won ${entry.prize}. We’ll contact you on your payment number with claim instructions.`
          : freeSpin
            ? `Your KES 0 bonus entry ${bonusEntry?.receipt || ''} is ready. It uses the next concealed position in the same committed pool — no payment needed.`
            : `Your ${bonus ? 'free-spin bonus' : 'paid'} entry drew a non-winning outcome from the fixed pool. Your result is final and can be verified with its receipt.`}
      </p>

      {won ? (
        <div className="festival-win-ticket" aria-label={`Winning festival ticket ${entry.receipt}`}>
          <div className="festival-win-ticket-top">
            <span>WINNING TICKET</span>
          </div>
          <div className="festival-win-ticket-body">
            <small>DECEMBER 2026 · NAIROBI</small>
            <strong>DETTY DEZEMBA</strong>
            <em>FESTIVAL</em>
            <span>{entry.prize}</span>
          </div>
          <div className="festival-win-ticket-receipt">
            <span>WINNING RECEIPT</span>
            <strong>{entry.receipt}</strong>
          </div>
          <div className="festival-win-ticket-meta">
            <span>ENTRY #{String(entry.entryNumber).padStart(3, '0')}</span>
            <span>HASH {shortHash(entry.resultHash, 10)}</span>
          </div>
        </div>
      ) : (
        <>
          {freeSpin && bonusEntry && (
            <div className="free-spin-pass">
              <span>FREE SPIN · KES 0</span>
              <strong>{bonusEntry.receipt}</strong>
              <small>Next committed position · Its own receipt and result hash</small>
            </div>
          )}
          <div className="result-ticket">
            <div><span>Entry</span><strong>#{String(entry.entryNumber).padStart(3, '0')}</strong></div>
            <div><span>Result</span><strong>{freeSpin ? 'FREE SPIN' : 'NO WIN'}</strong></div>
            <div><span>{bonus ? 'Entry type' : 'Payment ref.'}</span><strong>{bonus ? 'BONUS · KES 0' : entry.paymentReference || 'Confirmed'}</strong></div>
            <div><span>Receipt hash</span><strong>{shortHash(entry.resultHash, 10)}</strong></div>
          </div>
        </>
      )}

      {freeSpin && bonusEntry && (
        <button className="button button-primary button-full free-spin-continue" type="button" onClick={() => onFreeSpin(bonusEntry)}>
          <RotateCw size={18} /> Use my Free Spin <ArrowRight size={18} />
        </button>
      )}

      <div className="result-actions">
        <button className="button button-primary" type="button" onClick={saveReceipt}><Download size={17} /> Save receipt</button>
        <button className="button button-secondary" type="button" onClick={checkReceipt}>
          {verified ? <CheckCircle2 size={17} /> : <FileCheck2 size={17} />}
          {verified ? 'Verified' : 'Verify hash'}
        </button>
      </div>
    </Modal>
  );
}

export function FairnessModal({ campaign, onClose, onToast }) {
  const copyCommitment = async () => {
    await copyText(campaign.commitment);
    onToast('Pool commitment copied.');
  };

  const downloadCommitment = () => {
    downloadJson('tiketi-pool-commitment.json', {
      schema: 'tiketi.commitment-record.v1',
      campaignId: campaign.id,
      commitment: campaign.commitment,
      createdAt: campaign.createdAt,
      totalEntries: campaign.totalEntries,
      totalWinners: campaign.totalWinners,
      totalRegularTickets: campaign.totalRegularTickets,
      totalVipTickets: campaign.totalVipTickets,
      totalFreeSpins: campaign.totalFreeSpins,
      totalRewards: campaign.totalRewards,
      algorithm: 'SHA-256 of JSON.stringify(tiketi.pool.v5 payload)',
      poolRevealed: campaign.poolRevealed,
    });
    onToast('Commitment record downloaded.');
  };

  const downloadReveal = async () => {
    const reveal = await api('/api/campaign/reveal');
    downloadJson('tiketi-pool-reveal.json', reveal);
    onToast('Revealed pool downloaded for independent verification.');
  };

  return (
    <Modal onClose={onClose} label="How ticket spin verification works" className="fairness-modal">
      <span className="eyebrow">VERIFY, DON’T JUST TRUST</span>
      <h2>What the hashes prove.</h2>
      <p className="modal-intro">The system publishes a fingerprint of the shuffled outcome pool before entries open. After the drop, the original pool and salt can be revealed against that fingerprint.</p>
      <ol className="verification-steps">
        <li><b>01</b><div><strong>Pool committed</strong><p>Exactly {campaign.totalRegularTickets} Regular Ticket, {campaign.totalVipTickets} VIP Ticket, {campaign.totalFreeSpins} Free Spins and {campaign.totalEntries - campaign.totalRewards} No-Win positions are shuffled with Node’s cryptographic RNG. The salt and pool stay private while entries are open.</p></div></li>
        <li><b>02</b><div><strong>Entries fix the position</strong><p>Paid entries and KES 0 bonus entries receive the next pool position in allocation order. A Free Spin creates its bonus entry for the following position without using another paid-entry slot. The browser cannot choose or reroll an outcome.</p></div></li>
        <li><b>03</b><div><strong>Results form a hash chain</strong><p>Each issued receipt includes the previous result’s hash. Changing an old result breaks the chain that follows it.</p></div></li>
        <li><b>04</b><div><strong>Pool revealed after close</strong><p>Anyone can then hash the revealed pool and compare it with the commitment published before play.</p></div></li>
      </ol>
      <p className="modal-intro">The wheel keeps seven illustrated slots, with Regular Ticket, Free Spin and VIP Ticket separated by distributed No-Win positions. Slot size does not calculate the odds; the committed pool decides outcomes, and remaining odds change as positions are allocated.</p>
      <div className="modal-hash-box">
        <span>POOL COMMITMENT · SHA-256</span>
        <code>{campaign.commitment}</code>
        <button className="icon-button" type="button" onClick={copyCommitment} aria-label="Copy pool commitment"><Clipboard size={17} /></button>
      </div>
      <div className="result-actions">
        <button className="button button-secondary" type="button" onClick={downloadCommitment}><Download size={16} /> Commitment record</button>
        {campaign.poolRevealed && <button className="button button-primary" type="button" onClick={downloadReveal}><LockKeyhole size={16} /> Download reveal</button>}
      </div>
      {!campaign.poolRevealed && <p className="microcopy">Full pool reveal unlocks after the drop closes and every allocated entry, including Free Spins, is complete.</p>}
    </Modal>
  );
}

const legalContent = {
  terms: {
    eyebrow: 'DROP RULES',
    title: 'Plain-language terms.',
    sections: [
      ['Entry', 'This demonstration charges no money. For an approved live drop, each confirmed KES 500 Paystack M-Pesa payment receives one paid entry and one outcome reveal. Entrants must be 18 or older, with a maximum of three paid entries per phone number. Free Spins create KES 0 bonus entries and do not use another paid-entry slot.'],
      ['Prizes and results', 'There is exactly one Regular Detty Dezemba Festival ticket, one VIP ticket and four Free Spins in a fixed pool of 120 positions, alongside 114 No-Win positions. Starting odds are 1 in 120 for each ticket type, 1 in 60 for any ticket, and 1 in 20 for any reward. A winning receipt shows the prize reference. Winners must be reachable on their payment number and complete reasonable identity and eligibility checks before fulfilment.'],
      ['Refunds and cancellation', 'A revealed, valid entry is not refundable simply because it did not win. If the operator cancels the drop, affected paid entrants should receive a refund to the original payment number. Final launch terms must be reviewed by qualified Kenyan counsel.'],
    ],
  },
  privacy: {
    eyebrow: 'PRIVACY',
    title: 'Your number is not the show.',
    sections: [
      ['What is collected', 'A live service needs your phone number, email address for the Paystack receipt, payment reference, entry position and result to process payment, contact winners and prevent duplicate or fraudulent claims. This preview stores only test data.'],
      ['What is public', 'The public ledger displays a masked phone number, receipt, entry position, outcome and cryptographic proof. It never displays your full phone number or M-Pesa PIN.'],
      ['Production obligations', 'Before launch, the operator should publish a complete privacy notice, define retention periods, secure the production database and comply with applicable Kenyan data-protection requirements.'],
    ],
  },
  responsible: {
    eyebrow: 'PLAY WITH LIMITS',
    title: 'A ticket is a maybe, not a plan.',
    sections: [
      ['18+ only', 'This is a paid chance-based promotion in live mode. Never borrow money to enter, never treat it as income, and only spend what you can comfortably afford to lose.'],
      ['Built-in limit', 'The drop limits each phone number to three paid entries. Free Spins are KES 0 bonus entries. A loss is final; refreshing or paying again cannot change a previous result.'],
      ['Need a pause?', 'If entering stops feeling fun or starts causing pressure, stop. The operator should provide account-level exclusion and support routes before accepting live payments.'],
    ],
  },
};

export function LegalModal({ type, onClose }) {
  const content = legalContent[type] || legalContent.terms;
  return (
    <Modal onClose={onClose} label={content.title} className="legal-modal">
      <span className="eyebrow">{content.eyebrow}</span>
      <h2>{content.title}</h2>
      {content.sections.map(([title, body]) => (
        <section key={title}>
          <h3>{title}</h3>
          <p>{body}</p>
        </section>
      ))}
      <div className="legal-note"><ShieldCheck size={18} /> Paid prize promotions in Kenya may require BCLB authorisation. Obtain all required approvals before enabling live entry payments.</div>
    </Modal>
  );
}
